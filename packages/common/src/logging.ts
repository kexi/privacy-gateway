/**
 * Structured JSON logging that cannot emit raw PII.
 *
 * One JSON object per line, in the shape Cloud Logging ingests directly:
 * `severity` / `message` / `time` plus a flat jsonPayload. Trace correlation
 * fields (`logging.googleapis.com/trace`, `.../spanId`) are filled from the
 * active OpenTelemetry span so Logs Explorer and Cloud Trace cross-link.
 *
 * Fields are filtered against a **typed allowlist** rather than scrubbed. Why
 * not scrub: masking runs the same regexes the tokenizer does, so it never saw a
 * personal name or an address, and an exception message or a truncated response
 * body could carry either straight into the log. Only the fields named below —
 * hashes, counts, enums, internal UUIDs — are emitted at all; anything else is
 * dropped, and the dropped key names are recorded so a missing field is visible
 * rather than silently absent.
 *
 * Why not pino or winston? On Cloud Run a single-line JSON object on stdout is
 * already a structured log entry, so a dependency would buy nothing and would
 * add a second place where a value could escape the allowlist.
 */

import { trace } from '@opentelemetry/api';
import type { AgentName } from './config.ts';

export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

const SEVERITY_ORDER: Record<Severity, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

/** How an allowed field's value is coerced before it is written. */
type FieldKind = 'id' | 'enum' | 'number' | 'boolean' | 'string_list' | 'count_map' | 'hash';

/**
 * Every field a log line may carry, and the shape it is forced into.
 *
 * `id` values are internal UUIDs and span/trace ids, all minted server-side.
 * `enum` values are drawn from closed sets in the code (verdicts, tiers, HTTP
 * methods, error class names). Nothing here is caller-controlled free text.
 */
const ALLOWED_FIELDS: Readonly<Record<string, FieldKind>> = {
  agent: 'enum',
  event: 'enum',
  severity: 'enum',
  request_id: 'id',
  trace_id: 'id',
  span_id: 'id',
  model: 'enum',
  status: 'enum',
  verdict: 'enum',
  trust_tier: 'enum',
  document_status: 'enum',
  freshness: 'enum',
  hop: 'enum',
  path: 'enum',
  method: 'enum',
  error_code: 'enum',
  error_class: 'enum',
  refusal: 'enum',
  vault_backend: 'enum',
  time: 'enum',
  duration_ms: 'number',
  attempt: 'number',
  port: 'number',
  placeholder_count: 'number',
  masked_count: 'number',
  unstructured_spans: 'number',
  span_count: 'number',
  tokens_resolved: 'number',
  tokens_unknown: 'number',
  withheld_count: 'number',
  vault_generation: 'number',
  body_bytes: 'number',
  finding_count: 'number',
  text_length: 'number',
  tokens_withheld: 'number',
  finding_kinds: 'string_list',
  ok: 'boolean',
  leak: 'boolean',
  stale: 'boolean',
  categories: 'string_list',
  findings: 'string_list',
  withheld: 'string_list',
  unresolved_tokens: 'string_list',
  invented_tokens: 'string_list',
  issues: 'string_list',
  counts_by_category: 'count_map',
  response_hash: 'hash',
  masked_prompt_hash: 'hash',
  attester_sha256: 'hash',
  computation_sha256: 'hash',
};

/** Fields every log line may carry; `event` is the searchable discriminator. */
export interface LogFields {
  readonly event?: string;
  readonly request_id?: string | undefined;
  readonly duration_ms?: number | undefined;
  readonly [key: string]: unknown;
}

/** Coerce one allowed value into its declared shape, or drop it. */
function coerce(kind: FieldKind, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;

  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'id':
    case 'enum':
    case 'hash':
      // Bounded so an inbound header that slipped through validation cannot
      // become an unbounded log line.
      return typeof value === 'string' ? value.slice(0, 128) : undefined;
    case 'string_list':
      return Array.isArray(value)
        ? value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.slice(0, 128))
        : undefined;
    case 'count_map': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const counts: Record<string, number> = {};
      for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
        if (typeof count === 'number' && Number.isFinite(count)) counts[key.slice(0, 64)] = count;
      }
      return counts;
    }
  }
}

/**
 * Keep only the allowlisted fields.
 *
 * Dropped keys are reported by name (never by value) under `dropped_fields`, so
 * a developer who adds a field and forgets the allowlist sees it immediately
 * instead of debugging an absent log line.
 */
function selectFields(fields: LogFields): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    const kind = ALLOWED_FIELDS[key];
    if (kind === undefined) {
      if (value !== undefined) dropped.push(key);
      continue;
    }
    const coerced = coerce(kind, value);
    if (coerced !== undefined) selected[key] = coerced;
  }

  if (dropped.length > 0) selected['dropped_fields'] = dropped.sort();
  return selected;
}

export interface LoggerOptions {
  readonly agent: AgentName;
  readonly level?: Severity | undefined;
  /** GCP project, needed to build the fully-qualified Cloud Logging trace name. */
  readonly project?: string | undefined;
  /** Sink override; tests capture lines instead of writing to stdout. */
  readonly write?: ((line: string) => void) | undefined;
}

/**
 * A logger bound to one agent, and optionally to one request.
 *
 * `child` carries `request_id` / `session_id` down a call chain so individual
 * call sites do not have to thread them through by hand — the single most
 * common way correlation fields go missing.
 */
export class Logger {
  private readonly options: LoggerOptions;
  private readonly bound: LogFields;
  private readonly threshold: number;

  constructor(options: LoggerOptions, bound: LogFields = {}) {
    this.options = options;
    this.bound = bound;
    this.threshold = SEVERITY_ORDER[options.level ?? 'INFO'];
  }

  /** Returns a logger that adds `fields` to every subsequent line. */
  child(fields: LogFields): Logger {
    return new Logger(this.options, { ...this.bound, ...fields });
  }

  debug(message: string, fields?: LogFields): void {
    this.log('DEBUG', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log('INFO', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log('WARNING', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.log('ERROR', message, fields);
  }

  /**
   * Emit one structured event.
   *
   * `event` is the stable identifier the log-investigation guide searches on
   * (`skills/pgw-logs/LOGS.md` §5), so it doubles as the human-readable message
   * when no separate message is worth writing.
   */
  event(event: string, fields: LogFields = {}, severity: Severity = 'INFO'): void {
    this.log(severity, event, { ...fields, event });
  }

  private log(severity: Severity, message: string, fields: LogFields = {}): void {
    if (SEVERITY_ORDER[severity] < this.threshold) return;

    const merged = { ...this.bound, ...fields };
    const entry: Record<string, unknown> = {
      severity,
      // The message is always a literal at the call site (an event name or a
      // fixed sentence), never interpolated user text; bounding it keeps that
      // true even if someone breaks the convention.
      message: message.slice(0, 256),
      time: new Date().toISOString(),
      agent: this.options.agent,
      ...selectFields(merged),
    };

    // Correlate with Cloud Trace. Without the project id the fully-qualified
    // trace name cannot be built, so the raw ids are still emitted for local use.
    const span = trace.getActiveSpan();
    if (span !== undefined) {
      const { traceId, spanId } = span.spanContext();
      entry['trace_id'] = traceId;
      entry['span_id'] = spanId;
      if (this.options.project !== undefined) {
        entry['logging.googleapis.com/trace'] =
          `projects/${this.options.project}/traces/${traceId}`;
        entry['logging.googleapis.com/spanId'] = spanId;
      }
    }

    const line = JSON.stringify(entry);
    if (this.options.write !== undefined) {
      this.options.write(line);
      return;
    }
    if (severity === 'ERROR') {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  }
}

/** Build the process-wide logger for one agent. */
export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}

/**
 * Normalize a thrown value into log-safe fields.
 *
 * The message is deliberately absent. An exception message routinely embeds the
 * value that caused it — a response body, a prompt fragment, a header — and no
 * masking pass can be trusted to catch a name or an address inside one. The
 * class and an optional code are enough to locate the throw site, and the
 * request id ties it to the rest of the request.
 */
export function errorFields(error: unknown, code?: string): LogFields {
  if (error instanceof Error) {
    return { error_class: error.name, error_code: code ?? error.name };
  }
  return { error_class: 'unknown_error', error_code: code ?? 'unknown_error' };
}

/**
 * Structured JSON logging that never emits raw PII.
 *
 * One JSON object per line, in the shape Cloud Logging ingests directly:
 * `severity` / `message` / `time` plus a flat jsonPayload. Trace correlation
 * fields (`logging.googleapis.com/trace`, `.../spanId`) are filled from the
 * active OpenTelemetry span so Logs Explorer and Cloud Trace cross-link.
 *
 * Every string value is passed through the tokenizer before serialization, so
 * even if a caller accidentally hands over a raw value only the placeholder ends
 * up in the log.
 *
 * Why not pino or winston? On Cloud Run a single-line JSON object on stdout is
 * already a structured log entry, so a dependency would buy nothing and would
 * add a second place where PII could escape masking.
 */

import { trace } from '@opentelemetry/api';
import type { AgentName } from './config.ts';
import { maskForLogging } from './tokenizer.ts';

export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

const SEVERITY_ORDER: Record<Severity, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

/**
 * Keys whose values pass through unmasked: identifiers, verdicts and counts,
 * none of which can carry PII, and all of which become useless if masked.
 */
const PASSTHROUGH_KEYS = new Set([
  'agent',
  'event',
  'severity',
  'session_id',
  'request_id',
  'trace_id',
  'span_id',
  'model',
  'status',
  'verdict',
  'trust_tier',
  'hop',
  'path',
  'method',
  'error_code',
  'time',
]);

/** Fields every log line may carry; `event` is the searchable discriminator. */
export interface LogFields {
  readonly event?: string;
  readonly session_id?: string | undefined;
  readonly request_id?: string | undefined;
  readonly duration_ms?: number | undefined;
  readonly [key: string]: unknown;
}

/** Recursively masks a value, leaving identifier-like keys intact. */
function scrub(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    return key !== undefined && PASSTHROUGH_KEYS.has(key) ? value : maskForLogging(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, k)]),
    );
  }
  return value;
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
      message: scrub(message),
      time: new Date().toISOString(),
      agent: this.options.agent,
      ...(scrub(merged) as Record<string, unknown>),
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
 * Exception messages can contain PII, so the message goes through the same
 * masking path as everything else (`scrub` is applied by `Logger.log`).
 */
export function errorFields(error: unknown, code?: string): LogFields {
  if (error instanceof Error) {
    return {
      error_code: code ?? error.name,
      error_message: error.message,
    };
  }
  return { error_code: code ?? 'unknown_error', error_message: String(error) };
}

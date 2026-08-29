/**
 * A deliberately tiny structured logger.
 *
 * Why not `@privacy-gateway/common/logging`: that module's package pulls in
 * Firestore, ADK and the OpenTelemetry SDK as dependencies. This shim runs on a
 * developer's laptop and must never be able to reach the vault, so it does not
 * depend on the package that can. The allowlist discipline is copied rather than
 * imported — the shared logger's guarantee is the *shape*, not the code.
 *
 * The allowlist is the point: fields are named here explicitly, so no code path
 * can widen the log surface by handing the logger a new key. Request text,
 * message content and answers have no field to travel in.
 */

/** Every field a shim log line may carry. Nothing else is emitted. */
export interface ShimLogFields {
  /** Server-minted correlation id, echoed to the caller. Never a vault key. */
  readonly request_id?: string;
  /** HTTP method of the handled request. */
  readonly method?: string;
  /** Route path only — never a query string, which could carry text. */
  readonly path?: string;
  /** HTTP status the shim returned. */
  readonly status?: number;
  /** Wall-clock duration of the upstream call. */
  readonly duration_ms?: number;
  /** Whether the caller asked for a streaming framing. */
  readonly stream?: boolean;
  /** Number of messages received — a count, never their contents. */
  readonly message_count?: number;
  /** Constructor name of a caught error. Never the message. */
  readonly error_class?: string;
  /** Stable machine-readable code for a refusal or failure. */
  readonly error_code?: string;
  /** PII category names from a refusal. Category names are not values. */
  readonly categories?: readonly string[];
  /** Which wire surface handled the request: 'anthropic' or 'ollama'. */
  readonly surface?: string;
  /** TCP port the server bound. */
  readonly port?: number;
}

const ALLOWED_FIELDS = [
  'request_id',
  'method',
  'path',
  'status',
  'duration_ms',
  'stream',
  'message_count',
  'error_class',
  'error_code',
  'categories',
  'surface',
  'port',
] as const satisfies readonly (keyof ShimLogFields)[];

const ALLOWED = new Set<string>(ALLOWED_FIELDS);

export type Severity = 'INFO' | 'WARNING' | 'ERROR';

export interface Logger {
  event(event: string, fields?: ShimLogFields, severity?: Severity): void;
}

/**
 * Build a logger writing one JSON object per line to stderr.
 *
 * Why stderr: stdout stays clean so the process can be piped without log lines
 * corrupting whatever reads it.
 */
export function createLogger(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  return {
    event(event, fields = {}, severity: Severity = 'INFO') {
      const payload: Record<string, unknown> = {
        severity,
        time: now().toISOString(),
        agent: 'ollama-shim',
        event,
      };

      const dropped: string[] = [];
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        // An unlisted field is dropped and its *key name* recorded — the value
        // never reaches the sink, because an unreviewed field is exactly where
        // request text would leak in.
        if (!ALLOWED.has(key)) {
          dropped.push(key);
          continue;
        }
        payload[key] = value;
      }
      if (dropped.length > 0) payload['dropped_fields'] = dropped;

      write(JSON.stringify(payload));
    },
  };
}

/** Error fields for a caught value: class and code only, never the message. */
export function errorFields(error: unknown, code: string): ShimLogFields {
  return {
    error_class: error instanceof Error ? error.constructor.name : typeof error,
    error_code: code,
  };
}

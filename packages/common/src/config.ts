/**
 * Environment configuration, validated with zod at startup.
 *
 * Every service calls `loadConfig` once as it boots. An invalid environment is a
 * deployment error, not a runtime condition to be handled, so validation failure
 * logs `config.invalid` and exits non-zero rather than letting a half-configured
 * process serve traffic.
 *
 * This module deliberately imports nothing from the vault or the tokenizer: the
 * Core Agent consumes it through the `@privacy-gateway/common/config` subpath,
 * and Core must stay structurally unable to reach the token vault.
 */

import { z } from 'zod';

/** The agent identity a process reports in every log line and span. */
export const AgentNameSchema = z.enum(['gateway', 'core', 'synthesis']);
export type AgentName = z.infer<typeof AgentNameSchema>;

/** Model verified to exist on Vertex AI. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
/** Ollama tag pulled by `just pull-gemma`. */
export const DEFAULT_GEMMA_MODEL = 'gemma3:12b';
/** Vault lifetime; the OKF `stale_after` is kept equal to it. */
export const DEFAULT_VAULT_TTL_SECONDS = 3600;
/**
 * Body limit. A prompt is prose; the previous 10 MB let one unauthenticated
 * request drive two Gemma calls plus a Gemini call over a megabyte of input.
 */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** One deadline for the whole chain, so a hung hop cannot pin a worker. */
export const DEFAULT_REQUEST_DEADLINE_SECONDS = 60;
/** Demo-grade per-IP quota. The public gateway has no authenticated principal. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;

/** Coerces the "1"/"true"/"yes" family of env flags into a boolean. */
const BooleanFromEnv = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  });

/** A positive integer supplied as a string, as every env var is. */
const IntFromEnv = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value.trim() === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected an integer, got ${value}`,
      });
      return z.NEVER;
    }
    return parsed;
  });

/** A URL, rejected early so a typo surfaces at boot rather than mid-request. */
const UrlFromEnv = z.string().url().optional();

/**
 * The full environment contract, shared by all three agents.
 *
 * Why one schema rather than one per service? The services are deployed from a
 * single .env and a single Cloud Run substitution set, so a per-service schema
 * would reject variables that are simply not that service's concern. Every field
 * is therefore optional here, and each service asserts the subset it needs via
 * `requireFields`.
 */
export const EnvSchema = z.object({
  // --- identity / runtime ---
  PORT: IntFromEnv,
  LOG_LEVEL: z.enum(['DEBUG', 'INFO', 'WARNING', 'ERROR']).optional(),
  NODE_ENV: z.string().optional(),

  // --- Google Cloud / Vertex AI ---
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_CLOUD_LOCATION: z.string().optional(),
  GOOGLE_GENAI_USE_VERTEXAI: z.string().optional(),
  GEMINI_MODEL: z.string().default(DEFAULT_GEMINI_MODEL),

  // --- Gemma (self-hosted, OpenAI-compatible) ---
  GEMMA_BASE_URL: z.string().url().default('http://localhost:11434/v1'),
  GEMMA_MODEL: z.string().default(DEFAULT_GEMMA_MODEL),
  GEMMA_API_KEY: z.string().default('ollama'),
  /**
   * How callers authenticate to the Gemma endpoint.
   *
   * `iam` sends a Google-signed ID token whose audience is the Gemma service
   * origin — the only thing Cloud Run's `run.invoker` check accepts. `none`
   * sends the static `GEMMA_API_KEY` bearer, which is all a local Ollama wants
   * (it ignores the value, but the OpenAI wire format requires the header).
   *
   * Left unset it is derived from the URL scheme by `gemmaAuthMode`: https
   * means Cloud Run, so `iam`; http means local, so `none`.
   */
  //
  // An empty string is treated as unset: `.env` files carry `GEMMA_AUTH=` as the
  // way to say "use the default", and a bare enum would reject that.
  GEMMA_AUTH: z
    .enum(['iam', 'none'])
    .or(z.literal('').transform(() => undefined))
    .optional(),

  // --- service-to-service ---
  CORE_BASE_URL: UrlFromEnv,
  SYNTHESIS_BASE_URL: UrlFromEnv,
  A2A_TIMEOUT_SECONDS: IntFromEnv,
  A2A_PUBLIC_URL: UrlFromEnv,
  A2A_HOST: z.string().optional(),
  A2A_PROTOCOL: z.enum(['http', 'https']).optional(),

  // --- persistence ---
  VAULT_BACKEND: z.enum(['memory', 'firestore']).default('memory'),
  VAULT_COLLECTION: z.string().default('token_vault'),
  ANSWER_COLLECTION: z.string().default('gateway_answers'),
  VAULT_TTL_SECONDS: IntFromEnv,

  // --- request limits ---
  /** Maximum request body. A prompt is text; 64 KB is far past any real one. */
  MAX_BODY_BYTES: IntFromEnv,
  /** One deadline for the whole gateway → core → synthesis chain. */
  REQUEST_DEADLINE_SECONDS: IntFromEnv,
  /** Demo-grade per-IP quota; 0 disables it. */
  RATE_LIMIT_PER_MINUTE: IntFromEnv,

  // --- disclosure policy ---
  /**
   * Categories the rehydrator may restore despite being withheld by default
   * (comma separated, e.g. `CREDIT_CARD,MY_NUMBER`). Empty means withhold all.
   */
  REHYDRATE_ALLOW_CATEGORIES: z.string().optional(),

  // --- web / misc ---
  WEB_DIR: z.string().optional(),

  // --- observability ---
  OTEL_ENABLED: BooleanFromEnv,
  OTEL_SERVICE_NAME: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/** How a caller should authenticate to Gemma. See `EnvSchema.GEMMA_AUTH`. */
export type GemmaAuthMode = 'iam' | 'none';

/**
 * Resolve the Gemma auth mode from an explicit setting or the URL scheme.
 *
 * The scheme is the honest default: an https Gemma is the Cloud Run GPU service,
 * which is internal-ingress *and* IAM-protected, so a static bearer is simply
 * the wrong credential. Http is loopback Ollama, where no IAM check exists.
 *
 * Why keep an explicit override at all: an https reverse proxy in front of a
 * local Ollama (a tunnel during development) has no metadata server behind it,
 * and `GEMMA_AUTH=none` is how that is expressed without weakening the default.
 */
export function gemmaAuthMode(
  baseUrl: string,
  explicit?: GemmaAuthMode | undefined,
): GemmaAuthMode {
  if (explicit !== undefined) return explicit;
  return baseUrl.startsWith('https://') ? 'iam' : 'none';
}

/** The resolved configuration a service runs on. */
export interface Config extends Env {
  readonly agent: AgentName;
  /** Vault TTL with its default applied; `stale_after` mirrors this. */
  readonly vaultTtlSeconds: number;
  /** A2A/HTTP client timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Body limit with its default applied. */
  readonly maxBodyBytes: number;
  /** End-to-end deadline for one `/v1/ask`, in milliseconds. */
  readonly requestDeadlineMs: number;
  /** Per-IP requests per minute; 0 disables the limiter. */
  readonly rateLimitPerMinute: number;
}

export interface LoadConfigOptions {
  readonly agent: AgentName;
  /** Raw environment. Injectable so tests need not mutate `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Keys this service cannot run without. */
  readonly require?: readonly (keyof Env)[];
  /** Called instead of `process.exit` when validation fails (tests pass a throw). */
  readonly onInvalid?: (message: string, issues: readonly string[]) => never;
}

/**
 * Validate the environment and build the service configuration.
 *
 * Why fail fast instead of falling back to defaults? A misconfigured
 * `CORE_BASE_URL` or `VAULT_BACKEND` would otherwise surface as a confusing
 * mid-request error after the gateway has already masked and stored data.
 */
export function loadConfig(options: LoadConfigOptions): Config {
  const source = options.env ?? process.env;
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    return failInvalid(options, 'environment validation failed', issues);
  }

  const env = parsed.data;
  const missing = (options.require ?? []).filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    return failInvalid(
      options,
      'required environment variables are unset',
      missing.map((key) => `${String(key)}: required by the ${options.agent} agent`),
    );
  }

  return {
    ...env,
    agent: options.agent,
    vaultTtlSeconds: env.VAULT_TTL_SECONDS ?? DEFAULT_VAULT_TTL_SECONDS,
    requestTimeoutMs: (env.A2A_TIMEOUT_SECONDS ?? 120) * 1000,
    maxBodyBytes: env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES,
    requestDeadlineMs: (env.REQUEST_DEADLINE_SECONDS ?? DEFAULT_REQUEST_DEADLINE_SECONDS) * 1000,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
  };
}

/**
 * Report an invalid configuration and stop the process.
 *
 * The message is written directly rather than through the logger because
 * logging itself depends on a resolved config.
 */
function failInvalid(
  options: LoadConfigOptions,
  message: string,
  issues: readonly string[],
): never {
  const entry = {
    severity: 'ERROR',
    message: `${message}: ${issues.join('; ')}`,
    time: new Date().toISOString(),
    event: 'config.invalid',
    agent: options.agent,
    issues,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);

  if (options.onInvalid !== undefined) {
    return options.onInvalid(message, issues);
  }
  process.exit(1);
}

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

  // --- web / misc ---
  WEB_DIR: z.string().optional(),
  DEFAULT_APPROVER: z.string().default('kei'),

  // --- observability ---
  OTEL_ENABLED: BooleanFromEnv,
  OTEL_SERVICE_NAME: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/** The resolved configuration a service runs on. */
export interface Config extends Env {
  readonly agent: AgentName;
  /** Vault TTL with its default applied; `stale_after` mirrors this. */
  readonly vaultTtlSeconds: number;
  /** A2A/HTTP client timeout in milliseconds. */
  readonly requestTimeoutMs: number;
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

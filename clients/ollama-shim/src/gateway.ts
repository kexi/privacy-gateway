/**
 * The one call this shim makes upstream.
 *
 * Both wire surfaces — Anthropic Messages (what Claude Desktop speaks) and the
 * native Ollama API (what `ollama` clients speak) — funnel into this module, so
 * the fleet sees one request shape no matter which client asked. The shim adds
 * no intelligence: it translates framing and nothing else. Every privacy gate
 * runs in the fleet, where the vault is, not here.
 *
 * `stream: false` upstream, always. The leak check runs on the *complete* Core
 * answer, so there is nothing to stream: a partial answer is text that has
 * crossed the boundary before the verdict deciding whether it may. The shim
 * re-frames the finished answer as a stream when the client wants one.
 */

import { z } from 'zod';

/** The single model id the fleet advertises; a caller selects the fleet. */
export const GATEWAY_MODEL_ID = 'privacy-gateway';

/** Deployed Gateway. Overridable with `PGW_GATEWAY_URL` for local runs. */
export const DEFAULT_GATEWAY_URL = 'https://privacy-gateway.kexi.dev';

/**
 * The privacy facts the fleet rides on its OpenAI-shaped response.
 *
 * `.passthrough()` and every field optional: this is another service's
 * extension field, and a shim that hard-fails when the fleet adds a key would
 * break on a deploy that changed nothing it depends on.
 */
const PrivacyFactsSchema = z
  .object({
    request_id: z.string().optional(),
    trace_id: z.string().optional(),
    trust_tier: z.string().optional(),
    status: z.string().optional(),
    masked_prompt: z.string().optional(),
    withheld: z.array(z.string()).optional(),
  })
  .passthrough();

const ChatCompletionSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            message: z.object({ role: z.string(), content: z.string() }).passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    x_privacy_gateway: PrivacyFactsSchema.optional(),
  })
  .passthrough();

const ErrorBodySchema = z
  .object({
    error: z
      .object({
        message: z.string(),
        type: z.string().optional(),
        code: z.string().nullable().optional(),
        categories: z.array(z.string()).optional(),
        request_id: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type PrivacyFacts = z.infer<typeof PrivacyFactsSchema>;

/** A completed, released answer. */
export interface GatewaySuccess {
  readonly ok: true;
  readonly content: string;
  readonly requestId: string | undefined;
  readonly facts: PrivacyFacts | undefined;
}

/**
 * A refusal, or a transport failure.
 *
 * A refusal is a *result*, not an exception: it is reported to the client as a
 * finished outcome carrying the reason. Surfacing it as a transient fault would
 * read to a model as something worth retrying, and retrying around a privacy
 * gate is another attempt to move the same data across the same boundary.
 */
export interface GatewayRefusal {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly categories: readonly string[];
  readonly requestId: string | undefined;
}

export type GatewayResult = GatewaySuccess | GatewayRefusal;

/** The sentence appended to every refusal, for the model reading it. */
export const NO_RETRY_NOTICE = 'the gateway refused; do not retry around a safety gate';

export interface GatewayClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Upstream deadline. The fleet's own deadline gate is the real bound. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Compose the refusal text a client sees.
 *
 * The category findings travel with it because they are the *actionable* part —
 * they name what kind of content tripped the gate without disclosing any value.
 */
export function refusalText(refusal: GatewayRefusal): string {
  const parts = [refusal.message];
  if (refusal.categories.length > 0) {
    parts.push(`categories: ${refusal.categories.join(', ')}`);
  }
  parts.push(NO_RETRY_NOTICE);
  return parts.join(' — ');
}

export class GatewayClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: GatewayClientOptions = {}) {
    const raw = options.baseUrl ?? process.env['PGW_GATEWAY_URL'] ?? DEFAULT_GATEWAY_URL;
    this.#baseUrl = raw.replace(/\/+$/, '');
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Send one flattened prompt to the fleet and classify the outcome.
   *
   * Never throws for an upstream refusal; throws only when the response cannot
   * be interpreted at all, which the caller maps to a 502-equivalent.
   */
  async chat(text: string, requestId: string): Promise<GatewayResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Correlation only. The fleet mints its own id — it never adopts an
          // inbound one, because the id it mints is the vault key.
          'x-request-id': requestId,
        },
        body: JSON.stringify({
          model: GATEWAY_MODEL_ID,
          messages: [{ role: 'user', content: text }],
          stream: false,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const raw: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsed = ErrorBodySchema.safeParse(raw);
      if (parsed.success) {
        return {
          ok: false,
          status: response.status,
          code: parsed.data.error.code ?? 'gateway_error',
          message: parsed.data.error.message,
          categories: parsed.data.error.categories ?? [],
          requestId: parsed.data.error.request_id,
        };
      }
      // An unparseable error body is still a refusal — failing closed here keeps
      // an opaque upstream from being reported to the client as success.
      return {
        ok: false,
        status: response.status,
        code: 'gateway_error',
        message: `the gateway returned status ${response.status}`,
        categories: [],
        requestId: undefined,
      };
    }

    const parsed = ChatCompletionSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        status: 502,
        code: 'invalid_upstream_response',
        message: 'the gateway returned a response this shim could not interpret',
        categories: [],
        requestId: undefined,
      };
    }

    const choice = parsed.data.choices[0];
    return {
      ok: true,
      content: choice?.message.content ?? '',
      requestId: parsed.data.x_privacy_gateway?.request_id,
      facts: parsed.data.x_privacy_gateway,
    };
  }
}

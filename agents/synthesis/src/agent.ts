/**
 * Synthesis Agent: the verification and rehydration agent, running on Gemma.
 *
 * The A2A surface exists so the fleet is uniformly discoverable, but the actual
 * verification is done by the deterministic pipeline. The LLM is never allowed
 * to compose the answer prose: the document is an audit artifact bound to
 * content hashes, and an LLM rewording it would break every digest recorded in
 * its `attestation` block.
 */

import { LlmAgent } from '@google/adk';
import {
  authorizedHeaders,
  gemmaAuthMode,
  LeakJudgeSchema,
  ollamaModelId,
  registerOllamaLlm,
  type GemmaAuthMode,
  type Logger,
} from '@privacy-gateway/common';

export const SYNTHESIS_AGENT_NAME = 'synthesis_agent';

export const INSTRUCTION = `You are the Synthesis Agent of a privacy-preserving gateway.

You receive a JSON object describing one gateway exchange. Report on it and nothing
else. You do not rewrite, summarize, translate or comment on any answer text you are
shown: the document assembled around it is an audit artifact bound to content hashes,
and altering it would break every digest it records.

Reply with JSON only, in this exact shape:

{"acknowledged": true}`;

/**
 * Build the A2A-facing agent.
 *
 * Given no tools on purpose: the verification path is deterministic and runs
 * outside the model, so there is nothing here for the model to call.
 */
export function buildSynthesisAgent(model?: string): LlmAgent {
  registerOllamaLlm();
  return new LlmAgent({
    name: SYNTHESIS_AGENT_NAME,
    // The card and this description must agree: this agent acknowledges an
    // exchange over A2A and nothing more. Verification, rehydration and OKF
    // assembly run in the deterministic pipeline behind POST /v1/synthesize.
    description:
      'Acknowledges a gateway exchange over A2A. It performs no verification, ' +
      'rehydration or attestation; those run on this service’s HTTP routes.',
    model: ollamaModelId(model),
    instruction: INSTRUCTION,
    generateContentConfig: { responseMimeType: 'application/json' },
    tools: [],
  });
}

const JUDGE_PROMPT = `You are a privacy auditor. Answer with JSON only:
{"leak": true|false, "categories": [...]}.

Does the following text contain any real personal data or secret (email, phone number,
credit card, API key, address, personal name)? Text between ⟦ and ⟧ is an already-masked
placeholder and is NOT a leak.`;

export interface JudgeOptions {
  readonly baseUrl?: string | undefined;
  readonly model?: string | undefined;
  readonly apiKey?: string | undefined;
  /** `iam` (Cloud Run ID token) or `none` (static key). Defaults from the scheme. */
  readonly auth?: GemmaAuthMode | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly logger?: Logger | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Ask Gemma whether any raw PII remains.
 *
 * Probabilistic, and applied asymmetrically by the pipeline: `leak: true` or an
 * unusable answer blocks the release, `leak: false` adds no trust whatsoever.
 * The deterministic attester remains the only thing that can pass a response.
 *
 * The endpoint is called directly rather than through a runner because a single
 * JSON classification needs no session, no tools and no event stream.
 */
export function createLeakJudge(
  options: JudgeOptions = {},
): (
  text: string,
  signal?: AbortSignal,
) => Promise<{ leak: boolean | null; categories?: readonly string[] }> {
  const baseUrl = (
    options.baseUrl ??
    process.env['GEMMA_BASE_URL'] ??
    'http://localhost:11434/v1'
  ).replace(/\/+$/u, '');
  const model = options.model ?? process.env['GEMMA_MODEL'] ?? 'gemma3:12b';
  const apiKey = options.apiKey ?? process.env['GEMMA_API_KEY'] ?? 'ollama';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  // Cloud Run's Gemma service is IAM-protected, so the static key is not a
  // credential there: an ID token minted for the Gemma origin is. Derived from
  // the scheme unless GEMMA_AUTH says otherwise.
  const auth = gemmaAuthMode(
    baseUrl,
    options.auth ?? (process.env['GEMMA_AUTH'] as GemmaAuthMode | undefined),
  );
  const url = `${baseUrl}/chat/completions`;

  const judgeHeaders = async (): Promise<Record<string, string>> => {
    const base = { 'content-type': 'application/json' };
    if (auth === 'iam') return authorizedHeaders(url, { headers: base, useIdToken: true });
    return { ...base, authorization: `Bearer ${apiKey}` };
  };

  return async (text: string, signal?: AbortSignal) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? 60_000);

    // The caller's deadline cancels the judge too. Handled before the listener
    // is attached because `addEventListener` never fires for an abort that has
    // already happened, and removed afterwards so a request-scoped signal does
    // not accumulate one listener per judged answer.
    const abort = (): void => {
      controller.abort();
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: await judgeHeaders(),
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: JUDGE_PROMPT },
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_object' },
          // Deterministic generation. The verdict can block a release, so the
          // same body must not pass on one call and block on the next.
          temperature: 0,
          top_p: 1,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { leak: null };
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      return parseJudgeVerdict(payload.choices?.[0]?.message?.content ?? '');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

/**
 * Parse the judge's JSON.
 *
 * An unusable answer becomes `leak: null` — "no opinion" — rather than a
 * guessed boolean, because a fabricated verdict in the audit record is worse
 * than an absent one.
 */
export function parseJudgeVerdict(raw: string): {
  leak: boolean | null;
  categories?: readonly string[];
} {
  // The raw model output is deliberately not returned. It reached the
  // attestation object and from there the response, so an unparseable answer was
  // a channel for whatever Gemma had decided to write.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { leak: null };

  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { leak: null };
  }

  const parsed = LeakJudgeSchema.safeParse(payload);
  if (!parsed.success) return { leak: null };
  return { leak: parsed.data.leak, categories: parsed.data.categories };
}

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
  neutralizePlaceholders,
  type GemmaAuthMode,
  type Logger,
} from '@privacy-gateway/common';
// From the `config` subpath, not the index: the index deliberately does not
// re-export it, and a local literal here is what let the judge fall back to a
// model a major version behind the env default.
import { DEFAULT_GEMMA_MODEL } from '@privacy-gateway/common/config';
import type { LeakJudgeContext } from './pipeline.ts';

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
    // maxOutputTokens: the verdict object is tiny; the cap exists so a
    // confused judge can never pin a GPU slot with runaway generation.
    generateContentConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024 },
    tools: [],
  });
}

/**
 * How much of the masked prompt travels with the answer as context.
 *
 * The prompt is PII-free by construction, so the cap is about tokens rather than
 * safety: 2000 characters is far inside the served Gemma's window even alongside the
 * answer and this instruction, and the opening of a request carries the task
 * description that makes the answer legible. A truncated prompt is marked so the
 * model does not read the cut as the request ending there.
 */
export const JUDGE_PROMPT_CONTEXT_LIMIT = 2000;

const JUDGE_PROMPT = `You are a privacy auditor reviewing one exchange from a
privacy-preserving gateway. Answer with JSON only:
{"leak": true|false, "categories": [...]}.

## What you are looking at

Personal data was removed from this exchange BEFORE it reached you and replaced with
neutral markers like [masked email], [masked person] or [masked credit card]. Those
markers are the system working correctly. They are not personal data, and the real
values behind them are not available to you or to the model that wrote the answer.

You are shown the request for context and the answer to judge. Judge the ANSWER.

## The rule

Report leak=true ONLY when an actual value appears in the answer — a real email
address, phone number, credit card number, API key, postal address, or a specific
person's name written out. Something a person could copy and use.

Report leak=false for everything else. In particular:
- A [masked ...] marker is never a leak, however many appear.
- Discussing the topic — a customer, a failed charge, an account — is never a leak.
- Referring to "the customer" or "their email address" without stating a value is
  never a leak.
- A sentence that reads as though a value belongs there is not a leak unless the
  value is actually present.

If you report leak=true, name the categories in \`categories\` (EMAIL, PHONE,
CREDIT_CARD, API_KEY, ADDRESS, PERSON). An empty \`categories\` list alongside
leak=true means you found nothing specific, which means the answer is leak=false.

## Examples

Answer: "Dear [masked person], we have logged the failed charge on card
[masked credit card] and will write to [masked email]."
→ {"leak": false, "categories": []}
Every value is a marker; the system masked them all.

Answer: "Dear Taro Yamada, we have logged the charge. Contact us at
support@example.com or call 090-1234-5678."
→ {"leak": true, "categories": ["PERSON", "EMAIL", "PHONE"]}
Real values are written out in full.`;

export interface JudgeOptions {
  readonly baseUrl?: string | undefined;
  readonly model?: string | undefined;
  readonly apiKey?: string | undefined;
  /** `iam` (Cloud Run ID token) or `none` (static key). Defaults from the scheme. */
  readonly auth?: GemmaAuthMode | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly logger?: Logger | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Called after Gemma answers, whatever the verdict was.
   *
   * Exists so the fleet's warm/cold badge can be fed from the one place that
   * actually proves Gemma is resident. It is a plain callback rather than an
   * activity store because the judge has no business knowing what a Firestore
   * document is; the server wires the two together.
   *
   * Must not throw and must not block — the caller does not await it.
   */
  readonly onReached?: (() => void) | undefined;
}

/**
 * Build the user message: the request for context, then the answer to judge.
 *
 * Both texts pass through `neutralizePlaceholders`, so the "no `⟦…⟧` reaches the
 * judge" guarantee covers the context exactly as it covers the answer. The
 * masked prompt is PII-free by construction — it is the string that crossed the
 * boundary to Core — and the counts are category names only.
 *
 * Exported so a test can assert the shape without a model.
 */
export function buildJudgeMessage(text: string, context?: LeakJudgeContext): string {
  const answer = neutralizePlaceholders(text);
  if (context === undefined) return `## Answer to judge\n\n${answer}`;

  const prompt = neutralizePlaceholders(context.maskedPrompt);
  // Truncated rather than dropped: the opening carries the task description that
  // makes the answer legible, and the tail is rarely what explains it. The marker
  // stops the model reading the cut as the request ending there.
  const isTruncated = prompt.length > JUDGE_PROMPT_CONTEXT_LIMIT;
  const shownPrompt = isTruncated
    ? `${prompt.slice(0, JUDGE_PROMPT_CONTEXT_LIMIT)}\n[… request truncated for length …]`
    : prompt;

  const counts = Object.entries(context.maskedCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, count]) => `${category}: ${count}`)
    .join(', ');
  const summary = counts === '' ? 'nothing was masked in this exchange' : counts;

  return `## The request this answers (already masked)

${shownPrompt}

## What was masked out of this exchange

${summary}

## Answer to judge

${answer}`;
}

/**
 * Ask Gemma whether any raw PII remains.
 *
 * Probabilistic, and applied asymmetrically by the pipeline: `leak: true` or an
 * unusable answer blocks the release, `leak: false` adds no trust whatsoever.
 * The deterministic attester remains the only thing that can pass a response.
 *
 * Every well-formed placeholder is replaced with a neutral marker first, so the
 * question the model actually answers is "does this prose contain a real value".
 * Placeholders are not leaks by construction and the attester has already
 * checked them; leaving them in made the judge veto its own masking.
 *
 * Why replace rather than strip, as this did until now: a stripped answer is a
 * sentence with holes in it, and a model asked to audit it infers what the holes
 * held — which is how the judge came to flag nearly every masked answer while
 * naming no category. `[masked email]` says the same thing the gap said, without
 * inviting the inference.
 *
 * The endpoint is called directly rather than through a runner because a single
 * JSON classification needs no session, no tools and no event stream.
 */
export function createLeakJudge(
  options: JudgeOptions = {},
): (
  text: string,
  signal?: AbortSignal,
  context?: LeakJudgeContext,
) => Promise<{ leak: boolean | null; categories?: readonly string[] }> {
  const baseUrl = (
    options.baseUrl ??
    process.env['GEMMA_BASE_URL'] ??
    'http://localhost:11434/v1'
  ).replace(/\/+$/u, '');
  const model = options.model ?? process.env['GEMMA_MODEL'] ?? DEFAULT_GEMMA_MODEL;
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

  return async (text: string, signal?: AbortSignal, context?: LeakJudgeContext) => {
    // Placeholders are neutralized here, at the one place that talks to the
    // model, rather than at the call site: the guarantee is "the judge never
    // sees a placeholder", and a guarantee enforced at the boundary cannot be
    // lost by a future second caller that forgets to apply it.
    const userMessage = buildJudgeMessage(text, context);

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
            { role: 'user', content: userMessage },
          ],
          // A grammar, not just JSON mode: the verdict is generated inside this
          // schema, so a judge drifting into prose or an unexpected shape is
          // unrepresentable instead of being mapped to `leak: null` after the
          // fact. The zod parse downstream still decides acceptance.
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'verdict',
              schema: {
                type: 'object',
                properties: {
                  leak: { type: 'boolean' },
                  // Bounded so a drifting judge cannot spend its budget
                  // enumerating; anything past the known category names is
                  // dropped by the zod filter downstream anyway.
                  categories: {
                    type: 'array',
                    maxItems: 16,
                    items: { type: 'string', maxLength: 64 },
                  },
                },
                required: ['leak'],
                additionalProperties: false,
              },
              strict: true,
            },
          },
          // Deterministic generation. The verdict can block a release, so the
          // same body must not pass on one call and block on the next.
          temperature: 0,
          top_p: 1,
          // Gemma 4 thinks by default and a hard text can absorb the whole
          // budget in deliberation, leaving no verdict at all; the judge's job
          // is a schema-constrained yes/no, not an essay. `think: false` is the
          // native-API switch and is ignored on this OpenAI-compatible surface.
          reasoning_effort: 'none',
          // The verdict object is tiny; the cap exists so a confused judge can
          // never pin a GPU slot with runaway generation.
          max_tokens: 1024,
          stream: false,
        }),
        signal: controller.signal,
      });

      // Gemma answered, so it is demonstrably resident. Recorded before the body
      // is read and regardless of the verdict: a non-200 from a running service
      // still proves the GPU is up, which is the only thing this signal claims.
      options.onReached?.();

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

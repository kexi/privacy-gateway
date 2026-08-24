/**
 * Synthesis Agent: the verification and rehydration agent, running on Gemma.
 *
 * The A2A surface exists so the fleet is uniformly discoverable, but the actual
 * verification is done by the deterministic pipeline. The LLM is never allowed
 * to compose the answer prose: the rehydrated document is a signed audit
 * artifact, and an LLM rewording it would invalidate the attestation it carries.
 */

import { LlmAgent } from '@google/adk';
import {
  LeakJudgeSchema,
  ollamaModelId,
  registerOllamaLlm,
  type Logger,
} from '@privacy-gateway/common';

export const SYNTHESIS_AGENT_NAME = 'synthesis_agent';

export const INSTRUCTION = `You are the Synthesis Agent of a privacy-preserving gateway.

You receive a JSON object describing one gateway exchange. Report on it and nothing
else. You do not rewrite, summarize, translate or comment on any answer text you are
shown: the document assembled around it is a signed audit artifact, and altering it
would invalidate the attestation it carries.

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
    description:
      'Verifies a tokenized answer for leaks, rehydrates it from the token vault ' +
      'and packages it as an attested OKF document.',
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
  readonly fetchImpl?: typeof fetch | undefined;
  readonly logger?: Logger | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Ask Gemma whether any raw PII remains.
 *
 * Advisory only: it never decides pass or fail — the deterministic attester is
 * the sole judge. Used for logging and UI display.
 *
 * The endpoint is called directly rather than through a runner because a single
 * JSON classification needs no session, no tools and no event stream.
 */
export function createLeakJudge(
  options: JudgeOptions = {},
): (text: string) => Promise<{ leak: boolean | null; categories?: string[] }> {
  const baseUrl = (
    options.baseUrl ??
    process.env['GEMMA_BASE_URL'] ??
    'http://localhost:11434/v1'
  ).replace(/\/+$/u, '');
  const model = options.model ?? process.env['GEMMA_MODEL'] ?? 'gemma3:12b';
  const apiKey = options.apiKey ?? process.env['GEMMA_API_KEY'] ?? 'ollama';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return async (text: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? 60_000);

    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: JUDGE_PROMPT },
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_object' },
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
  categories?: string[];
  raw?: string;
} {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { leak: null, raw };

  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { leak: null, raw };
  }

  const parsed = LeakJudgeSchema.safeParse(payload);
  if (!parsed.success) return { leak: null, raw };
  return { leak: parsed.data.leak, categories: parsed.data.categories };
}

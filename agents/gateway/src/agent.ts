/**
 * The Gateway's Gemma agent: extraction of unstructured PII spans.
 *
 * Regular expressions only catch structured identifiers (emails, card numbers,
 * API keys and the like), so free-text entities such as personal names and
 * addresses are extracted here by Gemma. Gemma runs inside the boundary
 * (self-hosted), so this call does not let any raw PII out.
 */

import { InMemoryRunner, LlmAgent } from '@google/adk';
import {
  ollamaModelId,
  OllamaLlm,
  registerOllamaLlm,
  SpanExtractionSchema,
  type Detection,
  type Logger,
  type Span,
} from '@privacy-gateway/common';

/**
 * The categories Gemma is asked to return.
 *
 * Categories already covered by the regexes are excluded: duplicating them would
 * only mean the regex always wins span resolution, making the model call
 * pointless.
 */
export const UNSTRUCTURED_CATEGORIES = ['PERSON', 'ADDRESS', 'ORGANIZATION'] as const;

export const INSTRUCTION = `You extract unstructured personal data spans from text so they can be masked.

Return JSON only, in this exact shape:

{"spans": [{"text": "<exact substring>", "category": "PERSON"}]}

Rules:
- \`category\` must be one of: PERSON, ADDRESS, ORGANIZATION.
- \`text\` must be an exact, verbatim substring of the input, copied character for
  character. Do not normalize, trim honorifics, translate or reorder it.
- Extract personal names, postal addresses and employer/organization names.
- Do NOT extract email addresses, phone numbers, card numbers, IP addresses or API keys.
  Those are handled deterministically elsewhere.
- Do NOT extract anything already written between ⟦ and ⟧; those are already masked.
- If there is nothing to extract, return {"spans": []}.
- Output the JSON object and nothing else. No prose, no code fence.`;

export const SPAN_AGENT_NAME = 'gateway_pii_agent';

export interface BuildSpanAgentOptions {
  readonly model?: string | undefined;
  /**
   * Transport override.
   *
   * When supplied, an `OllamaLlm` instance is constructed here instead of being
   * resolved from the registry by name — the registry can only build a model
   * from its id, which leaves no seam for a test to substitute the endpoint.
   */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
}

/**
 * Build the extraction agent.
 *
 * The model is asked for JSON only and given no tools: small open models handle
 * function calling unreliably, and a structured-output contract is something the
 * response can be validated against with zod.
 */
export function buildSpanAgent(options: BuildSpanAgentOptions = {}): LlmAgent {
  registerOllamaLlm();
  const modelId = ollamaModelId(options.model);

  const model =
    options.fetchImpl === undefined && options.baseUrl === undefined
      ? modelId
      : new OllamaLlm({
          model: modelId,
          fetchImpl: options.fetchImpl,
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
        });

  return new LlmAgent({
    name: SPAN_AGENT_NAME,
    description: 'Extracts unstructured PII spans (names, addresses) for masking.',
    model,
    instruction: INSTRUCTION,
    generateContentConfig: { responseMimeType: 'application/json' },
    tools: [],
  });
}

/**
 * Convert the spans Gemma returned into `Detection` records with real offsets.
 *
 * Gemma cannot count start positions reliably, so it is not asked for them; the
 * offsets are located with `indexOf` instead. Every occurrence of a repeated
 * string is captured, and strings absent from the original text are discarded
 * (removing hallucinations).
 */
export function spansToDetections(text: string, spans: readonly Span[]): Detection[] {
  const detections: Detection[] = [];

  for (const span of spans) {
    const value = span.text;
    if (value.trim() === '') continue;

    let start = text.indexOf(value);
    while (start !== -1) {
      detections.push({
        start,
        end: start + value.length,
        category: span.category,
        value,
      });
      start = text.indexOf(value, start + value.length);
    }
  }
  return detections;
}

/**
 * Extract the JSON object from a model response and validate it.
 *
 * The braces are located rather than parsing the whole string because a model
 * asked for JSON still occasionally wraps it in a code fence. Malformed output
 * yields an empty list rather than an exception: the deterministic masking still
 * holds without it.
 */
export function parseSpans(raw: string): Span[] {
  if (raw === '') return [];

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }

  const parsed = SpanExtractionSchema.safeParse(payload);
  if (parsed.success) return parsed.data.spans;

  // A partially valid response still carries usable spans, and dropping them all
  // because one entry named an unknown category would weaken masking for no gain.
  if (payload !== null && typeof payload === 'object' && 'spans' in payload) {
    const raws = (payload as { spans: unknown }).spans;
    if (Array.isArray(raws)) {
      return raws.flatMap((entry) => {
        const single = SpanExtractionSchema.shape.spans.element.safeParse(entry);
        return single.success ? [single.data] : [];
      });
    }
  }
  return [];
}

/** Runs one turn of the agent and returns its final text. */
async function runAgentText(agent: LlmAgent, prompt: string): Promise<string> {
  const runner = new InMemoryRunner({ agent, appName: 'gateway_pii' });
  const chunks: string[] = [];

  for await (const event of runner.runEphemeral({
    userId: 'gateway',
    newMessage: { role: 'user', parts: [{ text: prompt }] },
  })) {
    // Only the final response is taken; intermediate reasoning never leaves the
    // boundary and is not part of the extraction contract.
    if (event.content?.parts === undefined) continue;
    for (const part of event.content.parts) {
      if (typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('').trim();
}

export interface ExtractOptions extends BuildSpanAgentOptions {
  readonly logger?: Logger | undefined;
  /** Injectable so the pipeline can be tested without a model at all. */
  readonly runAgent?: ((prompt: string) => Promise<string>) | undefined;
}

/**
 * Call Gemma to extract unstructured spans.
 *
 * Failures are swallowed rather than raised: the deterministic regex masking
 * still holds when Gemma is down, and degrading gracefully is safer than failing
 * the whole request. The egress guard remains the last line of defense.
 *
 * One retry is attempted on an unusable response, because a single reroll fixes
 * most JSON-mode misses; a second would just add latency to a model that is
 * genuinely not complying.
 */
export async function extractUnstructured(
  text: string,
  options: ExtractOptions = {},
): Promise<Detection[]> {
  const run =
    options.runAgent ?? ((prompt: string) => runAgentText(buildSpanAgent(options), prompt));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await run(text);
      const spans = parseSpans(raw);
      if (spans.length > 0 || raw.includes('"spans"')) {
        return spansToDetections(text, spans);
      }
      options.logger?.event(
        'mask.gemma.unparseable',
        { attempt: attempt + 1 },
        attempt === 0 ? 'INFO' : 'WARNING',
      );
    } catch (error) {
      options.logger?.event(
        'mask.gemma.failed',
        {
          attempt: attempt + 1,
          error_message: error instanceof Error ? error.message : String(error),
        },
        'WARNING',
      );
      // A transport failure will not fix itself on an immediate retry.
      return [];
    }
  }
  return [];
}

/**
 * The OpenAI **Responses API** façade over the ask pipeline.
 *
 * Codex CLI ≥ 0.149 deprecated `chat/completions` for custom providers: a
 * provider declaring `wire_api = "responses"` is called only at `POST
 * /v1/responses`. This module is the second rendering of the same pipeline —
 * `openai_compat.ts` renders it as a `chat.completion`, this one as a
 * `response` — and it runs the identical `runAsk`, so a gate that refuses here
 * refuses there.
 *
 * ## Input mapping
 *
 * The Responses API splits what `chat/completions` put in one list: `instructions`
 * is the system prompt and `input` is the turns. Both are flattened into the
 * single `text` the pipeline masks, `instructions` first, separated by blank
 * lines — the same concatenation the chat surface performs, for the same reason
 * (one masked text, one vault entry, no session).
 *
 * `assistant` turns are dropped exactly as on the chat surface: they are this
 * fleet's own prior output, already rehydrated in the caller's transcript, and
 * feeding them back would push the raw values just unmasked for the caller back
 * across the boundary, where the egress guard would refuse them.
 *
 * Non-message items — `reasoning`, `function_call`, `function_call_output` — are
 * dropped rather than refused. Codex replays them from its own history; none
 * carries text this fleet produced, and refusing a turn for containing the
 * caller's own tool log would break the CLI on its second request.
 *
 * ## Why the stream is one delta
 *
 * Codex hard-codes `stream: true` (`ResponsesApiRequest` in
 * `codex-rs/core/src/client.rs` sets the field to a literal, with no config to
 * turn it off), so SSE is not optional here the way it is on the chat surface.
 * The framing is still a single content delta followed by the terminal events,
 * for the reason the chat SSE gives: every gate is fail-closed and the leak
 * check runs on the *complete* Core answer, so streaming tokens as produced
 * would release text before the verdict that decides whether it may be released
 * at all. A refusal after the caller has rendered half an answer is not a
 * refusal. The pipeline runs to completion, the verdict lands, and only then
 * does the answer go out.
 */

import {
  OPENAI_MODEL_ID,
  OpenAiResponsesRequestSchema,
  RESPONSES_TEXT_PART_TYPES,
  type HighRiskCategory,
  type Logger,
  type OpenAiResponsesInputMessage,
  type OpenAiResponsesObject,
  type PiiCategory,
} from '@privacy-gateway/common';
import type { Response } from 'express';
import type { OpenAiErrorBody } from './openai_compat.ts';
import type { AskResult } from './pipeline.ts';

/** Separator between concatenated turns; a blank line, as a prompt would read. */
const TURN_SEPARATOR = '\n\n';

/** The roles whose content is forwarded. `assistant` is dropped — see the module docstring. */
const FORWARDED_ROLES = new Set(['system', 'developer', 'user']);

/** True when an `input` element is a message rather than a replayed tool/reasoning item. */
function isMessageItem(item: unknown): item is OpenAiResponsesInputMessage {
  if (typeof item !== 'object' || item === null) return false;
  const record = item as Record<string, unknown>;
  // A bare `{role, content}` with no `type` is the common Codex shape, so the
  // absence of `type` means message rather than unknown item.
  const type = record['type'];
  const isTaggedMessage = type === undefined || type === 'message';
  return isTaggedMessage && typeof record['role'] === 'string';
}

/**
 * The distinct non-text part kinds anywhere in the input, sorted.
 *
 * Collected across *every* message including `assistant` turns, for the reason
 * the chat surface gives: "we dropped the turn your image was in" is not a
 * defence against having accepted an image.
 *
 * Exported for the tests: the refusal is part of the documented contract.
 */
export function nonTextInputPartTypes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const kinds = new Set<string>();
  for (const item of input) {
    if (!isMessageItem(item)) continue;
    const { content } = item;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!RESPONSES_TEXT_PART_TYPES.includes(part.type)) kinds.add(part.type);
    }
  }
  return [...kinds].sort();
}

/** One message's content as text. */
function contentToText(content: OpenAiResponsesInputMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => part.text ?? '').join('');
}

/**
 * Flatten `instructions` + `input` into the one text the pipeline masks.
 *
 * Only reached once `nonTextInputPartTypes` has come back empty, so every part
 * here is text and joining them loses nothing.
 *
 * Exported for the tests: this mapping is the contract the endpoint documents,
 * so it is asserted directly rather than inferred from a masked prompt.
 */
export function flattenResponsesInput(
  input: string | readonly unknown[],
  instructions?: string,
): string {
  const turns: string[] = [];
  if (instructions !== undefined && instructions.trim().length > 0) {
    turns.push(instructions.trim());
  }

  if (typeof input === 'string') {
    turns.push(input.trim());
  } else {
    for (const item of input) {
      if (!isMessageItem(item)) continue;
      if (!FORWARDED_ROLES.has(item.role)) continue;
      turns.push(contentToText(item.content).trim());
    }
  }

  return turns.filter((turn) => turn.length > 0).join(TURN_SEPARATOR);
}

/** Shapes one successful result as a Responses `response` object. */
export function toResponsesObject(
  result: AskResult,
  createdMs: number,
  /** Echoed back so an aware client can confirm the opt-in was understood. */
  rehydrateAllow: readonly HighRiskCategory[] = [],
): OpenAiResponsesObject {
  return {
    // `resp-<request_id>` for the reason `chatcmpl-` carries the id: the request
    // id is the vault key and the evidence key, so a caller holding only a
    // Responses-shaped object can still fetch `/v1/requests/<id>`.
    id: `resp-${result.requestId}`,
    object: 'response',
    created_at: Math.floor(createdMs / 1000),
    status: 'completed',
    model: OPENAI_MODEL_ID,
    output: [
      {
        type: 'message',
        // Codex deserializes this into a `ResponseItem::Message`, whose `id` is
        // optional but whose absence makes the item unaddressable in its
        // history. Deriving it from the request id keeps it stable.
        id: `msg-${result.requestId}`,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: result.answer }],
      },
    ],
    // Zeros, as elsewhere on the compat surface: this fleet bills no tokens.
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    x_privacy_gateway: {
      request_id: result.requestId,
      ...(result.traceId !== undefined ? { trace_id: result.traceId } : {}),
      trust_tier: result.trustTier,
      status: result.status,
      masked_prompt: result.maskedPrompt,
      withheld: [...(result.attestation.withheld ?? [])] as PiiCategory[],
      ...(rehydrateAllow.length > 0 ? { disclosure_requested: [...rehydrateAllow] } : {}),
    },
  };
}

/** Writes one SSE event in the `type:`-tagged form the Responses API uses. */
function writeEvent(res: Response, type: string, payload: Record<string, unknown>): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

/**
 * Emit the response as the SSE sequence Codex's parser accepts.
 *
 * The order is the one `process_responses_event` in
 * `codex-rs/codex-api/src/sse/responses.rs` consumes:
 *
 *   response.created         → `ResponseEvent::Created` (needs a `response`)
 *   response.output_item.added
 *   response.output_text.delta → display only
 *   response.output_item.done  → **the answer**; Codex builds the agent message
 *                                from this item's `output_text`, not from deltas
 *   response.completed         → terminal; a stream without it is recorded as
 *                                "stream closed before response.completed"
 *
 * `output_item.done` is what actually delivers the text: `event_mapping.rs`
 * builds the agent message from the item's content, so a stream carrying only
 * deltas would render live and then leave Codex with an empty turn.
 */
export function writeResponsesSse(res: Response, response: OpenAiResponsesObject): void {
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  const item = response.output[0];
  const text = item?.content[0]?.text ?? '';

  // The privacy facts ride on the first event, so a client that stops reading
  // before the terminal event cannot consume the answer with no trust tier.
  writeEvent(res, 'response.created', {
    response: {
      id: response.id,
      object: 'response',
      created_at: response.created_at,
      status: 'in_progress',
      model: response.model,
      output: [],
      x_privacy_gateway: response.x_privacy_gateway,
    },
  });

  const emptyItem = { ...item, content: [], status: 'in_progress' };
  writeEvent(res, 'response.output_item.added', { output_index: 0, item: emptyItem });
  writeEvent(res, 'response.output_text.delta', {
    item_id: item?.id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  writeEvent(res, 'response.output_item.done', { output_index: 0, item });
  writeEvent(res, 'response.completed', { response });
  res.end();
}

/**
 * Emit a refusal as the SSE `response.failed` Codex maps to an API error.
 *
 * A streaming caller has already received a 200 and its headers by the time a
 * gate refuses, so the refusal cannot be an HTTP status — it has to be a
 * terminal event. `response.failed` is the one Codex turns into an error rather
 * than a turn, which keeps the invariant that a refusal never surfaces as a
 * success. The gateway's own code travels in `error.code`, and the message is
 * the refusal text, which never contains a masked value or an exception message.
 */
export function writeResponsesSseError(
  res: Response,
  body: OpenAiErrorBody,
  requestId: string,
  createdMs: number,
): void {
  if (!res.headersSent) {
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
  }

  writeEvent(res, 'response.failed', {
    response: {
      id: `resp-${requestId}`,
      object: 'response',
      created_at: Math.floor(createdMs / 1000),
      status: 'failed',
      model: OPENAI_MODEL_ID,
      output: [],
      error: {
        code: body.error.code,
        message: body.error.message,
        ...(body.error.categories !== undefined ? { categories: body.error.categories } : {}),
      },
    },
  });
  res.end();
}

/**
 * Parse and validate a Responses request.
 *
 * Returns the flattened text, or an error body the caller should send verbatim.
 */
export function parseResponsesRequest(
  body: unknown,
  requestId: string,
):
  | {
      readonly ok: true;
      readonly text: string;
      readonly stream: boolean;
      readonly rehydrateAllow: readonly HighRiskCategory[];
      readonly maskTerms: readonly string[];
    }
  | { readonly ok: false; readonly status: number; readonly body: OpenAiErrorBody } {
  const parsed = OpenAiResponsesRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: responsesError(
        400,
        'invalid_request',
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
        requestId,
      ),
    };
  }

  // Checked before flattening, so an image is refused rather than dropped on the
  // floor by a flattener that only knows how to read text.
  const nonText = nonTextInputPartTypes(parsed.data.input);
  if (nonText.length > 0) {
    return {
      ok: false,
      status: 400,
      body: responsesError(
        400,
        'multimodal_unsupported',
        `this gateway is text-only; the request carried non-text content part(s) ` +
          `(${nonText.join(', ')}) and nothing was sent. Redaction here is deterministic regex ` +
          `plus a text model, so PII inside an image or an audio clip — a face, a screenshot of ` +
          `a card, a name read aloud — cannot be found, masked or verified. Accepting the part ` +
          `and dropping it would send a prompt you did not write; forwarding it would put ` +
          `unmaskable data across the boundary. Send the content as text.`,
        requestId,
      ),
    };
  }

  const text = flattenResponsesInput(parsed.data.input, parsed.data.instructions);
  if (text.length === 0) {
    return {
      ok: false,
      status: 400,
      body: responsesError(
        400,
        'empty_prompt',
        'input contained no instructions, system or user content to send',
        requestId,
      ),
    };
  }

  return {
    ok: true,
    text,
    // Codex hard-codes `stream: true`; the default stays `false` so a plain
    // HTTP client that omits the field gets a JSON object rather than a stream.
    stream: parsed.data.stream ?? false,
    rehydrateAllow: parsed.data.x_privacy_gateway?.rehydrate_allow ?? [],
    maskTerms: parsed.data.x_privacy_gateway?.mask_terms ?? [],
  };
}

/**
 * The Responses error envelope.
 *
 * Shaped like the chat surface's — same `type` split, same `code`, same refusal
 * text — because the two façades render one classification and must not
 * disagree about whether something was refused.
 */
export function responsesError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  categories?: readonly string[],
): OpenAiErrorBody {
  return {
    error: {
      message,
      type: status >= 500 ? 'api_error' : 'invalid_request_error',
      param: null,
      code,
      ...(categories !== undefined && categories.length > 0 ? { categories: [...categories] } : {}),
      request_id: requestId,
    },
  };
}

/**
 * Logs the shape of a Responses request without any of its text.
 *
 * `forwarded_text_bytes` is what the extractor is actually handed, and
 * `raw_body_bytes` is what arrived. Both are sizes, never content. The pair
 * exists because the capacity narrative used to reason from the raw body — "the
 * CLI sends ~147 KB, so masking it is ~37 Gemma calls" — while this mapping
 * forwards only `instructions` plus the message turns: `tools`, `reasoning`,
 * `include` and the rest are accepted and dropped. Which of the two numbers
 * drives the deadline is a measurable fact, and now it is measured rather than
 * assumed.
 */
export function logResponsesStart(
  logger: Logger,
  stream: boolean,
  sizes: { readonly forwardedTextBytes: number; readonly rawBodyBytes: number },
): void {
  logger.event('openai.compat.responses.start', {
    method: 'POST',
    path: '/v1/responses',
    // Whether the caller asked to stream, as a fact about framing only.
    ok: stream,
    forwarded_text_bytes: sizes.forwardedTextBytes,
    raw_body_bytes: sizes.rawBodyBytes,
  });
}

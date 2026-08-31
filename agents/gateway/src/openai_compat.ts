/**
 * An OpenAI-compatible façade over the ask pipeline.
 *
 * The point is reach: any client that already speaks `chat/completions` — an
 * SDK, a chat UI, an agent framework — can put this fleet behind its `base_url`
 * and get masked-in-transit answers with no code change. It is a *façade*, not a
 * proxy: the request runs the same gates as `/v1/ask`, and a gate that refuses
 * produces an OpenAI-shaped error rather than a degraded completion.
 *
 * ## Message mapping
 *
 * `messages[]` is flattened into the single `text` the pipeline takes: `system`
 * and `user` contents are concatenated in order, separated by a blank line.
 * `assistant` turns are dropped.
 *
 * Why not keep the turns distinct? The pipeline masks one text and stores one
 * vault entry per request; there is no session, by design (a caller who can name
 * a vault key can resolve someone else's placeholders). Multi-turn context is
 * therefore *the caller's concatenation* — they resend the history they want
 * considered, and each request is masked and keyed independently.
 *
 * Why drop `assistant` turns? They are this fleet's own prior output, already
 * rehydrated in the caller's transcript. Feeding them back would push raw values
 * — the very ones just unmasked for the caller — back across the boundary, where
 * the egress guard would refuse them. Dropping them keeps a normal chat loop
 * working instead of failing on the second turn.
 */

import {
  OPENAI_MODEL_ID,
  OpenAiChatCompletionRequestSchema,
  type HighRiskCategory,
  type Logger,
  type OpenAiChatCompletionResponse,
  type OpenAiChatMessage,
  type OpenAiModelList,
  type PiiCategory,
} from '@privacy-gateway/common';
import type { Request, Response } from 'express';
import type { AskResult } from './pipeline.ts';

/** Separator between concatenated turns; a blank line, as a prompt would read. */
const TURN_SEPARATOR = '\n\n';

/**
 * The distinct non-text part kinds anywhere in the message list, sorted.
 *
 * Collected across *every* message including `assistant` turns: the flattener
 * drops those, and "we dropped the turn your image was in" is not a defence
 * against having accepted an image. The caller learns which kinds tripped the
 * refusal — `image_url`, `input_audio` — because "multimodal is unsupported" is
 * not actionable when the client library added the part on the caller's behalf.
 *
 * Empty means every part was text, which is the only shape this fleet forwards.
 */
export function nonTextPartTypes(messages: readonly OpenAiChatMessage[]): string[] {
  const kinds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'text') kinds.add(part.type);
    }
  }
  return [...kinds].sort();
}

/**
 * Flatten an OpenAI message list into the one text the pipeline masks.
 *
 * Only reached once `nonTextPartTypes` has come back empty, so the array form
 * here is an array of text parts and joining them loses nothing.
 *
 * Exported for the tests: the mapping is the contract this endpoint documents,
 * so it is asserted directly rather than inferred from a masked prompt.
 */
export function flattenMessages(messages: readonly OpenAiChatMessage[]): string {
  return messages
    .filter((message) => message.role === 'system' || message.role === 'user')
    .map((message) => contentToText(message.content).trim())
    .filter((content) => content.length > 0)
    .join(TURN_SEPARATOR);
}

/** One message's content as text. `null` is an empty turn, which the caller drops. */
function contentToText(content: OpenAiChatMessage['content']): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? ((part as { text?: string }).text ?? '') : ''))
    .join('');
}

/**
 * `GET /v1/models`: one id, because a caller selects the fleet, not a model.
 * Carries both OpenAI's `data` and Codex's `models` key: Codex ≥0.149 decodes
 * a `models` field and logs a stream error on the OpenAI shape alone, and a
 * superset response satisfies both clients without content negotiation.
 */
export function modelList(now: () => number): OpenAiModelList {
  const entry = {
    id: OPENAI_MODEL_ID,
    object: 'model' as const,
    created: Math.floor(now() / 1000),
    owned_by: OPENAI_MODEL_ID,
  };
  return {
    object: 'list',
    models: [entry],
    data: [entry],
  };
}

/** Shapes one successful result as a `chat.completion`. */
export function toChatCompletion(
  result: AskResult,
  createdMs: number,
  /** Echoed back so an aware client can confirm the opt-in was understood. */
  rehydrateAllow: readonly HighRiskCategory[] = [],
): OpenAiChatCompletionResponse {
  return {
    // `chatcmpl-<request_id>` rather than a fresh id: the request id is the vault
    // key and the evidence key, so a caller holding only an OpenAI-shaped
    // response can still fetch `/v1/requests/<id>` and verify the answer.
    id: `chatcmpl-${result.requestId}`,
    object: 'chat.completion',
    created: Math.floor(createdMs / 1000),
    model: OPENAI_MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.answer },
        finish_reason: 'stop',
      },
    ],
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

/**
 * The OpenAI error envelope.
 *
 * `param` and `code` are populated where they carry meaning so a stock client's
 * error handling has something to branch on; `message` is the gateway's own
 * refusal text, which never contains a masked value or an exception message.
 */
export interface OpenAiErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly param: string | null;
    readonly code: string | null;
    /** The refusal's category list, where the gate produced one. */
    readonly categories?: readonly string[];
    readonly request_id?: string;
  };
}

export function toOpenAiError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  categories?: readonly string[],
): OpenAiErrorBody {
  return {
    error: {
      message,
      // OpenAI's coarse split: 4xx is the caller's to fix, 5xx is ours. A 422
      // from a privacy gate is `invalid_request_error` because the caller *can*
      // act on it — by not sending that content — even though nothing about the
      // syntax was wrong.
      type: status >= 500 ? 'api_error' : 'invalid_request_error',
      param: null,
      code,
      ...(categories !== undefined && categories.length > 0 ? { categories: [...categories] } : {}),
      request_id: requestId,
    },
  };
}

/**
 * Emit the completion as a one-chunk SSE stream.
 *
 * There is exactly one content chunk, then `[DONE]`. This is not a limitation
 * that a later version removes: every gate in this fleet is fail-closed, and the
 * leak check runs on the *complete* Core answer. Streaming tokens as they were
 * produced would mean releasing text across the boundary before the verdict that
 * decides whether it may be released at all — and a refusal after the caller has
 * already rendered half an answer is not a refusal. So the pipeline runs to
 * completion, the verdict lands, and only then does the answer go out; the SSE
 * framing exists so streaming clients work, not to make the answer arrive sooner.
 */
export function writeSseCompletion(res: Response, completion: OpenAiChatCompletionResponse): void {
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  const base = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
  };

  const content = completion.choices[0]?.message.content ?? '';

  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
      // The privacy facts ride on the first chunk: a streaming client that never
      // reads the final chunk would otherwise consume the answer with no tier.
      x_privacy_gateway: completion.x_privacy_gateway,
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Parse and validate a chat request.
 *
 * Returns the flattened text, or an error body the caller should send verbatim.
 */
export function parseChatRequest(
  body: unknown,
  requestId: string,
):
  | {
      readonly ok: true;
      readonly text: string;
      readonly stream: boolean;
      readonly rehydrateAllow: readonly HighRiskCategory[];
      /** Phrases to mask verbatim, from `x_privacy_gateway.mask_terms`. */
      readonly maskTerms: readonly string[];
    }
  | { readonly ok: false; readonly status: number; readonly body: OpenAiErrorBody } {
  const parsed = OpenAiChatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: toOpenAiError(
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
  const nonText = nonTextPartTypes(parsed.data.messages);
  if (nonText.length > 0) {
    return {
      ok: false,
      status: 400,
      body: toOpenAiError(
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

  const text = flattenMessages(parsed.data.messages);
  if (text.length === 0) {
    // Every turn was an assistant turn or blank. Refusing beats masking an empty
    // string and asking Core to answer nothing.
    return {
      ok: false,
      status: 400,
      body: toOpenAiError(
        400,
        'empty_prompt',
        'messages contained no system or user content to send',
        requestId,
      ),
    };
  }

  return {
    ok: true,
    text,
    stream: parsed.data.stream ?? false,
    rehydrateAllow: parsed.data.x_privacy_gateway?.rehydrate_allow ?? [],
    maskTerms: parsed.data.x_privacy_gateway?.mask_terms ?? [],
  };
}

/** Logs the shape of a compat request without any of its text. */
export function logChatStart(logger: Logger, stream: boolean): void {
  logger.event('openai.compat.chat.start', {
    method: 'POST',
    path: '/v1/chat/completions',
    // Whether the caller asked to stream, as a fact about framing only.
    ok: stream,
  });
}

/** Answers `GET /v1/models`. */
export function handleModels(_req: Request, res: Response, now: () => number): void {
  res.json(modelList(now));
}

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
  type Logger,
  type OpenAiChatCompletionResponse,
  type OpenAiModelList,
  type PiiCategory,
} from '@privacy-gateway/common';
import type { Request, Response } from 'express';
import type { AskResult } from './pipeline.ts';

/** Separator between concatenated turns; a blank line, as a prompt would read. */
const TURN_SEPARATOR = '\n\n';

/**
 * Flatten an OpenAI message list into the one text the pipeline masks.
 *
 * Exported for the tests: the mapping is the contract this endpoint documents,
 * so it is asserted directly rather than inferred from a masked prompt.
 */
export function flattenMessages(
  messages: readonly { readonly role: string; readonly content: string }[],
): string {
  return messages
    .filter((message) => message.role === 'system' || message.role === 'user')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join(TURN_SEPARATOR);
}

/** `GET /v1/models`: one id, because a caller selects the fleet, not a model. */
export function modelList(now: () => number): OpenAiModelList {
  return {
    object: 'list',
    data: [
      {
        id: OPENAI_MODEL_ID,
        object: 'model',
        created: Math.floor(now() / 1000),
        owned_by: OPENAI_MODEL_ID,
      },
    ],
  };
}

/** Shapes one successful result as a `chat.completion`. */
export function toChatCompletion(
  result: AskResult,
  createdMs: number,
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
  | { readonly ok: true; readonly text: string; readonly stream: boolean }
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

  return { ok: true, text, stream: parsed.data.stream ?? false };
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

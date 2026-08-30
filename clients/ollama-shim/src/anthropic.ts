/**
 * The Anthropic Messages surface — the one Claude Desktop actually speaks.
 *
 * ## Why this file exists at all
 *
 * The obvious reading of "make privacy-gateway appear in Claude Desktop's model
 * picker, which since Ollama v0.33 lists models from a local Ollama" is that
 * Desktop discovers models over the *native Ollama API* (`/api/tags`), so a shim
 * only needs to answer that. It does not. Ollama v0.33 registers itself as a
 * **third-party gateway provider**, and a Claude third-party gateway serves the
 * **Anthropic Messages API**: `GET /v1/models` for discovery and
 * `POST /v1/messages` for inference. A shim that served only `/api/tags` would
 * be discovered by the `ollama` CLI and never by Claude Desktop.
 *
 * ## The model id is constrained
 *
 * Discovery keeps an entry only when its `id` contains `claude` or `anthropic`,
 * matched case-insensitively; every other entry is dropped. So the id advertised
 * here cannot be the bare `privacy-gateway` the OpenAI surface uses — that
 * string contains neither substring and would be filtered out silently, which is
 * exactly the "0 usable models" symptom operators hit. The id carries the
 * required substring while the display name stays honest about what is behind
 * it. Nothing about the id claims the answer comes from a Claude model: the
 * fleet's Core is Gemini and its Gateway is Gemma, and the display name says
 * "Privacy Gateway".
 *
 * ## Streaming
 *
 * Inference responses must stream — a gateway that buffers stalls the client —
 * so this surface always emits SSE. But it emits the *finished* answer as one
 * `text_delta`: the fleet's leak check runs on the complete Core answer, and
 * streaming tokens as produced would release text before the verdict deciding
 * whether it may be released. A refusal after the client has rendered half an
 * answer is not a refusal. The framing exists so the client works, not to make
 * the answer arrive sooner.
 */

import { z } from 'zod';
import { GATEWAY_MODEL_ID, refusalText, type GatewayResult } from './gateway.ts';

/**
 * The id Claude Desktop's discovery filter will keep.
 *
 * Why not `privacy-gateway`: discovery drops any id lacking `claude` or
 * `anthropic`. This is a routing key for the picker, not a claim about the model.
 */
export const ANTHROPIC_MODEL_ID = 'claude-privacy-gateway';

/** What the picker shows. Names the fleet, not a Claude model. */
export const ANTHROPIC_DISPLAY_NAME = 'Privacy Gateway (masked → Gemini)';

/** Content blocks: text is used; everything else is described, not decoded. */
const ContentBlockSchema = z
  .object({ type: z.string(), text: z.string().optional() })
  .passthrough();

const MessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

export const MessagesRequestSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(MessageSchema),
    system: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
    stream: z.boolean().optional(),
    max_tokens: z.number().optional(),
  })
  .passthrough();

export type MessagesRequest = z.infer<typeof MessagesRequestSchema>;

/**
 * The distinct non-text block kinds in a Messages request, sorted.
 *
 * Claude Desktop attaches images as `image` blocks, so this shim is the surface
 * most likely to be handed one. The gateway behind it masks text with regexes
 * and a text model and cannot redact a face, a whiteboard or a screenshot of a
 * card, so an image must be refused rather than dropped: dropping it sends a
 * prompt the user did not write, and forwarding it would put unmaskable data
 * across the boundary. Non-`user` turns are inspected too, because "we ignore
 * assistant turns" is not a reason to have accepted the attachment.
 */
export function nonTextBlockTypes(request: MessagesRequest): string[] {
  const kinds = new Set<string>();

  const collect = (content: MessagesRequest['messages'][number]['content']): void => {
    if (typeof content === 'string') return;
    for (const block of content) {
      if (block.type !== 'text') kinds.add(block.type);
    }
  };

  if (request.system !== undefined) collect(request.system);
  for (const message of request.messages) collect(message.content);

  return [...kinds].sort();
}

/** Flatten one message's content to text, dropping non-text blocks. */
function blocksToText(content: string | readonly z.infer<typeof ContentBlockSchema>[]): string {
  if (typeof content === 'string') return content.trim();
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text ?? '').trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/**
 * Flatten a Messages request into the single text the pipeline masks.
 *
 * `system` first, then `user` turns in order. `assistant` turns are dropped for
 * the same reason the OpenAI façade drops them: they are the fleet's own prior
 * output, already rehydrated in the caller's transcript, and feeding them back
 * would push raw values at the boundary the egress guard exists to hold.
 * Multi-turn context is therefore the caller's concatenation — each request is
 * masked and vault-keyed independently, because there are no sessions.
 */
export function flattenMessagesRequest(request: MessagesRequest): string {
  const parts: string[] = [];

  if (request.system !== undefined) {
    const system = blocksToText(request.system);
    if (system.length > 0) parts.push(system);
  }

  for (const message of request.messages) {
    if (message.role !== 'user') continue;
    const text = blocksToText(message.content);
    if (text.length > 0) parts.push(text);
  }

  return parts.join('\n\n');
}

/** `GET /v1/models`: the `data` array Claude Desktop's discovery reads. */
export function anthropicModelList(): {
  readonly data: readonly {
    readonly id: string;
    readonly display_name: string;
    readonly type: string;
    readonly created_at: string;
  }[];
  readonly has_more: boolean;
} {
  return {
    data: [
      {
        id: ANTHROPIC_MODEL_ID,
        display_name: ANTHROPIC_DISPLAY_NAME,
        type: 'model',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    has_more: false,
  };
}

/** A non-streaming `message` response. */
export function toMessagesResponse(
  content: string,
  requestId: string,
  stopReason: string,
): Record<string, unknown> {
  return {
    id: `msg_${requestId.replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: ANTHROPIC_MODEL_ID,
    content: [{ type: 'text', text: content }],
    stop_reason: stopReason,
    stop_sequence: null,
    // Token accounting is the fleet's, not the shim's. Reporting zeros is the
    // honest stub: inventing plausible counts would put fabricated numbers into
    // whatever cost tracker consumes them.
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** Anthropic's error envelope, with the shim's own refusal text. */
export function toAnthropicError(message: string, type: string): Record<string, unknown> {
  return { type: 'error', error: { type, message } };
}

/** Maps an upstream HTTP status onto the Anthropic error `type` vocabulary. */
export function anthropicErrorType(status: number): string {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 422) return 'invalid_request_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 504) return 'timeout_error';
  return 'api_error';
}

/** One SSE frame: the event name appears in both the header and the payload. */
function sseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/**
 * The SSE event sequence for one finished answer.
 *
 * Returned as an array rather than written directly so the framing can be
 * asserted in a test without a socket.
 */
export function messagesSseEvents(
  content: string,
  requestId: string,
  stopReason: string,
): string[] {
  const message = toMessagesResponse(content, requestId, stopReason);
  const start = { ...message, content: [], stop_reason: null };

  return [
    sseEvent('message_start', { message: start }),
    sseEvent('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: content },
    }),
    sseEvent('content_block_stop', { index: 0 }),
    sseEvent('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
    sseEvent('message_stop', {}),
  ];
}

/**
 * Render a gateway result as the text a Claude Desktop user will read.
 *
 * A refusal becomes assistant text on the streaming path only when the caller
 * has already been handed a 200 — see `server.ts`, which sends refusals as HTTP
 * errors wherever it still can.
 */
export function resultToText(result: GatewayResult): string {
  return result.ok ? result.content : refusalText(result);
}

/** The upstream model id this shim always sends, regardless of what was asked. */
export const UPSTREAM_MODEL_ID = GATEWAY_MODEL_ID;

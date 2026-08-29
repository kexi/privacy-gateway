/**
 * The native Ollama surface.
 *
 * This is what the `ollama` CLI, and the large ecosystem of tools that hardcode
 * `localhost:11434`, actually speak. It is *not* what Claude Desktop speaks —
 * see `anthropic.ts` for that — but it is what makes the shim usable from any
 * Ollama-shaped client without one of them needing to know the fleet exists.
 *
 * Metadata is fabricated where Ollama's schema demands a field the fleet has no
 * answer for. It is fabricated *honestly*: `parameter_size` is `"n/a"` rather
 * than a plausible number, because the thing behind this endpoint is a
 * three-agent fleet, not a model with a parameter count. A client that displays
 * it shows something true.
 */

import { z } from 'zod';
import { refusalText, type GatewayResult } from './gateway.ts';

/** The model name Ollama clients select. */
export const OLLAMA_MODEL_NAME = 'privacy-gateway:latest';

/** Fixed digest: the fleet is versioned by deploy, not by weights. */
const FAKE_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

const MODIFIED_AT = '2026-01-01T00:00:00Z';

const MODEL_DETAILS = {
  parent_model: '',
  format: 'gguf',
  family: 'privacy-gateway',
  families: ['privacy-gateway'],
  // Not a number: what answers here is a fleet, so any figure would be fiction.
  parameter_size: 'n/a',
  quantization_level: 'n/a',
} as const;

/** `GET /api/tags`: exactly one model, because a caller selects the fleet. */
export function tagsResponse(): Record<string, unknown> {
  return {
    models: [
      {
        name: OLLAMA_MODEL_NAME,
        model: OLLAMA_MODEL_NAME,
        modified_at: MODIFIED_AT,
        size: 0,
        digest: FAKE_DIGEST,
        details: MODEL_DETAILS,
      },
    ],
  };
}

/** `POST /api/show`: the metadata a client reads before selecting a model. */
export function showResponse(): Record<string, unknown> {
  return {
    license: 'See the privacy-gateway repository.',
    modelfile: `# Privacy-Preserving Gateway shim\nFROM ${OLLAMA_MODEL_NAME}\n`,
    parameters: '',
    template: '{{ .Prompt }}',
    details: MODEL_DETAILS,
    model_info: {
      'general.architecture': 'privacy-gateway',
      'general.parameter_count': 0,
    },
    capabilities: ['completion'],
    modified_at: MODIFIED_AT,
  };
}

const OllamaMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
});

export const OllamaChatRequestSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(OllamaMessageSchema),
    stream: z.boolean().optional(),
  })
  .passthrough();

export const OllamaGenerateRequestSchema = z
  .object({
    model: z.string().optional(),
    prompt: z.string(),
    system: z.string().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

export type OllamaChatRequest = z.infer<typeof OllamaChatRequestSchema>;
export type OllamaGenerateRequest = z.infer<typeof OllamaGenerateRequestSchema>;

/**
 * Flatten Ollama messages into the single text the pipeline masks.
 *
 * `system` and `user` in order; `assistant` dropped — the fleet's own prior
 * output, which fed back would push raw values at the egress boundary.
 */
export function flattenOllamaMessages(request: OllamaChatRequest): string {
  return request.messages
    .filter((message) => message.role === 'system' || message.role === 'user')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join('\n\n');
}

/** Flatten a `/api/generate` request the same way. */
export function flattenGenerateRequest(request: OllamaGenerateRequest): string {
  const parts = [request.system?.trim() ?? '', request.prompt.trim()];
  return parts.filter((part) => part.length > 0).join('\n\n');
}

/** One non-streaming `/api/chat` response. */
export function chatResponse(content: string, done: boolean): Record<string, unknown> {
  return {
    model: OLLAMA_MODEL_NAME,
    created_at: new Date(0).toISOString(),
    message: { role: 'assistant', content },
    done,
    done_reason: done ? 'stop' : undefined,
  };
}

/**
 * The NDJSON frames for a streamed `/api/chat`.
 *
 * Ollama streams newline-delimited JSON objects rather than SSE. As with every
 * other surface here there is exactly one content frame followed by a terminal
 * frame: the leak check runs on the complete answer, so there is nothing to
 * stream incrementally without releasing text before the verdict.
 */
export function chatNdjsonFrames(content: string): string[] {
  const contentFrame = {
    model: OLLAMA_MODEL_NAME,
    created_at: new Date(0).toISOString(),
    message: { role: 'assistant', content },
    done: false,
  };
  const finalFrame = {
    model: OLLAMA_MODEL_NAME,
    created_at: new Date(0).toISOString(),
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    total_duration: 0,
    eval_count: 0,
  };
  return [`${JSON.stringify(contentFrame)}\n`, `${JSON.stringify(finalFrame)}\n`];
}

/** The NDJSON frames for a streamed `/api/generate`. */
export function generateNdjsonFrames(content: string): string[] {
  const contentFrame = {
    model: OLLAMA_MODEL_NAME,
    created_at: new Date(0).toISOString(),
    response: content,
    done: false,
  };
  const finalFrame = {
    model: OLLAMA_MODEL_NAME,
    created_at: new Date(0).toISOString(),
    response: '',
    done: true,
    done_reason: 'stop',
    total_duration: 0,
    eval_count: 0,
  };
  return [`${JSON.stringify(contentFrame)}\n`, `${JSON.stringify(finalFrame)}\n`];
}

/** One non-streaming `/api/generate` response. */
export function generateResponse(content: string): Record<string, unknown> {
  return {
    model: OLLAMA_MODEL_NAME,
    created_at: new Date(0).toISOString(),
    response: content,
    done: true,
    done_reason: 'stop',
  };
}

/**
 * Ollama's error shape: `{"error": "..."}`.
 *
 * The refusal keeps its category findings and the do-not-retry notice, so a
 * model reading the error sees why it was refused and that retrying is not the
 * remedy.
 */
export function ollamaError(message: string): Record<string, unknown> {
  return { error: message };
}

/** Render a gateway result as the text an Ollama client will read. */
export function resultToOllamaText(result: GatewayResult): string {
  return result.ok ? result.content : refusalText(result);
}

/**
 * Gemma through Ollama's OpenAI-compatible API, as an ADK `BaseLlm`.
 *
 * Gemma runs inside the trust boundary — locally under Ollama during
 * development, on Cloud Run GPU in production — and both speak
 * `/v1/chat/completions`. Talking to that endpoint directly, rather than through
 * a provider-abstraction layer, keeps the request shape visible at the one place
 * where a stray field could change what leaves the boundary.
 *
 * The Gateway and Synthesis agents only ever ask Gemma for JSON objects, never
 * for tool calls, so this implementation deliberately supports system
 * instructions, streaming and JSON mode, and nothing else. Function calling is
 * left unimplemented because relying on it would make the fleet depend on a
 * capability small open models handle unreliably.
 */

import {
  BaseLlm,
  LLMRegistry,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import type { Content, Part } from '@google/genai';
import { DEFAULT_GEMMA_MODEL, gemmaAuthMode, type GemmaAuthMode } from './config.ts';
import { authorizedHeaders } from './http_client.ts';

/** Model names this class claims in the registry, e.g. `ollama/<gemma tag>`. */
const SUPPORTED_MODEL_PATTERN = /^ollama\/.*/u;

/** Prefix stripped before the name is sent to Ollama. */
const MODEL_PREFIX = 'ollama/';

// Re-exported from `config`, never redeclared: a second literal here is how the
// adapter drifted a major model version behind the env default once already.
export { DEFAULT_GEMMA_MODEL };
export const DEFAULT_GEMMA_BASE_URL = 'http://localhost:11434/v1';

/** One message in the OpenAI chat format. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionChoice {
  message?: { content?: string | null };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

interface ChatCompletionPayload {
  choices?: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OllamaLlmOptions {
  readonly model: string;
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  /**
   * `iam` to send a Google ID token, `none` to send the static key. Defaults to
   * the scheme-derived value (https => iam), see `gemmaAuthMode`.
   */
  readonly auth?: GemmaAuthMode | undefined;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * ADK model adapter for an OpenAI-compatible Ollama endpoint.
 *
 * Registered for the `ollama/` prefix, so an `LlmAgent` can be given
 * `model: ollamaModelId(DEFAULT_GEMMA_MODEL)` and the registry resolves it.
 */
export class OllamaLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [SUPPORTED_MODEL_PATTERN];

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly auth: GemmaAuthMode;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OllamaLlmOptions | { model: string }) {
    super({ model: options.model });
    const opts = options as OllamaLlmOptions;

    this.baseUrl = (
      opts.baseUrl ??
      process.env['GEMMA_BASE_URL'] ??
      DEFAULT_GEMMA_BASE_URL
    ).replace(/\/+$/u, '');
    // Ollama ignores the key but the OpenAI wire format requires one. On Cloud
    // Run this static value is NOT a credential: the service is IAM-protected,
    // so `auth: 'iam'` replaces it with a Google-signed ID token.
    this.apiKey = opts.apiKey ?? process.env['GEMMA_API_KEY'] ?? 'ollama';
    this.auth = gemmaAuthMode(
      this.baseUrl,
      opts.auth ?? (process.env['GEMMA_AUTH'] as GemmaAuthMode | undefined),
    );
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** The name Ollama knows, with the registry prefix removed. */
  private get remoteModel(): string {
    return this.model.startsWith(MODEL_PREFIX) ? this.model.slice(MODEL_PREFIX.length) : this.model;
  }

  /**
   * Send one completion request.
   *
   * Yields a single response when `stream` is false, and a sequence of partial
   * responses followed by one aggregated final response when it is true — the
   * contract ADK's runner expects from a streaming model.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const messages = toChatMessages(llmRequest);
    const body: Record<string, unknown> = {
      model: this.remoteModel,
      messages,
      stream,
    };

    // Thinking is disabled unconditionally. Gemma 4 is a reasoning model, and on
    // tool-schema-dense chunks it deliberated for the entire output budget —
    // 4096 tokens of thinking, an empty content field, and a refused request —
    // while the JSON grammar sat idle, because a grammar constrains content and
    // never thinking. Every call this class makes is a deterministic JSON task
    // (span extraction, leak judging); none of them wants deliberation. Why
    // `reasoning_effort` and not `think: false`: the latter is the native
    // /api/chat switch and is ignored on the OpenAI-compatible surface this
    // class speaks (measured: think:false ran away for 15k thinking chars,
    // reasoning_effort:"none" answered in 3 s).
    body['reasoning_effort'] = 'none';

    const temperature = llmRequest.config?.temperature;
    if (temperature !== undefined) body['temperature'] = temperature;
    const maxTokens = llmRequest.config?.maxOutputTokens;
    if (maxTokens !== undefined) body['max_tokens'] = maxTokens;

    // JSON mode. Gemma is only ever asked for structured output, so honouring
    // this is what makes the zod parse on the other side reliable.
    //
    // When the agent also carries a plain JSON Schema, the generation is
    // constrained to it grammar-level (Ollama structured outputs). `json_object`
    // alone only promises syntactic JSON: on tool-schema-dense Codex chunks the
    // model still generated thousands of tokens of non-conforming output and
    // exhausted its budget — a schema makes that output unrepresentable rather
    // than merely discouraged.
    if (wantsJson(llmRequest)) {
      const schema = llmRequest.config?.responseJsonSchema;
      body['response_format'] =
        schema === undefined
          ? { type: 'json_object' }
          : { type: 'json_schema', json_schema: { name: 'response', schema, strict: true } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    abortSignal?.addEventListener('abort', () => {
      controller.abort();
    });

    try {
      const url = `${this.baseUrl}/chat/completions`;
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: await this.authHeaders(url),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await safeText(response);
        yield {
          errorCode: String(response.status),
          errorMessage: `ollama request failed: ${response.status} ${detail}`.trim(),
        };
        return;
      }

      if (!stream) {
        const payload = (await response.json()) as ChatCompletionPayload;
        yield toLlmResponse(textOf(payload), payload, this.remoteModel);
        return;
      }

      yield* this.streamResponses(response);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Request headers, with the credential the target actually checks.
   *
   * `iam` fails closed: `authorizedHeaders` throws `IdTokenError` rather than
   * sending a request Cloud Run is certain to reject with an opaque 403.
   */
  private async authHeaders(url: string): Promise<Record<string, string>> {
    const base = { 'content-type': 'application/json' };
    if (this.auth === 'iam') {
      return authorizedHeaders(url, { headers: base, useIdToken: true });
    }
    return { ...base, authorization: `Bearer ${this.apiKey}` };
  }

  /** Parse an SSE stream into partial responses plus one aggregate. */
  private async *streamResponses(response: Response): AsyncGenerator<LlmResponse, void> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      yield { errorCode: 'no_body', errorMessage: 'ollama returned no response body' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let aggregate = '';
    let usage: ChatCompletionPayload['usage'];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; a partial frame stays buffered.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
        if (dataLine === undefined) continue;

        const data = dataLine.slice('data:'.length).trim();
        if (data === '' || data === '[DONE]') continue;

        let chunk: ChatCompletionPayload;
        try {
          chunk = JSON.parse(data) as ChatCompletionPayload;
        } catch {
          // A malformed frame is skipped rather than failing the turn: the
          // aggregate is rebuilt from whatever frames did parse.
          continue;
        }

        if (chunk.usage !== undefined) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta?.content ?? '';
        if (delta === '') continue;

        aggregate += delta;
        yield { content: textContent(delta), partial: true };
      }
    }

    yield toLlmResponse(aggregate, usage === undefined ? {} : { usage }, this.remoteModel, true);
  }

  /**
   * Live bidirectional streaming is not supported.
   *
   * Ollama's OpenAI-compatible surface has no bidi endpoint, and nothing in this
   * fleet needs one — Gemma is called for single-shot JSON extraction and
   * judging. Throwing is better than a silently degraded connection.
   */
  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(
      new Error('OllamaLlm does not support live connections; use generateContentAsync'),
    );
  }
}

/** Build an `LlmResponse` for a completed turn. */
function toLlmResponse(
  text: string,
  payload: Pick<ChatCompletionPayload, 'usage'>,
  model: string,
  turnComplete = false,
): LlmResponse {
  const response: LlmResponse = {
    content: textContent(text),
    modelVersion: model,
  };
  if (turnComplete) response.turnComplete = true;

  const usage = payload.usage;
  if (usage !== undefined) {
    // Each count is assigned only when present: under exactOptionalPropertyTypes
    // an explicit `undefined` is not the same as an absent field.
    const usageMetadata: Record<string, number> = {};
    if (usage.prompt_tokens !== undefined) usageMetadata['promptTokenCount'] = usage.prompt_tokens;
    if (usage.completion_tokens !== undefined) {
      usageMetadata['candidatesTokenCount'] = usage.completion_tokens;
    }
    if (usage.total_tokens !== undefined) usageMetadata['totalTokenCount'] = usage.total_tokens;
    response.usageMetadata = usageMetadata;
  }
  return response;
}

function textContent(text: string): Content {
  return { role: 'model', parts: [{ text }] };
}

function textOf(payload: ChatCompletionPayload): string {
  return payload.choices?.[0]?.message?.content ?? '';
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Whether the request asks for JSON.
 *
 * ADK expresses this either as a response MIME type or as a response schema, and
 * both mean "return a JSON object" to an OpenAI-compatible endpoint.
 */
export function wantsJson(llmRequest: LlmRequest): boolean {
  const config = llmRequest.config;
  if (config === undefined) return false;
  if (config.responseMimeType === 'application/json') return true;
  return config.responseSchema !== undefined || config.responseJsonSchema !== undefined;
}

/**
 * Convert an ADK request into OpenAI chat messages.
 *
 * The system instruction becomes a leading `system` message; ADK's `model` role
 * maps to `assistant`, and every non-text part is dropped because this endpoint
 * handles text only.
 */
export function toChatMessages(llmRequest: LlmRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  const instruction = systemInstructionText(llmRequest);
  if (instruction !== '') messages.push({ role: 'system', content: instruction });

  for (const content of llmRequest.contents) {
    const text = partsToText(content.parts);
    if (text === '') continue;
    messages.push({ role: content.role === 'model' ? 'assistant' : 'user', content: text });
  }

  // The endpoint rejects an empty conversation, and an agent invoked with no
  // user turn is a caller bug worth surfacing as an explicit empty prompt.
  if (messages.every((message) => message.role === 'system')) {
    messages.push({ role: 'user', content: '' });
  }
  return messages;
}

/** ADK allows the system instruction to be a string, a Part, or a Content. */
function systemInstructionText(llmRequest: LlmRequest): string {
  const instruction = llmRequest.config?.systemInstruction;
  if (instruction === undefined || instruction === null) return '';
  if (typeof instruction === 'string') return instruction;
  if (Array.isArray(instruction)) return partsToText(instruction as Part[]);

  const asContent = instruction as Content;
  if (Array.isArray(asContent.parts)) return partsToText(asContent.parts);

  const asPart = instruction as Part;
  return typeof asPart.text === 'string' ? asPart.text : '';
}

function partsToText(parts: readonly Part[] | undefined): string {
  if (parts === undefined) return '';
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

/** The registry key an agent uses for a Gemma model name. */
export function ollamaModelId(
  model: string = process.env['GEMMA_MODEL'] ?? DEFAULT_GEMMA_MODEL,
): string {
  return model.startsWith(MODEL_PREFIX) ? model : `${MODEL_PREFIX}${model}`;
}

let registered = false;

/**
 * Register `OllamaLlm` for `ollama/*` model names.
 *
 * Idempotent so each agent can call it at import time without ordering concerns.
 */
export function registerOllamaLlm(): void {
  if (registered) return;
  LLMRegistry.register(OllamaLlm);
  registered = true;
}

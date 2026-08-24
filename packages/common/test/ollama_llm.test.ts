/**
 * What the Gemma adapter guarantees: the OpenAI-compatible request carries the
 * system instruction and JSON mode, and both streaming and non-streaming
 * responses become well-formed ADK responses.
 */

import { LLMRegistry, type LlmRequest, type LlmResponse } from '@google/adk';
import { describe, expect, it } from 'vitest';
import {
  OllamaLlm,
  ollamaModelId,
  registerOllamaLlm,
  toChatMessages,
  wantsJson,
} from '../src/ollama_llm.ts';

/** Minimal LlmRequest; only the fields this adapter reads are populated. */
function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

/** Records the outgoing request and replies with a fixed completion body. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function completion(text: string) {
  return {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
}

async function collect(generator: AsyncGenerator<LlmResponse, void>): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of generator) responses.push(response);
  return responses;
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('non-streaming generation', () => {
  it('returns the completion text as model content', async () => {
    const { impl } = stubFetch(completion('{"spans": []}'));
    const llm = new OllamaLlm({ model: 'ollama/gemma3:12b', fetchImpl: impl });

    const responses = await collect(llm.generateContentAsync(request()));
    expect(responses).toHaveLength(1);
    expect(responses[0]?.content?.parts?.[0]?.text).toBe('{"spans": []}');
    expect(responses[0]?.content?.role).toBe('model');
  });

  it('reports token usage', async () => {
    const { impl } = stubFetch(completion('ok'));
    const llm = new OllamaLlm({ model: 'ollama/gemma3:12b', fetchImpl: impl });

    const [response] = await collect(llm.generateContentAsync(request()));
    expect(response?.usageMetadata).toMatchObject({
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      totalTokenCount: 14,
    });
  });

  it('strips the registry prefix from the model name it sends', async () => {
    const { impl, calls } = stubFetch(completion('ok'));
    const llm = new OllamaLlm({ model: 'ollama/gemma3:12b', fetchImpl: impl });
    await collect(llm.generateContentAsync(request()));

    expect(bodyOf(calls[0]?.init ?? {})['model']).toBe('gemma3:12b');
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('surfaces an HTTP failure as an error response rather than throwing', async () => {
    const { impl } = stubFetch({ error: 'model not found' }, 404);
    const llm = new OllamaLlm({ model: 'ollama/gemma3:12b', fetchImpl: impl });

    const [response] = await collect(llm.generateContentAsync(request()));
    expect(response?.errorCode).toBe('404');
    expect(response?.errorMessage).toContain('404');
  });
});

describe('JSON mode', () => {
  it('asks for a JSON object when the request sets the JSON MIME type', async () => {
    const { impl, calls } = stubFetch(completion('{}'));
    const llm = new OllamaLlm({ model: 'ollama/gemma3:12b', fetchImpl: impl });

    await collect(
      llm.generateContentAsync(request({ config: { responseMimeType: 'application/json' } })),
    );
    expect(bodyOf(calls[0]?.init ?? {})['response_format']).toEqual({ type: 'json_object' });
  });

  it('omits response_format for a plain text request', async () => {
    const { impl, calls } = stubFetch(completion('hi'));
    const llm = new OllamaLlm({ model: 'ollama/gemma3:12b', fetchImpl: impl });

    await collect(llm.generateContentAsync(request()));
    expect(bodyOf(calls[0]?.init ?? {})['response_format']).toBeUndefined();
  });

  it('detects a response schema as a JSON request', () => {
    expect(wantsJson(request({ config: { responseSchema: { type: 'OBJECT' } } }))).toBe(true);
  });
});

describe('message conversion', () => {
  it('puts the system instruction first', () => {
    const messages = toChatMessages(
      request({ config: { systemInstruction: 'You extract spans.' } }),
    );
    expect(messages[0]).toEqual({ role: 'system', content: 'You extract spans.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('maps the ADK model role to assistant', () => {
    const messages = toChatMessages(
      request({
        contents: [
          { role: 'user', parts: [{ text: 'q' }] },
          { role: 'model', parts: [{ text: 'a' }] },
        ],
      }),
    );
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('accepts a Content-shaped system instruction', () => {
    const messages = toChatMessages(
      request({
        config: { systemInstruction: { role: 'system', parts: [{ text: 'rules' }] } },
      }),
    );
    expect(messages[0]?.content).toBe('rules');
  });

  it('always sends at least one user turn', () => {
    const messages = toChatMessages(
      request({ contents: [], config: { systemInstruction: 'only system' } }),
    );
    expect(messages.some((message) => message.role === 'user')).toBe(true);
  });
});

describe('streaming', () => {
  it('yields partial chunks then one aggregated final response', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const impl = (() =>
      Promise.resolve(
        new Response(frames, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      )) as unknown as typeof fetch;

    const llm = new OllamaLlm({ model: 'ollama/gemma3:12b', fetchImpl: impl });
    const responses = await collect(llm.generateContentAsync(request(), true));

    expect(responses.filter((response) => response.partial === true)).toHaveLength(2);
    const final = responses.at(-1);
    expect(final?.turnComplete).toBe(true);
    expect(final?.content?.parts?.[0]?.text).toBe('Hello');
  });

  it('skips a malformed frame instead of failing the turn', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: {not json\n\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    ].join('');

    const impl = (() =>
      Promise.resolve(new Response(frames, { status: 200 }))) as unknown as typeof fetch;

    const llm = new OllamaLlm({ model: 'ollama/gemma3:12b', fetchImpl: impl });
    const responses = await collect(llm.generateContentAsync(request(), true));
    expect(responses.at(-1)?.content?.parts?.[0]?.text).toBe('AB');
  });
});

describe('registry', () => {
  it('resolves an ollama/ model name to this class', () => {
    registerOllamaLlm();
    expect(LLMRegistry.resolve('ollama/gemma3:12b')).toBe(OllamaLlm);
  });

  it('adds the prefix only when it is missing', () => {
    expect(ollamaModelId('gemma3:12b')).toBe('ollama/gemma3:12b');
    expect(ollamaModelId('ollama/gemma3:12b')).toBe('ollama/gemma3:12b');
  });
});

describe('live connections', () => {
  it('refuses rather than degrading silently', async () => {
    const llm = new OllamaLlm({ model: 'ollama/gemma3:12b' });
    await expect(llm.connect(request())).rejects.toThrow(/does not support live connections/u);
  });
});

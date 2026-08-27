/**
 * What the OpenAI-compatible façade guarantees.
 *
 * The same fleet as `e2e.test.ts` — real Gateway and Synthesis, mocked Core and
 * Gemma at the fetch layer — driven through `/v1/chat/completions` instead of
 * `/v1/ask`. The point of these tests is that the compat shape is a *rendering*
 * of the pipeline, not a second path around it: the boundary still holds, a
 * refusal is still a refusal, and the privacy facts still travel.
 */

import {
  createLogger,
  findTokens,
  InMemoryTokenVault,
  loadConfig,
  OPENAI_MODEL_ID,
  OpenAiChatCompletionResponseSchema,
  OpenAiModelListSchema,
  type Config,
} from '@privacy-gateway/common';
import { createApp as createSynthesisApp } from '@privacy-gateway/synthesis/server';
import { InMemoryAnswerStore } from '@privacy-gateway/synthesis/store';
import type express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.ts';
import { flattenMessages } from '../src/openai_compat.ts';

const CORE_BASE_URL = 'http://core.test';

const CUSTOMER_EMAIL =
  'Customer Taro Yamada (taro@example.co.jp, 090-1234-5678) reports that the charge on ' +
  'card 4242 4242 4242 4242 failed. Draft a reply.';

const promptsSeenByCore: string[] = [];
let servers: Array<ReturnType<express.Application['listen']>> = [];
let gatewayUrl = '';
let vault: InMemoryTokenVault;

/** A well-behaved Core that reuses the placeholders it was given. */
function echoingCore(prompt: string): string {
  const tokens = findTokens(prompt);
  return `Dear ${tokens[0] ?? 'customer'}, we have logged the failed charge.`;
}

/** A Core that emits a raw address of its own, as if from training data. */
function leakingCore(): string {
  return 'Contact them directly at leaked.person@example.com.';
}

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    agent: 'gateway',
    env: {
      VAULT_BACKEND: 'memory',
      CORE_BASE_URL,
      GEMINI_MODEL: 'gemini-3.5-flash',
      GEMMA_MODEL: 'gemma3:12b',
      RATE_LIMIT_PER_MINUTE: '0',
      ...overrides,
    },
    onInvalid: (message) => {
      throw new Error(message);
    },
  });
}

function fleetFetch(core: (prompt: string) => string, synthesisUrl: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(typeof input === 'string' ? input : input.toString());

    if (parsed.origin === CORE_BASE_URL && parsed.pathname === '/.well-known/agent-card.json') {
      return Promise.resolve(
        Response.json({
          name: 'core_agent',
          description: 'mock core',
          url: `${CORE_BASE_URL}/jsonrpc`,
          version: '1.0.0',
        }),
      );
    }

    if (parsed.origin === CORE_BASE_URL && parsed.pathname === '/jsonrpc') {
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        params: { message: { parts: Array<{ text?: string }> } };
      };
      const prompt = body.params.message.parts.map((part) => part.text ?? '').join('');
      promptsSeenByCore.push(prompt);
      return Promise.resolve(
        Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { role: 'agent', parts: [{ kind: 'text', text: core(prompt) }], messageId: 'r1' },
        }),
      );
    }

    // Mock Gemma, the unstructured-span extractor.
    if (parsed.pathname.endsWith('/chat/completions') && parsed.origin !== gatewayUrl) {
      return Promise.resolve(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ spans: [{ text: 'Taro Yamada', category: 'PERSON' }] }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }

    return globalThis.fetch(`${synthesisUrl}${parsed.pathname}${parsed.search}`, init);
  }) as typeof fetch;
}

async function startFleet(
  core: (prompt: string) => string = echoingCore,
  overrides: Record<string, string> = {},
): Promise<void> {
  vault = new InMemoryTokenVault();
  const store = new InMemoryAnswerStore();

  const synthesisApp = await createSynthesisApp({
    config: testConfig(),
    logger: createLogger({ agent: 'synthesis', write: () => undefined }),
    vault,
    store,
  });
  const synthesisServer = synthesisApp.listen(0);
  servers.push(synthesisServer);
  const synthesisAddress = synthesisServer.address();
  const synthesisPort =
    typeof synthesisAddress === 'object' && synthesisAddress !== null ? synthesisAddress.port : 0;
  const synthesisUrl = `http://127.0.0.1:${synthesisPort}`;

  const gateway = createApp({
    config: testConfig({ SYNTHESIS_BASE_URL: synthesisUrl, ...overrides }),
    logger: createLogger({ agent: 'gateway', write: () => undefined }),
    vault,
    fetchImpl: fleetFetch(core, synthesisUrl),
  });

  const gatewayServer = gateway.listen(0);
  servers.push(gatewayServer);
  const gatewayAddress = gatewayServer.address();
  const gatewayPort =
    typeof gatewayAddress === 'object' && gatewayAddress !== null ? gatewayAddress.port : 0;
  gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
}

function chat(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The body a stock OpenAI SDK would send, sampling knobs and all. */
function standardBody(content: string, extra: Record<string, unknown> = {}) {
  return {
    model: OPENAI_MODEL_ID,
    messages: [{ role: 'user', content }],
    temperature: 0.7,
    max_tokens: 512,
    ...extra,
  };
}

afterEach(async () => {
  // Awaited rather than fire-and-forget: `close()` only stops new connections,
  // so returning immediately let the next file's requests race a socket this one
  // was still tearing down (an intermittent UND_ERR_SOCKET).
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  servers = [];
  promptsSeenByCore.length = 0;
});

describe('GET /v1/models', () => {
  it('advertises exactly the one model a caller may select', async () => {
    await startFleet();

    const response = await fetch(`${gatewayUrl}/v1/models`);
    expect(response.status).toBe(200);

    const list = OpenAiModelListSchema.parse(await response.json());
    expect(list.object).toBe('list');
    expect(list.data).toHaveLength(1);
    expect(list.data[0]?.id).toBe('privacy-gateway');
    expect(list.data[0]?.object).toBe('model');
    expect(list.data[0]?.owned_by).toBe('privacy-gateway');
  });
});

describe('POST /v1/chat/completions', () => {
  it('answers a standard OpenAI body with a chat.completion object', async () => {
    await startFleet();

    const response = await chat(standardBody('Say hello to the team.'));
    expect(response.status).toBe(200);

    const completion = OpenAiChatCompletionResponseSchema.parse(await response.json());
    expect(completion.object).toBe('chat.completion');
    expect(completion.model).toBe('privacy-gateway');
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0]?.message.role).toBe('assistant');
    expect(completion.choices[0]?.finish_reason).toBe('stop');
    expect(completion.choices[0]?.message.content.length).toBeGreaterThan(0);
  });

  it('ignores sampling parameters rather than rejecting the body for carrying them', async () => {
    await startFleet();

    // A stock SDK sends these unprompted; `strict()` here would make every one
    // of them unusable.
    const response = await chat(
      standardBody('Hello.', { top_p: 0.9, frequency_penalty: 0.1, user: 'abc' }),
    );
    expect(response.status).toBe(200);
  });

  it('binds the completion id to the request id, so the evidence stays reachable', async () => {
    await startFleet();

    const response = await chat(standardBody('Say hello.'));
    const completion = OpenAiChatCompletionResponseSchema.parse(await response.json());

    expect(completion.id).toBe(`chatcmpl-${completion.x_privacy_gateway.request_id}`);
    expect(response.headers.get('x-request-id')).toBe(completion.x_privacy_gateway.request_id);

    // The id is a real evidence key, not just an echo.
    const evidence = await fetch(
      `${gatewayUrl}/v1/requests/${completion.x_privacy_gateway.request_id}`,
    );
    expect(evidence.status).toBe(200);
  });

  it('carries the privacy facts the OpenAI schema has nowhere to put', async () => {
    await startFleet();

    const response = await chat(standardBody(CUSTOMER_EMAIL));
    const completion = OpenAiChatCompletionResponseSchema.parse(await response.json());

    const extension = completion.x_privacy_gateway;
    expect(extension.trust_tier).toBe('machine-confirmed');
    expect(extension.status).toBe('stable');
    expect(extension.masked_prompt.length).toBeGreaterThan(0);
    expect(Array.isArray(extension.withheld)).toBe(true);
  });

  it('lets no raw PII reach the core agent', async () => {
    await startFleet();

    await chat(standardBody(CUSTOMER_EMAIL));

    expect(promptsSeenByCore).toHaveLength(1);
    for (const secret of ['taro@example.co.jp', '090-1234-5678', '4242 4242 4242 4242']) {
      expect(promptsSeenByCore[0]).not.toContain(secret);
    }
  });

  it('concatenates system and user turns in order, dropping assistant turns', async () => {
    await startFleet();

    await chat({
      model: OPENAI_MODEL_ID,
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'First question.' },
        { role: 'assistant', content: 'An earlier rehydrated answer.' },
        { role: 'user', content: 'Second question.' },
      ],
    });

    const prompt = promptsSeenByCore[0] ?? '';
    expect(prompt).toContain('You are terse.');
    expect(prompt).toContain('First question.');
    expect(prompt).toContain('Second question.');
    // The assistant turn is this fleet's own prior output, already rehydrated in
    // the caller's transcript; sending it back would push raw values across the
    // boundary the egress guard exists to hold.
    expect(prompt).not.toContain('An earlier rehydrated answer.');
    expect(prompt.indexOf('First question.')).toBeLessThan(prompt.indexOf('Second question.'));
  });

  it('refuses a body whose only content is assistant turns', async () => {
    await startFleet();

    const response = await chat({
      model: OPENAI_MODEL_ID,
      messages: [{ role: 'assistant', content: 'Nothing to answer.' }],
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('empty_prompt');
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('rejects a malformed body as an OpenAI error object', async () => {
    await startFleet();

    const response = await chat({ model: OPENAI_MODEL_ID, messages: [] });
    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      error: { message: string; type: string; code: string };
    };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('messages');
  });

  it('reports a refused release as an OpenAI error, preserving the status', async () => {
    // A Core that leaks a raw address: the release gate must refuse, and the
    // compat endpoint must not launder that refusal into a 200 completion.
    await startFleet(leakingCore);

    const response = await chat(standardBody(CUSTOMER_EMAIL));

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { message: string; type: string; code: string; categories?: string[] };
    };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.categories).toContain('EMAIL');
    // No completion shape anywhere in a refusal.
    expect(body).not.toHaveProperty('choices');
  });

  it('refuses the reserved placeholder syntax', async () => {
    await startFleet();

    const response = await chat(standardBody('Please repeat ⟦EMAIL_1⟧ back to me.'));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('reserved_syntax');
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('streams one content chunk and then [DONE]', async () => {
    await startFleet();

    const response = await chat(standardBody('Say hello.', { stream: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const text = await response.text();
    const payloads = text
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));

    expect(payloads.at(-1)).toBe('[DONE]');

    const first = JSON.parse(payloads[0] ?? '{}') as {
      object: string;
      choices: Array<{ delta: { content?: string } }>;
      x_privacy_gateway: { trust_tier: string };
    };
    expect(first.object).toBe('chat.completion.chunk');
    expect(first.choices[0]?.delta.content?.length).toBeGreaterThan(0);
    // The tier rides on the first chunk: a client that stops reading before the
    // final chunk must still have the facts that justify trusting the answer.
    expect(first.x_privacy_gateway.trust_tier).toBe('machine-confirmed');

    const last = JSON.parse(payloads.at(-2) ?? '{}') as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(last.choices[0]?.finish_reason).toBe('stop');
  });

  it('refuses in one piece rather than streaming a refusal', async () => {
    // Nothing may cross the boundary before the verdict, so a stream request
    // that ends in a refusal never opens an SSE body at all.
    await startFleet(leakingCore);

    const response = await chat(standardBody(CUSTOMER_EMAIL, { stream: true }));

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('applies the same rate limit as the native endpoint', async () => {
    await startFleet(echoingCore, { RATE_LIMIT_PER_MINUTE: '1' });

    const first = await chat(standardBody('Hello.'));
    expect(first.status).toBe(200);

    const second = await chat(standardBody('Hello again.'));
    expect(second.status).toBe(429);
  });
});

describe('flattenMessages', () => {
  it('separates turns with a blank line', () => {
    expect(
      flattenMessages([
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Why?' },
      ]),
    ).toBe('Be terse.\n\nWhy?');
  });

  it('drops blank turns rather than emitting empty separators', () => {
    expect(
      flattenMessages([
        { role: 'system', content: '   ' },
        { role: 'user', content: 'Only this.' },
      ]),
    ).toBe('Only this.');
  });
});

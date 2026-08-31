/**
 * What the Responses-API façade guarantees.
 *
 * The same fleet as `openai_compat.test.ts` — real Gateway and Synthesis, mocked
 * Core and Gemma at the fetch layer — driven through `/v1/responses`. The point
 * of these tests is that the Responses shape is a second *rendering* of the
 * pipeline, not a second path around it: the boundary still holds, a refusal is
 * still a refusal, and the SSE framing is the one Codex's parser accepts.
 *
 * The event order asserted here is not a style choice. Codex builds the agent
 * message from `response.output_item.done`, treats `response.output_text.delta`
 * as display only, and records a stream that ends without `response.completed`
 * as a failure — so these assertions are what "Codex works against this
 * gateway" reduces to.
 */

import {
  createLogger,
  findTokens,
  InMemoryTokenVault,
  loadConfig,
  OPENAI_MODEL_ID,
  OpenAiResponsesObjectSchema,
  type Config,
} from '@privacy-gateway/common';
import { createApp as createSynthesisApp } from '@privacy-gateway/synthesis/server';
import { InMemoryAnswerStore } from '@privacy-gateway/synthesis/store';
import type express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { flattenResponsesInput, nonTextInputPartTypes } from '../src/responses_compat.ts';
import { createApp } from '../src/server.ts';

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
      GEMMA_MODEL: 'gemma4:12b',
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

function responses(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${gatewayUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * The body Codex CLI actually sends, tool declarations and knobs included.
 *
 * Mirrors `ResponsesApiRequest` in `codex-rs/core/src/client.rs` so a change
 * that would break the CLI breaks a test instead.
 */
function codexBody(input: unknown, extra: Record<string, unknown> = {}) {
  return {
    model: OPENAI_MODEL_ID,
    instructions: 'You are Codex, a coding agent.',
    input,
    tools: [
      {
        type: 'function',
        name: 'shell',
        description: 'run a command',
        parameters: {},
        strict: false,
      },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort: 'medium', summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'thread-abc',
    ...extra,
  };
}

/** One decoded SSE event. `data` stays loose: each event type has its own shape. */
interface SseEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/** The `item` an `output_item.*` event carries. */
interface OutputItem {
  readonly type: string;
  readonly role: string;
  readonly content: Array<{ type: string; text: string }>;
}

/** The `response` a `created` / `completed` / `failed` event carries. */
interface EventResponse {
  readonly id: string;
  readonly status: string;
  readonly usage?: { total_tokens: number };
  readonly error?: { code: string };
  readonly x_privacy_gateway?: { trust_tier: string };
}

function itemOf(event: SseEvent | undefined): OutputItem {
  return event?.data['item'] as OutputItem;
}

function responseOf(event: SseEvent | undefined): EventResponse {
  return event?.data['response'] as EventResponse;
}

/** Splits an SSE body into decoded events, in wire order. */
async function sseEvents(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split('\n').find((line) => line.startsWith('data: ')) ?? '';
      const data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
      return { type: String(data['type']), data };
    });
}

afterEach(async () => {
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

describe('POST /v1/responses', () => {
  it('answers a non-streaming body with a response object', async () => {
    await startFleet();
    const response = await responses({
      model: OPENAI_MODEL_ID,
      input: CUSTOMER_EMAIL,
    });

    expect(response.status).toBe(200);
    const body = OpenAiResponsesObjectSchema.parse(await response.json());

    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.model).toBe(OPENAI_MODEL_ID);
    expect(body.output[0]?.role).toBe('assistant');
    expect(body.output[0]?.content[0]?.type).toBe('output_text');
    expect(body.output[0]?.content[0]?.text.length).toBeGreaterThan(0);
  });

  it('binds the response id to the request id, so the evidence stays reachable', async () => {
    await startFleet();
    const body = (await (
      await responses({ model: OPENAI_MODEL_ID, input: CUSTOMER_EMAIL })
    ).json()) as {
      id: string;
      x_privacy_gateway: { request_id: string };
    };

    expect(body.id).toBe(`resp-${body.x_privacy_gateway.request_id}`);

    const evidence = await fetch(`${gatewayUrl}/v1/requests/${body.x_privacy_gateway.request_id}`);
    expect(evidence.status).toBe(200);
  });

  it('carries the privacy facts the Responses schema has nowhere to put', async () => {
    await startFleet();
    const body = (await (
      await responses({ model: OPENAI_MODEL_ID, input: CUSTOMER_EMAIL })
    ).json()) as {
      x_privacy_gateway: { trust_tier: string; masked_prompt: string; withheld: string[] };
    };

    expect(body.x_privacy_gateway.trust_tier).toBe('machine-confirmed');
    expect(body.x_privacy_gateway.masked_prompt.length).toBeGreaterThan(0);
    expect(body.x_privacy_gateway.masked_prompt).not.toContain('taro@example.co.jp');
    expect(Array.isArray(body.x_privacy_gateway.withheld)).toBe(true);
  });

  it('lets no raw PII reach the core agent', async () => {
    await startFleet();
    await responses({ model: OPENAI_MODEL_ID, input: CUSTOMER_EMAIL });

    const seen = promptsSeenByCore.join('\n');
    expect(seen).not.toContain('taro@example.co.jp');
    expect(seen).not.toContain('090-1234-5678');
    expect(seen).not.toContain('4242 4242 4242 4242');
  });

  it('ignores the tool declarations and knobs Codex sends, rather than rejecting them', async () => {
    await startFleet();
    // The full Codex body, non-streaming so the assertion reads off JSON.
    const response = await responses(codexBody(CUSTOMER_EMAIL, { stream: false }));

    expect(response.status).toBe(200);
    const body = OpenAiResponsesObjectSchema.parse(await response.json());
    // Honest empty tool behaviour: a text answer, never a fabricated call.
    expect(body.output.every((item) => item.type === 'message')).toBe(true);
  });

  it('prepends instructions to the input turns', async () => {
    await startFleet();
    await responses({
      model: OPENAI_MODEL_ID,
      instructions: 'Answer in one sentence.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: CUSTOMER_EMAIL }] }],
    });

    const seen = promptsSeenByCore.join('\n');
    expect(seen).toContain('Answer in one sentence.');
  });

  it('refuses a body whose only content is assistant turns', async () => {
    await startFleet();
    const response = await responses({
      model: OPENAI_MODEL_ID,
      input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'earlier answer' }] }],
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('empty_prompt');
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('rejects a malformed body as an error object', async () => {
    await startFleet();
    const response = await responses({ model: OPENAI_MODEL_ID });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('reports a refused release as an error, preserving the status', async () => {
    await startFleet(leakingCore);
    const response = await responses({ model: OPENAI_MODEL_ID, input: CUSTOMER_EMAIL });

    // The release gate refused; the façade must not launder that into a 200.
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; categories?: string[] };
    };
    // The leak check found a raw address in the Core answer and refused the
    // release; the code is Synthesis's, not the caller's to fix.
    expect(body.error.code).toBe('leak_check_failed');
    expect(body.error.categories).toContain('EMAIL');
    expect(JSON.stringify(body)).not.toContain('leaked.person@example.com');
  });
});

describe('multimodal content parts over the Responses surface', () => {
  it('refuses an input_image part with multimodal_unsupported and sends nothing', async () => {
    await startFleet();
    const response = await responses({
      model: OPENAI_MODEL_ID,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: CUSTOMER_EMAIL },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('multimodal_unsupported');
    expect(body.error.message).toContain('input_image');
    // Nothing crossed the boundary.
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('accepts an all-text content array unchanged', async () => {
    await startFleet();
    const response = await responses({
      model: OPENAI_MODEL_ID,
      input: [{ role: 'user', content: [{ type: 'input_text', text: CUSTOMER_EMAIL }] }],
    });

    expect(response.status).toBe(200);
  });
});

describe('the Responses SSE framing', () => {
  it('emits the event sequence Codex parses, ending with response.completed', async () => {
    await startFleet();
    const response = await responses(codexBody(CUSTOMER_EMAIL));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = await sseEvents(response);
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  it('delivers the whole answer on output_item.done, which is what Codex reads', async () => {
    await startFleet();
    const events = await sseEvents(await responses(codexBody(CUSTOMER_EMAIL)));

    const item = itemOf(events.find((event) => event.type === 'response.output_item.done'));
    const text = item.content[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(item.type).toBe('message');
    expect(item.role).toBe('assistant');
    expect(item.content[0]?.type).toBe('output_text');

    // The single delta carries the same text: display and history agree.
    const delta = events.find((event) => event.type === 'response.output_text.delta');
    expect(delta?.data['delta']).toBe(text);
  });

  it('gives response.completed the id Codex requires to close the stream', async () => {
    await startFleet();
    const events = await sseEvents(await responses(codexBody(CUSTOMER_EMAIL)));

    const completed = events.at(-1);
    expect(completed?.type).toBe('response.completed');
    // Codex's `ResponseCompleted` struct fails to deserialize without `id`.
    const response = responseOf(completed);
    expect(response.id).toMatch(/^resp-/);
    expect(response.status).toBe('completed');
    expect(response.usage?.total_tokens).toBe(0);
  });

  it('puts the privacy facts on the first event, before any answer text', async () => {
    await startFleet();
    const events = await sseEvents(await responses(codexBody(CUSTOMER_EMAIL)));

    const created = events[0];
    expect(created?.type).toBe('response.created');
    expect(responseOf(created).x_privacy_gateway?.trust_tier).toBe('machine-confirmed');
  });

  it('refuses a stream with response.failed rather than a completed turn', async () => {
    await startFleet(leakingCore);
    const response = await responses(codexBody(CUSTOMER_EMAIL));

    // The stream was already committed to a 200 before the gate refused, so the
    // refusal has to be the terminal event.
    const events = await sseEvents(response);
    expect(events.map((event) => event.type)).toEqual(['response.failed']);

    const failed = responseOf(events[0]);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('leak_check_failed');
    // No completed turn anywhere, and nothing the leaking Core produced.
    expect(JSON.stringify(events)).not.toContain('response.completed');
    expect(JSON.stringify(events)).not.toContain('leaked.person@example.com');
  });
});

describe('flattenResponsesInput', () => {
  it('reads a bare string input as the text it holds', () => {
    expect(flattenResponsesInput('hello')).toBe('hello');
  });

  it('puts instructions ahead of the turns, separated by a blank line', () => {
    expect(flattenResponsesInput([{ role: 'user', content: 'question' }], 'be terse')).toBe(
      'be terse\n\nquestion',
    );
  });

  it('treats a developer turn as a system turn, because Codex sends one', () => {
    expect(
      flattenResponsesInput([
        { role: 'developer', content: 'rules' },
        { role: 'user', content: 'question' },
      ]),
    ).toBe('rules\n\nquestion');
  });

  it('drops assistant turns, as the chat surface does', () => {
    expect(
      flattenResponsesInput([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'output_text', text: 'prior answer' }] },
        { role: 'user', content: 'second' },
      ]),
    ).toBe('first\n\nsecond');
  });

  it('drops replayed reasoning and tool items rather than refusing them', () => {
    expect(
      flattenResponsesInput([
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { role: 'user', content: 'question' },
        { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' },
      ]),
    ).toBe('question');
  });

  it('drops blank turns rather than emitting empty separators', () => {
    expect(
      flattenResponsesInput([
        { role: 'user', content: '  ' },
        { role: 'user', content: 'real' },
      ]),
    ).toBe('real');
  });
});

describe('nonTextInputPartTypes', () => {
  it('finds nothing in a bare string input', () => {
    expect(nonTextInputPartTypes('plain')).toEqual([]);
  });

  it('finds nothing in an all-text content array', () => {
    expect(
      nonTextInputPartTypes([{ role: 'user', content: [{ type: 'input_text', text: 'a' }] }]),
    ).toEqual([]);
  });

  it('names each distinct non-text kind, sorted', () => {
    expect(
      nonTextInputPartTypes([
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'x' },
            { type: 'input_audio', audio_url: 'y' },
            { type: 'input_text', text: 'a' },
          ],
        },
      ]),
    ).toEqual(['input_audio', 'input_image']);
  });

  it('inspects assistant turns too, which the flattener would have dropped', () => {
    expect(
      nonTextInputPartTypes([
        { role: 'assistant', content: [{ type: 'input_image', image_url: 'x' }] },
      ]),
    ).toEqual(['input_image']);
  });
});

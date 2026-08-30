/**
 * What these tests guarantee.
 *
 * The shim is a translation layer, so the guarantees are all about wire shape
 * and about refusals staying refusals:
 *
 * - Discovery advertises exactly one model, under an id Claude Desktop's filter
 *   will actually keep.
 * - A prompt reaches the fleet flattened the way the fleet expects, with
 *   `assistant` turns dropped and `stream: false` upstream.
 * - A refusal is never laundered into a successful answer, on any surface, and
 *   it carries its category findings and the do-not-retry notice.
 * - Streaming framing is well-formed on both surfaces, and still contains the
 *   whole answer in one delta.
 * - No log line can carry prompt text.
 */

import { describe, expect, it } from 'vitest';
import { createHandler, REPORTED_OLLAMA_VERSION } from '../src/server.ts';
import { GatewayClient, NO_RETRY_NOTICE } from '../src/gateway.ts';
import { ANTHROPIC_MODEL_ID } from '../src/anthropic.ts';
import { OLLAMA_MODEL_NAME } from '../src/ollama.ts';
import { createLogger } from '../src/logging.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A fetch stub standing in for the deployed Gateway. */
function stubFetch(
  response: { status: number; body: unknown },
  captured?: { request?: unknown; headers?: Record<string, string> },
): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    if (captured) {
      captured.request = JSON.parse(String(init.body));
      captured.headers = init.headers as Record<string, string>;
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const SUCCESS_BODY = {
  id: 'chatcmpl-01a04ac6',
  model: 'privacy-gateway',
  choices: [{ message: { role: 'assistant', content: 'Masked answer.' }, finish_reason: 'stop' }],
  x_privacy_gateway: {
    request_id: '01a04ac6-38c4-741a-a013-99347f4d4f6b',
    trust_tier: 'machine-verified',
    status: 'released',
    masked_prompt: 'Customer ⟦PERSON_1⟧ (⟦EMAIL_1⟧) reports a failed charge.',
    withheld: [],
  },
};

const REFUSAL_BODY = {
  error: {
    message: 'the answer could not be released because the leak check failed',
    type: 'invalid_request_error',
    code: 'leak_check_failed',
    categories: ['EMAIL', 'PERSON'],
    request_id: '01a04ac6-38c4-741a-a013-99347f4d4f6b',
  },
};

/** Boot the handler on an ephemeral port and return its base URL. */
async function withServer(
  fetchImpl: typeof fetch,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const handler = createHandler({
    gateway: new GatewayClient({ baseUrl: 'http://gateway.test', fetchImpl }),
    // Logs are discarded here; a dedicated test below asserts the allowlist.
    logger: createLogger(() => {}),
    requestId: () => 'test-request-id',
  });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('model discovery', () => {
  it("advertises one Anthropic model whose id survives Claude Desktop's filter", async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const res = await fetch(`${base}/v1/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string; display_name: string }[] };

      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.id).toBe(ANTHROPIC_MODEL_ID);
      // The filter keeps an entry only when the id contains `claude` or
      // `anthropic`; an id lacking both is dropped and the picker shows nothing.
      expect(/claude|anthropic/i.test(body.data[0]?.id ?? '')).toBe(true);
      expect(body.data[0]?.display_name).toContain('Privacy Gateway');
    });
  });

  it('advertises one Ollama model with honest fabricated metadata', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const res = await fetch(`${base}/api/tags`);
      const body = (await res.json()) as {
        models: { name: string; details: { families: string[]; parameter_size: string } }[];
      };

      expect(body.models).toHaveLength(1);
      expect(body.models[0]?.name).toBe(OLLAMA_MODEL_NAME);
      expect(body.models[0]?.details.families).toEqual(['privacy-gateway']);
      // Not a plausible number: a fleet has no parameter count, and inventing
      // one would put fiction on a client's model card.
      expect(body.models[0]?.details.parameter_size).toBe('n/a');
    });
  });

  it('serves /api/show and /api/version', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const show = await fetch(`${base}/api/show`, {
        method: 'POST',
        body: JSON.stringify({ model: OLLAMA_MODEL_NAME }),
      });
      expect(show.status).toBe(200);
      expect((await show.json()) as { details: unknown }).toHaveProperty('details');

      const version = await fetch(`${base}/api/version`);
      expect((await version.json()) as { version: string }).toEqual({
        version: REPORTED_OLLAMA_VERSION,
      });
    });
  });
});

describe('Anthropic Messages surface', () => {
  it('flattens system and user turns, drops assistant turns, and never streams upstream', async () => {
    const captured: { request?: unknown } = {};
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }, captured), async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL_ID,
          system: 'You are terse.',
          messages: [
            { role: 'user', content: 'First question.' },
            { role: 'assistant', content: 'A previous fleet answer.' },
            { role: 'user', content: [{ type: 'text', text: 'Second question.' }] },
          ],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        type: string;
        role: string;
        content: { type: string; text: string }[];
        stop_reason: string;
      };
      expect(body.type).toBe('message');
      expect(body.role).toBe('assistant');
      expect(body.content[0]?.text).toBe('Masked answer.');
      expect(body.stop_reason).toBe('end_turn');

      const sent = captured.request as { messages: { content: string }[]; stream: boolean };
      // stream:false upstream: the leak check runs on the complete answer.
      expect(sent.stream).toBe(false);
      const text = sent.messages[0]?.content ?? '';
      expect(text).toContain('You are terse.');
      expect(text).toContain('First question.');
      expect(text).toContain('Second question.');
      // The fleet's own prior output must not be pushed back at the boundary.
      expect(text).not.toContain('A previous fleet answer.');
    });
  });

  it('emits well-formed SSE carrying the whole answer in one delta', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Question.' }],
          stream: true,
        }),
      });

      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();

      for (const event of [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]) {
        expect(text).toContain(`event: ${event}`);
      }
      // One delta, whole answer: not a stub, but the consequence of the verdict
      // landing before any text is released.
      expect(text.match(/event: content_block_delta/g)).toHaveLength(1);
      expect(text).toContain('Masked answer.');
    });
  });

  it('maps a refusal to an HTTP error carrying categories and the no-retry notice', async () => {
    await withServer(stubFetch({ status: 422, body: REFUSAL_BODY }), async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Question.' }] }),
      });

      // The refusal keeps its status; it is never a 200 whose body is an apology.
      expect(res.status).toBe(422);
      const body = (await res.json()) as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toContain('leak check failed');
      expect(body.error.message).toContain('EMAIL');
      expect(body.error.message).toContain('PERSON');
      expect(body.error.message).toContain(NO_RETRY_NOTICE);
    });
  });

  it('refuses a request with no user or system text rather than masking nothing', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'assistant', content: 'only this' }] }),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe('native Ollama surface', () => {
  it('answers /api/chat with the Ollama message shape', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL_NAME,
          messages: [{ role: 'user', content: 'Question.' }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        model: string;
        message: { role: string; content: string };
        done: boolean;
      };
      expect(body.model).toBe(OLLAMA_MODEL_NAME);
      expect(body.message).toEqual({ role: 'assistant', content: 'Masked answer.' });
      expect(body.done).toBe(true);
    });
  });

  it('streams NDJSON frames, one per line, ending with done:true', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `stream` omitted: Ollama's default is true, so this must stream.
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Question.' }] }),
      });

      expect(res.headers.get('content-type')).toContain('application/x-ndjson');
      const lines = (await res.text()).trim().split('\n');
      expect(lines).toHaveLength(2);

      const frames = lines.map(
        (line) => JSON.parse(line) as { done: boolean; message: { content: string } },
      );
      expect(frames[0]?.done).toBe(false);
      expect(frames[0]?.message.content).toBe('Masked answer.');
      expect(frames[1]?.done).toBe(true);
    });
  });

  it('maps a refusal to an Ollama error with categories and the no-retry notice', async () => {
    await withServer(stubFetch({ status: 422, body: REFUSAL_BODY }), async (base) => {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Question.' }] }),
      });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('leak check failed');
      expect(body.error).toContain('EMAIL');
      expect(body.error).toContain(NO_RETRY_NOTICE);
    });
  });

  it('serves /api/generate, flattening system and prompt', async () => {
    const captured: { request?: unknown } = {};
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }, captured), async (base) => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system: 'Be terse.', prompt: 'Question.', stream: false }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()) as { response: string }).toMatchObject({
        response: 'Masked answer.',
      });
      const sent = captured.request as { messages: { content: string }[] };
      expect(sent.messages[0]?.content).toBe('Be terse.\n\nQuestion.');
    });
  });

  it('streams /api/generate as NDJSON with a `response` field, not a `message`', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `stream` omitted: Ollama's default is true.
        body: JSON.stringify({ prompt: 'Question.' }),
      });

      expect(res.headers.get('content-type')).toContain('application/x-ndjson');
      const lines = (await res.text()).trim().split('\n');
      expect(lines).toHaveLength(2);

      const frames = lines.map((line) => JSON.parse(line) as { done: boolean; response: string });
      // `/api/generate` frames carry `response`, where `/api/chat` carries `message`.
      expect(frames[0]).toMatchObject({ done: false, response: 'Masked answer.' });
      expect(frames[1]).toMatchObject({ done: true, done_reason: 'stop' });
    });
  });

  it('404s an unknown route with an Ollama-shaped error', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const res = await fetch(`${base}/api/nope`);
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toHaveProperty('error');
    });
  });
});

describe('upstream failures fail closed', () => {
  it('treats an uninterpretable success body as a refusal, not an empty answer', async () => {
    await withServer(stubFetch({ status: 200, body: { unexpected: true } }), async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Question.' }] }),
      });
      expect(res.status).toBe(502);
    });
  });

  it('treats an unparseable error body as a refusal that keeps its status', async () => {
    await withServer(stubFetch({ status: 503, body: 'not json shaped' }), async (base) => {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Q.' }] }),
      });
      expect(res.status).toBe(503);
    });
  });
});

describe('logging cannot carry prompt text', () => {
  it('drops an unlisted field and records only its key name', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.event('shim.test', {
      request_id: 'abc',
      // A field no allowlist entry covers — exactly how prompt text would try
      // to reach a log sink.
      prompt: 'Taro Yamada taro@example.co.jp',
    } as never);

    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry['request_id']).toBe('abc');
    expect(entry).not.toHaveProperty('prompt');
    expect(entry['dropped_fields']).toEqual(['prompt']);
    expect(lines[0]).not.toContain('taro@example.co.jp');
  });

  it('logs an error class and code but never the exception message', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.event(
      'shim.request.error',
      { error_class: 'TypeError', error_code: 'unhandled' },
      'ERROR',
    );

    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry['error_class']).toBe('TypeError');
    expect(entry['error_code']).toBe('unhandled');
    expect(entry['severity']).toBe('ERROR');
  });
});

describe('the shim is text-only', () => {
  it('refuses an image block instead of dropping it', async () => {
    const captured: { request?: unknown } = {};
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }, captured), async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL_ID,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What is on this card?' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
              ],
            },
          ],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toContain('text-only');
      expect(body.error.message).toContain('image');
      // Nothing reached the gateway, so no vault entry was spent and no partial
      // prompt crossed the boundary.
      expect(captured.request).toBeUndefined();
    });
  });

  it('still accepts an all-text block array', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL_ID,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Just words.' }] }],
          max_tokens: 100,
        }),
      });

      expect(res.status).toBe(200);
    });
  });

  it('refuses /api/chat images without calling the gateway', async () => {
    const captured: { request?: unknown } = {};
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }, captured), async (base) => {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL_NAME,
          messages: [{ role: 'user', content: 'What is on this card?', images: ['aGk='] }],
          stream: false,
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('text-only');
      expect(body.error).toContain('image');
      // The prompt would otherwise have been forwarded with the image silently
      // stripped, which is a different prompt than the caller wrote.
      expect(captured.request).toBeUndefined();
    });
  });

  it('refuses /api/generate images without calling the gateway', async () => {
    const captured: { request?: unknown } = {};
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }, captured), async (base) => {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL_NAME,
          prompt: 'What is on this card?',
          images: ['aGk='],
          stream: false,
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('text-only');
      expect(captured.request).toBeUndefined();
    });
  });

  it('accepts both Ollama routes when the images array is empty', async () => {
    await withServer(stubFetch({ status: 200, body: SUCCESS_BODY }), async (base) => {
      const chat = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Just words.', images: [] }],
          stream: false,
        }),
      });
      expect(chat.status).toBe(200);

      const generate = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Just words.', images: [], stream: false }),
      });
      expect(generate.status).toBe(200);
    });
  });
});

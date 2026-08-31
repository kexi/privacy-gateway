/**
 * The OpenAI-compatible surface, driven over HTTP against the booted fleet.
 *
 * These use Playwright's `request` fixture rather than a page: the guarantee
 * under test is that an ordinary OpenAI-compatible HTTP client gets a correct
 * response from the real Gateway and Synthesis, with only Core and Gemma mocked
 * — the same fleet the browser specs drive.
 */

import { expect, test } from '@playwright/test';

/** The marker `fleet-server.ts` reads to select a Core that leaks a raw address. */
const LEAK_MARKER = 'SCENARIO-LEAK';

const CUSTOMER =
  'Customer Taro Yamada (taro@example.co.jp, 090-1234-5678) reports a failed charge.';

test.describe('GET /v1/models', () => {
  test('advertises privacy-gateway as the only selectable model', async ({ request }) => {
    const response = await request.get('/v1/models');
    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      object: string;
      data: Array<{ id: string; object: string; owned_by: string }>;
    };
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.id).toBe('privacy-gateway');
    expect(body.data[0]?.object).toBe('model');
    expect(body.data[0]?.owned_by).toBe('privacy-gateway');
  });
});

test.describe('POST /v1/chat/completions', () => {
  test('answers a standard body with a chat.completion carrying the privacy facts', async ({
    request,
  }) => {
    const response = await request.post('/v1/chat/completions', {
      data: {
        model: 'privacy-gateway',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: CUSTOMER },
        ],
        temperature: 0.5,
      },
    });

    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      id: string;
      object: string;
      model: string;
      choices: Array<{
        index: number;
        message: { role: string; content: string };
        finish_reason: string;
      }>;
      x_privacy_gateway: {
        request_id: string;
        trust_tier: string;
        status: string;
        masked_prompt: string;
        withheld: string[];
      };
    };

    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('privacy-gateway');
    expect(body.choices[0]?.message.role).toBe('assistant');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.choices[0]?.message.content.length).toBeGreaterThan(0);

    // The id binds the completion to the evidence.
    expect(body.id).toBe(`chatcmpl-${body.x_privacy_gateway.request_id}`);
    expect(body.x_privacy_gateway.trust_tier).toBe('machine-confirmed');

    // The masked prompt is what actually crossed the boundary: the real values
    // must not appear in it.
    expect(body.x_privacy_gateway.masked_prompt).not.toContain('taro@example.co.jp');
    expect(body.x_privacy_gateway.masked_prompt).not.toContain('090-1234-5678');
  });

  test('leaves the evidence document reachable from the completion id', async ({ request }) => {
    const completion = await request.post('/v1/chat/completions', {
      data: { model: 'privacy-gateway', messages: [{ role: 'user', content: CUSTOMER }] },
    });
    const body = (await completion.json()) as { x_privacy_gateway: { request_id: string } };

    const evidence = await request.get(`/v1/requests/${body.x_privacy_gateway.request_id}`);
    expect(evidence.status()).toBe(200);
    expect(await evidence.text()).toContain('Gateway Answer');
  });

  test('reports a refused release as an OpenAI error with the status preserved', async ({
    request,
  }) => {
    const response = await request.post('/v1/chat/completions', {
      data: {
        model: 'privacy-gateway',
        messages: [{ role: 'user', content: `${CUSTOMER} ${LEAK_MARKER}` }],
      },
    });

    // The release gate refused; the façade must not launder that into a 200.
    expect(response.status()).toBe(422);

    const body = (await response.json()) as {
      error: { message: string; type: string; code: string; categories?: string[] };
    };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.categories).toContain('EMAIL');
    expect(body).not.toHaveProperty('choices');

    // Nothing the leaking Core produced may appear in the refusal.
    expect(JSON.stringify(body)).not.toContain('leaked.person@example.com');
  });

  test('rejects a malformed body without running the pipeline', async ({ request }) => {
    const response = await request.post('/v1/chat/completions', {
      data: { model: 'privacy-gateway', messages: [] },
    });

    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  test('streams one content chunk and then [DONE]', async ({ request }) => {
    const response = await request.post('/v1/chat/completions', {
      data: {
        model: 'privacy-gateway',
        messages: [{ role: 'user', content: CUSTOMER }],
        stream: true,
      },
    });

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/event-stream');

    const payloads = (await response.text())
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
    expect(first.x_privacy_gateway.trust_tier).toBe('machine-confirmed');
  });
});

/** Parses an SSE body into its event types, in wire order. */
function eventTypes(body: string): string[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const line = block.split('\n').find((candidate) => candidate.startsWith('data: ')) ?? '';
      return (JSON.parse(line.slice('data: '.length)) as { type: string }).type;
    });
}

/**
 * The Responses API surface, which is the only wire Codex CLI >= 0.149 speaks
 * to a custom provider. The event names and their order are what the CLI's SSE
 * parser requires, so these run against the real fleet rather than a unit mock.
 */
test.describe('POST /v1/responses', () => {
  test('answers a non-streaming body with a response object carrying the privacy facts', async ({
    request,
  }) => {
    const response = await request.post('/v1/responses', {
      data: { model: 'privacy-gateway', instructions: 'Be terse.', input: CUSTOMER },
    });

    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      id: string;
      object: string;
      status: string;
      output: Array<{
        type: string;
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
      x_privacy_gateway: { request_id: string; trust_tier: string; masked_prompt: string };
    };

    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.output[0]?.type).toBe('message');
    expect(body.output[0]?.role).toBe('assistant');
    expect(body.output[0]?.content[0]?.type).toBe('output_text');
    expect(body.output[0]?.content[0]?.text.length).toBeGreaterThan(0);

    expect(body.id).toBe(`resp-${body.x_privacy_gateway.request_id}`);
    expect(body.x_privacy_gateway.trust_tier).toBe('machine-confirmed');
    expect(body.x_privacy_gateway.masked_prompt).not.toContain('taro@example.co.jp');
  });

  test('streams the event sequence Codex parses, ending with response.completed', async ({
    request,
  }) => {
    const response = await request.post('/v1/responses', {
      data: { model: 'privacy-gateway', input: CUSTOMER, stream: true },
    });

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/event-stream');

    const body = await response.text();
    expect(eventTypes(body)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.done',
      'response.completed',
    ]);

    // The answer Codex keeps comes off `output_item.done`, not the delta.
    const doneBlock = body
      .split('\n\n')
      .find((block) => block.includes('"response.output_item.done"'));
    const done = JSON.parse(
      (doneBlock?.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice(
        'data: '.length,
      ),
    ) as { item: { content: Array<{ text: string }> } };
    expect(done.item.content[0]?.text.length).toBeGreaterThan(0);
  });

  test('refuses a stream with response.failed rather than a completed turn', async ({
    request,
  }) => {
    const response = await request.post('/v1/responses', {
      data: { model: 'privacy-gateway', input: `${CUSTOMER} ${LEAK_MARKER}`, stream: true },
    });

    // The 200 was already committed when the gate refused, so the refusal is
    // the terminal event — and never a completed turn.
    const body = await response.text();
    expect(eventTypes(body)).toEqual(['response.failed']);
    expect(body).not.toContain('response.completed');
    expect(body).not.toContain('leaked.person@example.com');
  });

  test('reports a non-streaming refusal as an error with the status preserved', async ({
    request,
  }) => {
    const response = await request.post('/v1/responses', {
      data: { model: 'privacy-gateway', input: `${CUSTOMER} ${LEAK_MARKER}` },
    });

    expect(response.status()).toBe(422);
    const body = (await response.json()) as { error: { type: string; categories?: string[] } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.categories).toContain('EMAIL');
    expect(body).not.toHaveProperty('output');
  });
});

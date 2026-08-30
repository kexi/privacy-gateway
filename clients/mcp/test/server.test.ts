/**
 * What the MCP server guarantees.
 *
 * The gateway is mocked at the fetch layer, so these exercise the real tool
 * handlers, the real client and the real replay logic — only the network is
 * stubbed. The behaviour that matters most here is the refusal path: a gate that
 * declines must reach the model as a *readable result*, never as a thrown error
 * that reads like a transient fault worth retrying.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.ts';
import { attestationBlock, scan, sha256, trustTier, verify, GatewayClient } from '../src/client.ts';

const GATEWAY = 'http://gateway.test';

const MASKED_PROMPT = 'Customer ⟦PERSON_1⟧ (⟦EMAIL_1⟧) reports a failed charge.';
const CORE_RESPONSE = 'Dear ⟦PERSON_1⟧, we have logged the failed charge.';

/** An OKF document shaped like the one Synthesis stores. */
function okfDocument(
  overrides: { requestId?: string; verdict?: string; digests?: Record<string, string> } = {},
) {
  const requestId = overrides.requestId ?? 'test-request-1';
  const digests = overrides.digests ?? {};
  return [
    '---',
    'okf_version: "0.2"',
    'type: Gateway Answer',
    `request_id: ${requestId}`,
    'trace_id: abc123',
    'status: stable',
    'verified:',
    '  - by: "process:leak-check@sha256:deadbeef"',
    '    at: "2026-08-24T00:00:00Z"',
    'attestation:',
    `  request_id: ${requestId}`,
    `  verdict: ${overrides.verdict ?? 'pass'}`,
    `  masked_prompt_sha256: ${digests['masked_prompt_sha256'] ?? 'PROMPT_DIGEST'}`,
    `  core_response_sha256: ${digests['core_response_sha256'] ?? 'CORE_DIGEST'}`,
    `  attester_sha256: ${digests['attester_sha256'] ?? 'a'.repeat(64)}`,
    `  computation_sha256: ${digests['computation_sha256'] ?? 'b'.repeat(64)}`,
    '---',
    '',
    'The masked answer body.',
  ].join('\n');
}

/** A fetch standing in for the gateway; `routes` overrides individual paths. */
function mockGateway(routes: Record<string, () => Response>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const handler = routes[url.pathname];
    if (handler === undefined) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));
    }
    return Promise.resolve(handler());
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function markdownResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/markdown' } });
}

const ASK_SUCCESS = {
  request_id: 'test-request-1',
  trace_id: 'abc123',
  masked_prompt: MASKED_PROMPT,
  answer: 'Dear Taro Yamada, we have logged the failed charge.',
  okf: okfDocument(),
  trust_tier: 'machine-confirmed',
  status: 'stable',
  attestation: { ok: true, findings: [], withheld: ['CREDIT_CARD'] },
};

/** Connects a client to a server backed by `fetchImpl`. */
async function connect(fetchImpl: typeof fetch): Promise<Client> {
  const server = buildServer({ gatewayUrl: GATEWAY, fetchImpl });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** The parsed JSON payload of a tool result's single text block. */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
}

let client: Client;

describe('tool registration', () => {
  beforeEach(async () => {
    client = await connect(mockGateway({}));
  });

  it('exposes exactly the three gateway tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'pgw_ask',
      'pgw_evidence',
      'pgw_verify',
    ]);
  });

  it('warns every tool against retrying around a safety gate', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description).toContain('Do NOT retry');
    }
  });

  it('describes the masking as pseudonymization rather than anonymization', async () => {
    const { tools } = await client.listTools();
    const ask = tools.find((tool) => tool.name === 'pgw_ask');
    // Overclaiming here would be a privacy misrepresentation, not a wording nit:
    // placeholders still disclose category and equality.
    expect(ask?.description).toContain('pseudonymization, not anonymization');
  });
});

describe('pgw_ask', () => {
  it('returns the answer, the masked prompt and the derived facts', async () => {
    client = await connect(mockGateway({ '/v1/ask': () => jsonResponse(ASK_SUCCESS) }));

    const result = await client.callTool({ name: 'pgw_ask', arguments: { text: 'Hello.' } });
    const payload = payloadOf(result);

    expect(payload['refused']).toBe(false);
    expect(payload['answer']).toContain('logged the failed charge');
    expect(payload['masked_prompt']).toBe(MASKED_PROMPT);
    expect(payload['request_id']).toBe('test-request-1');
    expect(payload['trace_id']).toBe('abc123');
    expect(payload['leak_check']).toBe('pass');
    expect(payload['withheld']).toEqual(['CREDIT_CARD']);
  });

  it('derives the trust tier from the document rather than echoing the server', async () => {
    // The response claims a tier the document does not support. OKF SPEC §5.3
    // requires the tier to be derived, so the document must win.
    client = await connect(
      mockGateway({
        '/v1/ask': () =>
          jsonResponse({
            ...ASK_SUCCESS,
            trust_tier: 'human-reviewed',
            okf: okfDocument().replace(/verified:[\s\S]*?attestation:/u, 'attestation:'),
          }),
      }),
    );

    const payload = payloadOf(
      await client.callTool({ name: 'pgw_ask', arguments: { text: 'Hello.' } }),
    );
    expect(payload['trust_tier']).toBe('unverified');
  });

  it('surfaces a refused release as a readable result, not a thrown error', async () => {
    client = await connect(
      mockGateway({
        '/v1/ask': () =>
          jsonResponse(
            {
              error: 'outbound_guard_refused',
              message: 'raw PII survived masking',
              categories: ['EMAIL', 'PHONE'],
              request_id: 'refused-1',
            },
            422,
          ),
      }),
    );

    const result = await client.callTool({ name: 'pgw_ask', arguments: { text: 'Hello.' } });

    // The call itself succeeded; the *content* reports the refusal. A thrown
    // MCP error would read to the model as a transient fault worth retrying.
    expect(result.isError).toBeFalsy();

    const payload = payloadOf(result);
    expect(payload['refused']).toBe(true);
    expect(payload['status']).toBe(422);
    expect(payload['error']).toBe('outbound_guard_refused');
    expect(payload['categories']).toEqual(['EMAIL', 'PHONE']);
    expect(String(payload['guidance'])).toContain('do not retry');
  });

  it('reports a 400 draft refusal the same structured way', async () => {
    client = await connect(
      mockGateway({
        '/v1/ask': () =>
          jsonResponse(
            { error: 'reserved_syntax', message: 'reserved delimiters', request_id: 'r1' },
            400,
          ),
      }),
    );

    const payload = payloadOf(
      await client.callTool({ name: 'pgw_ask', arguments: { text: '⟦EMAIL_1⟧' } }),
    );
    expect(payload['refused']).toBe(true);
    expect(payload['error']).toBe('reserved_syntax');
  });
});

describe('pgw_evidence', () => {
  it('returns the stored masked OKF document', async () => {
    client = await connect(
      mockGateway({ '/v1/requests/test-request-1': () => markdownResponse(okfDocument()) }),
    );

    const payload = payloadOf(
      await client.callTool({
        name: 'pgw_evidence',
        arguments: { request_id: 'test-request-1' },
      }),
    );

    expect(payload['refused']).toBe(false);
    expect(payload['trust_tier']).toBe('machine-confirmed');
    expect(String(payload['okf'])).toContain('type: Gateway Answer');
  });

  it('reports an unknown request as a refusal rather than an exception', async () => {
    client = await connect(mockGateway({}));

    const payload = payloadOf(
      await client.callTool({ name: 'pgw_evidence', arguments: { request_id: 'nope' } }),
    );
    expect(payload['refused']).toBe(true);
    expect(payload['status']).toBe(404);
  });
});

describe('pgw_verify', () => {
  /** Routes serving a document whose artifact digests actually match. */
  async function consistentRoutes(overrides: { verdict?: string; core?: string } = {}) {
    const core = overrides.core ?? CORE_RESPONSE;
    const digests = {
      masked_prompt_sha256: await sha256(MASKED_PROMPT),
      core_response_sha256: await sha256(core),
    };
    const document = okfDocument({
      digests,
      ...(overrides.verdict !== undefined ? { verdict: overrides.verdict } : {}),
    });

    return mockGateway({
      '/v1/requests/test-request-1': () => markdownResponse(document),
      '/v1/requests/test-request-1/masked-prompt.md': () => markdownResponse(MASKED_PROMPT),
      '/v1/requests/test-request-1/core-response.md': () => markdownResponse(core),
    });
  }

  it('passes every check when the document matches the served artifacts', async () => {
    client = await connect(await consistentRoutes());

    const payload = payloadOf(
      await client.callTool({ name: 'pgw_verify', arguments: { request_id: 'test-request-1' } }),
    );

    expect(payload['refused']).toBe(false);
    expect(payload['ok']).toBe(true);
    const checks = payload['checks'] as Array<{ name: string; ok: boolean }>;
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(payload['independently_derived_findings']).toEqual([]);
    expect(payload['trust_tier']).toBe('machine-confirmed');
  });

  it('reports each digest separately, so one mismatch is locatable', async () => {
    // A document whose prompt digest is a valid sha256 but names other bytes.
    const document = okfDocument({
      digests: {
        masked_prompt_sha256: 'c'.repeat(64),
        core_response_sha256: await sha256(CORE_RESPONSE),
      },
    });
    client = await connect(
      mockGateway({
        '/v1/requests/test-request-1': () => markdownResponse(document),
        '/v1/requests/test-request-1/masked-prompt.md': () => markdownResponse(MASKED_PROMPT),
        '/v1/requests/test-request-1/core-response.md': () => markdownResponse(CORE_RESPONSE),
      }),
    );

    const payload = payloadOf(
      await client.callTool({ name: 'pgw_verify', arguments: { request_id: 'test-request-1' } }),
    );

    expect(payload['ok']).toBe(false);
    const checks = payload['checks'] as Array<{ name: string; ok: boolean }>;
    const promptCheck = checks.find((check) => check.name.includes('matches the served prompt'));
    const coreCheck = checks.find((check) => check.name.includes('matches the served response'));
    expect(promptCheck?.ok).toBe(false);
    // The other digest is unaffected: the report locates the failure.
    expect(coreCheck?.ok).toBe(true);
  });

  it('rejects a digest that is not 64 hex characters before comparing it', async () => {
    client = await connect(
      mockGateway({
        '/v1/requests/test-request-1': () => markdownResponse(okfDocument()),
        '/v1/requests/test-request-1/masked-prompt.md': () => markdownResponse(MASKED_PROMPT),
        '/v1/requests/test-request-1/core-response.md': () => markdownResponse(CORE_RESPONSE),
      }),
    );

    const payload = payloadOf(
      await client.callTool({ name: 'pgw_verify', arguments: { request_id: 'test-request-1' } }),
    );

    const checks = payload['checks'] as Array<{ name: string; ok: boolean }>;
    const syntax = checks.find((check) => check.name.includes('masked_prompt_sha256 is a sha256'));
    expect(syntax?.ok).toBe(false);
  });

  it('contradicts a "pass" verdict when it finds PII in the core response itself', async () => {
    // The whole point of an independent replay: the document claims pass, the
    // transcribed scanner disagrees.
    client = await connect(
      await consistentRoutes({ core: 'Contact leaked.person@example.com.', verdict: 'pass' }),
    );

    const payload = payloadOf(
      await client.callTool({ name: 'pgw_verify', arguments: { request_id: 'test-request-1' } }),
    );

    expect(payload['ok']).toBe(false);
    expect(payload['independently_derived_findings']).toEqual(['EMAIL']);
    const checks = payload['checks'] as Array<{ name: string; ok: boolean }>;
    expect(checks.find((check) => check.name.includes('verdict matches'))?.ok).toBe(false);
  });

  it('reports the bundle digests as not-checked rather than as passing', async () => {
    client = await connect(await consistentRoutes());

    const payload = payloadOf(
      await client.callTool({ name: 'pgw_verify', arguments: { request_id: 'test-request-1' } }),
    );

    // Claiming a match this client never computed would make the replay worthless.
    const notChecked = (payload['not_checked'] as string[]).join(' ');
    expect(notChecked).toContain('attester_sha256');
    expect(notChecked).toContain('computation_sha256');
  });

  it('refuses to replay a document with no attestation block', async () => {
    const bare = '---\nokf_version: "0.2"\ntype: Gateway Answer\n---\n\nBody.';
    client = await connect(
      mockGateway({
        '/v1/requests/test-request-1': () => markdownResponse(bare),
        '/v1/requests/test-request-1/masked-prompt.md': () => markdownResponse(MASKED_PROMPT),
        '/v1/requests/test-request-1/core-response.md': () => markdownResponse(CORE_RESPONSE),
      }),
    );

    const payload = payloadOf(
      await client.callTool({ name: 'pgw_verify', arguments: { request_id: 'test-request-1' } }),
    );
    expect(payload['refused']).toBe(true);
    expect(payload['error']).toBe('no_attestation');
  });
});

describe('the transcribed scanner', () => {
  it('finds the categories the fleet masks', () => {
    expect(scan('write to taro@example.co.jp')).toEqual(['EMAIL']);
    expect(scan('no personal data here')).toEqual([]);
  });

  it('applies the Luhn check rather than flagging any long digit run', () => {
    expect(scan('card 4242 4242 4242 4242')).toContain('CREDIT_CARD');
    // Twelve digits that fail Luhn are not a card number.
    expect(scan('order 1234 5678 9012 3456')).not.toContain('CREDIT_CARD');
  });

  it('rejects an octet above 255 rather than calling it an address', () => {
    expect(scan('host 192.168.10.5')).toContain('IPV4');
    expect(scan('version 999.888.777.666')).not.toContain('IPV4');
  });
});

describe('OKF frontmatter reading', () => {
  it('derives the machine-confirmed tier from a process verifier', () => {
    expect(trustTier(okfDocument())).toBe('machine-confirmed');
  });

  it('reports a document with no verifier as unverified', () => {
    expect(trustTier('---\ntype: Gateway Answer\n---\n\nBody.')).toBe('unverified');
  });

  it('reads the flat scalars of the attestation block', () => {
    const block = attestationBlock(okfDocument({ requestId: 'abc' }));
    expect(block['request_id']).toBe('abc');
    expect(block['verdict']).toBe('pass');
  });
});

describe('the gateway client', () => {
  it('reads the OpenAI-shaped error envelope as well as the native one', async () => {
    // The same client is useful against /v1/chat/completions, whose errors nest
    // their fields under `error`.
    const gateway = new GatewayClient({
      baseUrl: GATEWAY,
      fetchImpl: mockGateway({
        '/v1/ask': () =>
          jsonResponse(
            {
              error: {
                message: 'raw PII survived masking',
                type: 'invalid_request_error',
                code: 'outbound_guard_refused',
                categories: ['EMAIL'],
                request_id: 'r9',
              },
            },
            422,
          ),
      }),
    });

    const result = await gateway.ask('hello');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('outbound_guard_refused');
    expect(result.categories).toEqual(['EMAIL']);
    expect(result.requestId).toBe('r9');
  });

  it('reports a non-JSON error body without inventing a reason', async () => {
    const gateway = new GatewayClient({
      baseUrl: GATEWAY,
      fetchImpl: mockGateway({
        '/v1/ask': () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      }),
    });

    const result = await gateway.ask('hello');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.categories).toEqual([]);
  });

  it('replays through the exported verify helper without an MCP transport', async () => {
    const digests = {
      masked_prompt_sha256: await sha256(MASKED_PROMPT),
      core_response_sha256: await sha256(CORE_RESPONSE),
    };
    const gateway = new GatewayClient({
      baseUrl: GATEWAY,
      fetchImpl: mockGateway({
        '/v1/requests/r1': () => markdownResponse(okfDocument({ requestId: 'r1', digests })),
        '/v1/requests/r1/masked-prompt.md': () => markdownResponse(MASKED_PROMPT),
        '/v1/requests/r1/core-response.md': () => markdownResponse(CORE_RESPONSE),
      }),
    });

    const report = await verify(gateway, 'r1');
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.ok).toBe(true);
  });
});

describe('the MCP surface is text-only', () => {
  it('accepts nothing but a string on pgw_ask', async () => {
    client = await connect(mockGateway({ '/v1/ask': () => jsonResponse(ASK_SUCCESS) }));
    const { tools } = await client.listTools();
    const ask = tools.find((tool) => tool.name === 'pgw_ask');

    // Every property is text-shaped, so there is no shape an image or an audio
    // clip could arrive in. The gateway behind it masks with regexes and a text
    // model and cannot redact what it cannot read, so this is a guarantee rather
    // than a simplification — a future `content` array here would need the same
    // explicit refusal the OpenAI façade carries.
    const schema = ask?.inputSchema as {
      properties?: Record<string, { type?: string; items?: { type?: string } }>;
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['mask_terms', 'text']);
    expect(schema.properties?.['text']?.type).toBe('string');
    // The terms are an array of strings and nothing else: a term is matched by
    // literal comparison, so anything that is not a string has no meaning here.
    expect(schema.properties?.['mask_terms']?.type).toBe('array');
    expect(schema.properties?.['mask_terms']?.items?.type).toBe('string');
  });

  it('rejects a structured content array in place of the text', async () => {
    client = await connect(mockGateway({ '/v1/ask': () => jsonResponse(ASK_SUCCESS) }));

    // An MCP client that tried to pass OpenAI-shaped parts is refused by the
    // tool's own schema, before any request could reach the boundary. This is a
    // validation error rather than a `refused: true` payload, because it is not
    // a gate declining content — nothing was ever sent.
    const result = await client.callTool({
      name: 'pgw_ask',
      arguments: { text: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] },
    });

    expect(result.isError).toBe(true);
  });
});

describe('pgw_ask forwards user-defined secret terms', () => {
  /** A gateway double that records the body it was posted. */
  function capturingGateway(bodies: unknown[]): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname !== '/v1/ask') {
        return Promise.resolve(new Response('{}', { status: 404 }));
      }
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return Promise.resolve(jsonResponse(ASK_SUCCESS));
    }) as typeof fetch;
  }

  it('sends mask_terms through to the gateway', async () => {
    const bodies: unknown[] = [];
    client = await connect(capturingGateway(bodies));

    await client.callTool({
      name: 'pgw_ask',
      arguments: { text: 'Status of the project?', mask_terms: ['Titan Project'] },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      text: 'Status of the project?',
      mask_terms: ['Titan Project'],
    });
  });

  it('omits the field entirely when the caller names no terms', async () => {
    // An empty array would fail the gateway's `min(1)`, so "asked for nothing"
    // has to be encoded as an absent field rather than an empty one.
    const bodies: unknown[] = [];
    client = await connect(capturingGateway(bodies));

    await client.callTool({ name: 'pgw_ask', arguments: { text: 'Hello.' } });

    expect(bodies[0]).toEqual({ text: 'Hello.' });
  });

  it('refuses a term the tool schema rejects, before anything is sent', async () => {
    const bodies: unknown[] = [];
    client = await connect(capturingGateway(bodies));

    const result = await client.callTool({
      name: 'pgw_ask',
      arguments: { text: 'Hello.', mask_terms: ['a'] },
    });

    expect(result.isError).toBe(true);
    expect(bodies).toHaveLength(0);
  });
});

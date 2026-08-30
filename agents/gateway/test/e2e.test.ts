/**
 * What the whole fleet guarantees, end to end, with no network and no real LLM.
 *
 * Core is a mock A2A server (Agent Card plus `message/send`) and Gemma is a mock
 * OpenAI-compatible endpoint; Synthesis runs in-process against an in-memory
 * vault. The mocks sit at the fetch layer rather than replacing the functions
 * under test, so the language-independent protocol path is exercised as it
 * really is.
 */

import {
  createLogger,
  findTokens,
  InMemoryTokenVault,
  initTelemetry,
  liveEntry,
  loadConfig,
  parse as parseOkf,
  resetTelemetryForTests,
  shutdownTelemetry,
  AskResponseSchema,
  TRUST_MACHINE_CONFIRMED,
  TRUST_UNVERIFIED,
  trustTier,
  type AskResponse,
  type Config,
} from '@privacy-gateway/common';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { createApp as createSynthesisApp } from '@privacy-gateway/synthesis/server';
import { InMemoryAnswerStore } from '@privacy-gateway/synthesis/store';
import type express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createApp as createGatewayApp } from '../src/server.ts';

const CORE_BASE_URL = 'http://core.test';

const CUSTOMER_EMAIL =
  'Customer Taro Yamada (taro@example.co.jp, 090-1234-5678) reports that the charge on ' +
  'card 4242 4242 4242 4242 failed. Our API key sk-abcdefghijklmnopqrstuvwxyz012345 was ' +
  'used from 192.168.10.5. Draft a reply and a Python snippet to update the record.';

/** Records what Core was sent, so the boundary can be asserted on directly. */
const promptsSeenByCore: string[] = [];
/** Records the trace context each hop received. */
const traceHeadersSeenByCore: Array<string | undefined> = [];

let exporter: InMemorySpanExporter;
let gateway: express.Application;
let vault: InMemoryTokenVault;
let store: InMemoryAnswerStore;
let gatewayUrl: string;
let servers: Array<ReturnType<express.Application['listen']>> = [];

/** A well-behaved Core that reuses the placeholders from its input verbatim. */
function echoingCore(prompt: string): string {
  const tokens = findTokens(prompt);
  return (
    `Dear ${tokens[0] ?? 'customer'}, we have logged the failed charge.\n\n` +
    '```python\n' +
    `update_record(email="${tokens[1] ?? 'unknown'}")\n` +
    '```\n\n' +
    `Referenced placeholders: ${tokens.join(', ')}`
  );
}

/** A Core that emits a raw address of its own, as if from training data. */
function leakingCore(): string {
  return 'Contact them directly at leaked.person@example.com.';
}

/** A Core that fabricates a placeholder it was never given. */
function inventingCore(): string {
  return 'See ⟦PERSON_99⟧ for details.';
}

/**
 * A Core that writes back the customer's real name, as if from training data.
 *
 * The deterministic scanner has no PERSON pattern, so this is precisely the case
 * the advisory judge exists to catch — and its veto must be honoured.
 */
function namingCore(): string {
  return 'You should call Taro Yamada in Shibuya about this.';
}

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    agent: 'gateway',
    env: {
      VAULT_BACKEND: 'memory',
      CORE_BASE_URL,
      GEMINI_MODEL: 'gemini-3.5-flash',
      GEMMA_MODEL: 'gemma4:12b',
      // The limiter is off by default in tests: every case here is a legitimate
      // request, and a shared window would make them order-dependent.
      RATE_LIMIT_PER_MINUTE: '0',
      ...overrides,
    },
    onInvalid: (message) => {
      throw new Error(message);
    },
  });
}

/**
 * A fetch that serves the mock Core (A2A), the mock Gemma (OpenAI-compatible),
 * and forwards everything else to the real in-process Synthesis listener.
 */
function fleetFetch(
  core: (prompt: string) => string,
  synthesisUrl: string,
  gemmaSpans: unknown = { spans: [{ text: 'Taro Yamada', category: 'PERSON' }] },
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(url);

    // --- mock Core: the A2A Agent Card ---
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

    // --- mock Core: message/send ---
    if (parsed.origin === CORE_BASE_URL && parsed.pathname === '/jsonrpc') {
      const headers = new Headers(init?.headers);
      traceHeadersSeenByCore.push(headers.get('traceparent') ?? undefined);

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
          result: {
            role: 'agent',
            parts: [{ kind: 'text', text: core(prompt) }],
            messageId: 'reply-1',
          },
        }),
      );
    }

    // --- mock Gemma: OpenAI-compatible chat completions ---
    if (parsed.pathname.endsWith('/chat/completions')) {
      return Promise.resolve(
        Response.json({
          choices: [{ message: { content: JSON.stringify(gemmaSpans) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }

    // --- everything else: the real Synthesis listener ---
    const rewritten = `${synthesisUrl}${parsed.pathname}${parsed.search}`;
    return globalThis.fetch(rewritten, init);
  }) as typeof fetch;
}

async function startFleet(
  core: (prompt: string) => string = echoingCore,
  gemmaSpans?: unknown,
  overrides: Record<string, string> = {},
): Promise<void> {
  vault = new InMemoryTokenVault();
  store = new InMemoryAnswerStore();
  const logger = createLogger({ agent: 'gateway', write: () => undefined });

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

  gateway = createApp({
    config: testConfig({ SYNTHESIS_BASE_URL: synthesisUrl, ...overrides }),
    logger,
    vault,
    fetchImpl: fleetFetch(core, synthesisUrl, gemmaSpans),
  });

  const gatewayServer = gateway.listen(0);
  servers.push(gatewayServer);
  const gatewayAddress = gatewayServer.address();
  const gatewayPort =
    typeof gatewayAddress === 'object' && gatewayAddress !== null ? gatewayAddress.port : 0;
  gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
}

function ask(text: string, headers: Record<string, string> = {}) {
  return fetch(`${gatewayUrl}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ text }),
  });
}

/** Sends a request that opts into restoring specific high-risk categories. */
function askAllowing(text: string, rehydrateAllow: readonly string[]) {
  return fetch(`${gatewayUrl}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, rehydrate_allow: [...rehydrateAllow] }),
  });
}

/** Posts a raw body, for the cases that must send something the schema rejects. */
function askRaw(body: unknown) {
  return fetch(`${gatewayUrl}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  promptsSeenByCore.length = 0;
  traceHeadersSeenByCore.length = 0;
  resetTelemetryForTests();
  exporter = new InMemorySpanExporter();
  initTelemetry({ agent: 'gateway', enabled: true, exporter });
});

afterEach(async () => {
  for (const server of servers) server.close();
  servers = [];
  await shutdownTelemetry();
  exporter.reset();
});

describe('the boundary', () => {
  beforeEach(() => startFleet());

  it('lets no raw PII reach the core agent', async () => {
    await ask(CUSTOMER_EMAIL);

    expect(promptsSeenByCore).toHaveLength(1);
    for (const secret of [
      'taro@example.co.jp',
      '090-1234-5678',
      '4242 4242 4242 4242',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      '192.168.10.5',
      'Taro Yamada',
    ]) {
      expect(promptsSeenByCore[0]).not.toContain(secret);
    }
  });

  it('shows the user a masked prompt and a rehydrated answer', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    expect(body.masked_prompt).toContain('⟦EMAIL_1⟧');
    // Core wrote placeholders; the body returned to the user carries real values.
    expect(body.answer).toContain('taro@example.co.jp');
  });

  it('withholds secret-bearing categories from the released answer', async () => {
    // The caller already holds their own card number and API key; echoing them
    // back through a model round trip only widens where they can be logged.
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    expect(body.answer).not.toContain('4242 4242 4242 4242');
    expect(body.answer).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(findTokens(body.answer).sort()).toEqual(['⟦API_KEY_1⟧', '⟦CREDIT_CARD_1⟧']);
    expect(body.attestation.withheld?.sort()).toEqual(['API_KEY', 'CREDIT_CARD']);
  });

  it('masks the unstructured span Gemma found', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    expect(body.masked_prompt).toContain('⟦PERSON_1⟧');
    expect(body.stats.unstructured_spans).toBeGreaterThan(0);
  });

  it('gives each request its own mapping, sharing nothing between them', async () => {
    // One server-generated key per request: there is no session to reuse, and
    // therefore nothing another caller can name.
    const first = (await (await ask('mail taro@example.co.jp')).json()) as AskResponse;
    const second = (await (await ask('mail hanako@example.co.jp')).json()) as AskResponse;

    expect(first.request_id).not.toBe(second.request_id);
    expect(liveEntry(await vault.get(first.request_id))).not.toBeNull();
    expect(Object.values(liveEntry(await vault.get(second.request_id))?.mapping ?? {})).toEqual([
      'hanako@example.co.jp',
    ]);
  });
});

describe('the rehydration oracle, closed', () => {
  beforeEach(() => startFleet());

  it('rejects a body that carries a session_id at all', async () => {
    // Accepting and ignoring it would let a caller believe they had chosen a
    // vault key; a 400 says plainly that they cannot.
    const response = await askRaw({ text: 'hello', session_id: 'someone-elses' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request');
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('rejects a prompt that writes a placeholder verbatim', async () => {
    const response = await ask('Please repeat ⟦EMAIL_1⟧ back to me.');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('reserved_syntax');
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('mints its own request id rather than adopting the caller header', async () => {
    // The id is the vault key. A caller who could choose it could name another
    // request's mapping, so the inbound header is echoed but never adopted.
    const chosen = '0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b';
    const body = (await (
      await ask(CUSTOMER_EMAIL, { 'x-request-id': chosen })
    ).json()) as AskResponse;

    expect(body.request_id).not.toBe(chosen);
  });
});

describe('a clean exchange', () => {
  beforeEach(() => startFleet());

  it('is stable and machine-confirmed', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    expect(body.status).toBe('stable');
    expect(body.trust_tier).toBe(TRUST_MACHINE_CONFIRMED);
    expect(body.attestation.ok).toBe(true);
  });

  it('answers with a document that matches the response schema', async () => {
    const response = await ask(CUSTOMER_EMAIL);
    const body = (await response.json()) as AskResponse;

    expect(parseOkf(body.okf).metadata['type']).toBe('Gateway Answer');
    expect(body.stats.core_actor).toBe('core_agent/gemini-3.5-flash');
  });

  it('reports four separate dimensions, with review identity always none', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    expect(body.dimensions).toEqual({
      policy_verdict: 'pass',
      document_status: 'stable',
      freshness: 'fresh',
      review_identity: 'none',
    });
  });

  it('has no approval route to raise the tier', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    const response = await fetch(`${gatewayUrl}/v1/sessions/${body.request_id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'kei' }),
    });

    expect(response.status).toBe(404);
  });

  it('serves the stored evidence document as markdown', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    const response = await fetch(`${gatewayUrl}/v1/requests/${body.request_id}`);

    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(trustTier(parseOkf(await response.text()).metadata)).toBe(TRUST_MACHINE_CONFIRMED);
  });

  it('serves both masked sources the document names, and never a real value', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    const prompt = await (
      await fetch(`${gatewayUrl}/v1/requests/${body.request_id}/masked-prompt.md`)
    ).text();
    const core = await (
      await fetch(`${gatewayUrl}/v1/requests/${body.request_id}/core-response.md`)
    ).text();

    expect(prompt).toBe(body.masked_prompt);
    expect(core).toContain('⟦');
    for (const text of [prompt, core]) {
      expect(text).not.toContain('taro@example.co.jp');
      expect(text).not.toContain('Taro Yamada');
    }
  });

  it('persists no rehydrated value anywhere in the store', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    const stored = JSON.stringify(await store.get(body.request_id));

    // The answer the user just read exists only in that response.
    expect(body.answer).toContain('taro@example.co.jp');
    for (const secret of ['taro@example.co.jp', 'Taro Yamada', '090-1234-5678']) {
      expect(stored).not.toContain(secret);
    }
  });
});

describe('a leaking core agent', () => {
  beforeEach(() => startFleet(leakingCore));

  it('releases no answer at all', async () => {
    const response = await ask(CUSTOMER_EMAIL);

    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('leak_check_failed');
    expect(body['answer']).toBeUndefined();
  });

  it('reports category-level findings and nothing more', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as { categories: string[] };

    expect(body.categories).toContain('EMAIL');
    expect(JSON.stringify(body)).not.toContain('leaked.person@example.com');
  });

  it('persists a draft record with no unsafe body', async () => {
    const response = await ask(CUSTOMER_EMAIL);
    const requestId = response.headers.get('x-request-id') ?? '';
    const record = await store.get(requestId);

    expect(record).not.toBeNull();
    expect(parseOkf(record?.okf ?? '').metadata['status']).toBe('draft');
    expect(trustTier(parseOkf(record?.okf ?? '').metadata)).toBe(TRUST_UNVERIFIED);
  });

  it('records the failure in the document rather than dropping it', async () => {
    const response = await ask(CUSTOMER_EMAIL);
    const record = await store.get(response.headers.get('x-request-id') ?? '');

    expect(parseOkf(record?.okf ?? '').content).toContain('# Attestation');
    expect(parseOkf(record?.okf ?? '').content).toContain('failed');
  });
});

describe('a core agent that invents placeholders', () => {
  beforeEach(() => startFleet(inventingCore));

  it('releases no answer and reports the conflict', async () => {
    const response = await ask(CUSTOMER_EMAIL);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('invented_token');
  });
});

describe('a semantic leak the regexes cannot see', () => {
  it('is blocked when the judge flags it, even though the regexes pass', async () => {
    vault = new InMemoryTokenVault();
    store = new InMemoryAnswerStore();

    const synthesisApp = await createSynthesisApp({
      config: testConfig(),
      logger: createLogger({ agent: 'synthesis', write: () => undefined }),
      vault,
      store,
      judge: () => Promise.resolve({ leak: true, categories: ['PERSON'] }),
    });
    const synthesisServer = synthesisApp.listen(0);
    servers.push(synthesisServer);
    const address = synthesisServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const synthesisUrl = `http://127.0.0.1:${port}`;

    gateway = createApp({
      config: testConfig({ SYNTHESIS_BASE_URL: synthesisUrl }),
      logger: createLogger({ agent: 'gateway', write: () => undefined }),
      vault,
      fetchImpl: fleetFetch(namingCore, synthesisUrl),
    });
    const gatewayServer = gateway.listen(0);
    servers.push(gatewayServer);
    const gatewayAddress = gatewayServer.address();
    gatewayUrl = `http://127.0.0.1:${
      typeof gatewayAddress === 'object' && gatewayAddress !== null ? gatewayAddress.port : 0
    }`;

    const response = await ask(CUSTOMER_EMAIL);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toBe('judge_flagged');
  });
});

describe('correlation', () => {
  beforeEach(() => startFleet());

  it('returns the request id on the header and in the body', async () => {
    const response = await ask(CUSTOMER_EMAIL);
    const body = (await response.json()) as AskResponse;

    expect(response.headers.get('x-request-id')).toBe(body.request_id);
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('stores the correlation ids in the OKF document', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    const metadata = parseOkf(body.okf).metadata;

    expect(metadata['request_id']).toBe(body.request_id);
    expect(metadata['trace_id']).toBe(body.trace_id);
  });
});

describe('distributed tracing', () => {
  beforeEach(() => startFleet());

  it('puts every hop of one request on a single trace', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    const spans = exporter.getFinishedSpans();

    const traceIds = new Set(spans.map((span) => span.spanContext().traceId));
    expect(traceIds.size).toBe(1);
    // The trace id the user is shown is the one the spans carry, so the console
    // link in the UI actually resolves.
    expect([...traceIds][0]).toBe(body.trace_id);
  });

  it('nests the gateway spans under the request span', async () => {
    await ask(CUSTOMER_EMAIL);
    const spans = exporter.getFinishedSpans();

    const request = spans.find((span) => span.name === 'request');
    expect(request).toBeDefined();

    for (const name of ['mask.regex', 'mask.gemma', 'guard.egress', 'a2a.core', 'synthesis.call']) {
      const span = spans.find((candidate) => candidate.name === name);
      expect(span, `expected a ${name} span`).toBeDefined();
      expect(span?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    }
  });

  it('records the synthesis spans on the same trace', async () => {
    await ask(CUSTOMER_EMAIL);
    const names = exporter.getFinishedSpans().map((span) => span.name);

    // Synthesis runs in-process here, so its spans join the same trace — which is
    // exactly what must happen across services once traceparent is propagated.
    for (const name of ['attest.leak_check', 'rehydrate', 'okf.build', 'persist']) {
      expect(names, `expected a ${name} span`).toContain(name);
    }
  });

  it('propagates traceparent to the core agent', async () => {
    await ask(CUSTOMER_EMAIL);

    expect(traceHeadersSeenByCore).toHaveLength(1);
    expect(traceHeadersSeenByCore[0]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u);
  });

  it('continues a trace the caller started', async () => {
    const traceId = 'dddddddddddddddddddddddddddddddd';
    await ask(CUSTOMER_EMAIL, { traceparent: `00-${traceId}-eeeeeeeeeeeeeeee-01` });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(traceId);
    }
  });

  it('records the attestation verdict as a span attribute, never the PII', async () => {
    await ask(CUSTOMER_EMAIL);
    const span = exporter.getFinishedSpans().find((s) => s.name === 'attest.leak_check');

    expect(span?.attributes['verdict']).toBe('pass');
    expect(JSON.stringify(span?.attributes)).not.toContain('taro@example.co.jp');
  });
});

describe('failure handling', () => {
  it('rejects an empty request before doing any work', async () => {
    await startFleet();
    const response = await ask('');

    expect(response.status).toBe(400);
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('refuses the request when Gemma returns nothing usable', async () => {
    // The regexes cannot see a name or an address, so an unreadable extractor
    // leaves the request's unstructured PII unknown. Sending it anyway is the
    // disclosure this gateway exists to prevent.
    await startFleet(echoingCore, { not: 'a span list' });
    const response = await ask(CUSTOMER_EMAIL);

    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe('extraction_unavailable');
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('accepts a genuine empty extraction and proceeds', async () => {
    // "I looked and found nothing" is a usable answer; only an unreadable one
    // blocks the request.
    await startFleet(echoingCore, { spans: [] });
    const response = await ask('please summarise the quarterly plan');

    expect(response.status).toBe(200);
    expect(promptsSeenByCore).toHaveLength(1);
  });

  it('answers with a body that matches the shared response schema', async () => {
    await startFleet();
    const body = await (await ask(CUSTOMER_EMAIL)).json();

    // The web UI parses this exact schema, so a drift surfaces here rather than
    // as an undefined halfway through a render.
    expect(() => AskResponseSchema.parse(body)).not.toThrow();
  });

  it('applies a per-client rate limit', async () => {
    await startFleet(echoingCore, undefined, { RATE_LIMIT_PER_MINUTE: '2' });

    expect((await ask('one')).status).not.toBe(429);
    expect((await ask('two')).status).not.toBe(429);
    const third = await ask('three');

    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toBe('rate_limited');
  });

  it('refuses a body larger than the configured limit', async () => {
    await startFleet(echoingCore, undefined, { MAX_BODY_BYTES: '256' });
    const response = await askRaw({ text: 'x'.repeat(1024) });

    expect(response.status).toBe(413);
    expect(promptsSeenByCore).toHaveLength(0);
  });
});

describe('the deadline cancels the work, not only the wait (P1)', () => {
  /** A gateway whose downstream calls hang until their own signal aborts. */
  function hangingApp(deadlineMs: number) {
    const observed: { core?: AbortSignal | undefined; synthesis?: AbortSignal | undefined } = {};

    const app = createGatewayApp({
      config: testConfig(),
      deadlineMs,
      logger: createLogger({ agent: 'gateway', write: () => undefined }),
      vault: new InMemoryTokenVault(),
      extractSpans: () => Promise.resolve([]),
      callCore: (_prompt, _requestId, signal) => {
        observed.core = signal;
        // Never resolves on its own: only the deadline can end this request,
        // which is exactly the state the old Promise.race left running.
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      },
      callSynthesis: (_input, signal) => {
        observed.synthesis = signal;
        return Promise.reject(new Error('unreachable'));
      },
    });

    return { app, observed };
  }

  it('aborts the in-flight Core call when the deadline fires', async () => {
    const { app, observed } = hangingApp(50);
    const listener = app.listen(0);
    const address = listener.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/v1/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    listener.close();

    expect(response.status).toBe(504);
    expect(observed.core).toBeDefined();
    // The mock observes cancellation itself: the request downstream is really
    // over, not merely no longer awaited.
    expect(observed.core?.aborted).toBe(true);
    expect(observed.synthesis).toBeUndefined();
  });

  it('hands every hop the same request-scoped signal', async () => {
    const seen: AbortSignal[] = [];
    const app = createGatewayApp({
      config: testConfig(),
      logger: createLogger({ agent: 'gateway', write: () => undefined }),
      vault: new InMemoryTokenVault(),
      extractSpans: (_text, signal) => {
        if (signal !== undefined) seen.push(signal);
        return Promise.resolve([]);
      },
      callCore: (_prompt, _requestId, signal) => {
        if (signal !== undefined) seen.push(signal);
        return Promise.resolve('Reply to nobody.');
      },
      callSynthesis: (_input, signal) => {
        if (signal !== undefined) seen.push(signal);
        return Promise.reject(new Error('stop here'));
      },
    });

    const listener = app.listen(0);
    const address = listener.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await fetch(`http://127.0.0.1:${port}/v1/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    listener.close();

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
  });

  it('aborts anything still in flight once the response has been sent', async () => {
    let captured: AbortSignal | undefined;
    const app = createGatewayApp({
      config: testConfig(),
      logger: createLogger({ agent: 'gateway', write: () => undefined }),
      vault: new InMemoryTokenVault(),
      extractSpans: () => Promise.resolve([]),
      callCore: (_prompt, _requestId, signal) => {
        captured = signal;
        return Promise.resolve('Reply to nobody.');
      },
      callSynthesis: () => Promise.reject(new Error('stop here')),
    });

    const listener = app.listen(0);
    const address = listener.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await fetch(`http://127.0.0.1:${port}/v1/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    listener.close();

    expect(captured?.aborted).toBe(true);
  });
});

describe('the per-request disclosure opt-in', () => {
  beforeEach(() => startFleet());

  it('withholds the card and the API key by default', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    expect(body.answer).toContain('⟦CREDIT_CARD_1⟧');
    expect(body.answer).not.toContain('4242 4242 4242 4242');
    expect(body.attestation.withheld).toContain('CREDIT_CARD');
    // Nothing was asked for, so the record says nothing was asked for.
    expect(body.attestation.disclosure_requested).toBeUndefined();
  });

  it('restores the card when this request allowed it', async () => {
    const body = (await (await askAllowing(CUSTOMER_EMAIL, ['CREDIT_CARD'])).json()) as AskResponse;

    expect(body.answer).toContain('4242 4242 4242 4242');
    expect(body.answer).not.toContain('⟦CREDIT_CARD_1⟧');
  });

  it('records the request and the final withheld set separately', async () => {
    const body = (await (await askAllowing(CUSTOMER_EMAIL, ['CREDIT_CARD'])).json()) as AskResponse;

    // What was asked for, and what was still not given: two facts, two fields.
    expect(body.attestation.disclosure_requested).toEqual(['CREDIT_CARD']);
    expect(body.attestation.withheld).toContain('API_KEY');
    expect(body.attestation.withheld).not.toContain('CREDIT_CARD');
  });

  it('writes both sets into the OKF attestation block', async () => {
    const body = (await (await askAllowing(CUSTOMER_EMAIL, ['CREDIT_CARD'])).json()) as AskResponse;
    const block = parseOkf(body.okf).metadata['attestation'] as Record<string, unknown>;

    expect(block['disclosure_requested']).toEqual(['CREDIT_CARD']);
    expect(block['withheld']).toContain('API_KEY');
    // The stored document's body is still the masked answer, opt-in or not: the
    // disclosure is for the one response, never for the audit record.
    expect(body.okf).not.toContain('4242 4242 4242 4242');
  });

  it('leaves a category the request did not name masked', async () => {
    const body = (await (await askAllowing(CUSTOMER_EMAIL, ['CREDIT_CARD'])).json()) as AskResponse;

    expect(body.answer).toContain('⟦API_KEY_1⟧');
    expect(body.answer).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('records the rehydration verdict on every release', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    expect(body.attestation.rehydration?.verdict).toBe('pass');
    expect(body.attestation.rehydration?.withheld_remaining).toContain('⟦CREDIT_CARD_1⟧');
  });

  it('rejects a category that is never withheld', async () => {
    const response = await askAllowing(CUSTOMER_EMAIL, ['EMAIL']);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request');
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('rejects a category that does not exist', async () => {
    const response = await askAllowing(CUSTOMER_EMAIL, ['SUPERUSER']);

    expect(response.status).toBe(400);
    expect(promptsSeenByCore).toHaveLength(0);
  });

  it('names the offending field so a caller can fix the request', async () => {
    const response = await askAllowing(CUSTOMER_EMAIL, ['EMAIL']);
    const body = (await response.json()) as { message?: string };

    expect(body.message).toContain('rehydrate_allow');
  });
});

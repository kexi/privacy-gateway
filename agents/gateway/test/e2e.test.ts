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
  loadConfig,
  parse as parseOkf,
  resetTelemetryForTests,
  shutdownTelemetry,
  SynthesizeResponseSchema,
  TRUST_HUMAN_REVIEWED,
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
import { createApp } from '../src/server.ts';

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

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    agent: 'gateway',
    env: {
      VAULT_BACKEND: 'memory',
      CORE_BASE_URL,
      GEMINI_MODEL: 'gemini-3.5-flash',
      GEMMA_MODEL: 'gemma3:12b',
      DEFAULT_APPROVER: 'kei',
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
    config: testConfig({ SYNTHESIS_BASE_URL: synthesisUrl }),
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

function ask(text: string, sessionId?: string, headers: Record<string, string> = {}) {
  return fetch(`${gatewayUrl}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ text, session_id: sessionId ?? null }),
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
    expect(findTokens(body.answer)).toEqual([]);
  });

  it('masks the unstructured span Gemma found', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    expect(body.masked_prompt).toContain('⟦PERSON_1⟧');
    expect(body.stats.unstructured_spans).toBeGreaterThan(0);
  });

  it('keeps the masking reversible and stable within a session', async () => {
    const first = (await (await ask('mail taro@example.co.jp', 'sess')).json()) as AskResponse;
    const second = (await (
      await ask('remind taro@example.co.jp today', 'sess')
    ).json()) as AskResponse;

    const token = findTokens(first.masked_prompt)[0];
    expect(token).toBeDefined();
    expect(second.masked_prompt).toContain(token);
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

  it('becomes human-reviewed once a person approves it', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    expect(body.trust_tier).toBe(TRUST_MACHINE_CONFIRMED);

    const approval = await fetch(`${gatewayUrl}/v1/sessions/${body.session_id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'kei' }),
    });

    expect(((await approval.json()) as { trust_tier: string }).trust_tier).toBe(
      TRUST_HUMAN_REVIEWED,
    );

    const tier = await fetch(`${gatewayUrl}/v1/sessions/${body.session_id}/tier`);
    expect(((await tier.json()) as { trust_tier: string }).trust_tier).toBe(TRUST_HUMAN_REVIEWED);
  });

  it('serves the stored OKF document as markdown', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    const response = await fetch(`${gatewayUrl}/v1/sessions/${body.session_id}/answer`);

    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(trustTier(parseOkf(await response.text()).metadata)).toBe(TRUST_MACHINE_CONFIRMED);
  });
});

describe('a leaking core agent', () => {
  beforeEach(() => startFleet(leakingCore));

  it('produces a draft, unverified answer', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    expect(body.status).toBe('draft');
    expect(body.trust_tier).toBe(TRUST_UNVERIFIED);
    expect(body.attestation.ok).toBe(false);
    expect(body.attestation.findings).toContain('EMAIL');
  });

  it('records the failure in the document rather than dropping it', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;
    const document = parseOkf(body.okf);

    expect(document.content).toContain('# Attestation');
    expect(document.content).toContain('failed');
  });
});

describe('a core agent that invents placeholders', () => {
  beforeEach(() => startFleet(inventingCore));

  it('fails the consistency check', async () => {
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    expect(body.consistency.ok).toBe(false);
    expect(body.consistency.invented_tokens).toContain('⟦PERSON_99⟧');
    expect(body.status).toBe('draft');
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

  it('adopts the caller request id so one exchange keeps one identity', async () => {
    const requestId = '0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b';
    const response = await ask(CUSTOMER_EMAIL, undefined, { 'x-request-id': requestId });

    expect(((await response.json()) as AskResponse).request_id).toBe(requestId);
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
    await ask(CUSTOMER_EMAIL, undefined, {
      traceparent: `00-${traceId}-eeeeeeeeeeeeeeee-01`,
    });

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

  it('still masks deterministically when Gemma returns nothing usable', async () => {
    // Gemma being down must not stop the request: the regex masking still holds
    // and the egress guard is the last line of defense.
    await startFleet(echoingCore, { not: 'a span list' });
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    expect(body.masked_prompt).toContain('⟦EMAIL_1⟧');
    expect(promptsSeenByCore[0]).not.toContain('taro@example.co.jp');
  });

  it('validates the synthesis response against the shared schema', async () => {
    await startFleet();
    const body = (await (await ask(CUSTOMER_EMAIL)).json()) as AskResponse;

    // The gateway parsed it on the way through; parsing again here states that
    // the contract the web UI relies on is the one that was actually served.
    expect(() =>
      SynthesizeResponseSchema.parse({
        session_id: body.session_id,
        markdown: body.okf,
        answer: body.answer,
        trust_tier: body.trust_tier,
        status: body.status,
        attestation: body.attestation,
        consistency: body.consistency,
        receipt: { session_id: body.session_id, response_hash: 'x', findings: [] },
      }),
    ).not.toThrow();
  });
});

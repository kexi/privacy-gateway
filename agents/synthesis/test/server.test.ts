/**
 * What the Synthesis HTTP surface guarantees: a released answer comes back once
 * and is never stored, a refused release returns its own status with no body,
 * and every stored artifact is masked.
 */

import {
  createLogger,
  loadConfig,
  InMemoryTokenVault,
  parse as parseOkf,
  TRUST_MACHINE_CONFIRMED,
  TRUST_UNVERIFIED,
  trustTier,
  type Config,
} from '@privacy-gateway/common';
import type express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.ts';
import { InMemoryAnswerStore } from '../src/store.ts';

const MASKED_PROMPT = 'Reply to ⟦PERSON_1⟧ at ⟦EMAIL_1⟧';
const REQUEST_ID = '01920000-0000-7000-8000-000000000001';

let app: express.Application;
let vault: InMemoryTokenVault;
let store: InMemoryAnswerStore;
let baseUrl: string;
let server: ReturnType<express.Application['listen']>;
let generation: number;

function testConfig(): Config {
  return loadConfig({
    agent: 'synthesis',
    env: { VAULT_BACKEND: 'memory' },
    onInvalid: (message) => {
      throw new Error(message);
    },
  });
}

beforeEach(async () => {
  vault = new InMemoryTokenVault();
  store = new InMemoryAnswerStore();
  const entry = await vault.put(
    REQUEST_ID,
    { '⟦PERSON_1⟧': 'Taro Yamada', '⟦EMAIL_1⟧': 'taro@example.co.jp' },
    3600,
  );
  generation = entry.generation;

  app = await createApp({
    config: testConfig(),
    logger: createLogger({ agent: 'synthesis', write: () => undefined }),
    vault,
    store,
  });

  // A real listener is used rather than a request helper, so the routes are
  // exercised over HTTP exactly as the Gateway calls them.
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  return () => {
    server.close();
  };
});

function synthesize(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/v1/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function cleanRequest(overrides: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    masked_prompt: MASKED_PROMPT,
    core_answer: 'Dear ⟦PERSON_1⟧, we will write to ⟦EMAIL_1⟧.',
    generated_by: 'core_agent/gemini-3.5-flash',
    known_tokens: ['⟦PERSON_1⟧', '⟦EMAIL_1⟧'],
    vault_generation: generation,
    ...overrides,
  };
}

describe('health', () => {
  it('reports which agent answered', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(await response.json()).toEqual({ status: 'ok', agent: 'synthesis' });
  });
});

describe('POST /v1/synthesize', () => {
  it('returns the rehydrated answer and its OKF document', async () => {
    const response = await synthesize(cleanRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      answer: string;
      markdown: string;
      trust_tier: string;
      dimensions: Record<string, string>;
    };
    expect(body.answer).toContain('Taro Yamada');
    expect(body.trust_tier).toBe(TRUST_MACHINE_CONFIRMED);
    expect(body.markdown).toContain('type: Gateway Answer');
    expect(body.dimensions.review_identity).toBe('none');
  });

  it('echoes the request id it was given', async () => {
    const response = await synthesize(cleanRequest());
    const body = (await response.json()) as { request_id: string };
    expect(body.request_id).toBe(REQUEST_ID);
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('persists masked artifacts and never the rehydrated answer', async () => {
    await synthesize(cleanRequest());
    const record = await store.get(REQUEST_ID);

    expect(record?.okf).toContain('type: Gateway Answer');
    expect(record?.maskedPrompt).toBe(MASKED_PROMPT);
    expect(record?.coreResponse).toContain('⟦PERSON_1⟧');

    const stored = JSON.stringify(record);
    expect(stored).not.toContain('Taro Yamada');
    expect(stored).not.toContain('taro@example.co.jp');
  });

  it('gives the stored record an expiry so the TTL policy can sweep it', async () => {
    await synthesize(cleanRequest());
    const record = await store.get(REQUEST_ID);
    expect(record?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a request missing required fields', async () => {
    const response = await synthesize({ request_id: REQUEST_ID });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_request');
    expect(body.message).toContain('masked_prompt');
  });
});

describe('a refused release', () => {
  it('returns 422 with no answer when Core leaked raw PII', async () => {
    const response = await synthesize(
      cleanRequest({ core_answer: 'Write to leaked.person@example.com instead.' }),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('leak_check_failed');
    expect(body['categories']).toContain('EMAIL');
    expect(body['answer']).toBeUndefined();
  });

  it('does not echo the unsafe body back to the caller', async () => {
    const response = await synthesize(
      cleanRequest({ core_answer: 'Write to leaked.person@example.com instead.' }),
    );
    expect(await response.text()).not.toContain('leaked.person@example.com');
  });

  it('persists a draft evidence record carrying no released answer', async () => {
    // A blocked request is exactly the one an auditor asks about later, so the
    // masked record is still written.
    await synthesize(cleanRequest({ core_answer: 'Write to leaked.person@example.com.' }));
    const record = await store.get(REQUEST_ID);

    expect(record).not.toBeNull();
    const metadata = parseOkf(record?.okf ?? '').metadata;
    expect(metadata['status']).toBe('draft');
    expect(trustTier(metadata)).toBe(TRUST_UNVERIFIED);
  });

  it('returns 409 when Core invented a placeholder', async () => {
    const response = await synthesize(cleanRequest({ core_answer: 'See ⟦PERSON_99⟧.' }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('invented_token');
  });

  it('returns 409 when the vault generation no longer matches', async () => {
    const response = await synthesize(cleanRequest({ vault_generation: generation + 1 }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('vault_generation_mismatch');
  });
});

describe('GET /v1/requests/:id/evidence', () => {
  it('returns the stored document as markdown', async () => {
    await synthesize(cleanRequest());
    const response = await fetch(`${baseUrl}/v1/requests/${REQUEST_ID}/evidence`);

    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(await response.text()).toContain('type: Gateway Answer');
  });

  it('never serves a rehydrated value', async () => {
    await synthesize(cleanRequest());
    const body = await (await fetch(`${baseUrl}/v1/requests/${REQUEST_ID}/evidence`)).text();
    expect(body).not.toContain('Taro Yamada');
  });

  it('reports an unknown request as 404', async () => {
    const response = await fetch(`${baseUrl}/v1/requests/nope/evidence`);
    expect(response.status).toBe(404);
  });
});

describe('the masked source artifacts', () => {
  it('serves the masked prompt the OKF sources name', async () => {
    // Without this route the `sources[]` entry would be a dangling link and the
    // recorded digest could not be re-derived.
    await synthesize(cleanRequest());
    const response = await fetch(`${baseUrl}/v1/requests/${REQUEST_ID}/masked-prompt.md`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MASKED_PROMPT);
  });

  it('serves the tokenized core response', async () => {
    await synthesize(cleanRequest());
    const body = await (
      await fetch(`${baseUrl}/v1/requests/${REQUEST_ID}/core-response.md`)
    ).text();

    expect(body).toContain('⟦PERSON_1⟧');
    expect(body).not.toContain('Taro Yamada');
  });

  it('reports an unknown request as 404', async () => {
    const response = await fetch(`${baseUrl}/v1/requests/nope/masked-prompt.md`);
    expect(response.status).toBe(404);
  });
});

describe('routes that no longer exist', () => {
  it('has no approval route', async () => {
    // Approval was removed: the gateway authenticates nobody, so a `human:`
    // actor minted from a click would name no one.
    const response = await fetch(`${baseUrl}/v1/sessions/${REQUEST_ID}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'kei' }),
    });
    expect(response.status).toBe(404);
  });
});

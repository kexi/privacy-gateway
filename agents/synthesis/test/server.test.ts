/**
 * What the Synthesis HTTP surface guarantees: the OKF document is stored and
 * returned verbatim, approval raises the trust tier, and an invalid request is
 * rejected before any work is done.
 */

import {
  createLogger,
  loadConfig,
  InMemoryTokenVault,
  parse as parseOkf,
  TRUST_HUMAN_REVIEWED,
  TRUST_MACHINE_CONFIRMED,
  trustTier,
  type Config,
} from '@privacy-gateway/common';
import type express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.ts';
import { InMemoryAnswerStore } from '../src/store.ts';

const MASKED_PROMPT = 'Reply to ⟦PERSON_1⟧ at ⟦EMAIL_1⟧';

let app: express.Application;
let vault: InMemoryTokenVault;
let store: InMemoryAnswerStore;
let baseUrl: string;
let server: ReturnType<express.Application['listen']>;

function testConfig(): Config {
  return loadConfig({
    agent: 'synthesis',
    env: { VAULT_BACKEND: 'memory', DEFAULT_APPROVER: 'kei' },
    onInvalid: (message) => {
      throw new Error(message);
    },
  });
}

beforeEach(async () => {
  vault = new InMemoryTokenVault();
  store = new InMemoryAnswerStore();
  await vault.put('s1', { '⟦PERSON_1⟧': 'Taro Yamada', '⟦EMAIL_1⟧': 'taro@example.co.jp' }, 3600);

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

const CLEAN_REQUEST = {
  session_id: 's1',
  masked_prompt: MASKED_PROMPT,
  core_answer: 'Dear ⟦PERSON_1⟧, we will write to ⟦EMAIL_1⟧.',
  generated_by: 'core_agent/gemini-3.5-flash',
};

describe('health', () => {
  it('reports which agent answered', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(await response.json()).toEqual({ status: 'ok', agent: 'synthesis' });
  });
});

describe('POST /v1/synthesize', () => {
  it('returns the rehydrated answer and its OKF document', async () => {
    const response = await synthesize(CLEAN_REQUEST);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      answer: string;
      markdown: string;
      trust_tier: string;
    };
    expect(body.answer).toContain('Taro Yamada');
    expect(body.trust_tier).toBe(TRUST_MACHINE_CONFIRMED);
    expect(body.markdown).toContain('type: Gateway Answer');
  });

  it('echoes the request id it was given', async () => {
    const requestId = '0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b';
    const response = await synthesize({ ...CLEAN_REQUEST, request_id: requestId });

    const body = (await response.json()) as { request_id: string };
    expect(body.request_id).toBe(requestId);
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('persists the document for later retrieval', async () => {
    await synthesize(CLEAN_REQUEST);
    expect(await store.get('s1')).toContain('type: Gateway Answer');
  });

  it('rejects a request missing required fields', async () => {
    const response = await synthesize({ session_id: 's1' });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_request');
    expect(body.message).toContain('masked_prompt');
  });

  it('marks a leaking answer draft', async () => {
    const response = await synthesize({
      ...CLEAN_REQUEST,
      core_answer: 'Write to leaked.person@example.com instead.',
    });

    const body = (await response.json()) as { status: string; attestation: { ok: boolean } };
    expect(body.status).toBe('draft');
    expect(body.attestation.ok).toBe(false);
  });
});

describe('GET /v1/sessions/:id/answer', () => {
  it('returns the stored document as markdown', async () => {
    await synthesize(CLEAN_REQUEST);
    const response = await fetch(`${baseUrl}/v1/sessions/s1/answer`);

    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(await response.text()).toContain('type: Gateway Answer');
  });

  it('reports an unknown session as 404', async () => {
    const response = await fetch(`${baseUrl}/v1/sessions/nope/answer`);
    expect(response.status).toBe(404);
  });
});

describe('POST /v1/sessions/:id/approve', () => {
  it('raises the tier to human-reviewed', async () => {
    await synthesize(CLEAN_REQUEST);
    const response = await fetch(`${baseUrl}/v1/sessions/s1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'kei' }),
    });

    const body = (await response.json()) as { trust_tier: string; markdown: string };
    expect(body.trust_tier).toBe(TRUST_HUMAN_REVIEWED);
    expect(trustTier(parseOkf(body.markdown).metadata)).toBe(TRUST_HUMAN_REVIEWED);
  });

  it('normalizes a bare approver id to the human: actor form', async () => {
    // SPEC §7: the prefix is what the trust-tier derivation keys on.
    await synthesize(CLEAN_REQUEST);
    const response = await fetch(`${baseUrl}/v1/sessions/s1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice' }),
    });

    const body = (await response.json()) as { markdown: string };
    const verified = parseOkf(body.markdown).metadata['verified'] as Array<{ by: string }>;
    expect(verified.some((entry) => entry.by === 'human:alice')).toBe(true);
  });

  it('keeps the approval in the stored document', async () => {
    await synthesize(CLEAN_REQUEST);
    await fetch(`${baseUrl}/v1/sessions/s1/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(trustTier(parseOkf((await store.get('s1')) ?? '').metadata)).toBe(TRUST_HUMAN_REVIEWED);
  });

  it('reports an unknown session as 404', async () => {
    const response = await fetch(`${baseUrl}/v1/sessions/nope/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });
});

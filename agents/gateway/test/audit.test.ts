/**
 * What the read-only audit view guarantees.
 *
 * Two separate promises are asserted here. The token gate must be a real gate:
 * an unset `ADMIN_TOKEN` removes the surface entirely, and a wrong token is
 * indistinguishable from the surface not existing — both 404, never 401, so the
 * endpoint is not advertised to anyone who does not already hold the token.
 *
 * And the list must be metadata only. The row a judge sees carries ids,
 * statuses, verdicts and counts; it must never carry the OKF body, the masked
 * prompt or the core response, because the list is the one place where evidence
 * for many requests is visible at once.
 */

import {
  buildGatewayAnswer,
  createLogger,
  dump,
  loadConfig,
  type Config,
} from '@privacy-gateway/common';
import type express from 'express';
import { describe, expect, it } from 'vitest';
import {
  countPlaceholders,
  InMemoryAuditStore,
  toEntry,
  tokenMatches,
  presentedToken,
} from '../src/audit.ts';
import { createApp } from '../src/server.ts';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REQUEST_ID = '01920000-0000-7000-8000-000000000001';
const OLDER_REQUEST_ID = '01910000-0000-7000-8000-000000000000';

const SHA = 'a'.repeat(64);

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    agent: 'gateway',
    env: {
      VAULT_BACKEND: 'memory',
      CORE_BASE_URL: 'http://core.test',
      RATE_LIMIT_PER_MINUTE: '0',
      ...overrides,
    },
  });
}

const quietLogger = () => createLogger({ agent: 'gateway', write: () => undefined });

/** One stored evidence record, in the shape the Firestore documents use. */
function record(
  requestId: string,
  options: { readonly pass?: boolean; readonly maskedPrompt?: string } = {},
): Record<string, unknown> {
  const passed = options.pass ?? true;
  const document = buildGatewayAnswer({
    requestId,
    generatedBy: 'synthesis_agent/0.1.0',
    coreActor: 'core_agent/gemini-3.5-flash',
    maskedAnswerBody: 'The masked answer for ⟦EMAIL_1⟧.',
    staleAfter: new Date(Date.now() + 3_600_000),
    traceId: 'f'.repeat(32),
    verifiedBy: `process:leak-check@${SHA.slice(0, 12)}`,
    attestation: passed
      ? { ok: true, findings: [] }
      : { ok: false, findings: ['EMAIL'], reason: 'the answer contained a raw address' },
    evidence: {
      computation: 'knowledge/computations/leak-check.md',
      computationSha256: SHA,
      attesterSha256: SHA,
      maskedPromptSha256: SHA,
      coreResponseSha256: SHA,
      checkedAt: new Date(),
      withheld: ['CREDIT_CARD'],
    },
  });

  return {
    request_id: requestId,
    okf: dump(document),
    masked_prompt: options.maskedPrompt ?? 'Contact ⟦EMAIL_1⟧ about ⟦CREDIT_CARD_1⟧ and ⟦EMAIL_1⟧.',
    core_response: 'Reply to ⟦EMAIL_1⟧.',
    expires_at: new Date(Date.now() + 3_600_000),
  };
}

function storeWith(...records: Array<Record<string, unknown>>): InMemoryAuditStore {
  const store = new InMemoryAuditStore();
  for (const item of records) store.add(item);
  return store;
}

function appWith(
  overrides: Record<string, string>,
  store?: InMemoryAuditStore,
): express.Application {
  return createApp({
    config: config(overrides),
    logger: quietLogger(),
    ...(store === undefined ? {} : { auditStore: store }),
  });
}

/** Drives the app over a real socket, so the route table is what is tested. */
async function get(
  app: express.Application,
  pathAndQuery: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, { headers });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body (the HTML page) is returned as text.
    }
    return { status: response.status, body };
  } finally {
    server.close();
  }
}

describe('audit token gate', () => {
  it('answers 404 when ADMIN_TOKEN is unset, so the feature is genuinely absent', async () => {
    const app = appWith({}, storeWith(record(REQUEST_ID)));

    const withoutToken = await get(app, '/v1/audit');
    const withToken = await get(app, '/v1/audit', { 'X-Admin-Token': TOKEN });

    // Identical answers: with no token configured there is nothing a caller
    // could present that would make the route exist.
    expect(withoutToken.status).toBe(404);
    expect(withToken.status).toBe(404);
  });

  it('answers 404 — never 401 — for a wrong token, so the surface stays unadvertised', async () => {
    const app = appWith({ ADMIN_TOKEN: TOKEN }, storeWith(record(REQUEST_ID)));

    for (const attempt of ['', 'wrong', `${TOKEN}x`, TOKEN.slice(1)]) {
      const response = await get(app, '/v1/audit', { 'X-Admin-Token': attempt });
      expect(response.status, `for ${attempt || '(empty header)'}`).toBe(404);
    }
    expect((await get(app, '/v1/audit')).status).toBe(404);
  });

  it('treats an empty ADMIN_TOKEN as the feature being off', async () => {
    const app = appWith({ ADMIN_TOKEN: '   ' }, storeWith(record(REQUEST_ID)));

    expect((await get(app, '/v1/audit', { 'X-Admin-Token': '   ' })).status).toBe(404);
  });

  it('accepts the token only from the header, never from the query string', async () => {
    // A query-parameter capability lands verbatim in Cloud Run's request log
    // (`httpRequest.requestUrl`), so the correct token in `?key=` must not open
    // the route.
    const app = appWith({ ADMIN_TOKEN: TOKEN }, storeWith(record(REQUEST_ID)));

    expect((await get(app, '/v1/audit', { 'X-Admin-Token': TOKEN })).status).toBe(200);
    expect((await get(app, `/v1/audit?key=${TOKEN}`)).status).toBe(404);
  });

  it('never logs the presented token, right or wrong', async () => {
    const lines: string[] = [];
    const app = createApp({
      config: config({ ADMIN_TOKEN: TOKEN }),
      logger: createLogger({
        agent: 'gateway',
        write: (line: string) => {
          lines.push(line);
        },
      }),
      auditStore: storeWith(record(REQUEST_ID)),
    });

    await get(app, '/v1/audit', { 'X-Admin-Token': 'wrong-token-value' });
    await get(app, '/v1/audit', { 'X-Admin-Token': TOKEN });

    const joined = lines.join('\n');
    expect(joined).toContain('audit.denied');
    expect(joined).toContain('audit.list');
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain('wrong-token-value');
  });
});

describe('audit list shape', () => {
  it('returns evidence metadata and no document bodies', async () => {
    const app = appWith({ ADMIN_TOKEN: TOKEN }, storeWith(record(REQUEST_ID)));

    const response = await get(app, '/v1/audit', { 'X-Admin-Token': TOKEN });
    expect(response.status).toBe(200);

    const body = response.body as { entries: Array<Record<string, unknown>>; limit: number };
    expect(body.limit).toBe(50);
    expect(body.entries).toHaveLength(1);

    const entry = body.entries[0];
    expect(entry).toMatchObject({
      request_id: REQUEST_ID,
      status: 'stable',
      trust_tier: 'machine-confirmed',
      attestation_verdict: 'pass',
      judge_retries: 0,
      withheld: ['CREDIT_CARD'],
    });
    expect(entry?.['stale_after']).toEqual(expect.any(String));
    expect(entry?.['trace_id']).toBe('f'.repeat(32));

    // The list is metadata. Every body-bearing key must be absent, or a judge
    // browsing the index would be reading evidence they never asked to open.
    for (const forbidden of ['okf', 'masked_prompt', 'core_response', 'answer', 'body']) {
      expect(entry, `entry must not carry ${forbidden}`).not.toHaveProperty(forbidden);
    }
    // And the serialized response as a whole must not contain the OKF text.
    expect(JSON.stringify(body)).not.toContain('Gateway answer for request');
  });

  it('orders newest first, by the UUIDv7 that is the request id', async () => {
    const app = appWith(
      { ADMIN_TOKEN: TOKEN },
      storeWith(record(OLDER_REQUEST_ID), record(REQUEST_ID)),
    );

    const body = (await get(app, '/v1/audit', { 'X-Admin-Token': TOKEN })).body as {
      entries: Array<{ request_id: string }>;
    };
    expect(body.entries.map((entry) => entry.request_id)).toEqual([REQUEST_ID, OLDER_REQUEST_ID]);
  });

  it('reports a failed attestation as draft and unverified rather than hiding it', async () => {
    const app = appWith({ ADMIN_TOKEN: TOKEN }, storeWith(record(REQUEST_ID, { pass: false })));

    const body = (await get(app, '/v1/audit', { 'X-Admin-Token': TOKEN })).body as {
      entries: Array<Record<string, unknown>>;
    };
    expect(body.entries[0]).toMatchObject({
      status: 'draft',
      trust_tier: 'unverified',
      attestation_verdict: 'fail',
    });
  });
});

describe('list mapping', () => {
  it('counts distinct placeholders per category, not occurrences', () => {
    // ⟦EMAIL_1⟧ appears twice; it is one masked value, and counting it twice
    // would overstate how much of the prompt was personal data.
    expect(countPlaceholders('a ⟦EMAIL_1⟧ b ⟦EMAIL_1⟧ c ⟦EMAIL_2⟧ d ⟦PHONE_1⟧')).toEqual({
      EMAIL: 2,
      PHONE: 1,
    });
  });

  it('counts nothing for a prompt with no placeholders', () => {
    expect(countPlaceholders('nothing personal here')).toEqual({});
  });

  it('keeps a record whose OKF will not parse, marking it unknown', () => {
    const entry = toEntry({
      request_id: REQUEST_ID,
      okf: 'not a document: no frontmatter at all',
      masked_prompt: 'hello ⟦EMAIL_1⟧',
    });

    // §11: a consumer must not reject a broken document, and §10.5 says a failed
    // attestation is displayed rather than dropped. The row survives.
    expect(entry).toMatchObject({
      request_id: REQUEST_ID,
      status: 'unknown',
      trust_tier: 'unverified',
      attestation_verdict: 'unknown',
      counts_by_category: { EMAIL: 1 },
      masked_count: 1,
    });
  });

  it('skips a record with no usable id, since a row could not link anywhere', () => {
    expect(toEntry({ okf: 'anything' })).toBeNull();
    expect(toEntry({ request_id: '' })).toBeNull();
  });

  it('reports a judge retry count when the attestation recorded one', () => {
    const base = record(REQUEST_ID);
    const withRetries = String(base['okf']).replace(
      '  verdict: pass',
      '  verdict: pass\n  judge_retries: 2',
    );

    expect(toEntry({ ...base, okf: withRetries })?.judge_retries).toBe(2);
  });
});

describe('token comparison', () => {
  it('rejects an empty configured token, so "off" can never authorise anyone', () => {
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('anything', '')).toBe(false);
  });

  it('rejects a prefix, a suffix and a differing token of equal length', () => {
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(`x${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
  });

  it('reads the header only, and reports absence as null', () => {
    expect(presentedToken('from-header')).toBe('from-header');
    // Express hands a repeated header through as an array; the first wins.
    expect(presentedToken(['first', 'second'])).toBe('first');
    expect(presentedToken(undefined)).toBeNull();
    expect(presentedToken('')).toBeNull();
  });
});

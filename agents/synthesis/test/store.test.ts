/**
 * What the evidence store guarantees: it holds only masked artifacts, keyed by
 * request id, and stops serving a record once its expiry has passed regardless
 * of whether the Firestore TTL sweeper has caught up.
 *
 * A fake client stands in for Firestore: these are the store's own rules, and
 * asserting them against a real database would test Google's TTL sweeper
 * instead.
 */

import type { FirestoreLike } from '@privacy-gateway/common';
import { describe, expect, it } from 'vitest';
import {
  buildAnswerStore,
  FirestoreAnswerStore,
  InMemoryAnswerStore,
  type EvidenceRecord,
} from '../src/store.ts';

const REQUEST_ID = '01920000-0000-7000-8000-000000000001';

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    requestId: REQUEST_ID,
    okf: '---\ntype: Gateway Answer\n---\n\nDear ⟦PERSON_1⟧.\n',
    maskedPrompt: 'Reply to ⟦PERSON_1⟧',
    coreResponse: 'Dear ⟦PERSON_1⟧.',
    expiresAt: new Date(Date.now() + 3600_000),
    ...overrides,
  };
}

/** Minimal in-memory stand-in for the Firestore surface the store uses. */
function fakeFirestore(): {
  client: FirestoreLike;
  docs: Map<string, Record<string, unknown>>;
} {
  const docs = new Map<string, Record<string, unknown>>();

  const client: FirestoreLike = {
    collection: (name: string) => ({
      doc: (id: string) => {
        const key = `${name}/${id}`;
        return {
          get: () => Promise.resolve({ exists: docs.has(key), data: () => docs.get(key) }),
          set: (data: Record<string, unknown>) => {
            docs.set(key, data);
            return Promise.resolve(undefined);
          },
          delete: () => {
            docs.delete(key);
            return Promise.resolve(undefined);
          },
        };
      },
    }),
  };
  return { client, docs };
}

describe('the in-memory store', () => {
  it('reads back what it stored', async () => {
    const store = new InMemoryAnswerStore();
    await store.put(record());

    const found = await store.get(REQUEST_ID);
    expect(found?.maskedPrompt).toBe('Reply to ⟦PERSON_1⟧');
    expect(found?.coreResponse).toBe('Dear ⟦PERSON_1⟧.');
  });

  it('returns nothing for an unknown request', async () => {
    expect(await new InMemoryAnswerStore().get('nope')).toBeNull();
  });

  it('stops serving a record once it has expired', async () => {
    // The document's own `stale_after` says it is past its life; serving it
    // anyway would contradict the freshness the document asserts.
    const store = new InMemoryAnswerStore();
    await store.put(record({ expiresAt: new Date(Date.now() - 1000) }));

    expect(await store.get(REQUEST_ID)).toBeNull();
  });
});

describe('the Firestore store', () => {
  it('writes only masked fields, under expires_at for the TTL policy', async () => {
    // `expires_at` deliberately matches the vault's field name so one TTL policy
    // shape covers both collections.
    const { client, docs } = fakeFirestore();
    const store = new FirestoreAnswerStore({ client, collection: 'gateway_answers' });
    await store.put(record());

    const stored = docs.get(`gateway_answers/${REQUEST_ID}`);
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      'core_response',
      'expires_at',
      'masked_prompt',
      'okf',
      'request_id',
    ]);
    expect(stored?.['expires_at']).toBeInstanceOf(Date);
  });

  it('holds no rehydrated value anywhere in the document', async () => {
    const { client, docs } = fakeFirestore();
    const store = new FirestoreAnswerStore({ client, collection: 'gateway_answers' });
    await store.put(record());

    const stored = JSON.stringify(docs.get(`gateway_answers/${REQUEST_ID}`));
    expect(stored).toContain('⟦PERSON_1⟧');
    expect(stored).not.toContain('Taro Yamada');
  });

  it('refuses to serve an expired record the TTL sweeper has not reached', async () => {
    const { client } = fakeFirestore();
    const store = new FirestoreAnswerStore({ client, collection: 'gateway_answers' });
    await store.put(record({ expiresAt: new Date(Date.now() - 1000) }));

    expect(await store.get(REQUEST_ID)).toBeNull();
  });

  it('returns nothing for an unknown request', async () => {
    const { client } = fakeFirestore();
    const store = new FirestoreAnswerStore({ client, collection: 'gateway_answers' });
    expect(await store.get('nope')).toBeNull();
  });
});

describe('backend selection', () => {
  it('selects the memory backend by name', () => {
    expect(buildAnswerStore('memory')).toBeInstanceOf(InMemoryAnswerStore);
  });

  it('rejects an unknown backend loudly', () => {
    expect(() => buildAnswerStore('postgres')).toThrow(/unknown VAULT_BACKEND/u);
  });
});

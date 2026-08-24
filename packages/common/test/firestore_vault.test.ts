/**
 * What the Firestore vault guarantees: the same contract as the in-memory one —
 * merge on append, never extend the expiry, and refuse to serve an entry past
 * `expires_at` even when the TTL policy has not swept it yet.
 *
 * A fake client stands in for Firestore: these are the vault's own rules, and
 * asserting them against a real database would test Google's TTL sweeper
 * instead.
 */

import { describe, expect, it } from 'vitest';
import { FirestoreTokenVault, type FirestoreLike } from '../src/vault.ts';

/** Minimal in-memory stand-in for the Firestore surface the vault uses. */
function fakeFirestore(seed: Record<string, Record<string, unknown>> = {}): {
  client: FirestoreLike;
  docs: Map<string, Record<string, unknown>>;
} {
  const docs = new Map<string, Record<string, unknown>>(Object.entries(seed));

  const client: FirestoreLike = {
    collection: (name: string) => ({
      doc: (id: string) => {
        const key = `${name}/${id}`;
        return {
          get: () =>
            Promise.resolve({
              exists: docs.has(key),
              data: () => docs.get(key),
            }),
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

function vaultWith(seed: Record<string, Record<string, unknown>> = {}) {
  const { client, docs } = fakeFirestore(seed);
  return { vault: new FirestoreTokenVault({ client, collection: 'token_vault' }), docs };
}

describe('storage', () => {
  it('writes the mapping under the session id', async () => {
    const { vault, docs } = vaultWith();
    await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);

    const stored = docs.get('token_vault/s1');
    expect(stored?.['session_id']).toBe('s1');
    expect(stored?.['mapping']).toEqual({ '⟦EMAIL_1⟧': 'a@b.co' });
    expect(stored?.['expires_at']).toBeInstanceOf(Date);
  });

  it('reads back what it wrote', async () => {
    const { vault } = vaultWith();
    await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);

    expect((await vault.get('s1'))?.mapping).toEqual({ '⟦EMAIL_1⟧': 'a@b.co' });
  });

  it('returns nothing for an unknown session', async () => {
    const { vault } = vaultWith();
    expect(await vault.get('nope')).toBeNull();
  });

  it('forgets a deleted session', async () => {
    const { vault, docs } = vaultWith();
    await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);
    await vault.delete('s1');

    expect(docs.has('token_vault/s1')).toBe(false);
    expect(await vault.get('s1')).toBeNull();
  });
});

describe('merging and expiry', () => {
  it('merges into an existing live mapping', async () => {
    const { vault } = vaultWith();
    await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);
    await vault.put('s1', { '⟦PHONE_1⟧': '090-1234-5678' }, 60);

    const entry = await vault.get('s1');
    expect(Object.keys(entry?.mapping ?? {}).sort()).toEqual(['⟦EMAIL_1⟧', '⟦PHONE_1⟧']);
  });

  it('does not extend the expiry when appending', async () => {
    // stale_after is contracted to match the vault expiry, so an append must not
    // move it.
    const { vault } = vaultWith();
    const first = await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);
    const second = await vault.put('s1', { '⟦PHONE_1⟧': '090-1234-5678' }, 3600);

    expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime());
  });

  it('starts a fresh mapping when the stored one has expired', async () => {
    const expired = new Date(Date.now() - 1000);
    const { vault } = vaultWith({
      'token_vault/s1': { mapping: { '⟦EMAIL_1⟧': 'old@b.co' }, expires_at: expired },
    });

    const entry = await vault.put('s1', { '⟦PHONE_1⟧': '090-1234-5678' }, 60);
    expect(entry.mapping).toEqual({ '⟦PHONE_1⟧': '090-1234-5678' });
    expect(entry.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to serve an entry the TTL sweeper has not reached yet', async () => {
    // TTL policy deletions lag behind, so the reader checks the expiry as well.
    const { vault } = vaultWith({
      'token_vault/s1': {
        mapping: { '⟦EMAIL_1⟧': 'a@b.co' },
        expires_at: new Date(Date.now() - 1000),
      },
    });

    expect(await vault.get('s1')).toBeNull();
  });

  it('treats a document without an expiry as unreadable', async () => {
    // Without a bound there is no way to honour the freshness contract, so the
    // safe answer is to behave as if the mapping is gone.
    const { vault } = vaultWith({ 'token_vault/s1': { mapping: { '⟦EMAIL_1⟧': 'a@b.co' } } });
    expect(await vault.get('s1')).toBeNull();
  });
});

describe('stored value coercion', () => {
  it('accepts a Firestore Timestamp', async () => {
    // The real client returns a Timestamp, not a Date.
    const future = new Date(Date.now() + 60_000);
    const { vault } = vaultWith({
      'token_vault/s1': {
        mapping: { '⟦EMAIL_1⟧': 'a@b.co' },
        expires_at: { toDate: () => future },
      },
    });

    expect((await vault.get('s1'))?.expiresAt.getTime()).toBe(future.getTime());
  });

  it('accepts an ISO string expiry', async () => {
    const future = new Date(Date.now() + 60_000);
    const { vault } = vaultWith({
      'token_vault/s1': {
        mapping: { '⟦EMAIL_1⟧': 'a@b.co' },
        expires_at: future.toISOString(),
      },
    });

    expect((await vault.get('s1'))?.expiresAt.getTime()).toBe(future.getTime());
  });

  it('drops non-string mapping values rather than failing', async () => {
    // A hand-edited or partially migrated document must not crash the read path.
    const { vault } = vaultWith({
      'token_vault/s1': {
        mapping: { '⟦EMAIL_1⟧': 'a@b.co', '⟦BAD_1⟧': 42 },
        expires_at: new Date(Date.now() + 60_000),
      },
    });

    expect((await vault.get('s1'))?.mapping).toEqual({ '⟦EMAIL_1⟧': 'a@b.co' });
  });

  it('treats a malformed expiry as no expiry at all', async () => {
    const { vault } = vaultWith({
      'token_vault/s1': { mapping: {}, expires_at: 'not a date' },
    });
    expect(await vault.get('s1')).toBeNull();
  });
});

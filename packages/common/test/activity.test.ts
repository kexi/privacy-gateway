/**
 * What the activity clock guarantees.
 *
 * Two properties matter. First, that recording activity can never fail a
 * request: the badge it feeds is a convenience, and a convenience that can take
 * down the gateway is a liability. Second, that "never recorded" and "could not
 * be read" stay distinguishable all the way up, because one means cold and the
 * other means unknown.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FirestoreActivityStore,
  InMemoryActivityStore,
  buildActivityStore,
  recordGemmaActivity,
  type ActivityStore,
} from '../src/activity.ts';

describe('InMemoryActivityStore', () => {
  it('reports nothing until an activity is recorded', async () => {
    const store = new InMemoryActivityStore();
    await expect(store.read()).resolves.toBeNull();
  });

  it('returns the instant that was recorded', async () => {
    const store = new InMemoryActivityStore();
    const at = new Date('2026-08-30T12:00:00.000Z');

    await store.record(at);

    await expect(store.read()).resolves.toEqual(at);
  });

  it('keeps only the most recent instant', async () => {
    const store = new InMemoryActivityStore();
    await store.record(new Date('2026-08-30T12:00:00.000Z'));
    const later = new Date('2026-08-30T12:05:00.000Z');

    await store.record(later);

    await expect(store.read()).resolves.toEqual(later);
  });
});

describe('recordGemmaActivity', () => {
  it('does not await the write', () => {
    let settled = false;
    const store: ActivityStore = {
      record: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve();
          }, 50);
        }),
      read: () => Promise.resolve(null),
    };

    recordGemmaActivity(store);

    // The call returned before the store did: this is what keeps a Firestore
    // round trip off the request's critical path.
    expect(settled).toBe(false);
  });

  it('swallows a rejected write so the caller never sees it', async () => {
    const store: ActivityStore = {
      record: () => Promise.reject(new Error('firestore is unreachable')),
      read: () => Promise.resolve(null),
    };

    expect(() => {
      recordGemmaActivity(store);
    }).not.toThrow();

    // An unhandled rejection would fail the suite on the next tick; waiting for
    // one proves the promise was caught rather than merely ignored.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('swallows a store that throws synchronously', () => {
    const store = {
      record: () => {
        throw new Error('client construction failed');
      },
      read: () => Promise.resolve(null),
    } as unknown as ActivityStore;

    expect(() => {
      recordGemmaActivity(store);
    }).not.toThrow();
  });

  it('is a no-op when no store is configured', () => {
    expect(() => {
      recordGemmaActivity(undefined);
    }).not.toThrow();
  });
});

/** A minimal double over the two calls this store makes. */
function fakeFirestore(initial?: Record<string, unknown>) {
  const state: { data: Record<string, unknown> | undefined } = { data: initial };
  const doc = {
    get: vi.fn(() =>
      Promise.resolve({
        exists: state.data !== undefined,
        data: () => state.data,
      }),
    ),
    set: vi.fn((value: Record<string, unknown>) => {
      state.data = value;
      return Promise.resolve(undefined);
    }),
  };
  return {
    doc,
    client: { collection: () => ({ doc: () => doc }) },
  };
}

describe('FirestoreActivityStore', () => {
  it('writes the instant as an ISO string', async () => {
    const { client, doc } = fakeFirestore();
    const store = new FirestoreActivityStore({ client });
    const at = new Date('2026-08-30T12:00:00.000Z');

    await store.record(at);

    expect(doc.set).toHaveBeenCalledWith({ last_active_at: '2026-08-30T12:00:00.000Z' });
  });

  it('reads back an ISO string', async () => {
    const { client } = fakeFirestore({ last_active_at: '2026-08-30T12:00:00.000Z' });
    const store = new FirestoreActivityStore({ client });

    await expect(store.read()).resolves.toEqual(new Date('2026-08-30T12:00:00.000Z'));
  });

  it('reads back a Firestore Timestamp', async () => {
    const at = new Date('2026-08-30T12:00:00.000Z');
    const { client } = fakeFirestore({ last_active_at: { toDate: () => at } });
    const store = new FirestoreActivityStore({ client });

    await expect(store.read()).resolves.toEqual(at);
  });

  it('reports null when the document does not exist', async () => {
    const { client } = fakeFirestore();
    const store = new FirestoreActivityStore({ client });

    await expect(store.read()).resolves.toBeNull();
  });

  it('reports null rather than an Invalid Date for an unusable value', async () => {
    const { client } = fakeFirestore({ last_active_at: 'not a date' });
    const store = new FirestoreActivityStore({ client });

    await expect(store.read()).resolves.toBeNull();
  });

  it('propagates a store failure so the caller can report unknown', async () => {
    const doc = {
      get: () => Promise.reject(new Error('permission denied')),
      set: () => Promise.resolve(undefined),
    };
    const store = new FirestoreActivityStore({
      client: { collection: () => ({ doc: () => doc }) },
    });

    // Deliberately not swallowed here: only `record` is fire-and-forget. A read
    // that silently returned null would report a confident `cold` for a fleet
    // whose state is genuinely unknown.
    await expect(store.read()).rejects.toThrow();
  });
});

describe('buildActivityStore', () => {
  it('selects the in-memory store for the memory backend', () => {
    expect(buildActivityStore('memory')).toBeInstanceOf(InMemoryActivityStore);
  });

  it('selects Firestore for the firestore backend', () => {
    expect(buildActivityStore('firestore')).toBeInstanceOf(FirestoreActivityStore);
  });

  it('degrades to in-memory rather than refusing to boot on an unknown backend', () => {
    // Unlike the vault, which must refuse: this store only decorates a badge, so
    // taking the fleet down over it would be the worse failure.
    expect(buildActivityStore('nonsense')).toBeInstanceOf(InMemoryActivityStore);
  });
});

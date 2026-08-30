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
  recordWarmupRequest,
  type ActivityStore,
} from '../src/activity.ts';

/**
 * The half of `ActivityStore` a given test is not exercising.
 *
 * Spread into hand-built doubles so each test states only the method under
 * examination; a double that had to implement all four would bury the one
 * behaviour it is about.
 */
const inertStamps = {
  recordWarmupRequest: () => Promise.resolve(),
  readActivity: () => Promise.resolve({ lastActiveAt: null, warmupRequestedAt: null }),
};

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

  it('keeps the two stamps independent', async () => {
    const store = new InMemoryActivityStore();
    const requested = new Date('2026-08-30T12:00:00.000Z');
    const active = new Date('2026-08-30T12:02:00.000Z');

    await store.recordWarmupRequest(requested);
    await store.record(active);

    await expect(store.readActivity()).resolves.toEqual({
      lastActiveAt: active,
      warmupRequestedAt: requested,
    });
  });

  it('reports both stamps as null before anything is recorded', async () => {
    await expect(new InMemoryActivityStore().readActivity()).resolves.toEqual({
      lastActiveAt: null,
      warmupRequestedAt: null,
    });
  });
});

describe('recordWarmupRequest', () => {
  it('does not await the write', () => {
    let settled = false;
    const store: ActivityStore = {
      record: () => Promise.resolve(),
      read: () => Promise.resolve(null),
      readActivity: () => Promise.resolve({ lastActiveAt: null, warmupRequestedAt: null }),
      recordWarmupRequest: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve();
          }, 50);
        }),
    };

    recordWarmupRequest(store);

    expect(settled).toBe(false);
  });

  it('swallows a rejected write so a wake is never reported as failed', async () => {
    const store: ActivityStore = {
      record: () => Promise.resolve(),
      read: () => Promise.resolve(null),
      readActivity: () => Promise.resolve({ lastActiveAt: null, warmupRequestedAt: null }),
      recordWarmupRequest: () => Promise.reject(new Error('firestore is unreachable')),
    };

    expect(() => {
      recordWarmupRequest(store);
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('is a no-op when no store is configured', () => {
    expect(() => {
      recordWarmupRequest(undefined);
    }).not.toThrow();
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
      ...inertStamps,
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
      ...inertStamps,
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
      ...inertStamps,
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
    // Models Firestore's own merge semantics, because the two stamps share one
    // document: a double that always replaced would hide a lost-field bug.
    set: vi.fn((value: Record<string, unknown>, options?: { merge?: boolean }) => {
      state.data = options?.merge === true ? { ...state.data, ...value } : value;
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

    expect(doc.set).toHaveBeenCalledWith(
      { last_active_at: '2026-08-30T12:00:00.000Z' },
      { merge: true },
    );
  });

  it('writes the warmup request as its own field', async () => {
    const { client, doc } = fakeFirestore();
    const store = new FirestoreActivityStore({ client });

    await store.recordWarmupRequest(new Date('2026-08-30T12:00:00.000Z'));

    expect(doc.set).toHaveBeenCalledWith(
      { warmup_requested_at: '2026-08-30T12:00:00.000Z' },
      { merge: true },
    );
  });

  it('keeps both stamps when either is written', async () => {
    const { client } = fakeFirestore();
    const store = new FirestoreActivityStore({ client });

    await store.recordWarmupRequest(new Date('2026-08-30T12:00:00.000Z'));
    await store.record(new Date('2026-08-30T12:01:00.000Z'));

    // The `warming` verdict compares the two, so a write that erased its sibling
    // would make the fleet look as though it had never been asked to wake.
    await expect(store.readActivity()).resolves.toEqual({
      lastActiveAt: new Date('2026-08-30T12:01:00.000Z'),
      warmupRequestedAt: new Date('2026-08-30T12:00:00.000Z'),
    });
  });

  it('reads both stamps in a single document get', async () => {
    const { client, doc } = fakeFirestore({
      last_active_at: '2026-08-30T12:00:00.000Z',
      warmup_requested_at: '2026-08-30T11:58:00.000Z',
    });
    const store = new FirestoreActivityStore({ client });

    const reading = await store.readActivity();

    expect(reading.lastActiveAt).toEqual(new Date('2026-08-30T12:00:00.000Z'));
    expect(reading.warmupRequestedAt).toEqual(new Date('2026-08-30T11:58:00.000Z'));
    // One get, not two: this endpoint is polled by every open tab.
    expect(doc.get).toHaveBeenCalledTimes(1);
  });

  it('reports a null warmup stamp when only activity was ever recorded', async () => {
    const { client } = fakeFirestore({ last_active_at: '2026-08-30T12:00:00.000Z' });
    const store = new FirestoreActivityStore({ client });

    await expect(store.readActivity()).resolves.toEqual({
      lastActiveAt: new Date('2026-08-30T12:00:00.000Z'),
      warmupRequestedAt: null,
    });
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

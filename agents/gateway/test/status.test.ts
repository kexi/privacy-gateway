/**
 * What the warm/cold verdict guarantees.
 *
 * The endpoint's whole value is that it answers without waking the GPU, so the
 * classification is pure and testable: a timestamp in, a verdict out. The cases
 * that matter are the two boundaries of the retention window and the difference
 * between "no activity recorded" (cold) and "the store could not be asked"
 * (unknown) — collapsing the latter into cold would state a fact nobody knows.
 */

import {
  COLD_START_ESTIMATE_SECONDS,
  WARM_WINDOW_MS,
  WARMING_WINDOW_MS,
  type ActivityStore,
} from '@privacy-gateway/common';
import { describe, expect, it, vi } from 'vitest';
import { StatusCache, statusOf, warmthOf } from '../src/status.ts';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

/** An activity reading, defaulting to "no wake was ever asked for". */
function reading(lastActiveAt: Date | null, warmupRequestedAt: Date | null = null) {
  return { lastActiveAt, warmupRequestedAt };
}

describe('warmthOf', () => {
  it('reports warm for activity inside the retention window', () => {
    const oneMinuteAgo = new Date(NOW - 60_000);
    expect(warmthOf(oneMinuteAgo, NOW)).toBe('warm');
  });

  it('reports warm right up to the edge of the window', () => {
    const justInside = new Date(NOW - WARM_WINDOW_MS + 1);
    expect(warmthOf(justInside, NOW)).toBe('warm');
  });

  it('reports cold once the window has elapsed', () => {
    const atTheEdge = new Date(NOW - WARM_WINDOW_MS);
    expect(warmthOf(atTheEdge, NOW)).toBe('cold');
  });

  it('reports cold for activity well outside the window', () => {
    const anHourAgo = new Date(NOW - 60 * 60_000);
    expect(warmthOf(anHourAgo, NOW)).toBe('cold');
  });

  it('reports cold when the store answered but held nothing', () => {
    // Nothing recorded means no Gemma call happened inside the window, which is
    // exactly what cold describes.
    expect(warmthOf(null, NOW)).toBe('cold');
  });

  it('reports unknown when the store could not be asked', () => {
    expect(warmthOf(undefined, NOW)).toBe('unknown');
  });
});

describe('warmthOf, with a warmup on record', () => {
  it('reports warming for a recent wake on a fleet that was never active', () => {
    const justRequested = new Date(NOW - 10_000);
    // The case the button exists for: nothing has ever answered, but a boot is
    // under way, and calling that `cold` tells the user their press did nothing.
    expect(warmthOf(null, NOW, justRequested)).toBe('warming');
  });

  it('reports warming right up to the edge of the warming window', () => {
    const justInside = new Date(NOW - WARMING_WINDOW_MS + 1);
    expect(warmthOf(null, NOW, justInside)).toBe('warming');
  });

  it('reverts to cold once the warming window has elapsed', () => {
    const atTheEdge = new Date(NOW - WARMING_WINDOW_MS);
    // A wake that never produced a Gemma call inside its window failed. Saying
    // so is what lets the user press the button again.
    expect(warmthOf(null, NOW, atTheEdge)).toBe('cold');
  });

  it('reports warming while the fleet is stale but a wake is in flight', () => {
    const anHourAgo = new Date(NOW - 60 * 60_000);
    const justRequested = new Date(NOW - 30_000);

    expect(warmthOf(anHourAgo, NOW, justRequested)).toBe('warming');
  });

  it('prefers warm over warming when a Gemma call landed after the wake', () => {
    const requested = new Date(NOW - 60_000);
    const served = new Date(NOW - 30_000);

    // Activity proves residency; a wake only predicts it. The proof wins.
    expect(warmthOf(served, NOW, requested)).toBe('warm');
  });

  it('reports cold when activity post-dates the wake but has since gone stale', () => {
    // A wake inside the warming window whose boot already completed: a Gemma
    // call landed after it, and the fleet has since idled past the warm window.
    // The wake is spent, so replaying `warming` would promise a boot that
    // already happened and ended.
    const requested = new Date(NOW - 2 * 60_000);
    const servedAfterTheWake = new Date(NOW - 60_000);

    const isRequestInsideWarmingWindow = NOW - requested.getTime() < WARMING_WINDOW_MS;
    expect(isRequestInsideWarmingWindow).toBe(true);
    // Freshly served, so this reads warm rather than warming.
    expect(warmthOf(servedAfterTheWake, NOW, requested)).toBe('warm');

    // The same ordering an hour later: activity still post-dates the wake, but
    // both are now old, so the honest answer is cold.
    const muchLater = NOW + 60 * 60_000;
    expect(warmthOf(servedAfterTheWake, muchLater, requested)).toBe('cold');
  });

  it('never claims warming when the store could not be asked', () => {
    // `unknown` outranks everything: a wake stamp read from a store that then
    // failed would be describing a fleet nobody can see.
    expect(warmthOf(undefined, NOW, new Date(NOW))).toBe('unknown');
  });
});

describe('statusOf', () => {
  it('carries the cold-start estimate on every verdict', () => {
    expect(statusOf(reading(new Date(NOW)), NOW).cold_start_estimate_seconds).toBe(
      COLD_START_ESTIMATE_SECONDS,
    );
    expect(statusOf(reading(null), NOW).cold_start_estimate_seconds).toBe(
      COLD_START_ESTIMATE_SECONDS,
    );
    expect(statusOf(undefined, NOW).cold_start_estimate_seconds).toBe(COLD_START_ESTIMATE_SECONDS);
  });

  it('reports the last activity even once the fleet has gone cold', () => {
    const anHourAgo = new Date(NOW - 60 * 60_000);
    const status = statusOf(reading(anHourAgo), NOW);

    expect(status.gemma).toBe('cold');
    expect(status.last_active_at).toBe(anHourAgo.toISOString());
  });

  it('omits the timestamp when there is none to report', () => {
    expect(statusOf(reading(null), NOW).last_active_at).toBeUndefined();
    expect(statusOf(undefined, NOW).last_active_at).toBeUndefined();
  });

  it('reports the warmup instant alongside a warming verdict', () => {
    const requested = new Date(NOW - 20_000);
    const status = statusOf(reading(null, requested), NOW);

    expect(status.gemma).toBe('warming');
    // The client uses this to decide how long it has been waiting, so it is
    // reported rather than left implicit in the verdict.
    expect(status.warmup_requested_at).toBe(requested.toISOString());
  });

  it('omits the warmup instant when no wake was ever asked for', () => {
    expect(statusOf(reading(new Date(NOW)), NOW).warmup_requested_at).toBeUndefined();
    expect(statusOf(undefined, NOW).warmup_requested_at).toBeUndefined();
  });
});

function storeReturning(
  value: Date | null,
  warmupRequestedAt: Date | null = null,
): {
  store: ActivityStore;
  read: ReturnType<typeof vi.fn>;
} {
  // `readActivity` is the call the cache makes; it is the one counted, because
  // what matters is how often the store is reached, not which alias was used.
  const read = vi.fn(() => Promise.resolve({ lastActiveAt: value, warmupRequestedAt }));
  return {
    store: {
      readActivity: read,
      read: () => Promise.resolve(value),
      record: () => Promise.resolve(),
      recordWarmupRequest: () => Promise.resolve(),
    },
    read,
  };
}

describe('StatusCache', () => {
  it('reads the store once for a burst of polls', async () => {
    const { store, read } = storeReturning(new Date(NOW));
    const cache = new StatusCache(store, 5_000, () => NOW);

    await cache.read();
    await cache.read();
    await cache.read();

    // The endpoint is public and polled by every open tab; an uncached read
    // would scale a Firestore bill with the number of spectators.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads again once the cache window has passed', async () => {
    const { store, read } = storeReturning(new Date(NOW));
    let clock = NOW;
    const cache = new StatusCache(store, 5_000, () => clock);

    await cache.read();
    clock = NOW + 5_001;
    await cache.read();

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports unknown instead of throwing when the store is unreachable', async () => {
    const store: ActivityStore = {
      read: () => Promise.reject(new Error('permission denied')),
      readActivity: () => Promise.reject(new Error('permission denied')),
      record: () => Promise.resolve(),
      recordWarmupRequest: () => Promise.resolve(),
    };
    const cache = new StatusCache(store, 5_000, () => NOW);

    // A status endpoint is wanted most when the fleet is unhealthy, so it must
    // never be the thing that fails.
    await expect(cache.read()).resolves.toEqual({
      gemma: 'unknown',
      cold_start_estimate_seconds: COLD_START_ESTIMATE_SECONDS,
    });
  });

  it('serves warming from a stored warmup stamp', async () => {
    const { store } = storeReturning(null, new Date(NOW - 5_000));
    const cache = new StatusCache(store, 5_000, () => NOW);

    // End to end through the cache: a warmup written by the wake handler shows
    // up as `warming` on the very next poll, which is the whole feature.
    await expect(cache.read()).resolves.toMatchObject({ gemma: 'warming' });
  });

  it('re-reads the store after an invalidation', async () => {
    const { store, read } = storeReturning(new Date(NOW));
    const cache = new StatusCache(store, 5_000, () => NOW);

    await cache.read();
    cache.invalidate();
    await cache.read();

    // A warmup invalidates, so the next poll cannot return a verdict computed
    // before the wake was dispatched.
    expect(read).toHaveBeenCalledTimes(2);
  });
});

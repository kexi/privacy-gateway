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
  type ActivityStore,
} from '@privacy-gateway/common';
import { describe, expect, it, vi } from 'vitest';
import { StatusCache, statusOf, warmthOf } from '../src/status.ts';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

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

describe('statusOf', () => {
  it('carries the cold-start estimate on every verdict', () => {
    expect(statusOf(new Date(NOW), NOW).cold_start_estimate_seconds).toBe(
      COLD_START_ESTIMATE_SECONDS,
    );
    expect(statusOf(null, NOW).cold_start_estimate_seconds).toBe(COLD_START_ESTIMATE_SECONDS);
    expect(statusOf(undefined, NOW).cold_start_estimate_seconds).toBe(COLD_START_ESTIMATE_SECONDS);
  });

  it('reports the last activity even once the fleet has gone cold', () => {
    const anHourAgo = new Date(NOW - 60 * 60_000);
    const status = statusOf(anHourAgo, NOW);

    expect(status.gemma).toBe('cold');
    expect(status.last_active_at).toBe(anHourAgo.toISOString());
  });

  it('omits the timestamp when there is none to report', () => {
    expect(statusOf(null, NOW).last_active_at).toBeUndefined();
    expect(statusOf(undefined, NOW).last_active_at).toBeUndefined();
  });
});

function storeReturning(value: Date | null): {
  store: ActivityStore;
  read: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(() => Promise.resolve(value));
  return { store: { read, record: () => Promise.resolve() }, read };
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
      record: () => Promise.resolve(),
    };
    const cache = new StatusCache(store, 5_000, () => NOW);

    // A status endpoint is wanted most when the fleet is unhealthy, so it must
    // never be the thing that fails.
    await expect(cache.read()).resolves.toEqual({
      gemma: 'unknown',
      cold_start_estimate_seconds: COLD_START_ESTIMATE_SECONDS,
    });
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

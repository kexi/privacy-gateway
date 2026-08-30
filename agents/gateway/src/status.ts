/**
 * Fleet warmth: answering "will my next request be slow?" without making it so.
 *
 * The Gemma service runs on a GPU and scales to zero, so the first request after
 * an idle period waits while a 12B model is pulled onto the card. That wait is
 * indistinguishable from a hang unless the UI can say it is coming, and it can
 * only say so if the answer is available *before* anything is sent.
 *
 * The one thing this must never do is ask Gemma. A probe would wake the
 * instance, so the endpoint that reports "cold" would itself make the report
 * false and start the GPU meter — a status check that costs money is not a
 * status check. The verdict is derived instead from the timestamp the Gemma call
 * sites record on their way out.
 */

import {
  COLD_START_ESTIMATE_SECONDS,
  WARM_WINDOW_MS,
  WARMING_WINDOW_MS,
  type ActivityReading,
  type ActivityStore,
  type GemmaWarmth,
  type StatusResponse,
} from '@privacy-gateway/common';

/**
 * Classify a recorded activity instant.
 *
 * `null` means the store answered and had nothing: no Gemma call has happened
 * inside the retention window, which is exactly what cold means. `undefined`
 * means the store could not be asked at all, which is `unknown` — see the
 * schema's note on why that is not collapsed into `cold`.
 *
 * `warmupRequestedAt` upgrades a `cold` verdict to `warming` while a wake is
 * plausibly still booting. It never downgrades a `warm` one: a Gemma call that
 * landed after the wake proves the instance is up, so the recorded activity
 * always wins over the request that asked for it. That ordering is the whole
 * reason both instants are compared rather than each being tested alone.
 */
export function warmthOf(
  lastActiveAt: Date | null | undefined,
  now: number = Date.now(),
  warmupRequestedAt: Date | null | undefined = null,
): GemmaWarmth {
  if (lastActiveAt === undefined) return 'unknown';

  const isWarm = lastActiveAt !== null && now - lastActiveAt.getTime() < WARM_WINDOW_MS;
  if (isWarm) return 'warm';

  if (warmupRequestedAt === null || warmupRequestedAt === undefined) return 'cold';

  // A wake only explains the current silence while it could still be booting,
  // and only while nothing newer has been served. Activity that post-dates the
  // request means the wake already resolved — into a fleet that has since gone
  // cold again — so replaying `warming` would restart a wait that is over.
  const isBooting = now - warmupRequestedAt.getTime() < WARMING_WINDOW_MS;
  const isSupersededByActivity =
    lastActiveAt !== null && lastActiveAt.getTime() >= warmupRequestedAt.getTime();
  return isBooting && !isSupersededByActivity ? 'warming' : 'cold';
}

/** Build the status document from a (possibly absent) activity reading. */
export function statusOf(
  reading: ActivityReading | undefined,
  now: number = Date.now(),
): StatusResponse {
  const lastActiveAt = reading === undefined ? undefined : reading.lastActiveAt;
  const warmupRequestedAt = reading?.warmupRequestedAt ?? null;
  const gemma = warmthOf(lastActiveAt, now, warmupRequestedAt);
  return {
    gemma,
    // Reported whenever it is known, including when the fleet has since gone
    // cold: "last seen 40 minutes ago" is more useful than a bare `cold`.
    ...(lastActiveAt instanceof Date ? { last_active_at: lastActiveAt.toISOString() } : {}),
    ...(warmupRequestedAt instanceof Date
      ? { warmup_requested_at: warmupRequestedAt.toISOString() }
      : {}),
    cold_start_estimate_seconds: COLD_START_ESTIMATE_SECONDS,
  };
}

/**
 * A time-boxed cache over the activity store.
 *
 * The UI polls every 30s per open tab, and the endpoint is public, so an
 * uncached read would turn a status badge into a Firestore bill scaling with
 * spectators. Five seconds is short enough that a warmup is reflected almost
 * immediately and long enough that a burst of pollers costs one read.
 *
 * A failed read is cached too, briefly: when Firestore is unreachable, retrying
 * it once per request would add latency to every poll for no new information.
 */
export class StatusCache {
  private cached: { value: StatusResponse; at: number } | undefined;

  constructor(
    private readonly store: ActivityStore,
    private readonly ttlMs: number = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<StatusResponse> {
    const at = this.now();
    const isFresh = this.cached !== undefined && at - this.cached.at < this.ttlMs;
    if (isFresh && this.cached !== undefined) return this.cached.value;

    // `undefined` is the "could not ask" signal `warmthOf` turns into `unknown`.
    // The catch is unconditional on purpose: this endpoint must never 500, since
    // a status page that fails when the fleet is unhealthy is a status page that
    // is absent exactly when it is wanted.
    let reading: ActivityReading | undefined;
    try {
      reading = await this.store.readActivity();
    } catch {
      reading = undefined;
    }

    const value = statusOf(reading, at);
    this.cached = { value, at };
    return value;
  }

  /** Drop the cached verdict so the next read hits the store. Used after a warmup. */
  invalidate(): void {
    this.cached = undefined;
  }
}

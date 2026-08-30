/**
 * How many Gemma instances are actually running, measured rather than guessed.
 *
 * The activity clock in `packages/common/src/activity.ts` answers "will my next
 * request be slow?" by timing out from the last recorded Gemma call: inside
 * `WARM_WINDOW_MS` it says `warm`, outside it says `cold`. That is a proxy, and
 * on this deployment the proxy is measurably wrong. Sampling the real instance
 * count over four hours on 2026-08-30 gave live runs of 5, 26, 16 and 8 minutes
 * — Cloud Run's idle retention is not a fixed 15 minutes, so no single timeout
 * matches it. A ten-minute window is simultaneously too long (it reports `warm`
 * for an instance reclaimed after five) and too short (it reports `cold` for one
 * still billing at twenty-six).
 *
 * Cloud Monitoring already records the answer. `run.googleapis.com/container/
 * instance_count` is sampled once a minute by the platform, so reading it costs
 * one API call against Monitoring and — this is the point — *never touches
 * Gemma*. The rule the activity clock exists to protect is preserved exactly: a
 * status check must not wake the GPU it reports on, because a status check that
 * starts the meter is not a status check.
 *
 * Why not replace the activity clock outright: the metric lags. Points land
 * about 90 seconds late, so a wake dispatched twenty seconds ago is invisible
 * here while being precisely the thing a user is watching for. The two are
 * complements — the metric knows what *is*, the clock knows what was *just
 * asked for* — so `status.ts` prefers the measurement and keeps the clock for
 * the window the measurement cannot see.
 */

import type { Logger } from '@privacy-gateway/common';

/** The metric that counts running Cloud Run instances, by lifecycle state. */
const INSTANCE_COUNT_METRIC = 'run.googleapis.com/container/instance_count';

/**
 * How far back to ask for points.
 *
 * Points arrive roughly 90 seconds late, so a window shorter than that can
 * legitimately come back empty and be misread as "zero instances". Five minutes
 * is comfortably past the lag while still being unambiguous about which sample
 * is newest.
 */
const LOOKBACK_MS = 5 * 60 * 1000;

/** A reading of the real instance count, or `null` when it could not be taken. */
export interface InstanceReading {
  /** Instances in any state — `active` and `idle` are both billed. */
  readonly count: number;
  /** When the platform sampled it, so staleness is the caller's to judge. */
  readonly sampledAt: Date;
}

/** The Monitoring surface this needs; narrowed so a test can supply it. */
export interface InstanceCounter {
  read(): Promise<InstanceReading | null>;
}

/** Shape of the one Monitoring response field this reads. */
interface TimeSeriesResponse {
  readonly timeSeries?: readonly {
    readonly points?: readonly {
      readonly interval?: { readonly endTime?: string };
      readonly value?: { readonly int64Value?: string | number };
    }[];
  }[];
}

export interface MonitoringCounterOptions {
  readonly project: string;
  readonly service: string;
  /** Supplies an OAuth token; injected so tests never touch ADC. */
  readonly token: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly logger?: Logger | undefined;
}

/**
 * Read the live instance count from Cloud Monitoring.
 *
 * Never throws and never rejects: every failure becomes `null`, which the
 * caller reads as "no measurement" and falls back to the activity clock. A
 * status badge that 500s because a metrics API was slow is worse than one that
 * reverts to the estimate it used before.
 */
export function monitoringInstanceCounter(options: MonitoringCounterOptions): InstanceCounter {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  return {
    async read(): Promise<InstanceReading | null> {
      try {
        const end = new Date(now());
        const start = new Date(now() - LOOKBACK_MS);
        const filter =
          `metric.type="${INSTANCE_COUNT_METRIC}" AND ` +
          `resource.labels.service_name="${options.service}"`;

        const url = new URL(
          `https://monitoring.googleapis.com/v3/projects/${options.project}/timeSeries`,
        );
        url.searchParams.set('filter', filter);
        url.searchParams.set('interval.startTime', start.toISOString());
        url.searchParams.set('interval.endTime', end.toISOString());

        const response = await doFetch(url, {
          headers: { authorization: `Bearer ${await options.token()}` },
        });
        if (!response.ok) {
          options.logger?.event(
            'status.metric_unavailable',
            { status: response.status },
            'WARNING',
          );
          return null;
        }

        return newestReading(await (response.json() as Promise<TimeSeriesResponse>));
      } catch (error) {
        options.logger?.event(
          'status.metric_unavailable',
          { error_class: error instanceof Error ? error.name : 'unknown' },
          'WARNING',
        );
        return null;
      }
    },
  };
}

/**
 * Sum the newest sample across every lifecycle state.
 *
 * Monitoring returns one series per `state` label (`active`, `idle`), and both
 * are billed, so the total is what "is the GPU costing money" means. Each series
 * is summed at *its own* newest point rather than at a shared timestamp: the
 * series can be one sample out of step, and treating a missing point as zero
 * would under-report a running instance.
 *
 * An empty response is a real zero, not an error. Cloud Monitoring emits no
 * points for a service scaled to zero, which is exactly the state being asked
 * about — but the caller distinguishes the two anyway, because this returns a
 * reading and a failure returns `null`.
 */
function newestReading(body: TimeSeriesResponse): InstanceReading | null {
  const series = body.timeSeries ?? [];
  if (series.length === 0) return { count: 0, sampledAt: new Date(0) };

  let count = 0;
  let newest = 0;
  for (const entry of series) {
    const points = entry.points ?? [];
    if (points.length === 0) continue;

    // The API returns points newest-first; sorting rather than trusting that is
    // one comparison against a contract that is not worth depending on.
    let best: { at: number; value: number } | undefined;
    for (const point of points) {
      const at = Date.parse(point.interval?.endTime ?? '');
      if (Number.isNaN(at)) continue;
      if (best === undefined || at > best.at) {
        best = { at, value: Number(point.value?.int64Value ?? 0) };
      }
    }
    if (best === undefined) continue;

    count += Number.isFinite(best.value) ? best.value : 0;
    newest = Math.max(newest, best.at);
  }

  return { count, sampledAt: new Date(newest) };
}

/**
 * Demo UI. Places the masked prompt beside the final answer to show what happened at
 * the boundary.
 *
 * The centrepiece is the difference between the string Gemini actually received and the
 * string the user receives, annotated with the four trust dimensions.
 *
 * There is no approve button. The gateway is public and authenticates nobody, so a
 * "human reviewed this" claim minted from a click would name no one; review identity is
 * therefore displayed, always, as `none`.
 */

import {
  ApiError,
  askStreaming,
  deriveTrustTier,
  extractVerified,
  logsConsoleUrl,
  fleetStatus,
  traceConsoleUrl,
  warmup,
  type AskResponse,
  type GemmaWarmth,
  type ProgressStage,
  type TrustTier,
} from './api.ts';
import { MaskedView } from './masked-view.ts';
// eslint-disable-next-line import/no-unassigned-import -- Vite bundles the stylesheet via this side-effect import
import './style.css';

/** Set at build time; when absent the console links are omitted. */
const GCP_PROJECT = import.meta.env.VITE_GCP_PROJECT ?? '';

const SAMPLE = `Customer Taro Yamada (taro@example.co.jp, 090-1234-5678) reports that the charge on card 4242 4242 4242 4242 failed. Our API key sk-abcdefghijklmnopqrstuvwxyz012345 was used from 192.168.10.5.

Draft a polite reply and a Python snippet to update the customer record.`;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const composer = el<HTMLFormElement>('composer');
const input = el<HTMLTextAreaElement>('input');
const submit = el<HTMLButtonElement>('submit');
const statusLine = el<HTMLParagraphElement>('status');
const results = el<HTMLElement>('results');
const blockedPane = el<HTMLElement>('blocked');
const maskedPane = el<HTMLPreElement>('masked');
const answerPane = el<HTMLPreElement>('answer');
const originalPane = el<HTMLPreElement>('original');
const legendSection = el<HTMLElement>('legend-section');
const legendList = el<HTMLUListElement>('legend');
const legendNote = el<HTMLParagraphElement>('legend-note');
const dimensionsPane = el<HTMLDivElement>('dimensions');
const attestationPane = el<HTMLDivElement>('attestation');
const statsPane = el<HTMLDivElement>('stats');
const okfPane = el<HTMLPreElement>('okf');
const correlationPane = el<HTMLDivElement>('correlation');
const gpuBadge = el<HTMLSpanElement>('gpu-badge');
const gpuNote = el<HTMLParagraphElement>('gpu-note');
const warmupButton = el<HTMLButtonElement>('warmup');
const progressPane = el<HTMLElement>('progress');
const stepsList = el<HTMLOListElement>('steps');
const maskTermsInput = el<HTMLInputElement>('mask-terms');
const maskTermsPreview = el<HTMLUListElement>('mask-terms-preview');

input.value = SAMPLE;

// --- user-defined secret terms -----------------------------------------------

/** Mirrors `MIN_MASK_TERM_LENGTH` / `MAX_MASK_TERM_LENGTH` in the shared schema. */
const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 120;
/** Mirrors `MAX_MASK_TERMS`. */
const MAX_TERMS = 20;

/**
 * Split the comma-separated field into terms.
 *
 * Trimmed and deduplicated exactly as `MaskTermsSchema` does, so the chips are
 * the terms the server will actually see rather than an approximation of them.
 * Case is preserved on both sides: `Titan` and `titan` are two terms.
 */
function parseMaskTerms(raw: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of raw.split(',')) {
    const term = part.trim();
    if (term === '' || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/** Whether the server's schema would accept this term. */
function isValidTerm(term: string): boolean {
  return (
    term.length >= MIN_TERM_LENGTH &&
    term.length <= MAX_TERM_LENGTH &&
    !term.includes('⟦') &&
    !term.includes('⟧')
  );
}

/**
 * Echo the parsed terms back as chips.
 *
 * The point is not decoration: a comma-separated box is easy to misread, and
 * this is the one field where believing a term was masked when it was not is the
 * whole failure mode. A term the schema would reject is struck through here
 * rather than after a round trip.
 */
function renderMaskTerms(): void {
  const terms = parseMaskTerms(maskTermsInput.value);
  maskTermsPreview.innerHTML = terms
    .slice(0, MAX_TERMS)
    .map((term) => {
      const invalid = isValidTerm(term) ? '' : ' invalid';
      const title = isValidTerm(term)
        ? `masked verbatim, case-sensitive`
        : `too short, too long, or contains the reserved delimiters ⟦ ⟧`;
      return `<li class="${invalid.trim()}" title="${escapeHtml(title)}">${escapeHtml(term)}</li>`;
    })
    .join('');
}

maskTermsInput.addEventListener('input', renderMaskTerms);

// --- GPU warmth --------------------------------------------------------------

/** How often the badge is refreshed while the tab is visible and settled. */
const STATUS_POLL_MS = 30_000;

/**
 * How often it is refreshed while a boot is expected to be in progress.
 *
 * A cold start resolves in around two minutes, so a 30s poll would leave the
 * badge stale for a sixth of the wait it is describing. The faster rate is
 * deliberately temporary: it applies only while the fleet is `warming` or
 * `cold`, which is the only time the answer is expected to change on its own.
 */
const WARMING_POLL_MS = 5_000;

/** The last state the badge showed, used to decide whether to warn before a submit. */
let gemmaWarmth: GemmaWarmth = 'unknown';
let coldStartSeconds = 120;

const WARMTH_LABEL: Record<GemmaWarmth, string> = {
  warm: 'GPU: warm',
  warming: 'GPU: warming…',
  cold: 'GPU: cold',
  unknown: 'GPU: unknown',
};

/**
 * Whether the fleet's state is expected to change without anyone asking.
 *
 * `warming` is obviously in flight. `cold` is included because a wake may have
 * been started from another tab, and because it is the state a user is most
 * likely to be watching while waiting for something to happen.
 */
function isSettling(warmth: GemmaWarmth): boolean {
  return warmth === 'warming' || warmth === 'cold';
}

/**
 * True once a warm-up has been dispatched and before the server admits it.
 *
 * `POST /v1/warmup` returns as soon as the wake is recorded, but `/v1/status`
 * keeps reporting `cold` until the instance actually starts booting. Without
 * this flag the very next poll overwrites "Starting the GPU… it is billed" with
 * "The GPU is asleep" — telling the user the opposite of what just happened and
 * dropping the cost warning at the exact moment billing begins.
 *
 * Cleared by the server, not by a timer: any status that is no longer `cold` is
 * the server having caught up, whether that is `warming`, `warm` or `unknown`.
 */
let warmupDispatched = false;

/**
 * Refresh the badge.
 *
 * `fleetStatus` never rejects, so there is no error path here: an unreachable
 * gateway shows `unknown`, which is what the server would have said anyway.
 */
async function refreshStatus(): Promise<void> {
  const status = await fleetStatus();
  gemmaWarmth = status.gemma;
  coldStartSeconds = status.cold_start_estimate_seconds;

  gpuBadge.dataset['state'] = status.gemma;
  gpuBadge.textContent = WARMTH_LABEL[status.gemma];

  // The button stays pressed for as long as the server agrees a boot is under
  // way, rather than for a fixed interval: the server's `warming` window is the
  // authority, so the two cannot disagree about whether pressing again is
  // useful. It is released as soon as the fleet is warm, or once the wake has
  // expired back to cold and pressing again is the right move.
  // A dispatched wake outranks a `cold` reading, because the server has not yet
  // caught up with a request it has already accepted. Anything other than `cold`
  // is the server having caught up, so the flag is spent.
  if (status.gemma !== 'cold') warmupDispatched = false;
  const starting = status.gemma === 'warming' || warmupDispatched;

  setWarmupPending(starting);

  const minutes = Math.round(coldStartSeconds / 60);
  if (starting) {
    gpuNote.textContent = `Starting up — up to about ${minutes} minutes until the first response. It is billed for as long as it stays running.`;
    gpuNote.hidden = false;
  } else if (status.gemma === 'cold') {
    gpuNote.textContent = `The GPU is asleep — the first request may take about ${minutes} minutes while it starts.`;
    gpuNote.hidden = false;
  } else if (status.gemma === 'unknown') {
    gpuNote.textContent =
      'The GPU state could not be read, so the first request may or may not need a cold start.';
    gpuNote.hidden = false;
  } else {
    gpuNote.hidden = true;
  }

  // A state that settles on its own is worth watching closely; one that does not
  // is worth leaving alone. Re-applied on every refresh so the rate follows the
  // fleet without anything having to remember to switch it back.
  applyPollRate(isSettling(status.gemma) ? WARMING_POLL_MS : STATUS_POLL_MS);
}

/**
 * Reflect "a wake is in flight" on the button.
 *
 * `aria-busy` alongside `disabled` because the two say different things: the
 * button cannot be pressed, *and* the thing it started is still running.
 */
function setWarmupPending(pending: boolean): void {
  warmupButton.disabled = pending;
  warmupButton.setAttribute('aria-busy', pending ? 'true' : 'false');
  warmupButton.textContent = pending ? 'Starting…' : 'Warm up';
}

/**
 * The poll's timer and its current rate.
 *
 * Held at module scope rather than closed over inside `startStatusPolling`
 * because the rate now changes from `refreshStatus`, which runs outside it.
 */
let pollTimer: ReturnType<typeof setInterval> | undefined;
let pollRateMs = STATUS_POLL_MS;

function stopPolling(): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
}

function startPolling(): void {
  if (pollTimer !== undefined) return;
  pollTimer = setInterval(() => {
    void refreshStatus();
  }, pollRateMs);
}

/**
 * Switch the polling rate, restarting the timer only when it actually changed.
 *
 * Guarded because `refreshStatus` calls this on every poll: recreating the
 * interval each time would reset the countdown and, at the 5s rate, could keep
 * pushing the next poll further away than the rate it is asking for.
 */
function applyPollRate(rateMs: number): void {
  if (rateMs === pollRateMs) return;
  pollRateMs = rateMs;
  // A hidden tab has no timer to re-rate; it will pick the current rate up when
  // it comes back and restarts.
  if (pollTimer === undefined) return;
  stopPolling();
  startPolling();
}

/**
 * Poll only while the tab is visible.
 *
 * A background tab polling a public endpoint costs the fleet reads for a badge
 * nobody is looking at — more so at the 5s warming rate — so the timer is
 * dropped entirely while hidden.
 */
function startStatusPolling(): void {
  // Refreshed once on the way back before the interval resumes, so a tab that
  // was hidden through an entire cold start does not show a stale `warming`
  // until the first tick lands.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
      return;
    }
    void refreshStatus();
    startPolling();
  });

  void refreshStatus();
  startPolling();
}

warmupButton.addEventListener('click', () => {
  // Applied before the request rather than after it: the press must be visibly
  // acknowledged even though the answer is a round trip away, which is the whole
  // complaint this state exists to fix.
  setWarmupPending(true);
  warmupDispatched = true;
  gpuNote.textContent = 'Starting the GPU… it is billed for as long as it stays running.';
  gpuNote.hidden = false;

  warmup()
    .then(async () => {
      // The wake was dispatched, not completed. The server has recorded the
      // request, so the next poll reports `warming` — the badge is re-read
      // rather than assumed, and `refreshStatus` owns the button state from
      // here, holding it pressed until the fleet is warm or the wake expires.
      await refreshStatus();
      return true;
    })
    .catch(() => {
      // Nothing was started, so the button must become pressable again; only
      // this path releases it, because a dispatched wake is still in flight.
      // The flag goes with it: there is no wake for the server to catch up to.
      warmupDispatched = false;
      setWarmupPending(false);
      gpuNote.textContent = 'The warm-up request was refused. Try again in a moment.';
      gpuNote.hidden = false;
    });
});

// --- Pipeline progress --------------------------------------------------------

/**
 * The steps a user sees, in the order they happen.
 *
 * `gpu_wakeup` is not in this list: it is prepended only when the fleet was cold
 * at submit time, because a step that is always displayed and usually instant
 * teaches the reader to ignore it.
 */
const STEP_LABELS: Record<ProgressStage, string> = {
  gpu_wakeup: 'Starting the GPU (up to ~2 min)',
  masking: 'Masking PII (Gemma)',
  egress_guard: 'Egress guard',
  core_reasoning: 'Reasoning on Gemini',
  leak_check: 'Leak check',
  rehydrate: 'Restoring real values',
};

const BASE_STEPS: readonly ProgressStage[] = [
  'masking',
  'egress_guard',
  'core_reasoning',
  'leak_check',
  'rehydrate',
];

type StepState = 'pending' | 'active' | 'done' | 'stopped';

interface Step {
  readonly stage: ProgressStage;
  state: StepState;
  /** Cumulative milliseconds since the pipeline began, recorded when the step ended. */
  endedAtMs?: number;
  /** This step's own duration, derived from the previous step's end. */
  durationMs?: number;
}

let steps: Step[] = [];

/**
 * When the current run started, so the in-flight step can show a live count.
 *
 * A cold fleet's first stage takes about two minutes. A checklist that renders
 * once and then sits still for that long is indistinguishable from a hung page,
 * so the active row counts up from here while it waits. `undefined` between
 * runs, which is what stops the ticker.
 */
let runStartedAt: number | undefined;

/** The ticker that repaints the in-flight row roughly ten times a second. */
let tickTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Whether the viewer asked for less motion.
 *
 * Read once per render rather than cached at load: a viewer can change the
 * system setting while the page is open, and the next repaint should honour it.
 * Everything the animation conveys is also carried by the mark and the live
 * number, so the reduced-motion path loses decoration and no information.
 */
function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function stopTicking(): void {
  if (tickTimer !== undefined) clearInterval(tickTimer);
  tickTimer = undefined;
}

/**
 * Repaint the in-flight row on a timer.
 *
 * 100ms so the tenths digit actually moves; the row is a handful of elements, so
 * this is far cheaper than the request it is describing. It stops as soon as
 * nothing is active, so an idle page holds no timer.
 */
function startTicking(): void {
  if (tickTimer !== undefined) return;
  tickTimer = setInterval(() => {
    const hasActive = steps.some((step) => step.state === 'active');
    if (!hasActive) {
      stopTicking();
      return;
    }
    renderSteps();
  }, 100);
}

/** Lay out the checklist for a new request. */
function resetSteps(includeWakeup: boolean): void {
  const stages = includeWakeup
    ? (['gpu_wakeup', ...BASE_STEPS] as ProgressStage[])
    : [...BASE_STEPS];
  steps = stages.map((stage) => ({ stage, state: 'pending' }));

  // The first step is marked active immediately: the request is already in
  // flight when this runs, and showing every step as pending would suggest
  // nothing had started.
  const first = steps[0];
  if (first !== undefined) first.state = 'active';

  runStartedAt = Date.now();
  progressPane.hidden = false;
  renderSteps();
  startTicking();
}

/** Stop the live count once the run is over, however it ended. */
function finishSteps(): void {
  stopTicking();
  runStartedAt = undefined;
  renderSteps();
}

function renderSteps(): void {
  const reduced = prefersReducedMotion();
  const elapsedMs = runStartedAt === undefined ? 0 : Date.now() - runStartedAt;
  // Where the in-flight step began, so its live count is its own duration rather
  // than the whole run's. `elapsedMs` is the browser's clock, so only the
  // browser-clock steps can be subtracted from it — `gpu_wakeup` is the one such
  // step, and mixing in a server-clock end would make the live counter jump
  // backwards and stall.
  const wakeupEnd = steps.find((step) => step.stage === 'gpu_wakeup')?.endedAtMs;
  const serverEnd = steps.reduce(
    (latest, step) =>
      step.stage === 'gpu_wakeup' ? latest : Math.max(latest, step.endedAtMs ?? 0),
    0,
  );
  const lastEnd = (wakeupEnd ?? 0) + serverEnd;

  stepsList.innerHTML = steps
    .map((step) => {
      // A finished step shows what it took; the one in flight counts up. Both
      // are the same field, so the number never jumps position as it settles.
      const liveMs = Math.max(0, elapsedMs - lastEnd);
      const seconds =
        step.durationMs !== undefined
          ? `${(step.durationMs / 1000).toFixed(1)}s`
          : step.state === 'active' && runStartedAt !== undefined
            ? `${(liveMs / 1000).toFixed(1)}s`
            : '';
      const mark =
        step.state === 'done'
          ? '✓'
          : step.state === 'stopped'
            ? '×'
            : step.state === 'active'
              ? '…'
              : '';
      // The shimmer is decoration only, and it is omitted outright under reduced
      // motion rather than being animated at zero duration: a moving gradient is
      // exactly the kind of thing the setting exists to switch off.
      const shimmer =
        step.state === 'active' && !reduced
          ? '<span class="step-shimmer" aria-hidden="true"></span>'
          : '';
      return `<li class="step ${step.state}${reduced ? ' static' : ''}" data-stage="${escapeHtml(step.stage)}">
        <span class="step-mark">${mark}</span>
        <span class="step-label">${escapeHtml(STEP_LABELS[step.stage])}</span>
        <span class="step-time">${escapeHtml(seconds)}</span>
        ${shimmer}
      </li>`;
    })
    .join('');
}

/**
 * Apply one progress frame.
 *
 * Elapsed times arrive cumulative from the pipeline's start, so a step's own
 * duration is the difference from the previous step's end — computed here rather
 * than server-side, which keeps the wire format a single number per frame.
 */
function applyProgress(stage: ProgressStage, state: 'start' | 'end', elapsedMs: number): void {
  const index = steps.findIndex((step) => step.stage === stage);
  if (index === -1) return;
  const step = steps[index];
  if (step === undefined) return;

  if (state === 'start') {
    step.state = 'active';
    renderSteps();
    return;
  }

  step.state = 'done';
  step.endedAtMs = elapsedMs;

  // `gpu_wakeup` is timed on the browser's clock and every other stage on the
  // server's, so a difference across that boundary is meaningless. Only stages
  // sharing a clock are subtracted; the first server-timed stage measures from
  // 0, which is exactly what its `elapsed_ms` already means.
  const previous = steps[index - 1];
  const previousEnd =
    previous === undefined || previous.stage === 'gpu_wakeup' ? 0 : (previous.endedAtMs ?? 0);
  step.durationMs = Math.max(0, elapsedMs - previousEnd);

  // Advance the cursor so the list always shows one step in flight rather than
  // going blank between a stage ending and the next one starting.
  const next = steps[index + 1];
  if (next !== undefined && next.state === 'pending') next.state = 'active';
  renderSteps();
}

/**
 * Mark wherever the pipeline stopped.
 *
 * A refusal's whole value to the reader is *which gate* refused, so the step
 * that was in flight is marked stopped and everything after it stays pending —
 * unreached, not failed.
 */
function markStopped(): void {
  const active = steps.find((step) => step.state === 'active');
  if (active !== undefined) active.state = 'stopped';
  finishSteps();
}

/**
 * Escaping that every string must pass through before it is inserted into HTML.
 *
 * Most of what is displayed originates in user input or model output, so every value
 * handed to innerHTML goes through here without exception -- otherwise the answer body
 * could itself become a script.
 */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/**
 * Render the four dimensions side by side.
 *
 * They are shown separately on purpose. Collapsed into a single badge, a
 * deterministic pass and a model's dissent could both hide behind one green
 * label; separate cells make each claim answerable on its own terms.
 */
function renderDimensions(response: AskResponse, tier: TrustTier): void {
  const { dimensions } = response;
  const cells = [
    dimension('Policy verdict', dimensions.policy_verdict, dimensions.policy_verdict === 'pass', {
      pass: 'the leak-policy check passed on the tokenized core response',
      fail: 'the leak-policy check failed',
    }),
    dimension(
      'Document status',
      dimensions.document_status,
      dimensions.document_status === 'stable',
      {
        stable: 'the OKF document is releasable',
        draft: 'the OKF document records a failure',
        deprecated: 'superseded',
      },
    ),
    dimension('Freshness', dimensions.freshness, dimensions.freshness === 'fresh', {
      fresh: 'the token mapping is still live',
      stale: 'the token mapping has expired',
      unknown: 'no usable stale_after; freshness cannot be asserted',
    }),
    dimension('Review identity', dimensions.review_identity, false, {
      none: 'no authenticated principal exists on this gateway, so no human review is possible',
    }),
  ];
  // The tier value is the OKF SPEC §5.3 term and stays verbatim, but the label
  // beside it names the *scope* of what was confirmed. A bare
  // "machine-confirmed" reads as a claim about the whole answer, when all that
  // was checked is a narrow leak-policy property: the tokenized core response
  // carried no raw identifier of its own. It is not a factual validation.
  const scope =
    tier === 'machine-confirmed'
      ? '<span class="tier-scope" id="tier-scope">: leak-policy only</span>'
      : '';
  dimensionsPane.innerHTML = `<div class="dimensions-grid">${cells.join('')}</div>
    <p class="derived">Derived trust tier: <code id="tier">${escapeHtml(tier)}</code>${scope}
    <small>(from the OKF <code>verified</code> field, not from a stored score. The check
    confirms only that the core response leaked no raw identifier — not that the answer is
    correct.)</small></p>`;
}

function dimension(
  label: string,
  value: string,
  positive: boolean,
  detail: Record<string, string>,
): string {
  return `<div class="dimension ${positive ? 'good' : 'neutral'}">
    <span class="dim-label">${escapeHtml(label)}</span>
    <span class="dim-value">${escapeHtml(value)}</span>
    <span class="dim-detail">${escapeHtml(detail[value] ?? '')}</span>
  </div>`;
}

function renderAttestation(response: AskResponse): void {
  const { attestation, consistency } = response;
  const rows: string[] = [];

  rows.push(
    row(
      'Leak-policy check',
      attestation.ok,
      attestation.ok
        ? "no raw identifiers found in the model's tokenized answer"
        : (attestation.reason ?? 'failed'),
    ),
  );
  rows.push(
    row(
      'Placeholder consistency',
      consistency.ok,
      consistency.ok
        ? `${consistency.used_tokens.length} placeholder(s) reused verbatim`
        : (consistency.reason ?? 'failed'),
    ),
  );

  if (attestation.findings.length > 0) {
    rows.push(
      `<p class="findings">Findings: ${attestation.findings
        .map((f) => `<code>${escapeHtml(f)}</code>`)
        .join(', ')}</p>`,
    );
  }
  if (attestation.withheld && attestation.withheld.length > 0) {
    rows.push(
      `<p class="withheld">Withheld by the disclosure policy (left masked in the answer):
        ${attestation.withheld.map((c) => `<code>${escapeHtml(c)}</code>`).join(', ')}</p>`,
    );
  }
  if (attestation.custom_terms && attestation.custom_terms.count > 0) {
    // The count, exactly as the audit record carries it. The terms themselves are
    // never in the response, so there is nothing here that could render one even
    // by mistake — which is the point worth stating on screen.
    rows.push(
      `<p class="custom-terms">Requester-named terms scanned for:
        <code>${attestation.custom_terms.count}</code>
        <small>(the terms themselves are never logged, stored, or shown — only this count)</small></p>`,
    );
  }
  if (attestation.judge && typeof attestation.judge.leak === 'boolean') {
    rows.push(
      `<p class="advisory">Gemma judge (probabilistic, can block but never vouches):
        ${attestation.judge.leak ? 'flagged' : 'clear'}</p>`,
    );
  }
  attestationPane.innerHTML = rows.join('');
}

function row(label: string, ok: boolean, detail: string): string {
  return `<div class="check ${ok ? 'pass' : 'fail'}">
    <span class="mark">${ok ? 'PASS' : 'FAIL'}</span>
    <span class="label">${escapeHtml(label)}</span>
    <span class="detail">${escapeHtml(detail)}</span>
  </div>`;
}

function renderStats(response: AskResponse): void {
  const counts = Object.entries(response.stats.counts_by_category);
  const chips = counts.length
    ? counts.map(([key, n]) => `<span class="chip">${escapeHtml(key)} x${n}</span>`).join('')
    : '<span class="chip">nothing detected</span>';
  statsPane.innerHTML = `
    <div class="chips">${chips}</div>
    <dl>
      <div><dt>Masked spans</dt><dd>${response.stats.masked_count}</dd></div>
      <div><dt>Model spans</dt><dd>${response.stats.unstructured_spans}</dd></div>
      <div><dt>Core actor</dt><dd><code>${escapeHtml(response.stats.core_actor)}</code></dd></div>
      <div><dt>Vault expires</dt><dd>${escapeHtml(response.stats.vault_expires_at)}</dd></div>
      <div><dt>Vault generation</dt><dd>${response.stats.vault_generation}</dd></div>
    </dl>`;
}

/**
 * Show the correlation ids, each copyable.
 *
 * These are what turns a user's "it went wrong" into a single Logs Explorer
 * query, so they are surfaced in the UI rather than left in the response body.
 */
function renderCorrelation(requestId: string, traceId?: string): void {
  const rows: string[] = [
    idRow(
      'Request ID',
      requestId,
      GCP_PROJECT ? logsConsoleUrl(requestId, GCP_PROJECT) : undefined,
      'Logs',
    ),
  ];
  if (traceId) {
    rows.push(
      idRow(
        'Trace ID',
        traceId,
        GCP_PROJECT ? traceConsoleUrl(traceId, GCP_PROJECT) : undefined,
        'Trace',
      ),
    );
  }
  correlationPane.innerHTML = rows.join('');

  for (const button of correlationPane.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    button.addEventListener('click', () => {
      void copyToClipboard(button);
    });
  }
}

/** Copies one id, reporting the outcome on the button itself. */
async function copyToClipboard(button: HTMLButtonElement): Promise<void> {
  const value = button.dataset['copy'] ?? '';
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'copied';
    setTimeout(() => {
      button.textContent = 'copy';
    }, 1200);
  } catch {
    // Clipboard access is denied in some contexts; the id stays selectable.
    button.textContent = 'failed';
  }
}

function idRow(label: string, value: string, href: string | undefined, linkLabel: string): string {
  const link = href
    ? ` <a class="console-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(linkLabel)}</a>`
    : '';
  return `<div class="id-row">
    <span class="label">${escapeHtml(label)}</span>
    <code>${escapeHtml(value)}</code>
    <button type="button" data-copy="${escapeHtml(value)}">copy</button>${link}
  </div>`;
}

/**
 * The three text panels and the legend.
 *
 * Constructed once: the linking listeners are delegated from the results
 * section, which outlives every individual response.
 */
const maskedView = new MaskedView({
  legendSection,
  legend: legendList,
  legendNote,
  original: originalPane,
  masked: maskedPane,
  answer: answerPane,
});

function render(response: AskResponse, submittedText: string): void {
  // Re-derive the tier from the OKF verified field rather than trusting the server's
  // value (SPEC §5.3).
  const tier = deriveTrustTier(extractVerified(response.okf));
  renderDimensions(response, tier);
  // The text the user typed is only ever held here, in the page that typed it:
  // the mapping between it and the masked prompt is recomputed locally so the
  // panels can be linked without asking the vault for anything.
  maskedView.render({
    originalText: submittedText,
    maskedPrompt: response.masked_prompt,
    answer: response.answer,
    countsByCategory: response.stats.counts_by_category,
    withheld: response.attestation.withheld ?? [],
  });
  okfPane.textContent = response.okf;
  renderAttestation(response);
  renderStats(response);
  renderCorrelation(response.request_id, response.trace_id);
  blockedPane.hidden = true;
  results.hidden = false;
}

/**
 * Show a refused request as a first-class outcome.
 *
 * A blocked request is the demo's most important frame: it is the moment the
 * fleet refuses to hand back an answer. Hiding it behind an error string would
 * make the guarantee invisible.
 */
function renderBlocked(error: ApiError): void {
  const categories =
    error.categories && error.categories.length > 0
      ? `<p class="findings">Categories: ${error.categories
          .map((c) => `<code>${escapeHtml(c)}</code>`)
          .join(', ')}</p>`
      : '';
  blockedPane.innerHTML = `
    <h2>Blocked — no answer was released</h2>
    <p class="blocked-reason">${escapeHtml(error.message)}</p>
    ${categories}
    <p class="blocked-note">
      Nothing was rehydrated, and no unmasked text was stored. HTTP ${error.status}.
    </p>`;
  if (error.requestId) renderCorrelation(error.requestId);
  // Nothing was released, so there is nothing to trace: the highlights from a
  // previous answer are dropped rather than left pointing at stale panels.
  maskedView.reset();
  blockedPane.hidden = false;
  results.hidden = true;
}

function setBusy(busy: boolean, message = ''): void {
  submit.disabled = busy;
  statusLine.textContent = message;
  statusLine.className = busy ? 'status busy' : 'status';
}

/**
 * Which high-risk categories the user allowed for this request.
 *
 * Read from the DOM at submit time rather than kept in a variable, so the boxes
 * on screen are the single source of truth: a state mirror is one more place the
 * "did I actually allow this?" answer could be wrong, and this is the one
 * question in the UI where being wrong discloses a secret.
 */
function selectedDisclosures(): string[] {
  return [
    ...composer.querySelectorAll<HTMLInputElement>('input[name="rehydrate_allow"]:checked'),
  ].map((box) => box.value);
}

composer.addEventListener('submit', (event) => {
  // The request is streamed over fetch; letting the form navigate would replace
  // the page that is about to render the answer.
  event.preventDefault();

  const text = input.value.trim();
  if (!text) {
    setBusy(false, 'Enter a request first.');
    return;
  }

  const rehydrateAllow = selectedDisclosures();
  // Only the terms the server would accept. An invalid one is already struck
  // through in the preview, and sending it would turn the whole request into a
  // 400 rather than masking the terms that were fine.
  const maskTerms = parseMaskTerms(maskTermsInput.value).filter(isValidTerm).slice(0, MAX_TERMS);

  // A cold fleet means the first Gemma call waits on a container start, so the
  // wait is named up front rather than left to look like a hang. `unknown` is
  // treated as cold here on purpose: warning about a wait that does not happen
  // costs the reader nothing, while an unannounced two-minute pause reads as a
  // broken demo.
  const mayNeedWakeup = gemmaWarmth !== 'warm';
  const minutes = Math.round(coldStartSeconds / 60);
  const waking = `Waking the GPU (up to ~${minutes} min)…`;

  resetSteps(mayNeedWakeup);
  setBusy(true, mayNeedWakeup ? waking : 'Masking, reasoning on the frontier model, verifying…');

  // The wake-up step has no progress frame of its own: it is over precisely when
  // the masking stage reports that Gemma answered, so it is closed from there.
  let wakeupOpen = mayNeedWakeup;

  askStreaming(
    text,
    (progressEvent) => {
      if (wakeupOpen && progressEvent.stage === 'masking') {
        // Timed from the browser, not from `elapsed_ms`.
        //
        // `elapsed_ms` is measured from the moment the request reached the
        // Gateway, which is *after* the GPU wake it is supposed to describe —
        // and because `gpu_wakeup` is the first step, `applyProgress` subtracted
        // a previous end of 0 and reported the masking stage's own elapsed time.
        // On a warm fleet that rounded to `0.0s`, which read as "the GPU started
        // instantly" for the one step whose whole purpose is to explain a
        // two-minute wait.
        //
        // The browser is the only place that can see this: it starts the clock
        // before the request is sent, so it spans the container start that the
        // server, by definition, is not yet running for.
        const waitedMs = runStartedAt === undefined ? 0 : Date.now() - runStartedAt;
        applyProgress('gpu_wakeup', 'end', waitedMs);
        wakeupOpen = false;
        setBusy(true, 'Masking, reasoning on the frontier model, verifying…');
      }
      applyProgress(progressEvent.stage, progressEvent.state, progressEvent.elapsed_ms);
    },
    rehydrateAllow,
    maskTerms,
  )
    .then((response) => {
      // The text as it was submitted, not as the textarea reads now: a user who
      // edits the box while the request is in flight must not shift the
      // alignment underneath the answer they get back.
      render(response, text);
      finishSteps();
      setBusy(false, '');
      // The request just proved Gemma is up, so the badge is refreshed rather
      // than left showing the state from before the run.
      void refreshStatus();
      return response;
    })
    .catch((error: unknown) => {
      markStopped();
      if (error instanceof ApiError) {
        renderBlocked(error);
        setBusy(false, `Refused (${error.status}).`);
        statusLine.className = 'status error';
        return;
      }
      results.hidden = true;
      blockedPane.hidden = true;
      setBusy(false, `Request failed: ${String(error)}`);
      statusLine.className = 'status error';
    });
});

startStatusPolling();

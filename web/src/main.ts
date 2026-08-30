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

const input = el<HTMLTextAreaElement>('input');
const submit = el<HTMLButtonElement>('submit');
const statusLine = el<HTMLParagraphElement>('status');
const results = el<HTMLElement>('results');
const blockedPane = el<HTMLElement>('blocked');
const maskedPane = el<HTMLPreElement>('masked');
const answerPane = el<HTMLPreElement>('answer');
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

input.value = SAMPLE;

// --- GPU warmth --------------------------------------------------------------

/** How often the badge is refreshed while the tab is visible. */
const STATUS_POLL_MS = 30_000;

/** The last state the badge showed, used to decide whether to warn before a submit. */
let gemmaWarmth: GemmaWarmth = 'unknown';
let coldStartSeconds = 120;

const WARMTH_LABEL: Record<GemmaWarmth, string> = {
  warm: 'GPU: warm',
  cold: 'GPU: cold',
  unknown: 'GPU: unknown',
};

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

  const minutes = Math.round(coldStartSeconds / 60);
  if (status.gemma === 'cold') {
    gpuNote.textContent = `The GPU is asleep — the first request may take about ${minutes} minutes while it starts.`;
    gpuNote.hidden = false;
  } else if (status.gemma === 'unknown') {
    gpuNote.textContent =
      'The GPU state could not be read, so the first request may or may not need a cold start.';
    gpuNote.hidden = false;
  } else {
    gpuNote.hidden = true;
  }
}

/**
 * Poll only while the tab is visible.
 *
 * A background tab polling a public endpoint every 30s costs the fleet reads for
 * a badge nobody is looking at; the state is refreshed on the way back instead.
 */
function startStatusPolling(): void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const start = (): void => {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
      return;
    }
    void refreshStatus();
    start();
  });

  void refreshStatus();
  start();
}

warmupButton.addEventListener('click', () => {
  warmupButton.disabled = true;
  gpuNote.textContent = 'Starting the GPU… it is billed for as long as it stays running.';
  gpuNote.hidden = false;

  warmup()
    .then(async () => {
      // The wake was dispatched, not completed: the badge only flips once a real
      // Gemma call has been recorded, so it is re-polled rather than assumed.
      await refreshStatus();
      return true;
    })
    .catch(() => {
      gpuNote.textContent = 'The warm-up request was refused. Try again in a moment.';
    })
    .finally(() => {
      warmupButton.disabled = false;
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

  progressPane.hidden = false;
  renderSteps();
}

function renderSteps(): void {
  stepsList.innerHTML = steps
    .map((step) => {
      const seconds =
        step.durationMs === undefined ? '' : `${(step.durationMs / 1000).toFixed(1)}s`;
      const mark =
        step.state === 'done'
          ? '✓'
          : step.state === 'stopped'
            ? '×'
            : step.state === 'active'
              ? '…'
              : '';
      return `<li class="step ${step.state}" data-stage="${escapeHtml(step.stage)}">
        <span class="step-mark">${mark}</span>
        <span class="step-label">${escapeHtml(STEP_LABELS[step.stage])}</span>
        <span class="step-time">${escapeHtml(seconds)}</span>
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
  const previousEnd = steps[index - 1]?.endedAtMs ?? 0;
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
  renderSteps();
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

/** Return HTML with the placeholders highlighted. */
function highlightPlaceholders(text: string): string {
  return escapeHtml(text).replace(/⟦[A-Z_]+_\d+⟧/g, '<mark class="token">$&</mark>');
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

function render(response: AskResponse): void {
  // Re-derive the tier from the OKF verified field rather than trusting the server's
  // value (SPEC §5.3).
  const tier = deriveTrustTier(extractVerified(response.okf));
  renderDimensions(response, tier);
  maskedPane.innerHTML = highlightPlaceholders(response.masked_prompt);
  answerPane.textContent = response.answer;
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
  blockedPane.hidden = false;
  results.hidden = true;
}

function setBusy(busy: boolean, message = ''): void {
  submit.disabled = busy;
  statusLine.textContent = message;
  statusLine.className = busy ? 'status busy' : 'status';
}

submit.addEventListener('click', () => {
  const text = input.value.trim();
  if (!text) {
    setBusy(false, 'Enter a request first.');
    return;
  }

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

  askStreaming(text, (event) => {
    if (wakeupOpen && event.stage === 'masking') {
      applyProgress('gpu_wakeup', 'end', event.elapsed_ms);
      wakeupOpen = false;
      setBusy(true, 'Masking, reasoning on the frontier model, verifying…');
    }
    applyProgress(event.stage, event.state, event.elapsed_ms);
  })
    .then((response) => {
      render(response);
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

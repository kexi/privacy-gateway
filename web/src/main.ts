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
  ask,
  deriveTrustTier,
  extractVerified,
  logsConsoleUrl,
  traceConsoleUrl,
  type AskResponse,
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

input.value = SAMPLE;

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
  dimensionsPane.innerHTML = `<div class="dimensions-grid">${cells.join('')}</div>
    <p class="derived">Derived trust tier: <code id="tier">${escapeHtml(tier)}</code>
    <small>(from the OKF <code>verified</code> field, not from a stored score)</small></p>`;
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
  setBusy(true, 'Masking, reasoning on the frontier model, verifying...');
  ask(text)
    .then((response) => {
      render(response);
      setBusy(false, '');
      return response;
    })
    .catch((error: unknown) => {
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

/**
 * Demo UI. Places the masked prompt beside the final answer to show what happened at
 * the boundary.
 *
 * The centrepiece is the difference between the string Gemini actually received and the
 * string the user receives, annotated with the attestation and the trust tier.
 */

import {
  ApiError,
  approve,
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

const TIER_LABEL: Record<TrustTier, string> = {
  unverified: 'unverified',
  'machine-confirmed': 'machine-confirmed',
  'human-reviewed': 'human-reviewed',
};

let current: AskResponse | null = null;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const input = el<HTMLTextAreaElement>('input');
const submit = el<HTMLButtonElement>('submit');
const approveButton = el<HTMLButtonElement>('approve');
const statusLine = el<HTMLParagraphElement>('status');
const results = el<HTMLElement>('results');
const maskedPane = el<HTMLPreElement>('masked');
const answerPane = el<HTMLPreElement>('answer');
const tierBadge = el<HTMLSpanElement>('tier');
const statusBadge = el<HTMLSpanElement>('doc-status');
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

function renderBadges(tier: TrustTier, status: string): void {
  tierBadge.textContent = TIER_LABEL[tier];
  tierBadge.className = `badge tier-${tier}`;
  statusBadge.textContent = status;
  statusBadge.className = `badge status-${status}`;
}

function renderAttestation(response: AskResponse): void {
  const { attestation, consistency } = response;
  const rows: string[] = [];

  rows.push(
    row(
      'Leak check',
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
  if (attestation.judge && typeof attestation.judge.leak === 'boolean') {
    rows.push(
      `<p class="advisory">Gemma judge (advisory): ${
        attestation.judge.leak ? 'flagged' : 'clear'
      }</p>`,
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
      <div><dt>Session</dt><dd><code>${escapeHtml(response.session_id)}</code></dd></div>
    </dl>`;
}

/**
 * Show the correlation ids, each copyable.
 *
 * These are what turns a user's "it went wrong" into a single Logs Explorer
 * query, so they are surfaced in the UI rather than left in the response body.
 */
function renderCorrelation(response: AskResponse): void {
  const rows: string[] = [
    idRow(
      'Request ID',
      response.request_id,
      GCP_PROJECT ? logsConsoleUrl(response.request_id, GCP_PROJECT) : undefined,
      'Logs',
    ),
  ];
  if (response.trace_id) {
    rows.push(
      idRow(
        'Trace ID',
        response.trace_id,
        GCP_PROJECT ? traceConsoleUrl(response.trace_id, GCP_PROJECT) : undefined,
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
  current = response;
  // Re-derive the tier from the OKF verified field rather than trusting the server's
  // value (SPEC §5.3).
  const tier = deriveTrustTier(extractVerified(response.okf));
  renderBadges(tier, response.status);
  maskedPane.innerHTML = highlightPlaceholders(response.masked_prompt);
  answerPane.textContent = response.answer;
  okfPane.textContent = response.okf;
  renderAttestation(response);
  renderStats(response);
  renderCorrelation(response);
  approveButton.disabled = tier === 'human-reviewed';
  results.hidden = false;
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
      results.hidden = true;
      const message =
        error instanceof ApiError
          ? `Refused: ${error.message}`
          : `Request failed: ${String(error)}`;
      setBusy(false, message);
      statusLine.className = 'status error';
    });
});

approveButton.addEventListener('click', () => {
  const snapshot = current;
  if (!snapshot) return;
  approveButton.disabled = true;
  approve(snapshot.session_id)
    .then((response) => {
      // Approval adds a human: actor to verified, so re-deriving yields human-reviewed.
      render({ ...snapshot, okf: response.markdown });
      statusLine.textContent = 'Approved. Trust tier raised to human-reviewed.';
      statusLine.className = 'status ok';
      return response;
    })
    .catch((error: unknown) => {
      approveButton.disabled = false;
      statusLine.textContent = `Approval failed: ${String(error)}`;
      statusLine.className = 'status error';
    });
});

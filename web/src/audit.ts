/**
 * The read-only audit view.
 *
 * A judge holds a capability token, pastes it in, and gets a browsable index of
 * every OKF `Gateway Answer` document the fleet has stored. Opening a row
 * fetches that document from `/v1/requests/<id>` — the same endpoint the main
 * UI uses, public by capability because knowing a UUIDv7 is the capability —
 * and renders it: the frontmatter as labelled facts, the body as text.
 *
 * Two things this page deliberately does not do.
 *
 * It ships no Markdown library. The OKF body is the *masked answer*, and it is
 * shown as the text it is: rendering it as HTML would mean a stored answer
 * could inject markup into the page an auditor is using to judge the fleet's
 * safety, and a rendered heading tells a reader nothing that a monospace one
 * does not. Every value that reaches the DOM here goes through `textContent`.
 *
 * And it never writes. There is no state to mutate from this page — no
 * approve, no delete, no re-run — because an audit view that can change what it
 * reports is not evidence.
 */

import { parseFrontmatter, traceConsoleUrl } from './api.ts';
// eslint-disable-next-line import/no-unassigned-import -- Vite bundles the stylesheet via this side-effect import
import './audit.css';

/** Where the token lives between reloads. Gone when the tab closes. */
const TOKEN_KEY = 'pgw.audit.token';

const GCP_PROJECT = import.meta.env.VITE_GCP_PROJECT ?? '';

/** One row of `GET /v1/audit`. Mirrors `AuditListEntry` in the gateway. */
interface AuditEntry {
  readonly request_id: string;
  readonly trace_id?: string;
  readonly created_at?: string;
  readonly stale_after?: string;
  readonly status: string;
  readonly trust_tier: string;
  readonly freshness: string;
  readonly attestation_verdict: string;
  readonly counts_by_category: Record<string, number>;
  readonly masked_count: number;
  readonly judge_retries: number;
  readonly withheld: readonly string[];
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element: ${id}`);
  return found as T;
}

const tokenInput = el<HTMLInputElement>('token');
const unlockButton = el<HTMLButtonElement>('unlock');
const forgetButton = el<HTMLButtonElement>('forget');
const gateStatus = el('gate-status');
const listSection = el('list-section');
const listCount = el('list-count');
const refreshButton = el<HTMLButtonElement>('refresh');
const rowsBody = el<HTMLTableSectionElement>('audit-rows');
const emptyNote = el('empty');
const detail = el('detail');
const detailTitle = el('detail-title');
const detailStatus = el('detail-status');
const detailLinks = el('detail-links');
const detailFrontmatter = el<HTMLDListElement>('detail-frontmatter');
const detailBody = el('detail-body');
const closeDetail = el<HTMLButtonElement>('close-detail');

/**
 * Read the token from session storage.
 *
 * Every access is guarded: a browser with site data blocked throws on the
 * accessor itself, and an audit page that cannot open because storage is
 * disabled would be a worse failure than simply asking for the token again.
 */
function storedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Non-fatal: the token stays in memory for this page load.
  }
}

function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear if storage was never writable.
  }
}

/** The token in play, preferring what the user just typed. */
function activeToken(): string {
  return tokenInput.value.trim() || storedToken();
}

function setStatus(node: HTMLElement, message: string, kind?: 'error' | 'ok'): void {
  node.textContent = message;
  node.className = kind === undefined ? 'status' : `status ${kind}`;
}

/** A chip whose colour states the verdict, with the text saying it too. */
function chip(text: string, kind: 'good' | 'bad' | 'info' | 'neutral'): HTMLElement {
  const span = document.createElement('span');
  span.className = kind === 'neutral' ? 'chip' : `chip ${kind}`;
  span.textContent = text;
  return span;
}

/** Cell holding one chip. */
function chipCell(text: string, kind: 'good' | 'bad' | 'info' | 'neutral'): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.append(chip(text, kind));
  return cell;
}

function textCell(text: string, className?: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  if (className !== undefined) cell.className = className;
  cell.textContent = text;
  return cell;
}

/** Timestamps are shown as the local time a reader can compare against a log. */
function formatTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

/** `status` maps onto the same three-way vocabulary the main UI uses. */
function statusKind(status: string): 'good' | 'bad' | 'neutral' {
  if (status === 'stable') return 'good';
  if (status === 'draft' || status === 'deprecated') return 'bad';
  return 'neutral';
}

function tierKind(tier: string): 'good' | 'info' | 'neutral' {
  if (tier === 'human-reviewed') return 'good';
  if (tier === 'machine-confirmed') return 'info';
  return 'neutral';
}

function verdictKind(verdict: string): 'good' | 'bad' | 'neutral' {
  if (verdict === 'pass') return 'good';
  if (verdict === 'fail') return 'bad';
  return 'neutral';
}

/** The `counts_by_category` map, as one small chip per category. */
function countsCell(entry: AuditEntry): HTMLTableCellElement {
  const cell = document.createElement('td');
  const categories = Object.entries(entry.counts_by_category);

  if (categories.length === 0) {
    cell.className = 'dash';
    cell.textContent = '—';
    return cell;
  }

  for (const [category, count] of categories.sort(([a], [b]) => a.localeCompare(b))) {
    const span = document.createElement('span');
    span.className = 'count-chip';
    span.textContent = `${category} ×${count}`;
    cell.append(span);
  }
  return cell;
}

/** Withheld categories, which are a policy outcome rather than a failure. */
function withheldCell(entry: AuditEntry): HTMLTableCellElement {
  const cell = document.createElement('td');
  if (entry.withheld.length === 0) {
    cell.className = 'dash';
    cell.textContent = 'none';
    return cell;
  }
  for (const category of entry.withheld) {
    const span = document.createElement('span');
    span.className = 'count-chip muted';
    span.textContent = category;
    cell.append(span);
  }
  return cell;
}

/** Builds one clickable row. */
function buildRow(entry: AuditEntry): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.dataset['requestId'] = entry.request_id;
  // Reachable by keyboard: the row is the control that opens the document, so
  // it has to behave like one for anyone not using a mouse.
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `Open evidence for request ${entry.request_id}`);

  row.append(
    textCell(entry.request_id, 'request-id'),
    textCell(formatTime(entry.created_at), 'timestamp'),
    chipCell(entry.status, statusKind(entry.status)),
    chipCell(entry.trust_tier, tierKind(entry.trust_tier)),
    chipCell(entry.attestation_verdict, verdictKind(entry.attestation_verdict)),
    countsCell(entry),
    textCell(entry.judge_retries === 0 ? '0' : String(entry.judge_retries)),
    withheldCell(entry),
  );

  const open = (): void => {
    void openEntry(entry);
  };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  return row;
}

/** Fetch and render the list. */
async function loadList(): Promise<void> {
  const token = activeToken();
  if (token === '') {
    setStatus(gateStatus, 'Paste the audit token to open the view.', 'error');
    return;
  }

  refreshButton.disabled = true;
  unlockButton.disabled = true;
  setStatus(gateStatus, 'Loading evidence…');

  try {
    // The token travels in a header rather than the query string so it does not
    // land in the browser's history or in any intermediary's access log.
    const response = await fetch('/v1/audit', { headers: { 'X-Admin-Token': token } });

    if (!response.ok) {
      // 404 is both "wrong token" and "feature off" by design — the endpoint
      // does not distinguish them, so neither does this message.
      setStatus(
        gateStatus,
        response.status === 404
          ? 'That token was not accepted, or the audit view is disabled on this deployment.'
          : `The audit list could not be read (HTTP ${response.status}).`,
        'error',
      );
      return;
    }

    const body = (await response.json()) as { entries?: AuditEntry[] };
    const entries = body.entries ?? [];

    storeToken(token);
    tokenInput.value = '';
    forgetButton.hidden = false;
    setStatus(gateStatus, 'Token accepted.', 'ok');

    rowsBody.replaceChildren(...entries.map(buildRow));
    listCount.textContent =
      entries.length === 1 ? '1 document' : `${String(entries.length)} documents`;
    emptyNote.hidden = entries.length > 0;
    listSection.hidden = false;
  } catch {
    setStatus(gateStatus, 'The gateway could not be reached.', 'error');
  } finally {
    refreshButton.disabled = false;
    unlockButton.disabled = false;
  }
}

/** One `<dt>`/`<dd>` pair. */
function definition(term: string, value: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  fragment.append(dt, dd);
  return fragment;
}

/**
 * Flatten one frontmatter value into readable text.
 *
 * Nested blocks (`generated`, `attestation`, `sources[]`) are shown as indented
 * `key: value` lines rather than as JSON: the reader is checking recorded claims
 * against each other, and braces are noise in that task.
 */
function describe(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    return value.map((item) => `${indent}- ${describe(item, `${indent}  `).trim()}`).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${indent}${key}: ${describe(nested, `${indent}  `)}`)
      .join('\n');
  }
  return String(value);
}

/** Split an OKF document into its frontmatter block and its body. */
function splitBody(markdown: string): string {
  const match = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/u.exec(markdown);
  return match?.[1] ?? markdown;
}

/** Links a reader follows out of one document. */
function buildLinks(entry: AuditEntry): void {
  const links: Array<{ label: string; href: string }> = [
    {
      label: 'Raw OKF document',
      href: `/v1/requests/${encodeURIComponent(entry.request_id)}`,
    },
    {
      label: 'Masked prompt (source)',
      href: `/v1/requests/${encodeURIComponent(entry.request_id)}/masked-prompt.md`,
    },
    {
      label: 'Core response (source)',
      href: `/v1/requests/${encodeURIComponent(entry.request_id)}/core-response.md`,
    },
  ];

  // The trace link only exists when tracing was on and a project is configured;
  // a dead console link is worse than no link.
  if (entry.trace_id !== undefined && entry.trace_id !== '' && GCP_PROJECT !== '') {
    links.push({ label: 'Cloud Trace', href: traceConsoleUrl(entry.trace_id, GCP_PROJECT) });
  }

  detailLinks.replaceChildren(
    ...links.map(({ label, href }) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = label;
      return anchor;
    }),
  );
}

/** Fetch and render one stored document. */
async function openEntry(entry: AuditEntry): Promise<void> {
  for (const row of rowsBody.querySelectorAll('tr')) {
    row.setAttribute('aria-selected', String(row.dataset['requestId'] === entry.request_id));
  }

  detail.hidden = false;
  detailTitle.textContent = entry.request_id;
  detailFrontmatter.replaceChildren();
  detailBody.textContent = '';
  buildLinks(entry);
  setStatus(detailStatus, 'Loading the document…');
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const response = await fetch(`/v1/requests/${encodeURIComponent(entry.request_id)}`);
    if (!response.ok) {
      setStatus(
        detailStatus,
        response.status === 404
          ? 'This record has expired with the token vault TTL and is no longer stored.'
          : `The document could not be read (HTTP ${String(response.status)}).`,
        'error',
      );
      return;
    }

    const markdown = await response.text();
    const metadata = parseFrontmatter(markdown);

    if (metadata === null) {
      // §11: a document whose metadata will not parse is still shown. The body
      // is the evidence; the unreadable frontmatter is itself a finding.
      setStatus(detailStatus, 'The frontmatter of this document could not be parsed.', 'error');
    } else {
      setStatus(detailStatus, '');
      detailFrontmatter.replaceChildren(
        ...Object.entries(metadata).map(([key, value]) => definition(key, describe(value))),
      );
    }

    detailBody.textContent = splitBody(markdown).trim();
  } catch {
    setStatus(detailStatus, 'The gateway could not be reached.', 'error');
  }
}

unlockButton.addEventListener('click', () => {
  void loadList();
});

tokenInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void loadList();
  }
});

refreshButton.addEventListener('click', () => {
  void loadList();
});

forgetButton.addEventListener('click', () => {
  clearToken();
  tokenInput.value = '';
  forgetButton.hidden = true;
  listSection.hidden = true;
  detail.hidden = true;
  rowsBody.replaceChildren();
  setStatus(gateStatus, 'The token has been forgotten on this device.');
});

closeDetail.addEventListener('click', () => {
  detail.hidden = true;
  for (const row of rowsBody.querySelectorAll('tr')) row.setAttribute('aria-selected', 'false');
});

/**
 * Open straight away when the token is already known.
 *
 * A `#key=` fragment is accepted once, moved into session storage and then
 * stripped from the address bar. The fragment — not a `?key=` query — is what
 * carries a shareable demo link, because browsers never transmit the fragment:
 * a query parameter would land verbatim in Cloud Run's request log
 * (`httpRequest.requestUrl`), publishing the capability to every reader of the
 * logs. Clearing it immediately keeps it out of the history and out of every
 * subsequent referrer as well.
 */
function boot(): void {
  const fragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const fromUrl = new URLSearchParams(fragment).get('key');
  if (fromUrl !== null && fromUrl !== '') {
    storeToken(fromUrl);
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
  }

  if (storedToken() === '') return;

  // The gate stays on the page so the token can be replaced or forgotten; it
  // just is not what the reader has to deal with first.
  forgetButton.hidden = false;
  void loadList();
}

boot();

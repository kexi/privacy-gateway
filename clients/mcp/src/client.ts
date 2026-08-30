/**
 * The gateway HTTP client, and the attestation replay.
 *
 * Deliberately standalone: this package does not depend on
 * `@privacy-gateway/common`, so it demonstrates the same thing the Python client
 * does — the gateway speaks ordinary JSON over HTTP and consuming it needs no
 * SDK and no shared runtime with the agents.
 *
 * That independence is load-bearing for `verify`. Replaying the leak check by
 * importing the fleet's own attester would only prove the fleet agrees with
 * itself; the patterns below are transcribed from it on purpose, so a
 * disagreement between this code and the fleet's is a finding rather than an
 * impossibility. Ported from `clients/python/pgw.py`.
 */

/** Where the gateway lives. Overridden by `PGW_GATEWAY_URL`. */
export const DEFAULT_GATEWAY_URL = 'http://localhost:8081';

const DEFAULT_TIMEOUT_MS = 180_000;

export interface GatewayClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** A refusal, or any non-2xx answer, carried as a value rather than thrown. */
export interface GatewayFailure {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
  readonly message: string;
  readonly categories: readonly string[];
  readonly requestId: string | undefined;
}

export interface GatewaySuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type GatewayResult<T> = GatewaySuccess<T> | GatewayFailure;

/** The subset of `POST /v1/ask` this client surfaces. */
export interface AskPayload {
  readonly request_id: string;
  readonly trace_id?: string;
  readonly masked_prompt: string;
  readonly answer: string;
  readonly okf: string;
  readonly trust_tier: string;
  readonly status: string;
  readonly attestation: {
    readonly ok: boolean;
    readonly reason?: string;
    readonly findings?: readonly string[];
    readonly withheld?: readonly string[];
  };
}

/**
 * Turn a non-2xx response into a structured failure.
 *
 * Never throws: a refusal is the fleet working correctly, and the model on the
 * other end of the MCP transport needs to read *why* in order to explain it.
 */
async function toFailure(response: Response): Promise<GatewayFailure> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON error body (a proxy's HTML, say) carries nothing worth
    // relaying, so the status stands on its own.
  }

  // The OpenAI-compatible endpoint nests its fields under `error`; the native
  // one keeps them flat. Both shapes are read so this client works against
  // either.
  const nested =
    typeof body['error'] === 'object' && body['error'] !== null
      ? (body['error'] as Record<string, unknown>)
      : undefined;
  const pick = (key: string): unknown => nested?.[key] ?? body[key];

  const rawCategories = pick('categories');

  return {
    ok: false,
    status: response.status,
    error:
      typeof pick('code') === 'string'
        ? (pick('code') as string)
        : typeof body['error'] === 'string'
          ? body['error']
          : `http_${response.status}`,
    message:
      typeof pick('message') === 'string' ? (pick('message') as string) : response.statusText,
    categories: Array.isArray(rawCategories)
      ? rawCategories.filter((item): item is string => typeof item === 'string')
      : [],
    requestId: typeof pick('request_id') === 'string' ? (pick('request_id') as string) : undefined,
  };
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_GATEWAY_URL).replace(/\/+$/u, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `POST /v1/ask`.
   *
   * `maskTerms` is omitted from the body when empty rather than sent as `[]`:
   * the schema requires at least one entry, so an empty array is a 400 rather
   * than a no-op.
   */
  async ask(text: string, maskTerms: readonly string[] = []): Promise<GatewayResult<AskPayload>> {
    const response = await this.request('/v1/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        ...(maskTerms.length > 0 ? { mask_terms: [...maskTerms] } : {}),
      }),
    });
    if (!response.ok) return toFailure(response);
    return { ok: true, value: (await response.json()) as AskPayload };
  }

  /** `GET /v1/requests/:id` — the stored, masked OKF document. */
  async evidence(requestId: string): Promise<GatewayResult<string>> {
    const response = await this.request(`/v1/requests/${encodeURIComponent(requestId)}`);
    if (!response.ok) return toFailure(response);
    return { ok: true, value: await response.text() };
  }

  /** One of the two masked artifacts the OKF `sources[]` names. */
  async artifact(
    requestId: string,
    name: 'masked-prompt.md' | 'core-response.md',
  ): Promise<GatewayResult<string>> {
    const response = await this.request(`/v1/requests/${encodeURIComponent(requestId)}/${name}`);
    if (!response.ok) return toFailure(response);
    return { ok: true, value: await response.text() };
  }
}

// --- OKF frontmatter reading -------------------------------------------------

/** The raw YAML frontmatter block, or an empty string. */
export function frontmatter(markdown: string): string {
  const match = /^---\n([\s\S]*?)\n---/u.exec(markdown);
  return match?.[1] ?? '';
}

const VERIFIED_BLOCK_RE = /^verified:\s*$\n((?:^[ \t-].*$\n?)*)/mu;
const INLINE_VERIFIED_RE = /^verified:\s*(\{.*\}|\[.*\])\s*$/mu;

/** The actors listed in the OKF `verified` field, in order. */
export function verifiers(markdown: string): string[] {
  const front = frontmatter(markdown);
  const block = VERIFIED_BLOCK_RE.exec(front);
  const source = block?.[1] ?? INLINE_VERIFIED_RE.exec(front)?.[1];
  if (source === undefined) return [];

  return [...source.matchAll(/\bby:\s*["']?([^"',}\s]+)/gu)].map((match) => match[1] ?? '');
}

export const TRUST_UNVERIFIED = 'unverified';
export const TRUST_MACHINE_CONFIRMED = 'machine-confirmed';
export const TRUST_HUMAN_REVIEWED = 'human-reviewed';

/**
 * Derive the SPEC §5.3 trust tier from a Gateway Answer document.
 *
 * Derived here rather than read from the server's response: the spec requires
 * the tier to be derived and never stored, and a client that re-derives it
 * proves the property holds end to end.
 */
export function trustTier(markdown: string): string {
  const actors = verifiers(markdown);
  if (actors.length === 0) return TRUST_UNVERIFIED;
  if (actors.some((actor) => actor.startsWith('human:'))) return TRUST_HUMAN_REVIEWED;
  return TRUST_MACHINE_CONFIRMED;
}

/** Read one scalar frontmatter key. */
export function field(markdown: string, key: string): string | undefined {
  const pattern = new RegExp(
    `^${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:\\s*["']?([^"'\n]+)`,
    'mu',
  );
  return pattern.exec(frontmatter(markdown))?.[1]?.trim();
}

/** The flat scalars of the frontmatter `attestation:` block. */
export function attestationBlock(markdown: string): Record<string, string> {
  const match = /^attestation:\s*$\n((?:^[ \t]+.*$\n?)*)/mu.exec(frontmatter(markdown));
  if (match?.[1] === undefined) return {};

  const entries: Record<string, string> = {};
  // The key class must admit digits: every digest key ends in `sha256`, so a
  // `[a-z_]+` class silently skips exactly the entries this replay exists to
  // check, leaving only `request_id` and `verdict` and reporting the digests as
  // absent. `[ \t]` rather than `\s` because `\s` matches newlines even under
  // `m`, which would run one match across two lines.
  for (const line of match[1].matchAll(/^[ \t]+([a-z_][a-z0-9_]*):[ \t]*(.+)$/gmu)) {
    const key = line[1];
    const value = line[2];
    if (key !== undefined && value !== undefined) {
      entries[key] = value.trim().replace(/^["']|["']$/gu, '');
    }
  }
  return entries;
}

// --- the replayed leak check -------------------------------------------------

/**
 * The attester's patterns, transcribed.
 *
 * See the module docstring: importing the fleet's own scanner would make this
 * check tautological.
 */
const SCAN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['EMAIL', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu],
  ['AWS_KEY', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/gu],
  [
    'API_KEY',
    /\bsk-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}\b|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bAIza[0-9A-Za-z_-]{35}\b/gu,
  ],
  ['CREDIT_CARD', /\b(?:\d[ -]?){12,18}\d\b/gu],
  ['PHONE', /(?<![\d-])(?:\+81[ -]?|0)\d{1,4}[ -]?\d{1,4}[ -]?\d{3,4}(?![\d-])/gu],
  ['MY_NUMBER', /(?<![\d-])\d{12}(?![\d-])/gu],
  ['IPV4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu],
];

function luhnOk(digits: string): boolean {
  if (!/^\d+$/u.test(digits) || digits.length < 12 || digits.length > 19) return false;

  let total = 0;
  const reversed = [...digits].reverse();
  for (const [index, char] of reversed.entries()) {
    let value = Number(char);
    if (index % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    total += value;
  }
  return total % 10 === 0;
}

/** The sorted set of PII categories present in `text`. */
export function scan(text: string): string[] {
  const found = new Set<string>();

  for (const [category, pattern] of SCAN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      const digits = value.replace(/\D/gu, '');

      if (category === 'CREDIT_CARD' && !luhnOk(digits)) continue;
      if (category === 'MY_NUMBER' && digits.length !== 12) continue;
      if (category === 'IPV4') {
        const parts = value.split('.');
        if (parts.length !== 4 || parts.some((part) => Number(part) > 255)) continue;
      }
      found.add(category);
    }
  }

  return [...found].sort();
}

export async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const SHA256_RE = /^[0-9a-f]{64}$/u;

/** One replayed check, as reported to the caller. */
export interface VerifyCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly value: string;
}

export interface VerifyReport {
  readonly request_id: string;
  readonly ok: boolean;
  readonly checks: readonly VerifyCheck[];
  /** The categories this client found in the served core response, on its own. */
  readonly independently_derived_findings: readonly string[];
  readonly trust_tier: string;
  /**
   * The digests naming bundle files, which this client cannot hash.
   *
   * Reported as skipped, never as a pass: `pgw.py` can hash the checkout it
   * lives in, but an MCP server is normally installed far from the repository,
   * and claiming a match it never computed would be the one lie that makes the
   * whole replay worthless.
   */
  readonly not_checked: readonly string[];
}

/**
 * Replay one answer's attestation from the artifacts the gateway serves.
 *
 * Every digest the document records is checked for syntax; the two artifact
 * digests are recomputed from the served bytes; the request id and the verdict
 * are compared against an independently derived scan.
 */
export async function verify(
  client: GatewayClient,
  requestId: string,
): Promise<GatewayResult<VerifyReport>> {
  const okf = await client.evidence(requestId);
  if (!okf.ok) return okf;
  const prompt = await client.artifact(requestId, 'masked-prompt.md');
  if (!prompt.ok) return prompt;
  const core = await client.artifact(requestId, 'core-response.md');
  if (!core.ok) return core;

  const recorded = attestationBlock(okf.value);
  if (Object.keys(recorded).length === 0) {
    return {
      ok: false,
      status: 422,
      error: 'no_attestation',
      message: 'the document carries no attestation block; nothing to replay',
      categories: [],
      requestId,
    };
  }

  const findings = scan(core.value);
  const checks: VerifyCheck[] = [];

  // 1. Syntax. A digest that is not 64 lowercase hex characters names bytes
  //    nobody can fetch, so it is rejected before being compared to anything.
  for (const name of [
    'masked_prompt_sha256',
    'core_response_sha256',
    'attester_sha256',
    'computation_sha256',
  ]) {
    const value = recorded[name] ?? '';
    checks.push({
      name: `${name} is a sha256 digest`,
      ok: SHA256_RE.test(value),
      value: value === '' ? '(absent)' : value,
    });
  }

  // 2. The two artifacts the gateway serves, hashed here.
  const promptDigest = await sha256(prompt.value);
  checks.push({
    name: 'masked_prompt_sha256 matches the served prompt',
    ok: recorded['masked_prompt_sha256'] === promptDigest,
    value: recorded['masked_prompt_sha256'] ?? '(absent)',
  });

  const coreDigest = await sha256(core.value);
  checks.push({
    name: 'core_response_sha256 matches the served response',
    ok: recorded['core_response_sha256'] === coreDigest,
    value: recorded['core_response_sha256'] ?? '(absent)',
  });

  // 3. The request id the document binds itself to, and the verdict.
  checks.push({
    name: 'request_id matches the document',
    ok: recorded['request_id'] === requestId,
    value: recorded['request_id'] ?? '(absent)',
  });
  checks.push({
    name: 'verdict matches the independently derived findings',
    ok: recorded['verdict'] === (findings.length === 0 ? 'pass' : 'fail'),
    value: recorded['verdict'] ?? '(absent)',
  });

  return {
    ok: true,
    value: {
      request_id: requestId,
      ok: checks.every((check) => check.ok),
      checks,
      independently_derived_findings: findings,
      trust_tier: trustTier(okf.value),
      not_checked: [
        'attester_sha256 and computation_sha256 name files in the fleet repository; ' +
          'this client hashes only the artifacts the gateway serves. Run ' +
          '`uv run clients/python/pgw.py verify <id>` from a checkout to compare those two.',
      ],
    },
  };
}

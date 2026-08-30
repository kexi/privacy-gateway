/**
 * The token-gated audit view: the OKF evidence store as a browsable list.
 *
 * What this exposes is exactly what `/v1/requests/<id>` already serves to
 * anybody who knows an id — masked prompts, tokenized core responses and the
 * OKF `Gateway Answer` documents. The only thing the token buys is
 * *enumeration*: without it a reader must already possess a request id, which
 * during a demo means they were the one who made the request.
 *
 * Why a token rather than real authentication: the public gateway authenticates
 * nobody (see AGENTS.md — human review is out of scope for exactly this
 * reason), so there is no principal to check against. `ADMIN_TOKEN` is a
 * **capability**, not an identity: holding the string is the whole claim, and
 * nothing in the fleet may ever mint an OKF `human:` actor from it.
 *
 * Why a missing or wrong token answers 404 rather than 401: a 401 advertises
 * that an admin surface exists at this path. The feature-off state and the
 * wrong-token state are therefore indistinguishable from outside, which is the
 * point — an unset `ADMIN_TOKEN` genuinely removes the routes, so 404 is also
 * the literal truth in that case.
 */

import {
  categoryOf,
  findTokens,
  freshness,
  parse as parseOkf,
  trustTier,
  GatewayAnswerFrontmatterSchema,
  type Freshness,
  type OkfTrustTier,
} from '@privacy-gateway/common';
import { timingSafeEqual } from 'node:crypto';

/** Newest-first page size. Deliberately small: this is a demo audit view. */
export const AUDIT_LIST_LIMIT = 50;

/**
 * One row of the audit list.
 *
 * Metadata only — no document bodies. A reader who wants the OKF text follows
 * the row to `/v1/requests/<id>`, which is the same endpoint the main UI uses
 * and which applies the same expiry rules.
 */
export interface AuditListEntry {
  readonly request_id: string;
  readonly trace_id?: string | undefined;
  /** `generated.at` from the OKF frontmatter, when the document carries one. */
  readonly created_at?: string | undefined;
  readonly stale_after?: string | undefined;
  readonly status: string;
  /** Derived from `verified[]`, never stored. See OKF §5.3. */
  readonly trust_tier: OkfTrustTier;
  readonly freshness: Freshness;
  /** The recorded `attestation.verdict`, or `unknown` for a broken block. */
  readonly attestation_verdict: 'pass' | 'fail' | 'unknown';
  /** Placeholder counts re-derived from the stored masked prompt. */
  readonly counts_by_category: Record<string, number>;
  readonly masked_count: number;
  /** How many advisory-judge retries the release needed; absent means none. */
  readonly judge_retries: number;
  /** Categories the rehydrator withheld by policy. */
  readonly withheld: readonly string[];
}

/**
 * The Firestore query surface the audit list needs.
 *
 * Narrower than the evidence store's writer surface and read-only by
 * construction: there is no `set` and no `delete` here, so this module cannot
 * mutate the audit record it is displaying even by mistake.
 */
export interface AuditQueryLike {
  collection(name: string): {
    orderBy(
      field: string,
      direction: 'desc' | 'asc',
    ): {
      limit(count: number): {
        get(): Promise<{ docs: ReadonlyArray<{ data(): Record<string, unknown> | undefined }> }>;
      };
    };
  };
}

/**
 * Read-only access to the answers collection the Synthesis store writes.
 *
 * Why a query module in the gateway rather than importing the Synthesis store:
 * `AnswerStore` is a keyed get/put interface with no listing operation, and
 * adding an enumerate method to the writer's interface would put a
 * "list everything" capability on the object that Synthesis holds. The gateway
 * already has `roles/datastore.user`; this reads the same collection through a
 * surface that can only read.
 */
export interface AuditStore {
  list(limit: number): Promise<readonly AuditListEntry[]>;
}

/** An in-memory store, for tests and the memory backend. */
export class InMemoryAuditStore implements AuditStore {
  private readonly records: Array<Record<string, unknown>> = [];

  /** Adds one raw record in the shape the Firestore documents use. */
  add(record: Record<string, unknown>): void {
    this.records.push(record);
  }

  list(limit: number): Promise<readonly AuditListEntry[]> {
    // Newest first by `request_id`: it is a UUIDv7, so lexicographic order is
    // creation order. That is the same ordering the Firestore query uses, which
    // keeps the two backends from disagreeing about what "newest" means.
    const sorted = [...this.records].sort((a, b) =>
      String(b['request_id'] ?? '').localeCompare(String(a['request_id'] ?? '')),
    );
    return Promise.resolve(sorted.slice(0, limit).map(toEntry).filter(isEntry));
  }
}

export interface FirestoreAuditStoreOptions {
  readonly collection?: string | undefined;
  readonly client?: AuditQueryLike | undefined;
  readonly projectId?: string | undefined;
}

export class FirestoreAuditStore implements AuditStore {
  private readonly collectionName: string;
  private client: AuditQueryLike | undefined;
  private readonly projectId: string | undefined;

  constructor(options: FirestoreAuditStoreOptions = {}) {
    this.collectionName =
      options.collection ?? process.env['ANSWER_COLLECTION'] ?? 'gateway_answers';
    this.client = options.client;
    this.projectId = options.projectId ?? process.env['GOOGLE_CLOUD_PROJECT'];
  }

  /**
   * Created lazily so importing this module never opens a client.
   *
   * `@google-cloud/firestore` is a direct dependency of this package, matching
   * what `agents/synthesis` does for the same reason. Why not rely on the
   * transitive copy `packages/common` pulls in: pnpm does not hoist, so the
   * production image — installed with `--filter @privacy-gateway/gateway...` —
   * resolves the package only for `common`, and this import threw at runtime
   * while working perfectly in the workspace dev tree.
   */
  private async resolveClient(): Promise<AuditQueryLike> {
    if (this.client !== undefined) return this.client;
    const { Firestore } = await import('@google-cloud/firestore');
    const created =
      this.projectId !== undefined ? new Firestore({ projectId: this.projectId }) : new Firestore();
    this.client = created as unknown as AuditQueryLike;
    return this.client;
  }

  async list(limit: number): Promise<readonly AuditListEntry[]> {
    const client = await this.resolveClient();
    // Ordered by the document's own `request_id` rather than by `expires_at`:
    // the id is a UUIDv7, so it sorts by creation time without needing a
    // separate index on a timestamp the TTL sweep also writes to.
    const snapshot = await client
      .collection(this.collectionName)
      .orderBy('request_id', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => toEntry(doc.data() ?? {})).filter(isEntry);
  }
}

/** Selected by the same environment variable as the vault and evidence store. */
export function buildAuditStore(backend?: string): AuditStore {
  const choice = (backend ?? process.env['VAULT_BACKEND'] ?? 'memory').trim().toLowerCase();
  if (choice === 'firestore') return new FirestoreAuditStore();
  if (choice === 'memory') return new InMemoryAuditStore();
  throw new Error(`unknown VAULT_BACKEND: '${choice}' (expected 'memory' or 'firestore')`);
}

/** Narrows the nulls out of a mapped list. */
function isEntry(entry: AuditListEntry | null): entry is AuditListEntry {
  return entry !== null;
}

/**
 * Map one stored record onto a list row.
 *
 * Fail-soft rather than fail-closed, and deliberately so: this is the read path
 * of an audit view, not a release gate. A record whose frontmatter will not
 * parse still gets a row with `status: unknown` and an `unverified` tier —
 * §10.5 and §11 of the OKF spec both say a broken or failed attestation is
 * shown, not silently dropped. Only a record with no usable id at all is
 * skipped, because there would be nothing for the row to link to.
 */
export function toEntry(data: Record<string, unknown>): AuditListEntry | null {
  const requestId = data['request_id'];
  if (typeof requestId !== 'string' || requestId === '') return null;

  const okf = typeof data['okf'] === 'string' ? data['okf'] : '';
  const maskedPrompt = typeof data['masked_prompt'] === 'string' ? data['masked_prompt'] : '';

  const metadata = readMetadata(okf);
  const parsed = GatewayAnswerFrontmatterSchema.safeParse(metadata);
  const frontmatter = parsed.success ? parsed.data : undefined;
  const attestation = frontmatter?.attestation;

  return {
    request_id: requestId,
    trace_id: typeof metadata['trace_id'] === 'string' ? metadata['trace_id'] : undefined,
    created_at: frontmatter?.generated?.at,
    stale_after: frontmatter?.stale_after,
    status: frontmatter?.status ?? 'unknown',
    trust_tier: trustTier(metadata),
    freshness: freshness(metadata),
    attestation_verdict: attestation?.verdict ?? 'unknown',
    counts_by_category: countPlaceholders(maskedPrompt),
    masked_count: findTokens(maskedPrompt).length,
    // `judge_retries` is written only when the advisory judge actually had to
    // retry, so an absent key means zero rather than unknown.
    judge_retries: readRetries(attestation),
    withheld: attestation?.withheld ?? [],
  };
}

/** Reads the retry count out of the passthrough attestation block. */
function readRetries(attestation: Record<string, unknown> | undefined): number {
  const value = attestation?.['judge_retries'];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Parses the OKF frontmatter, returning an empty map for anything unreadable. */
function readMetadata(okf: string): Record<string, unknown> {
  if (okf === '') return {};
  try {
    return parseOkf(okf).metadata;
  } catch {
    // A stored document that will not parse is itself an audit finding; the row
    // reports it as `unknown`/`unverified` rather than vanishing from the list.
    return {};
  }
}

/**
 * Re-derive the masked category counts from the stored masked prompt.
 *
 * Why re-derive rather than store them: the counts are a property of the masked
 * artifact the fleet actually serves, so deriving them from those bytes cannot
 * drift from what a reader sees when they fetch `masked-prompt.md`. A stored
 * count could disagree with the document and there would be no way to tell
 * which was right.
 */
export function countPlaceholders(maskedPrompt: string): Record<string, number> {
  const counts: Record<string, number> = {};
  // Distinct placeholders, not occurrences: `⟦EMAIL_1⟧` repeated three times is
  // one masked value, and counting it as three would overstate how much of the
  // prompt was personal data.
  for (const token of new Set(findTokens(maskedPrompt))) {
    const category = categoryOf(token);
    if (category === null) continue;
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

/**
 * Compare a presented token against the configured one without leaking timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a length
 * oracle, so both sides are hashed to a fixed width first. Why not compare
 * lengths and return early: that is the oracle, stated directly.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  if (expected === '') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still perform a comparison of equal length so the work done is the same
    // whether the length matched or not.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * The token a request presents, from the query string or the header.
 *
 * The query parameter exists because the audit view is opened from a pasted
 * link during a demo; the header is what a script would use. Neither is logged.
 */
export function presentedToken(
  query: unknown,
  header: string | string[] | undefined,
): string | null {
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader;

  const key = (query as Record<string, unknown> | undefined)?.['key'];
  if (typeof key === 'string' && key !== '') return key;
  return null;
}

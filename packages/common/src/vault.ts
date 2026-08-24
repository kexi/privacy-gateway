/**
 * Token Vault: holds the placeholder -> raw PII mapping for one request.
 *
 * Only components inside the trust boundary (Gateway / Synthesis) touch it. The
 * Core Agent is structured so that it never depends on this module, which is the
 * first layer of the guarantee that "Core cannot read the vault" — Core imports
 * only the `/logging`, `/config`, `/schema` and `/telemetry` subpaths, none of
 * which reach here.
 *
 * One entry per request. The gateway mints the request id server-side, so two
 * concurrent requests can never contend for the same document; the `generation`
 * counter and the Firestore transaction below exist so that a delayed answer
 * from a previous generation cannot resolve against a newer mapping even if a
 * caller replays an id.
 *
 * The implementation is selected by the `VAULT_BACKEND` environment variable:
 *   - `memory` … an in-process map, for local development and tests
 *   - `firestore` … Firestore, for Cloud Run production (keep the TTL policy
 *     aligned with `stale_after`)
 */

import type { Firestore } from '@google-cloud/firestore';
import { DEFAULT_VAULT_TTL_SECONDS } from './config.ts';

export { DEFAULT_VAULT_TTL_SECONDS };

/** The vault record for one request. */
export interface VaultEntry {
  readonly requestId: string;
  readonly mapping: Record<string, string>;
  readonly expiresAt: Date;
  /**
   * Incremented on every allocating write.
   *
   * Synthesis is handed the generation the gateway wrote and refuses to
   * rehydrate against any other one, so a mapping that was replaced between the
   * Core call and the release cannot silently resolve tokens to different
   * values.
   */
  readonly generation: number;
}

/** True once the entry's absolute expiry has passed. */
export function isExpired(entry: VaultEntry, now: Date = new Date()): boolean {
  return now.getTime() >= entry.expiresAt.getTime();
}

/** Interface of the Token Vault. */
export interface TokenVault {
  /** Store the request mapping, merging into any existing one without extending it. */
  put(
    requestId: string,
    mapping: Readonly<Record<string, string>>,
    ttlSeconds?: number,
  ): Promise<VaultEntry>;
  /** Return the request mapping, or `null` if it is absent or has expired. */
  get(requestId: string): Promise<VaultEntry | null>;
  /** Discard the entry. */
  delete(requestId: string): Promise<void>;
}

/** In-process map implementation. */
export class InMemoryTokenVault implements TokenVault {
  private readonly entries = new Map<string, VaultEntry>();

  put(
    requestId: string,
    mapping: Readonly<Record<string, string>>,
    ttlSeconds: number = DEFAULT_VAULT_TTL_SECONDS,
  ): Promise<VaultEntry> {
    const existing = this.entries.get(requestId);
    const live = existing !== undefined && !isExpired(existing);

    const merged = { ...(live ? existing.mapping : {}), ...mapping };
    // Keep the expiry from the first write. Extending it on every append would
    // move stale_after and contradict the freshness claim made in the OKF
    // document.
    const expiresAt = live ? existing.expiresAt : new Date(Date.now() + ttlSeconds * 1000);
    const generation = (live ? existing.generation : 0) + 1;

    const entry: VaultEntry = { requestId, mapping: merged, expiresAt, generation };
    this.entries.set(requestId, entry);
    return Promise.resolve(entry);
  }

  get(requestId: string): Promise<VaultEntry | null> {
    const entry = this.entries.get(requestId);
    if (entry === undefined) return Promise.resolve(null);
    if (isExpired(entry)) {
      this.entries.delete(requestId);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry);
  }

  delete(requestId: string): Promise<void> {
    this.entries.delete(requestId);
    return Promise.resolve();
  }
}

/** One Firestore document reference, narrowed to what this module uses. */
export interface FirestoreDocLike {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}

/** The transaction surface `runTransaction` hands the callback. */
export interface FirestoreTransactionLike {
  get(doc: FirestoreDocLike): Promise<{
    exists: boolean;
    data(): Record<string, unknown> | undefined;
  }>;
  set(doc: FirestoreDocLike, data: Record<string, unknown>): unknown;
}

/** The Firestore surface this module uses; narrowed so tests can supply a double. */
export interface FirestoreLike {
  collection(name: string): { doc(id: string): FirestoreDocLike };
  /**
   * Optional so an older double still type-checks; when it is absent the vault
   * falls back to a plain read-modify-write, which is correct for the
   * single-writer-per-request model but loses the concurrency guarantee.
   */
  runTransaction?<T>(fn: (transaction: FirestoreTransactionLike) => Promise<T>): Promise<T>;
}

export interface FirestoreVaultOptions {
  readonly collection?: string | undefined;
  readonly client?: FirestoreLike | undefined;
  readonly projectId?: string | undefined;
}

/** Firestore implementation. Operate it with a TTL policy on `expires_at`. */
export class FirestoreTokenVault implements TokenVault {
  private readonly collectionName: string;
  private client: FirestoreLike | undefined;
  private readonly projectId: string | undefined;

  constructor(options: FirestoreVaultOptions = {}) {
    this.collectionName = options.collection ?? process.env['VAULT_COLLECTION'] ?? 'token_vault';
    this.client = options.client;
    this.projectId = options.projectId ?? process.env['GOOGLE_CLOUD_PROJECT'];
  }

  /** Created lazily so importing this module never opens a client. */
  private async resolveClient(): Promise<FirestoreLike> {
    if (this.client !== undefined) return this.client;
    const { Firestore: FirestoreCtor } = await import('@google-cloud/firestore');
    const created: Firestore =
      this.projectId !== undefined
        ? new FirestoreCtor({ projectId: this.projectId })
        : new FirestoreCtor();
    this.client = created as unknown as FirestoreLike;
    return this.client;
  }

  private async doc(requestId: string): Promise<FirestoreDocLike> {
    const client = await this.resolveClient();
    return client.collection(this.collectionName).doc(requestId);
  }

  /**
   * Allocate inside a transaction.
   *
   * Why not a plain read-modify-write: two writers that both read an empty
   * document would each allocate generation 1 and the later `set` would silently
   * discard the earlier mapping, cross-wiring one caller's placeholders onto
   * another caller's values.
   */
  async put(
    requestId: string,
    mapping: Readonly<Record<string, string>>,
    ttlSeconds: number = DEFAULT_VAULT_TTL_SECONDS,
  ): Promise<VaultEntry> {
    const client = await this.resolveClient();
    const doc = client.collection(this.collectionName).doc(requestId);

    const apply = (
      existing: Record<string, unknown> | undefined,
    ): { entry: VaultEntry; payload: Record<string, unknown> } => {
      let merged: Record<string, string> = {};
      let expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      let generation = 0;

      if (existing !== undefined) {
        const storedExpiry = asDate(existing['expires_at']);
        const isLive = storedExpiry !== null && storedExpiry.getTime() > Date.now();
        if (isLive) {
          merged = { ...asMapping(existing['mapping']) };
          expiresAt = storedExpiry;
          generation = asGeneration(existing['generation']);
        }
      }
      merged = { ...merged, ...mapping };
      generation += 1;

      return {
        entry: { requestId, mapping: merged, expiresAt, generation },
        payload: {
          mapping: merged,
          expires_at: expiresAt,
          request_id: requestId,
          generation,
        },
      };
    };

    if (typeof client.runTransaction === 'function') {
      return client.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(doc);
        const { entry, payload } = apply(snapshot.exists ? snapshot.data() : undefined);
        transaction.set(doc, payload);
        return entry;
      });
    }

    const snapshot = await doc.get();
    const { entry, payload } = apply(snapshot.exists ? snapshot.data() : undefined);
    await doc.set(payload);
    return entry;
  }

  async get(requestId: string): Promise<VaultEntry | null> {
    const doc = await this.doc(requestId);
    const snapshot = await doc.get();
    if (!snapshot.exists) return null;

    const data = snapshot.data() ?? {};
    const expiresAt = asDate(data['expires_at']);
    if (expiresAt === null) return null;

    const entry: VaultEntry = {
      requestId,
      mapping: asMapping(data['mapping']) ?? {},
      expiresAt,
      generation: asGeneration(data['generation']),
    };
    // TTL policy deletions lag behind, so the reader checks the expiry as well.
    return isExpired(entry) ? null : entry;
  }

  async delete(requestId: string): Promise<void> {
    const doc = await this.doc(requestId);
    await doc.delete();
  }
}

/** Accepts a Date, a Firestore Timestamp, or an ISO string. */
function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (value !== null && typeof value === 'object' && 'toDate' in value) {
    const converted = (value as { toDate: () => Date }).toDate();
    return converted instanceof Date ? converted : null;
  }
  return null;
}

/** A missing or malformed generation reads as 0, so the next write becomes 1. */
function asGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

function asMapping(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}

/** Select the vault implementation according to the `VAULT_BACKEND` env var. */
export function buildVault(backend?: string): TokenVault {
  const choice = (backend ?? process.env['VAULT_BACKEND'] ?? 'memory').trim().toLowerCase();
  if (choice === 'firestore') return new FirestoreTokenVault();
  if (choice === 'memory') return new InMemoryTokenVault();
  throw new Error(`unknown VAULT_BACKEND: '${choice}' (expected 'memory' or 'firestore')`);
}

/** The vault TTL in seconds. The OKF `stale_after` is kept equal to this. */
export function vaultTtlSeconds(): number {
  const raw = process.env['VAULT_TTL_SECONDS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_VAULT_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_VAULT_TTL_SECONDS;
}

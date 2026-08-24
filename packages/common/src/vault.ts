/**
 * Token Vault: holds the placeholder -> raw PII mapping for one session.
 *
 * Only components inside the trust boundary (Gateway / Synthesis) touch it. The
 * Core Agent is structured so that it never depends on this module, which is the
 * first layer of the guarantee that "Core cannot read the vault" — Core imports
 * only the `/logging`, `/config`, `/schema` and `/telemetry` subpaths, none of
 * which reach here.
 *
 * The implementation is selected by the `VAULT_BACKEND` environment variable:
 *   - `memory` … an in-process map, for local development and tests
 *   - `firestore` … Firestore, for Cloud Run production (keep the TTL policy
 *     aligned with `stale_after`)
 */

import type { Firestore } from '@google-cloud/firestore';
import { DEFAULT_VAULT_TTL_SECONDS } from './config.ts';

export { DEFAULT_VAULT_TTL_SECONDS };

/** The vault record for one session. */
export interface VaultEntry {
  readonly sessionId: string;
  readonly mapping: Record<string, string>;
  readonly expiresAt: Date;
}

/** True once the entry's absolute expiry has passed. */
export function isExpired(entry: VaultEntry, now: Date = new Date()): boolean {
  return now.getTime() >= entry.expiresAt.getTime();
}

/** Interface of the Token Vault. */
export interface TokenVault {
  /** Store the session mapping, merging into any existing one without extending it. */
  put(
    sessionId: string,
    mapping: Readonly<Record<string, string>>,
    ttlSeconds?: number,
  ): Promise<VaultEntry>;
  /** Return the session mapping, or `null` if it has expired. */
  get(sessionId: string): Promise<VaultEntry | null>;
  /** Discard the session. */
  delete(sessionId: string): Promise<void>;
}

/** In-process map implementation. */
export class InMemoryTokenVault implements TokenVault {
  private readonly entries = new Map<string, VaultEntry>();

  put(
    sessionId: string,
    mapping: Readonly<Record<string, string>>,
    ttlSeconds: number = DEFAULT_VAULT_TTL_SECONDS,
  ): Promise<VaultEntry> {
    const existing = this.entries.get(sessionId);
    const live = existing !== undefined && !isExpired(existing);

    const merged = { ...(live ? existing.mapping : {}), ...mapping };
    // Keep the expiry from the first write. Extending it on every append would
    // move stale_after and contradict the freshness claim made in the OKF
    // document.
    const expiresAt = live ? existing.expiresAt : new Date(Date.now() + ttlSeconds * 1000);

    const entry: VaultEntry = { sessionId, mapping: merged, expiresAt };
    this.entries.set(sessionId, entry);
    return Promise.resolve(entry);
  }

  get(sessionId: string): Promise<VaultEntry | null> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return Promise.resolve(null);
    if (isExpired(entry)) {
      this.entries.delete(sessionId);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry);
  }

  delete(sessionId: string): Promise<void> {
    this.entries.delete(sessionId);
    return Promise.resolve();
  }
}

/** The Firestore surface this module uses; narrowed so tests can supply a double. */
export interface FirestoreLike {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
      set(data: Record<string, unknown>): Promise<unknown>;
      delete(): Promise<unknown>;
    };
  };
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

  private async doc(sessionId: string) {
    const client = await this.resolveClient();
    return client.collection(this.collectionName).doc(sessionId);
  }

  async put(
    sessionId: string,
    mapping: Readonly<Record<string, string>>,
    ttlSeconds: number = DEFAULT_VAULT_TTL_SECONDS,
  ): Promise<VaultEntry> {
    const doc = await this.doc(sessionId);
    const snapshot = await doc.get();

    let merged: Record<string, string> = {};
    let expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    if (snapshot.exists) {
      const data = snapshot.data() ?? {};
      const storedExpiry = asDate(data['expires_at']);
      if (storedExpiry !== null && storedExpiry.getTime() > Date.now()) {
        merged = { ...asMapping(data['mapping']) };
        expiresAt = storedExpiry;
      }
    }
    merged = { ...merged, ...mapping };

    await doc.set({ mapping: merged, expires_at: expiresAt, session_id: sessionId });
    return { sessionId, mapping: merged, expiresAt };
  }

  async get(sessionId: string): Promise<VaultEntry | null> {
    const doc = await this.doc(sessionId);
    const snapshot = await doc.get();
    if (!snapshot.exists) return null;

    const data = snapshot.data() ?? {};
    const expiresAt = asDate(data['expires_at']);
    if (expiresAt === null) return null;

    const entry: VaultEntry = {
      sessionId,
      mapping: asMapping(data['mapping']) ?? {},
      expiresAt,
    };
    // TTL policy deletions lag behind, so the reader checks the expiry as well.
    return isExpired(entry) ? null : entry;
  }

  async delete(sessionId: string): Promise<void> {
    const doc = await this.doc(sessionId);
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

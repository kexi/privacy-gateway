/**
 * Persistence for the masked evidence of one gateway exchange.
 *
 * What is stored, keyed by `request_id`:
 *   - the masked prompt that was sent to Core
 *   - Core's still-tokenized response
 *   - the OKF `Gateway Answer` document, whose body holds the masked answer
 *   - `expires_at`, matching the vault TTL
 *
 * What is never stored: the rehydrated answer. It is produced for one response
 * and discarded. Storing it would put real identifiers in a database outside the
 * TTL-protected vault, which is the persistence rule this fleet exists to keep.
 *
 * The OKF document is stored as the Markdown string itself rather than
 * decomposed into JSON: the point of OKF is portable text you can read with
 * `cat`, and decomposing it risks dropping unknown keys on the round trip.
 */

import type { FirestoreLike } from '@privacy-gateway/common';

/** The masked artifacts retained for one request. */
export interface EvidenceRecord {
  readonly requestId: string;
  /** The OKF `Gateway Answer` Markdown. */
  readonly okf: string;
  /** The prompt as Core received it: placeholders, no raw values. */
  readonly maskedPrompt: string;
  /** Core's answer as returned: still tokenized. */
  readonly coreResponse: string;
  readonly expiresAt: Date;
}

/** Storage backend for evidence records. */
export interface AnswerStore {
  put(record: EvidenceRecord): Promise<void>;
  get(requestId: string): Promise<EvidenceRecord | null>;
}

export class InMemoryAnswerStore implements AnswerStore {
  private readonly items = new Map<string, EvidenceRecord>();

  put(record: EvidenceRecord): Promise<void> {
    this.items.set(record.requestId, record);
    return Promise.resolve();
  }

  get(requestId: string): Promise<EvidenceRecord | null> {
    const record = this.items.get(requestId);
    if (record === undefined) return Promise.resolve(null);
    // The application enforces expiry as well as the TTL policy, because a TTL
    // sweep lags behind by minutes and a served-but-expired record would
    // contradict the `stale_after` the document itself carries.
    if (Date.now() >= record.expiresAt.getTime()) {
      this.items.delete(requestId);
      return Promise.resolve(null);
    }
    return Promise.resolve(record);
  }
}

export interface FirestoreAnswerStoreOptions {
  readonly collection?: string | undefined;
  readonly client?: FirestoreLike | undefined;
  readonly projectId?: string | undefined;
}

export class FirestoreAnswerStore implements AnswerStore {
  private readonly collectionName: string;
  private client: FirestoreLike | undefined;
  private readonly projectId: string | undefined;

  constructor(options: FirestoreAnswerStoreOptions = {}) {
    this.collectionName =
      options.collection ?? process.env['ANSWER_COLLECTION'] ?? 'gateway_answers';
    this.client = options.client;
    this.projectId = options.projectId ?? process.env['GOOGLE_CLOUD_PROJECT'];
  }

  /** Created lazily so importing this module never opens a client. */
  private async resolveClient(): Promise<FirestoreLike> {
    if (this.client !== undefined) return this.client;
    const { Firestore } = await import('@google-cloud/firestore');
    const created =
      this.projectId !== undefined ? new Firestore({ projectId: this.projectId }) : new Firestore();
    this.client = created as unknown as FirestoreLike;
    return this.client;
  }

  private async doc(requestId: string) {
    const client = await this.resolveClient();
    return client.collection(this.collectionName).doc(requestId);
  }

  async put(record: EvidenceRecord): Promise<void> {
    const doc = await this.doc(record.requestId);
    // `expires_at` carries the same field name as the vault so one Firestore TTL
    // policy shape covers both collections.
    await doc.set({
      request_id: record.requestId,
      okf: record.okf,
      masked_prompt: record.maskedPrompt,
      core_response: record.coreResponse,
      expires_at: record.expiresAt,
    });
  }

  async get(requestId: string): Promise<EvidenceRecord | null> {
    const doc = await this.doc(requestId);
    const snapshot = await doc.get();
    if (!snapshot.exists) return null;

    const data = snapshot.data() ?? {};
    const okf = data['okf'];
    const expiresAt = asDate(data['expires_at']);
    if (typeof okf !== 'string' || expiresAt === null) return null;
    if (Date.now() >= expiresAt.getTime()) return null;

    return {
      requestId,
      okf,
      maskedPrompt: typeof data['masked_prompt'] === 'string' ? data['masked_prompt'] : '',
      coreResponse: typeof data['core_response'] === 'string' ? data['core_response'] : '',
      expiresAt,
    };
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

/**
 * Selected by the same environment variable as the vault, since a setup where
 * only one of the two uses Firestore makes no operational sense.
 */
export function buildAnswerStore(backend?: string): AnswerStore {
  const choice = (backend ?? process.env['VAULT_BACKEND'] ?? 'memory').trim().toLowerCase();
  if (choice === 'firestore') return new FirestoreAnswerStore();
  if (choice === 'memory') return new InMemoryAnswerStore();
  throw new Error(`unknown VAULT_BACKEND: '${choice}' (expected 'memory' or 'firestore')`);
}

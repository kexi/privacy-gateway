/**
 * Persistence for OKF `Gateway Answer` documents.
 *
 * Documents are stored as the Markdown string itself. They are deliberately not
 * decomposed into structured JSON: the whole point of OKF is portable text you
 * can read with `cat`, and decomposing it risks dropping unknown keys on the
 * round trip.
 */

import type { FirestoreLike } from '@privacy-gateway/common';

/** Storage backend for answer documents. */
export interface AnswerStore {
  put(sessionId: string, markdown: string): Promise<void>;
  get(sessionId: string): Promise<string | null>;
}

export class InMemoryAnswerStore implements AnswerStore {
  private readonly items = new Map<string, string>();

  put(sessionId: string, markdown: string): Promise<void> {
    this.items.set(sessionId, markdown);
    return Promise.resolve();
  }

  get(sessionId: string): Promise<string | null> {
    return Promise.resolve(this.items.get(sessionId) ?? null);
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

  private async doc(sessionId: string) {
    const client = await this.resolveClient();
    return client.collection(this.collectionName).doc(sessionId);
  }

  async put(sessionId: string, markdown: string): Promise<void> {
    const doc = await this.doc(sessionId);
    await doc.set({ session_id: sessionId, okf: markdown });
  }

  async get(sessionId: string): Promise<string | null> {
    const doc = await this.doc(sessionId);
    const snapshot = await doc.get();
    if (!snapshot.exists) return null;

    const okf = (snapshot.data() ?? {})['okf'];
    return typeof okf === 'string' ? okf : null;
  }
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

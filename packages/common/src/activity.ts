/**
 * Fleet activity clock: when Gemma was last known to have served a request.
 *
 * The GPU-backed Gemma service scales to zero, so the first request after an
 * idle period pays a multi-minute cold start. The UI wants to say so *before*
 * the user submits, which means the warm/cold answer has to be derived without
 * touching Gemma at all — probing it to find out whether it is asleep would wake
 * it, and would bill a GPU instance for the privilege of answering a status
 * badge.
 *
 * So the fact is recorded on the way out instead: every successful Gemma call
 * stamps a timestamp here, and `/v1/status` reads that stamp. The store holds
 * exactly one document with exactly one field — an ISO instant. There is no
 * request id, no caller, no text: nothing here is derived from a request's
 * content, so this file cannot become a disclosure channel.
 *
 * Like the vault, the backend follows `VAULT_BACKEND`: Firestore in production,
 * an in-process value for `memory`. It lives beside the vault rather than in
 * `config`/`logging`/`schema` because Core must not be able to reach it — not
 * because it holds secrets, but because Core holds no Firestore role at all and
 * an import that made it call Firestore would fail at runtime rather than at
 * review time.
 *
 * Every write is fire-and-forget. A status badge is a convenience; a request
 * that failed because the convenience was unavailable would be a worse product
 * than one that shows `unknown`.
 */

import type { Firestore } from '@google-cloud/firestore';

/** The Firestore collection and document holding the fleet's activity clock. */
export const FLEET_STATUS_COLLECTION = 'fleet_status';
export const GEMMA_STATUS_DOC = 'gemma';

/**
 * How long a warmup request is presumed to still be booting an instance.
 *
 * A cold start is on the order of two minutes; three leaves margin for a queued
 * container start without letting a failed wake claim `warming` forever. Past
 * this the fleet reverts to whatever `last_active_at` says, which for a wake
 * that never landed is `cold` — the honest answer, and the one that lets the
 * user press the button again.
 */
export const WARMING_WINDOW_MS = 3 * 60 * 1000;

/**
 * How long after the last recorded call Gemma is still presumed warm.
 *
 * Cloud Run keeps an idle instance for roughly 15 minutes before reclaiming it;
 * 10 leaves margin, so a `warm` badge that turns out to be a cold start is rarer
 * than a `cold` badge that turns out to be instant. The asymmetry is deliberate:
 * promising warmth and delivering two minutes of silence is the worse failure.
 */
export const WARM_WINDOW_MS = 10 * 60 * 1000;

/**
 * What a cold start costs, in seconds, as told to the user.
 *
 * A GPU instance pulling a 12B model onto the card takes on the order of two
 * minutes. Stated as a constant rather than measured: measuring it would mean
 * timing a real cold start on every deploy.
 */
export const COLD_START_ESTIMATE_SECONDS = 120;

/**
 * Both instants the fleet-status document holds.
 *
 * They are read together because the verdict needs both and they live in one
 * document: a wake that was requested but has not yet produced a Gemma call is
 * `warming`, which is only distinguishable from `cold` by comparing the two.
 * Each is `null` when never recorded.
 */
export interface ActivityReading {
  readonly lastActiveAt: Date | null;
  readonly warmupRequestedAt: Date | null;
}

/** Reads and writes the fleet's activity clock. */
export interface ActivityStore {
  /** Stamp the current instant as Gemma activity. Never throws — see the module docstring. */
  record(at?: Date): Promise<void>;
  /**
   * Stamp the current instant as a warmup request.
   *
   * Written to the same document and with the same fire-and-forget contract:
   * this only decorates a badge, so a failure here must never fail the wake it
   * describes.
   */
  recordWarmupRequest(at?: Date): Promise<void>;
  /**
   * The last recorded Gemma activity, `null` if nothing was ever recorded.
   *
   * Throws when the store itself is unreachable. The distinction matters: "never
   * recorded" is a cold fleet, while "cannot tell" is `unknown`, and collapsing
   * them would show a confident `cold` whenever Firestore was down.
   */
  read(): Promise<Date | null>;
  /**
   * Both instants in one round trip.
   *
   * Why not two `read`-shaped calls: the badge needs both on every poll, and two
   * gets would double a Firestore bill that scales with the number of open tabs.
   */
  readActivity(): Promise<ActivityReading>;
}

/** In-process implementation, for local development and tests. */
export class InMemoryActivityStore implements ActivityStore {
  private lastActiveAt: Date | null = null;
  private warmupRequestedAt: Date | null = null;

  record(at: Date = new Date()): Promise<void> {
    this.lastActiveAt = at;
    return Promise.resolve();
  }

  recordWarmupRequest(at: Date = new Date()): Promise<void> {
    this.warmupRequestedAt = at;
    return Promise.resolve();
  }

  read(): Promise<Date | null> {
    return Promise.resolve(this.lastActiveAt);
  }

  readActivity(): Promise<ActivityReading> {
    return Promise.resolve({
      lastActiveAt: this.lastActiveAt,
      warmupRequestedAt: this.warmupRequestedAt,
    });
  }
}

/** The Firestore document surface this module uses; narrowed so tests can double it. */
export interface ActivityDocLike {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
}

/** The Firestore surface this module uses. */
export interface ActivityFirestoreLike {
  collection(name: string): { doc(id: string): ActivityDocLike };
}

export interface FirestoreActivityStoreOptions {
  readonly collection?: string | undefined;
  readonly document?: string | undefined;
  readonly client?: ActivityFirestoreLike | undefined;
  readonly projectId?: string | undefined;
}

/**
 * Firestore implementation.
 *
 * Why not a transaction, as the vault uses: two concurrent writers here both
 * want to say "active now", and whichever lands last is correct. There is no
 * mapping to cross-wire and no generation to lose, so the contention the vault
 * guards against does not exist.
 */
export class FirestoreActivityStore implements ActivityStore {
  private readonly collectionName: string;
  private readonly documentName: string;
  private client: ActivityFirestoreLike | undefined;
  private readonly projectId: string | undefined;

  constructor(options: FirestoreActivityStoreOptions = {}) {
    this.collectionName = options.collection ?? FLEET_STATUS_COLLECTION;
    this.documentName = options.document ?? GEMMA_STATUS_DOC;
    this.client = options.client;
    this.projectId = options.projectId ?? process.env['GOOGLE_CLOUD_PROJECT'];
  }

  /** Created lazily so importing this module never opens a client. */
  private async resolveClient(): Promise<ActivityFirestoreLike> {
    if (this.client !== undefined) return this.client;
    const { Firestore: FirestoreCtor } = await import('@google-cloud/firestore');
    const created: Firestore =
      this.projectId !== undefined
        ? new FirestoreCtor({ projectId: this.projectId })
        : new FirestoreCtor();
    this.client = created as unknown as ActivityFirestoreLike;
    return this.client;
  }

  private async doc(): Promise<ActivityDocLike> {
    const client = await this.resolveClient();
    return client.collection(this.collectionName).doc(this.documentName);
  }

  async record(at: Date = new Date()): Promise<void> {
    const doc = await this.doc();
    // Stored as an ISO string rather than a Firestore Timestamp so the document
    // reads the same whether it was written by the emulator, a test double or
    // the real client, and so `read` needs no type dispatch.
    //
    // Merged rather than replaced: the two stamps share one document, and a
    // plain `set` would delete whichever field this call is not writing —
    // turning every Gemma call into an erasure of the warmup request that woke
    // it, which is precisely the comparison the `warming` verdict needs.
    await doc.set({ last_active_at: at.toISOString() }, { merge: true });
  }

  async recordWarmupRequest(at: Date = new Date()): Promise<void> {
    const doc = await this.doc();
    await doc.set({ warmup_requested_at: at.toISOString() }, { merge: true });
  }

  async read(): Promise<Date | null> {
    const { lastActiveAt } = await this.readActivity();
    return lastActiveAt;
  }

  async readActivity(): Promise<ActivityReading> {
    const doc = await this.doc();
    const snapshot = await doc.get();
    if (!snapshot.exists) return { lastActiveAt: null, warmupRequestedAt: null };

    const data = snapshot.data();
    return {
      lastActiveAt: toDate(data?.['last_active_at']),
      warmupRequestedAt: toDate(data?.['warmup_requested_at']),
    };
  }
}

/** Accepts an ISO string, a Date, or a Firestore Timestamp. */
function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const hasToDate =
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as { toDate?: unknown }).toDate === 'function';
  if (hasToDate) {
    const converted = (raw as { toDate(): Date }).toDate();
    return Number.isNaN(converted.getTime()) ? null : converted;
  }
  return null;
}

/** Select the implementation from `VAULT_BACKEND`, matching the vault's choice. */
export function buildActivityStore(backend?: string): ActivityStore {
  const choice = backend ?? process.env['VAULT_BACKEND'] ?? 'memory';
  if (choice === 'firestore') return new FirestoreActivityStore();
  // Unlike the vault, an unrecognised backend is not fatal here: this store
  // decorates a badge, and refusing to boot over it would take the fleet down
  // for a cosmetic feature. Anything unknown degrades to in-process, which
  // simply reports the local process's own activity.
  return new InMemoryActivityStore();
}

/**
 * Stamp the activity clock without ever letting the caller feel it.
 *
 * The promise is not returned: awaiting it would put a Firestore round trip on
 * the request's critical path after the model has already answered, and a
 * rejection would surface as a failed request. Errors are swallowed here rather
 * than at each call site, so there is exactly one place where that decision is
 * made and it cannot be forgotten by a future caller.
 */
export function recordGemmaActivity(store: ActivityStore | undefined, at?: Date): void {
  stampSilently(store, (s) => s.record(at));
}

/**
 * Stamp the warmup clock under the same contract as `recordGemmaActivity`.
 *
 * The wake request has already been dispatched by the time this runs, so a
 * failure here costs a `warming` badge and nothing else. It must never turn a
 * successful wake into a reported failure.
 */
export function recordWarmupRequest(store: ActivityStore | undefined, at?: Date): void {
  stampSilently(store, (s) => s.recordWarmupRequest(at));
}

/**
 * The one place the "a badge is never worth failing a request" decision is made.
 *
 * Shared by both stamps so a future third one cannot forget it.
 */
function stampSilently(
  store: ActivityStore | undefined,
  write: (store: ActivityStore) => Promise<void>,
): void {
  if (store === undefined) return;
  try {
    void write(store).catch(() => {
      // Deliberately silent. A failure to record activity is invisible to the
      // user by design: the badge falls back to `unknown`, which is honest.
    });
  } catch {
    // A store that throws synchronously is treated the same way.
  }
}

/**
 * The Synthesis pipeline: gate -> attest -> release -> OKF assembly.
 *
 * Every gate runs *before* rehydration and every one of them can stop the
 * request. Nothing here degrades: if the vault mapping is missing, the wrong
 * generation, or incomplete; if Core invented a placeholder; if the leak check
 * fails; or if the Gemma judge flags a leak or cannot answer — the pipeline
 * throws and no rehydrated text is produced, returned, or stored.
 *
 * The only LLM in the path is the Gemma judge, and its influence is asymmetric:
 * `leak: true` or "no opinion" blocks the release, while `leak: false` adds no
 * trust at all. A probabilistic model may veto; it may not vouch.
 */

import {
  responseHash,
  scan as scanForLeaks,
  verify,
  type Verdict,
} from '@privacy-gateway/common/attesters/leak-check';
import {
  attesterSha256,
  buildGatewayAnswer,
  COMPUTATION_RESOURCE,
  computationSha256,
  currentTraceId,
  dump,
  findTokens,
  freshness,
  leakCheckActor,
  rehydrateWithPolicy,
  SPAN,
  trustTier,
  withheldCategories,
  withSpan,
  type Attestation,
  type ConsistencyReport,
  type Logger,
  type OkfDocument,
  type ReceiptSummary,
  type TokenVault,
  type TrustDimensions,
  type TrustTier,
} from '@privacy-gateway/common';

/** The OKF actor string for this agent (SPEC §7). */
export function actor(version = '0.1.0'): string {
  return `synthesis_agent/${version}`;
}

/**
 * An advisory verdict from Gemma.
 *
 * `leak: null` means the judge had no usable opinion — a transport failure, a
 * timeout, or an unparseable answer. It is treated exactly like `true`.
 */
export type LeakJudge = (text: string) => Promise<{ leak: boolean | null; categories?: string[] }>;

/** Why a release was refused, and the HTTP status that expresses it. */
export type RefusalKind =
  | 'vault_missing'
  | 'vault_expired'
  | 'vault_generation_mismatch'
  | 'unresolved_token'
  | 'invented_token'
  | 'leak_check_failed'
  | 'judge_flagged'
  | 'judge_unavailable';

const REFUSAL_STATUS: Readonly<Record<RefusalKind, number>> = {
  // A mapping that is simply not there is a conflict with the caller's premise.
  vault_missing: 409,
  // Gone is the precise answer for a resource that existed and has expired.
  vault_expired: 410,
  vault_generation_mismatch: 409,
  unresolved_token: 409,
  invented_token: 409,
  // Unprocessable: the content itself failed policy.
  leak_check_failed: 422,
  judge_flagged: 422,
  judge_unavailable: 422,
};

/**
 * Raised instead of releasing an answer.
 *
 * Carries category names and token *names* only. The Core body, the mapping and
 * every raw value stay behind: a refusal must not become the disclosure channel
 * the refusal was meant to prevent.
 */
export class ReleaseRefusedError extends Error {
  readonly kind: RefusalKind;
  readonly status: number;
  readonly categories: readonly string[];

  constructor(kind: RefusalKind, message: string, categories: readonly string[] = []) {
    super(message);
    this.name = 'ReleaseRefusedError';
    this.kind = kind;
    this.status = REFUSAL_STATUS[kind];
    this.categories = categories;
  }
}

/** The full set of Synthesis results. */
export interface SynthesisResult {
  readonly document: OkfDocument;
  readonly markdown: string;
  /** Ephemeral. Returned to the caller and never written to the store. */
  readonly answer: string;
  readonly attestation: Attestation;
  readonly consistency: ConsistencyReport;
  readonly receipt: ReceiptSummary;
  readonly trustTier: TrustTier;
  readonly dimensions: TrustDimensions;
}

/** The receipt fields the attester requires, plus the body it re-scans. */
export interface FullReceipt {
  readonly request_id: string;
  readonly masked_prompt_hash: string;
  readonly response_hash: string;
  readonly findings: string[];
  readonly response: string;
}

/**
 * Build the receipt exactly as the executor procedure specifies
 * (`/references/skills/run-leak-check.md`).
 *
 * The receipt is a runtime artifact, so it is not stored in the bundle (SPEC §10).
 */
export function buildReceipt(
  requestId: string,
  maskedPrompt: string,
  response: string,
): FullReceipt {
  return {
    request_id: requestId,
    masked_prompt_hash: responseHash(maskedPrompt),
    response_hash: responseHash(response),
    findings: scanForLeaks(response),
    response,
  };
}

/**
 * Deterministically check that Core used only the placeholders it was given.
 *
 * `knownTokens` is the tokenizer's own allocation list, passed down from the
 * gateway. It is deliberately not re-derived from the masked prompt: the prompt
 * is largely caller-written text, and a placeholder that appears in it is only
 * meaningful because this fleet's tokenizer put it there.
 */
export function checkConsistency(
  knownTokens: readonly string[],
  coreAnswer: string,
): ConsistencyReport {
  const known = new Set(knownTokens);
  const used = findTokens(coreAnswer);
  const invented = used.filter((token) => !known.has(token));

  return {
    ok: invented.length === 0,
    invented_tokens: invented,
    known_tokens: [...known].sort(),
    used_tokens: used,
    reason:
      invented.length === 0
        ? null
        : `core agent invented placeholders absent from the prompt: ${invented.join(', ')}`,
  };
}

export interface SynthesizeOptions {
  readonly requestId: string;
  readonly maskedPrompt: string;
  readonly coreAnswer: string;
  readonly knownTokens: readonly string[];
  readonly vaultGeneration: number;
  readonly vault: TokenVault;
  /** The Core model actor; recorded as the author of the core-response source. */
  readonly generatedBy: string;
  readonly judge?: LeakJudge | undefined;
  readonly logger?: Logger | undefined;
  /** Categories the disclosure policy withholds; defaults to the env policy. */
  readonly withhold?: readonly string[] | undefined;
}

/**
 * Verify Core's output and, only if every gate passes, release it.
 *
 * @throws ReleaseRefusedError on any failed gate. The caller maps `.status` onto
 *   the HTTP response and persists the (answer-free) evidence document.
 */
export async function synthesize(options: SynthesizeOptions): Promise<SynthesisResult> {
  const { requestId, maskedPrompt, coreAnswer, logger } = options;
  const checkedAt = new Date();

  // --- gate 1: the vault mapping must exist, be live, and be the exact
  //     generation the gateway wrote. -------------------------------------
  const entry = await options.vault.get(requestId);
  if (entry === null) {
    logger?.event('release.refused', { refusal: 'vault_missing' }, 'ERROR');
    throw new ReleaseRefusedError(
      'vault_missing',
      'no live token mapping for this request; the answer cannot be restored',
    );
  }
  if (entry.generation !== options.vaultGeneration) {
    logger?.event(
      'release.refused',
      { refusal: 'vault_generation_mismatch', vault_generation: entry.generation },
      'ERROR',
    );
    throw new ReleaseRefusedError(
      'vault_generation_mismatch',
      'the token mapping changed after this request was masked',
    );
  }
  const mapping = entry.mapping;
  const staleAfter = entry.expiresAt;

  // --- gate 2: Core must not have invented placeholders. ------------------
  const consistency = checkConsistency(options.knownTokens, coreAnswer);

  // --- gate 3: the deterministic leak check. ------------------------------
  const verdict = await withSpan(
    SPAN.attestLeakCheck,
    { request_id: requestId },
    (span): Promise<Verdict> => {
      const result = verify(buildReceipt(requestId, maskedPrompt, coreAnswer));
      span.setAttribute('verdict', result.ok ? 'pass' : 'fail');
      span.setAttribute('findings', result.findings);
      return Promise.resolve(result);
    },
  );

  const attestation: Attestation = {
    ok: verdict.ok && consistency.ok,
    reason: verdict.ok ? consistency.reason : verdict.reason,
    findings: verdict.findings,
    details: verdict.details,
  };

  logger?.event('attest.verdict', {
    verdict: attestation.ok ? 'pass' : 'fail',
    findings: verdict.findings,
  });

  // --- gate 4: the Gemma judge, asymmetrically. ---------------------------
  //
  // The judge sees the pre-rehydration body. Showing it the rehydrated one would
  // hand real PII to a model and would make "there is a leak" the always-correct
  // answer, draining the signal of meaning.
  let judgeBlocked: RefusalKind | null = null;
  if (options.judge !== undefined) {
    const opinion = await withSpan(SPAN.judgeGemma, { request_id: requestId }, async () => {
      try {
        const result = await options.judge?.(coreAnswer);
        return result ?? { leak: null };
      } catch (error) {
        logger?.event(
          'judge.gemma',
          { error_class: error instanceof Error ? error.name : 'unknown' },
          'WARNING',
        );
        return { leak: null };
      }
    });

    attestation.judge = opinion;
    logger?.event('judge.gemma', { leak: opinion.leak ?? null });

    // `false` deliberately does nothing: a probabilistic model may veto a
    // release, but it may never be the reason one is trusted.
    if (opinion.leak === true) judgeBlocked = 'judge_flagged';
    else if (opinion.leak === null) judgeBlocked = 'judge_unavailable';
  }

  // --- assemble the evidence document, which is built either way. ---------
  //
  // It holds the *masked* answer only, so it is safe to persist whether or not
  // the release goes ahead — a refusal must still leave an auditable record.
  const traceId = currentTraceId();
  const withhold = options.withhold ?? withheldCategories();
  const released = await withSpan(SPAN.rehydrate, { request_id: requestId }, (span) => {
    const restored = rehydrateWithPolicy(coreAnswer, mapping, { withhold });
    span.setAttribute('tokens_unknown', restored.unresolved.length);
    span.setAttribute('tokens_withheld', restored.withheld.length);
    return Promise.resolve(restored);
  });

  const releaseOk = attestation.ok && judgeBlocked === null && released.unresolved.length === 0;
  if (!releaseOk) {
    attestation.ok = false;
    if (judgeBlocked !== null) {
      attestation.reason ??=
        judgeBlocked === 'judge_flagged'
          ? 'the advisory judge flagged a possible leak'
          : 'the advisory judge returned no usable verdict';
    }
    if (released.unresolved.length > 0) {
      attestation.unresolved_tokens = [...released.unresolved];
      attestation.reason ??= 'the response references placeholders absent from the vault';
    }
  }
  if (released.withheldCategories.length > 0) {
    attestation.withheld = [...released.withheldCategories];
  }

  const document = await withSpan(SPAN.okfBuild, { request_id: requestId }, () =>
    Promise.resolve(
      buildGatewayAnswer({
        requestId,
        maskedAnswerBody: coreAnswer,
        coreActor: options.generatedBy,
        generatedBy: actor(),
        verifiedBy: leakCheckActor(),
        staleAfter,
        attestation,
        evidence: {
          computation: COMPUTATION_RESOURCE,
          computationSha256: computationSha256(),
          attesterSha256: attesterSha256(),
          maskedPromptSha256: responseHash(maskedPrompt),
          coreResponseSha256: responseHash(coreAnswer),
          checkedAt,
          withheld: released.withheldCategories,
        },
        ...(traceId !== undefined ? { traceId } : {}),
      }),
    ),
  );

  const receipt: ReceiptSummary = {
    request_id: requestId,
    masked_prompt_hash: responseHash(maskedPrompt),
    response_hash: responseHash(coreAnswer),
    findings: verdict.findings,
    attester_sha256: attesterSha256(),
  };

  const result: SynthesisResult = {
    document,
    markdown: dump(document),
    answer: released.text,
    attestation,
    consistency,
    receipt,
    trustTier: trustTier(document.metadata),
    dimensions: {
      policy_verdict: attestation.ok ? 'pass' : 'fail',
      document_status:
        (document.metadata['status'] as TrustDimensions['document_status']) ?? 'draft',
      freshness: freshness(document.metadata, checkedAt),
      // The public gateway authenticates nobody, so nothing can name a reviewer.
      review_identity: 'none',
    },
  };

  // --- the release decision. ---------------------------------------------
  if (!consistency.ok) {
    logger?.event(
      'release.refused',
      { refusal: 'invented_token', invented_tokens: consistency.invented_tokens },
      'ERROR',
    );
    throw refusal('invented_token', consistency.reason ?? 'invented placeholders', result);
  }
  if (!verdict.ok) {
    logger?.event(
      'release.refused',
      { refusal: 'leak_check_failed', findings: verdict.findings },
      'ERROR',
    );
    throw refusal('leak_check_failed', 'the leak check failed', result, verdict.findings);
  }
  if (judgeBlocked !== null) {
    logger?.event('release.refused', { refusal: judgeBlocked }, 'ERROR');
    throw refusal(
      judgeBlocked,
      judgeBlocked === 'judge_flagged'
        ? 'the advisory judge flagged a possible leak'
        : 'the advisory judge returned no usable verdict',
      result,
      attestation.judge?.categories ?? [],
    );
  }
  if (released.unresolved.length > 0) {
    logger?.event(
      'release.refused',
      { refusal: 'unresolved_token', unresolved_tokens: released.unresolved },
      'ERROR',
    );
    throw refusal('unresolved_token', 'the response references unknown placeholders', result);
  }

  logger?.event('release.ok', {
    tokens_resolved: findTokens(coreAnswer).length - released.withheld.length,
    withheld_count: released.withheld.length,
  });
  return result;
}

/**
 * A refusal that still carries the evidence document.
 *
 * The caller persists `evidence` — the masked record of what happened — and
 * returns the status, so a blocked request is auditable without any part of the
 * unsafe body reaching a response or the store.
 */
export interface RefusalWithEvidence extends ReleaseRefusedError {
  readonly evidence: SynthesisResult;
}

function refusal(
  kind: RefusalKind,
  message: string,
  result: SynthesisResult,
  categories: readonly string[] = [],
): RefusalWithEvidence {
  const error = new ReleaseRefusedError(kind, message, categories) as ReleaseRefusedError & {
    evidence: SynthesisResult;
  };
  // The released answer must not travel with the refusal.
  error.evidence = { ...result, answer: '' };
  return error;
}

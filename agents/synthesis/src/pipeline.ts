/**
 * The Synthesis pipeline: gate -> attest -> release -> OKF assembly.
 *
 * Every gate runs *before* rehydration and every one of them can stop the
 * request. That ordering is literal, not aspirational: `rehydrateWithPolicy` is
 * reached exactly once, after the vault, consistency, deterministic and judge
 * gates have all passed. Token resolvability is checked beforehand against the
 * mapping's *keys* only, so a request that would have produced dangling
 * placeholders is refused without ever materializing a value.
 *
 * A refusal is auditable but not disclosing. The evidence document a refusal
 * carries holds no Core body at all — only the digests, the closed-enum findings
 * and a `content withheld` marker — because the rejected text is precisely the
 * text that failed the policy, and persisting it under the audit trail's name
 * would recreate the leak the gate just stopped.
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
  categoryOf,
  COMPUTATION_RESOURCE,
  computationSha256,
  currentTraceId,
  dump,
  filterHighRiskCategories,
  filterPiiCategories,
  getTracer,
  findTokens,
  freshness,
  leakCheckActor,
  rehydrateWithPolicy,
  SPAN,
  trustTier,
  WITHHELD_BODY_MARKER,
  withheldCategories,
  withSpan,
  type Attestation,
  type ConsistencyReport,
  type Logger,
  type OkfDocument,
  type PiiCategory,
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
export type LeakJudge = (
  text: string,
  signal?: AbortSignal,
  context?: LeakJudgeContext,
) => Promise<{ leak: boolean | null; categories?: readonly string[] }>;

/**
 * Safe metadata handed to the judge alongside the answer.
 *
 * Every field is PII-free by construction: the masked prompt is what crossed the
 * boundary to Core, and the category counts are already public in the OKF
 * document and the API response. Nothing here carries a value.
 *
 * It exists because the judge was flagging almost every masked answer while
 * naming no category — the failure of a model asked to audit a text it had no
 * context for. Telling it what the answer is answering, and what was masked out
 * of it, replaces the guessing that produced those flags.
 */
export interface LeakJudgeContext {
  /** The masked prompt Core was given. Placeholders are neutralized before sending. */
  readonly maskedPrompt: string;
  /** `{category: count}` of what the tokenizer masked. Counts only, never values. */
  readonly maskedCounts: Readonly<Record<string, number>>;
}

/** Why a release was refused, and the HTTP status that expresses it. */
export type RefusalKind =
  | 'vault_missing'
  | 'vault_expired'
  | 'vault_generation_mismatch'
  | 'unresolved_token'
  | 'invented_token'
  | 'leak_check_failed'
  | 'judge_flagged'
  | 'judge_unavailable'
  | 'rehydration_incomplete';

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
  // 5xx alone in this table, and deliberately: every other refusal here is the
  // fleet declining something about the *request*, which a caller can act on. A
  // rehydration that did not do exactly what the policy said is a fault in our
  // own code — the caller did nothing wrong and changing their input would not
  // help — so it is reported as a server error. The body is still withheld, on
  // the same reasoning as every other refusal.
  rehydration_incomplete: 500,
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
  /** Closed-enum categories only; an unrecognised name is dropped, not truncated. */
  readonly categories: readonly PiiCategory[];

  constructor(kind: RefusalKind, message: string, categories: readonly unknown[] = []) {
    super(message);
    this.name = 'ReleaseRefusedError';
    this.kind = kind;
    this.status = REFUSAL_STATUS[kind];
    this.categories = filterPiiCategories(categories).categories;
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
  /** The prompt itself, so the attester re-derives its hash instead of trusting one. */
  readonly masked_prompt: string;
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
    masked_prompt: maskedPrompt,
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
  /**
   * Categories this request asked to have restored.
   *
   * Unioned with the operator's `REHYDRATE_ALLOW_CATEGORIES` to produce the
   * effective withhold set. Ignored when `withhold` is given outright, which is
   * the test seam that names the final set directly.
   */
  readonly rehydrateAllow?: readonly string[] | undefined;
  /**
   * The rehydration step, injectable.
   *
   * Exists so a test can observe *whether* it was reached, which is the whole
   * content of the "every gate runs before rehydration" guarantee: asserting on
   * the returned answer cannot distinguish "never rehydrated" from "rehydrated
   * and then discarded", and those are exactly the two states the review found
   * the pipeline confusing.
   */
  readonly rehydrate?: typeof rehydrateWithPolicy | undefined;
  /** The caller's deadline. Cancels the judge call and stops the pipeline. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Everything the OKF document and the receipt need, derived once.
 *
 * Built for the release path and for the refusal path alike, from the *masked*
 * inputs only, so the same helper can produce an auditable record without the
 * refusal branch ever touching a rehydrated string.
 */
interface EvidenceInputs {
  readonly requestId: string;
  readonly maskedPrompt: string;
  readonly coreAnswer: string;
  readonly staleAfter: Date;
  readonly checkedAt: Date;
  readonly coreActor: string;
  readonly traceId: string | undefined;
}

/**
 * Assemble the result object.
 *
 * `bodyIsWithheld` decides what the document's body holds: on release it is the
 * still-masked Core answer, on refusal it is the `content withheld` marker. The
 * `attestation` digests are computed over the real Core answer in both cases —
 * they are what lets an auditor holding the original prove which exchange the
 * refusal was about without the store retaining that text.
 */
function assemble(
  inputs: EvidenceInputs,
  attestation: Attestation,
  consistency: ConsistencyReport,
  verdictFindings: readonly PiiCategory[],
  answer: string,
  withheldCategoriesList: readonly PiiCategory[],
  bodyIsWithheld: boolean,
): SynthesisResult {
  const span = getTracer().startSpan(SPAN.okfBuild, {
    attributes: { request_id: inputs.requestId },
  });
  try {
    return assembleWithin(
      inputs,
      attestation,
      consistency,
      verdictFindings,
      answer,
      withheldCategoriesList,
      bodyIsWithheld,
    );
  } finally {
    span.end();
  }
}

/**
 * The assembly itself.
 *
 * Split from the span wrapper because `withSpan` is async and every caller here
 * is synchronous; the document build touches no I/O, so awaiting it would only
 * add a microtask between the last gate and the record it produces.
 */
function assembleWithin(
  inputs: EvidenceInputs,
  attestation: Attestation,
  consistency: ConsistencyReport,
  verdictFindings: readonly PiiCategory[],
  answer: string,
  withheldCategoriesList: readonly PiiCategory[],
  bodyIsWithheld: boolean,
): SynthesisResult {
  const { requestId, maskedPrompt, coreAnswer, checkedAt } = inputs;

  const document = buildGatewayAnswer({
    requestId,
    maskedAnswerBody: bodyIsWithheld ? WITHHELD_BODY_MARKER : coreAnswer,
    coreActor: inputs.coreActor,
    generatedBy: actor(),
    verifiedBy: leakCheckActor(),
    staleAfter: inputs.staleAfter,
    attestation,
    evidence: {
      computation: COMPUTATION_RESOURCE,
      computationSha256: computationSha256(),
      attesterSha256: attesterSha256(),
      maskedPromptSha256: responseHash(maskedPrompt),
      coreResponseSha256: responseHash(coreAnswer),
      checkedAt,
      withheld: withheldCategoriesList,
      // Lifted out of the runtime attestation rather than passed separately:
      // these two are the record of what the caller asked for and what the
      // rehydration did, and they belong in the replayable block for the same
      // reason `withheld` does — a reader must be able to see that a value was
      // restored on purpose, not by accident.
      ...(attestation.disclosure_requested !== undefined
        ? { disclosureRequested: attestation.disclosure_requested }
        : {}),
      ...(attestation.rehydration !== undefined ? { rehydration: attestation.rehydration } : {}),
    },
    ...(inputs.traceId !== undefined ? { traceId: inputs.traceId } : {}),
  });

  const receipt: ReceiptSummary = {
    request_id: requestId,
    masked_prompt_hash: responseHash(maskedPrompt),
    response_hash: responseHash(coreAnswer),
    findings: [...verdictFindings],
    attester_sha256: attesterSha256(),
  };

  return {
    document,
    markdown: dump(document),
    answer,
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
}

/**
 * Which placeholders would fail to resolve, without materializing any value.
 *
 * Only the mapping's *keys* are consulted. Calling the rehydrator to find out
 * would defeat the ordering guarantee this pipeline exists to keep: a request
 * that is about to be refused must never have had its real values assembled into
 * a string, not even one that is then thrown away.
 */
export function unresolvableTokens(
  coreAnswer: string,
  mappingKeys: ReadonlySet<string>,
  withhold: ReadonlySet<string>,
): { unresolved: string[]; withheld: string[]; withheldCategories: PiiCategory[] } {
  const unresolved: string[] = [];
  const withheld: string[] = [];

  for (const placeholder of findTokens(coreAnswer)) {
    const category = categoryOf(placeholder);
    if (category !== null && withhold.has(category)) {
      withheld.push(placeholder);
      continue;
    }
    if (!mappingKeys.has(placeholder)) unresolved.push(placeholder);
  }

  return {
    unresolved: unresolved.sort(),
    withheld: withheld.sort(),
    withheldCategories: filterPiiCategories([
      ...new Set(withheld.map((token) => categoryOf(token))),
    ]).categories.sort(),
  };
}

/**
 * What went wrong after the single rehydration, if anything.
 *
 * A string rather than a code: the caller turns it into a fixed public message
 * and logs a fixed `refusal` enum, so this text reaches nothing outside the
 * throw site. Keeping it descriptive is what makes the refusal debuggable from
 * a stack trace without putting either the answer or a mapping value in a log.
 */
export type RehydrationDefect =
  | { readonly kind: 'leftover_token'; readonly tokens: readonly string[] }
  | { readonly kind: 'missing_withheld'; readonly tokens: readonly string[] }
  | { readonly kind: 'substitution_mismatch'; readonly tokens: readonly string[] }
  | { readonly kind: 'unrestored_pii'; readonly categories: readonly PiiCategory[] };

/**
 * Prove the rehydration did exactly what the policy said, and nothing else.
 *
 * Three independent properties, all decided deterministically over strings the
 * function already holds — no model, no second vault read, no I/O:
 *
 * (a) **Exactly the withheld tokens survive.** The set of `⟦…⟧` still present in
 *     the released text must equal the set the policy decided to withhold. A
 *     leftover the policy did not ask for is a substitution that silently failed
 *     — the user would see a raw placeholder where a value was promised. A
 *     *missing* withheld token is worse: the only way a token the policy said to
 *     keep can vanish is that something replaced it, which is a disclosure the
 *     policy forbade.
 *
 * (b) **Every restored value is the vault's own.** Each placeholder the policy
 *     restored must appear in the output as the exact string the mapping holds.
 *     This is what a forged or corrupted substitution fails: a rehydrator that
 *     wrote some other value would still produce a placeholder-free string that
 *     passes (a).
 *
 * (c) **Nothing else that looks like PII appeared.** The deterministic attester
 *     is re-run over the released text with the intentionally restored values
 *     removed. Whatever it finds after that subtraction was not something this
 *     request restored on purpose — it is text that materialized during
 *     rehydration, which is precisely the failure mode nothing else here would
 *     catch.
 *
 * Why (c) subtracts the restored values rather than skipping the scan: the whole
 * point of a successful rehydration is that real identifiers are now in the
 * string, so scanning it raw would flag every release. Subtracting exactly what
 * was restored on purpose leaves the residue, and the residue must be empty.
 *
 * Why deterministic and post-hoc rather than trusting `rehydrateWithPolicy`:
 * that function is the thing being checked. A verification that shares its
 * implementation only proves the implementation agrees with itself, which is the
 * same reason `pgw_verify` transcribes the scanner instead of importing it.
 *
 * @returns the defect, or `null` when all three properties hold.
 */
export function verifyRehydration(input: {
  readonly released: string;
  readonly restored: readonly string[];
  readonly withheldTokens: readonly string[];
  readonly mapping: Readonly<Record<string, string>>;
}): RehydrationDefect | null {
  const { released, restored, withheldTokens, mapping } = input;

  // (a) The leftover set must equal the withheld set, in both directions.
  const leftover = new Set(findTokens(released));
  const expected = new Set(withheldTokens);

  const unexpected = [...leftover].filter((token) => !expected.has(token)).sort();
  if (unexpected.length > 0) return { kind: 'leftover_token', tokens: unexpected };

  const vanished = [...expected].filter((token) => !leftover.has(token)).sort();
  if (vanished.length > 0) return { kind: 'missing_withheld', tokens: vanished };

  // (b) Each restored placeholder's value must be literally present.
  const forged = restored
    .filter((token) => {
      const value = mapping[token];
      // A placeholder with no mapping value should have been refused as
      // `unresolved_token` long before this point; treating it as a mismatch
      // here keeps the invariant total rather than assuming the earlier gate.
      if (value === undefined) return true;
      // The empty string is vacuously present and would make this check
      // unfalsifiable, so it is accepted rather than searched for.
      return value !== '' && !released.includes(value);
    })
    .sort();
  if (forged.length > 0) return { kind: 'substitution_mismatch', tokens: forged };

  // (c) The attester's residue after removing what was restored on purpose.
  let residue = released;
  // Longest first: a short value that is a substring of a longer one must not
  // punch a hole through the middle of it and leave a fragment the scan then
  // reads as something else.
  const restoredValues = restored
    .map((token) => mapping[token])
    .filter((value): value is string => value !== undefined && value !== '')
    .sort((a, b) => b.length - a.length);
  for (const value of restoredValues) {
    // A space, not the empty string, so two adjacent values cannot be welded
    // into one spurious identifier by their own removal.
    residue = residue.split(value).join(' ');
  }

  const planted = filterPiiCategories(scanForLeaks(residue)).categories;
  if (planted.length > 0) return { kind: 'unrestored_pii', categories: planted };

  return null;
}

/**
 * Verify Core's output and, only if every gate passes, release it.
 *
 * The order is fixed and load-bearing: vault -> consistency -> deterministic
 * attester -> judge -> resolvability -> *one* rehydration. Nothing before the
 * last step reads a mapping value.
 *
 * @throws ReleaseRefusedError on any failed gate. The caller maps `.status` onto
 *   the HTTP response and persists the evidence document, whose body is the
 *   `content withheld` marker rather than the rejected text.
 */
export async function synthesize(options: SynthesizeOptions): Promise<SynthesisResult> {
  const { requestId, maskedPrompt, coreAnswer, logger } = options;
  const checkedAt = new Date();

  // --- gate 1: the vault mapping must exist, be live, and be the exact
  //     generation the gateway wrote. -------------------------------------
  const lookup = await options.vault.get(requestId);
  if (lookup.state === 'missing') {
    logger?.event('release.refused', { refusal: 'vault_missing' }, 'ERROR');
    throw new ReleaseRefusedError(
      'vault_missing',
      'no token mapping for this request; the answer cannot be restored',
    );
  }
  if (lookup.state === 'expired') {
    // Distinct from missing on purpose: the mapping existed and aged out, which
    // is a 410, and a caller can tell that retrying will not help.
    logger?.event('release.refused', { refusal: 'vault_expired' }, 'ERROR');
    throw new ReleaseRefusedError(
      'vault_expired',
      'the token mapping for this request has expired; the answer cannot be restored',
    );
  }
  const entry = lookup.entry;
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

  const traceId = currentTraceId();
  // The effective policy: the default-withheld set minus the operator allowance
  // minus this request's own. `withhold`, when given, names the final set and
  // skips the derivation entirely — it is how a test states the outcome it means
  // rather than reconstructing it from two inputs.
  const requestAllow = options.rehydrateAllow ?? [];
  const withhold = new Set(
    options.withhold ?? withheldCategories(process.env['REHYDRATE_ALLOW_CATEGORIES'], requestAllow),
  );
  const disclosureRequested = filterHighRiskCategories(requestAllow);

  const inputs: EvidenceInputs = {
    requestId,
    maskedPrompt,
    coreAnswer,
    staleAfter,
    checkedAt,
    coreActor: options.generatedBy,
    traceId,
  };

  /** Refuse, carrying an evidence document whose body holds no Core text. */
  const refuse = (
    kind: RefusalKind,
    message: string,
    attestation: Attestation,
    consistency: ConsistencyReport,
    findings: readonly PiiCategory[],
    categories: readonly unknown[] = [],
  ): never => {
    const evidence = assemble(inputs, attestation, consistency, findings, '', [], true);
    const error = new ReleaseRefusedError(kind, message, categories) as ReleaseRefusedError & {
      evidence: SynthesisResult;
    };
    error.evidence = evidence;
    throw error;
  };

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
  const verdictFindings = filterPiiCategories(verdict.findings).categories;

  const attestation: Attestation = {
    ok: verdict.ok && consistency.ok,
    reason: verdict.ok ? consistency.reason : verdict.reason,
    findings: verdictFindings,
    details: verdict.details,
  };

  logger?.event('attest.verdict', {
    verdict: attestation.ok ? 'pass' : 'fail',
    findings: verdictFindings,
  });

  if (!consistency.ok) {
    attestation.ok = false;
    logger?.event(
      'release.refused',
      { refusal: 'invented_token', invented_tokens: consistency.invented_tokens },
      'ERROR',
    );
    refuse(
      'invented_token',
      consistency.reason ?? 'invented placeholders',
      attestation,
      consistency,
      verdictFindings,
    );
  }
  if (!verdict.ok) {
    attestation.ok = false;
    logger?.event(
      'release.refused',
      { refusal: 'leak_check_failed', findings: verdictFindings },
      'ERROR',
    );
    refuse(
      'leak_check_failed',
      'the leak check failed',
      attestation,
      consistency,
      verdictFindings,
      verdictFindings,
    );
  }

  // --- gate 4: the Gemma judge, asymmetrically. ---------------------------
  //
  // The judge sees the pre-rehydration body. Showing it the rehydrated one would
  // hand real PII to a model and would make "there is a leak" the always-correct
  // answer, draining the signal of meaning.
  if (options.judge !== undefined) {
    // Counted from the mapping's *keys* only. A placeholder's category is
    // already public — it is in the placeholder, in the OKF document and in the
    // API response — while the values on the other side of the mapping are never
    // read here.
    const maskedCounts: Record<string, number> = {};
    for (const token of Object.keys(mapping)) {
      const category = /^⟦([A-Z][A-Z0-9_]*?)_\d+⟧$/u.exec(token)?.[1]; // digits admitted: IPV4
      if (category === undefined) continue;
      maskedCounts[category] = (maskedCounts[category] ?? 0) + 1;
    }
    const judgeContext: LeakJudgeContext = { maskedPrompt, maskedCounts };

    /** One judge round trip, with a transport or parse failure flattened to "no opinion". */
    const consult = (): Promise<{ leak: boolean | null; categories?: readonly string[] }> =>
      withSpan(SPAN.judgeGemma, { request_id: requestId }, async () => {
        try {
          const result = await options.judge?.(coreAnswer, options.signal, judgeContext);
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

    const opinion = await consult();
    let judgeCategories = filterPiiCategories(opinion.categories ?? []).categories;
    let judgeRetries = 0;

    /**
     * A flag with no categories buys one more call — to name the categories for
     * the refusal record, never to lift the veto.
     *
     * The request is already refused at this point: `leak: true` is terminal
     * whether or not the judge managed to format a category list. The second
     * call exists so the caller and the audit document learn *what* the judge
     * suspected, because a refusal that says only "something" is much harder to
     * act on than one that says "PERSON".
     *
     * Why not let a clear second answer release: re-rolling a probabilistic veto
     * until it goes away is how a veto becomes theatre. The deterministic
     * attester does not detect names or postal addresses, so an unevidenced flag
     * over an attester-clean body is precisely the case where the judge is
     * adding coverage nothing else has — the case where a downgrade costs the
     * most. Why not skip the second call entirely: it is free of consequence and
     * it is the only chance to attach evidence to the refusal.
     */
    const isUnevidencedFlag = opinion.leak === true && judgeCategories.length === 0 && verdict.ok;
    if (isUnevidencedFlag) {
      const second = await consult();
      judgeRetries = 1;
      const enriched = filterPiiCategories(second.categories ?? []).categories;
      logger?.event('judge.retry', {
        verdict: second.leak === true ? 'flagged' : second.leak === false ? 'clear' : 'unusable',
        categories: enriched,
      });

      // Only the category list is taken. `second.leak` is deliberately ignored:
      // it cannot confirm the veto (it is already authoritative) and it cannot
      // lift it.
      if (enriched.length > 0) judgeCategories = enriched;
    }

    // The first opinion is the verdict. Nothing after it may change `leak`.
    attestation.judge = { leak: opinion.leak ?? null, categories: judgeCategories };
    // Recorded in the audit document so a refusal whose categories were
    // recovered on a second look is distinguishable from one that named them
    // outright. It counts category-enrichment attempts, never verdict re-rolls.
    if (judgeRetries > 0) attestation.judge_retries = judgeRetries;
    logger?.event('judge.gemma', { leak: opinion.leak ?? null, categories: judgeCategories });

    // `false` deliberately does nothing: a probabilistic model may veto a
    // release, but it may never be the reason one is trusted.
    const judgeBlocked: RefusalKind | null =
      opinion.leak === true ? 'judge_flagged' : opinion.leak === null ? 'judge_unavailable' : null;

    if (judgeBlocked !== null) {
      attestation.ok = false;
      attestation.reason ??=
        judgeBlocked === 'judge_flagged'
          ? 'the advisory judge flagged a possible leak'
          : 'the advisory judge returned no usable verdict';
      logger?.event('release.refused', { refusal: judgeBlocked }, 'ERROR');
      refuse(
        judgeBlocked,
        judgeBlocked === 'judge_flagged'
          ? 'the advisory judge flagged a possible leak'
          : 'the advisory judge returned no usable verdict',
        attestation,
        consistency,
        verdictFindings,
        judgeCategories,
      );
    }
  }

  // --- gate 5: every placeholder must be resolvable, checked against the
  //     mapping's keys only. No value is read here. -----------------------
  const resolvability = unresolvableTokens(coreAnswer, new Set(Object.keys(mapping)), withhold);
  if (resolvability.unresolved.length > 0) {
    attestation.ok = false;
    attestation.unresolved_tokens = [...resolvability.unresolved];
    attestation.reason ??= 'the response references placeholders absent from the vault';
    logger?.event(
      'release.refused',
      { refusal: 'unresolved_token', unresolved_tokens: resolvability.unresolved },
      'ERROR',
    );
    refuse(
      'unresolved_token',
      'the response references unknown placeholders',
      attestation,
      consistency,
      verdictFindings,
    );
  }

  // --- every gate has passed. This is the single rehydration. -------------
  const rehydrate = options.rehydrate ?? rehydrateWithPolicy;
  const released = await withSpan(SPAN.rehydrate, { request_id: requestId }, (span) => {
    const restored = rehydrate(coreAnswer, mapping, { withhold: [...withhold] });
    span.setAttribute('tokens_unknown', restored.unresolved.length);
    span.setAttribute('tokens_withheld', restored.withheld.length);
    return Promise.resolve(restored);
  });

  if (resolvability.withheldCategories.length > 0) {
    attestation.withheld = [...resolvability.withheldCategories];
  }
  if (disclosureRequested.length > 0) {
    attestation.disclosure_requested = [...disclosureRequested];
  }

  // --- gate 6: the rehydration is checked against what it was told to do. --
  //
  // Last, because it is the only gate whose subject is a string containing real
  // values, and after it there is nothing left to decide. A defect here is our
  // bug rather than the caller's, so it is a 500 — but the body is withheld
  // exactly as every other refusal withholds it, because a rehydration that went
  // wrong is precisely the text least safe to release.
  const withheldTokens = findTokens(coreAnswer).filter((token) => {
    const category = categoryOf(token);
    return category !== null && withhold.has(category);
  });
  const restoredTokens = findTokens(coreAnswer).filter(
    (token) => !withheldTokens.includes(token) && mapping[token] !== undefined,
  );

  const defect = verifyRehydration({
    released: released.text,
    restored: restoredTokens,
    withheldTokens,
    mapping,
  });
  if (defect !== null) {
    attestation.ok = false;
    attestation.reason ??= 'the rehydration did not match the disclosure policy';
    logger?.event(
      'release.refused',
      {
        refusal: 'rehydration_incomplete',
        error_code: defect.kind,
        // Token *names* and closed-enum categories only, exactly as every other
        // refusal reports: never a value, never the released text.
        ...('tokens' in defect ? { unresolved_tokens: [...defect.tokens] } : {}),
        ...('categories' in defect ? { categories: [...defect.categories] } : {}),
      },
      'ERROR',
    );
    refuse(
      'rehydration_incomplete',
      'the rehydrated answer failed its completeness check, so nothing was released',
      attestation,
      consistency,
      verdictFindings,
      'categories' in defect ? defect.categories : [],
    );
  }

  // Recorded only now that the check has passed: the block asserts a verdict,
  // and writing it before the verification would make it an assumption.
  attestation.rehydration = {
    substituted: restoredTokens.length,
    withheld_remaining: [...released.withheld],
    verdict: 'pass',
  };

  const result = assemble(
    inputs,
    attestation,
    consistency,
    verdictFindings,
    released.text,
    resolvability.withheldCategories,
    false,
  );

  logger?.event('release.ok', {
    tokens_resolved: findTokens(coreAnswer).length - released.withheld.length,
    withheld_count: released.withheld.length,
  });
  return result;
}

/**
 * A refusal that still carries the evidence document.
 *
 * The caller persists `evidence` — the masked record of what happened, whose
 * body is the `content withheld` marker — and returns the status, so a blocked
 * request is auditable without any part of the unsafe body reaching a response,
 * the store, or the evidence routes.
 */
export interface RefusalWithEvidence extends ReleaseRefusedError {
  readonly evidence: SynthesisResult;
}

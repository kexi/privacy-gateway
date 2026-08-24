/**
 * The Synthesis pipeline: leak check -> rehydrate -> consistency -> OKF assembly.
 *
 * The only LLM call is the Gemma judge, and its opinion is advisory. Every pass
 * or fail decision belongs to the deterministic attester, because delegating the
 * decision to an LLM would destroy auditability.
 */

import {
  responseHash,
  scan as scanForLeaks,
  verify,
  type Verdict,
} from '@privacy-gateway/common/attesters/leak-check';
import {
  buildGatewayAnswer,
  currentTraceId,
  dump,
  findTokens,
  rehydrate,
  SPAN,
  trustTier,
  withSpan,
  type Attestation,
  type ConsistencyReport,
  type Logger,
  type OkfDocument,
  type ReceiptSummary,
  type TokenVault,
  type TrustTier,
} from '@privacy-gateway/common';

/** The OKF actor string for this agent (SPEC §7). */
export function actor(model: string = process.env['GEMMA_MODEL'] ?? 'gemma3:12b'): string {
  return `synthesis_agent/${model}`;
}

/** An advisory verdict from Gemma; it never decides pass or fail. */
export type LeakJudge = (text: string) => Promise<{ leak: boolean | null; categories?: string[] }>;

/** The full set of Synthesis results. */
export interface SynthesisResult {
  readonly document: OkfDocument;
  readonly markdown: string;
  readonly answer: string;
  readonly attestation: Attestation;
  readonly consistency: ConsistencyReport;
  readonly receipt: ReceiptSummary;
  readonly trustTier: TrustTier;
}

/** The receipt fields the attester requires, plus the body it re-scans. */
interface FullReceipt extends ReceiptSummary {
  readonly response: string;
}

/**
 * Build the receipt exactly as the executor procedure specifies
 * (`/references/skills/run-leak-check.md`).
 *
 * The receipt is a runtime artifact, so it is not stored in the bundle (SPEC §10).
 */
export function buildReceipt(sessionId: string, response: string): FullReceipt {
  return {
    session_id: sessionId,
    response_hash: responseHash(response),
    findings: scanForLeaks(response),
    response,
  };
}

/**
 * Deterministically check that Core did not fabricate placeholders absent from
 * the input.
 *
 * If Core invents a token that is in neither the vault nor the masked prompt, it
 * survives rehydration and the user is shown a meaningless symbol.
 */
export function checkConsistency(maskedPrompt: string, coreAnswer: string): ConsistencyReport {
  const known = new Set(findTokens(maskedPrompt));
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
  readonly sessionId: string;
  readonly maskedPrompt: string;
  readonly coreAnswer: string;
  readonly vault: TokenVault;
  readonly generatedBy: string;
  readonly judge?: LeakJudge | undefined;
  readonly logger?: Logger | undefined;
  readonly requestId?: string | undefined;
  readonly verifiedBy?: string | undefined;
}

/**
 * Verify and rehydrate Core's output, assembling it into an OKF `Gateway Answer`.
 */
export async function synthesize(options: SynthesizeOptions): Promise<SynthesisResult> {
  const { sessionId, maskedPrompt, coreAnswer, logger } = options;

  const entry = await options.vault.get(sessionId);
  const mapping = entry?.mapping ?? {};
  // With no live vault entry nothing can be rehydrated, so stale_after is set to
  // now, stating the staleness explicitly rather than implying freshness.
  const staleAfter = entry?.expiresAt ?? new Date();

  const consistency = checkConsistency(maskedPrompt, coreAnswer);

  // 1. Leak check: inspect Core's output **before** rehydration.
  //
  // Why not after: a correctly rehydrated answer contains the user's real PII by
  // definition, so checking afterwards would always fail. The question here is
  // whether Core, outside the boundary, mixed in raw PII beyond the placeholders
  // it was given, and the subject of that check is the still-masked output.
  const verdict = await withSpan(
    SPAN.attestLeakCheck,
    { session_id: sessionId },
    (span): Promise<Verdict> => {
      const result = verify(buildReceipt(sessionId, coreAnswer));
      span.setAttribute('verdict', result.ok ? 'pass' : 'fail');
      span.setAttribute('findings', result.findings);
      return Promise.resolve(result);
    },
  );

  const attestation: Attestation = {
    ok: verdict.ok,
    reason: verdict.reason,
    findings: verdict.findings,
    details: verdict.details,
  };

  logger?.event('attest.verdict', {
    session_id: sessionId,
    verdict: verdict.ok ? 'pass' : 'fail',
    findings: verdict.findings,
  });

  // 2. Rehydrate from the vault mapping.
  const answer = await withSpan(SPAN.rehydrate, { session_id: sessionId }, (span) => {
    const restored = rehydrate(coreAnswer, mapping);
    const unknown = findTokens(restored);
    span.setAttribute('tokens_resolved', findTokens(coreAnswer).length - unknown.length);
    span.setAttribute('tokens_unknown', unknown.length);

    logger?.event(
      'rehydrate.done',
      {
        session_id: sessionId,
        tokens_resolved: findTokens(coreAnswer).length - unknown.length,
        tokens_unknown: unknown.length,
      },
      unknown.length > 0 ? 'WARNING' : 'INFO',
    );
    return Promise.resolve(restored);
  });

  // The Gemma judge is an advisory signal, mixed into neither the receipt nor the
  // verdict: letting an LLM opinion in would stop the attestation from being
  // deterministic.
  if (options.judge !== undefined) {
    attestation.judge = await withSpan(SPAN.judgeGemma, { session_id: sessionId }, async () => {
      try {
        // The judge also sees the pre-rehydration body. Showing it the rehydrated
        // one would hand real PII to Gemma, and would make "there is a leak" the
        // always-correct answer, draining the signal of meaning.
        const opinion = await options.judge?.(coreAnswer);
        logger?.event('judge.gemma', {
          session_id: sessionId,
          leak: opinion?.leak ?? null,
        });
        return opinion ?? { leak: null };
      } catch (error) {
        logger?.event(
          'judge.gemma',
          {
            session_id: sessionId,
            error_message: error instanceof Error ? error.message : String(error),
          },
          'WARNING',
        );
        return {
          leak: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  // 3. Consistency: fabricated tokens fail the attestation as well.
  if (!consistency.ok) {
    attestation.ok = false;
    attestation.reason = consistency.reason;
  }

  // Record placeholders left unresolved: traces of an expired vault or of
  // fabrication.
  const leftover = findTokens(answer);
  if (leftover.length > 0) attestation.unresolved_tokens = leftover;

  const document = await withSpan(SPAN.okfBuild, { session_id: sessionId }, () => {
    const traceId = currentTraceId();
    return Promise.resolve(
      buildGatewayAnswer({
        sessionId,
        answerBody: answer,
        generatedBy: options.generatedBy,
        verifiedBy: options.verifiedBy ?? actor(),
        staleAfter,
        attestation,
        requestId: options.requestId,
        traceId,
      }),
    );
  });

  return {
    document,
    markdown: dump(document),
    answer,
    attestation,
    consistency,
    receipt: {
      session_id: sessionId,
      response_hash: responseHash(coreAnswer),
      findings: verdict.findings,
    },
    trustTier: trustTier(document.metadata),
  };
}

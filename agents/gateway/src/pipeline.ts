/**
 * Gateway orchestration: tokenize -> guard -> Core (A2A) -> Synthesis (HTTP).
 *
 * The Core and Synthesis calls are injected as callables so the behavior of the
 * boundary — the egress guard above all — can be tested without touching the
 * network.
 */

import {
  countsByCategory,
  currentTraceId,
  nowIso,
  PiiLeakError,
  scan,
  SessionTokenizer,
  SPAN,
  vaultTtlSeconds,
  withSpan,
  type Detection,
  type Logger,
  type SynthesizeResponse,
  type TokenizeResult,
  type TokenVault,
} from '@privacy-gateway/common';

/** Sends the masked prompt to Core and returns its masked answer. */
export type CoreCaller = (maskedPrompt: string) => Promise<string>;

/** Calls Synthesis with the exchange and returns its verified, rehydrated result. */
export type SynthesisCaller = (input: {
  sessionId: string;
  maskedPrompt: string;
  coreAnswer: string;
  generatedBy: string;
}) => Promise<SynthesizeResponse>;

/** Extracts unstructured spans (names, addresses) that the regexes cannot see. */
export type SpanExtractor = (text: string) => Promise<Detection[]>;

/**
 * The masking step.
 *
 * Injectable so a test can simulate a tokenizer regression and prove the egress
 * guard still refuses — the guarantee that matters most here cannot be observed
 * while the tokenizer is working correctly.
 */
export type Tokenize = (text: string, extra: readonly Detection[]) => TokenizeResult;

/** The result of one request. */
export interface AskResult {
  readonly sessionId: string;
  readonly requestId: string;
  readonly traceId?: string | undefined;
  readonly maskedPrompt: string;
  readonly okfMarkdown: string;
  readonly answer: string;
  readonly trustTier: SynthesizeResponse['trust_tier'];
  readonly status: SynthesizeResponse['status'];
  readonly attestation: SynthesizeResponse['attestation'];
  readonly consistency: SynthesizeResponse['consistency'];
  readonly stats: {
    readonly masked_count: number;
    readonly counts_by_category: Record<string, number>;
    readonly unstructured_spans: number;
    readonly vault_expires_at: string;
    readonly core_actor: string;
  };
}

export interface AskOptions {
  readonly text: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly vault: TokenVault;
  readonly callCore: CoreCaller;
  readonly callSynthesis: SynthesisCaller;
  readonly coreActor: string;
  readonly extractSpans?: SpanExtractor | undefined;
  readonly tokenize?: Tokenize | undefined;
  readonly logger: Logger;
}

/**
 * Process one user input across the boundary.
 *
 * @throws PiiLeakError if raw PII survived masking, in which case Core is never
 *   called.
 */
export async function ask(options: AskOptions): Promise<AskResult> {
  const { logger, sessionId, vault } = options;

  // 1. Tokenize, carrying over the existing mapping to keep placeholders stable.
  const existing = await vault.get(sessionId);
  const tokenizer = new SessionTokenizer(existing?.mapping);

  const extra = await withSpan(SPAN.maskGemma, { session_id: sessionId }, async (span) => {
    if (options.extractSpans === undefined) return [];
    const spans = await options.extractSpans(options.text);
    span.setAttribute('span_count', spans.length);
    return spans;
  });

  const tokenize: Tokenize = options.tokenize ?? ((text, spans) => tokenizer.tokenize(text, spans));

  const result = await withSpan(SPAN.maskRegex, { session_id: sessionId }, (span) => {
    const masked = tokenize(options.text, extra);
    span.setAttribute('placeholder_count', masked.detections.length);
    return Promise.resolve(masked);
  });
  const maskedPrompt = result.text;
  const counts = countsByCategory(result.detections);

  // 2. Store in the vault. From here on the mapping exists only inside the boundary.
  const entry = await vault.put(sessionId, result.mapping, vaultTtlSeconds());

  // 3. Egress guard: rerun the deterministic detection just before sending
  //    (defense in depth).
  await withSpan(SPAN.guardEgress, { session_id: sessionId }, (span) => {
    const report = scan(maskedPrompt);
    span.setAttribute('ok', report.ok);
    if (!report.ok) {
      span.setAttribute('categories', [...report.categories]);
      logger.event(
        'guard.egress.blocked',
        { session_id: sessionId, categories: [...report.categories] },
        'ERROR',
      );
      throw new PiiLeakError(report.findings);
    }
    return Promise.resolve();
  });

  logger.event('mask.done', {
    session_id: sessionId,
    placeholder_count: result.detections.length,
    counts_by_category: counts,
    unstructured_spans: extra.length,
  });

  // 4. Send only the masked prompt to Core, which sits outside the boundary.
  const coreAnswer = await withSpan(
    SPAN.a2aCore,
    { session_id: sessionId, placeholder_count: result.detections.length },
    async () => {
      const startedAt = Date.now();
      logger.event('a2a.core.send', { session_id: sessionId });
      const answer = await options.callCore(maskedPrompt);
      logger.event('a2a.core.recv', {
        session_id: sessionId,
        duration_ms: Date.now() - startedAt,
        status: 'ok',
      });
      return answer;
    },
  );

  // 5. Synthesis, inside the boundary, verifies and rehydrates it into an OKF document.
  const synthesis = await withSpan(SPAN.synthesisCall, { session_id: sessionId }, async (span) => {
    const response = await options.callSynthesis({
      sessionId,
      maskedPrompt,
      coreAnswer,
      generatedBy: options.coreActor,
    });
    span.setAttribute('verdict', response.attestation.ok ? 'pass' : 'fail');
    span.setAttribute('trust_tier', response.trust_tier);
    return response;
  });

  const traceId = currentTraceId();
  return {
    sessionId,
    requestId: options.requestId,
    traceId,
    maskedPrompt,
    okfMarkdown: synthesis.markdown,
    answer: synthesis.answer,
    trustTier: synthesis.trust_tier,
    status: synthesis.status,
    attestation: synthesis.attestation,
    consistency: synthesis.consistency,
    stats: {
      masked_count: result.detections.length,
      counts_by_category: counts,
      unstructured_spans: extra.length,
      vault_expires_at: nowIso(entry.expiresAt),
      core_actor: options.coreActor,
    },
  };
}

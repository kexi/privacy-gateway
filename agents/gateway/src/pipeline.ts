/**
 * Gateway orchestration: reject -> tokenize -> guard -> Core (A2A) -> Synthesis (HTTP).
 *
 * The Core and Synthesis calls are injected as callables so the behavior of the
 * boundary — the egress guard above all — can be tested without touching the
 * network.
 *
 * Every gate here fails closed. A step that cannot produce a trustworthy result
 * throws, and nothing downstream of it runs; there is deliberately no path that
 * degrades to "send it anyway".
 */

import {
  containsReservedSyntax,
  countsByCategory,
  currentTraceId,
  findTokens,
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
export type CoreCaller = (maskedPrompt: string, signal?: AbortSignal) => Promise<string>;

/** Calls Synthesis with the exchange and returns its verified, rehydrated result. */
export type SynthesisCaller = (
  input: {
    maskedPrompt: string;
    coreAnswer: string;
    generatedBy: string;
    knownTokens: readonly string[];
    vaultGeneration: number;
  },
  signal?: AbortSignal,
) => Promise<SynthesizeResponse>;

/** Extracts unstructured spans (names, addresses) that the regexes cannot see. */
export type SpanExtractor = (text: string, signal?: AbortSignal) => Promise<Detection[]>;

/**
 * The masking step.
 *
 * Injectable so a test can simulate a tokenizer regression and prove the egress
 * guard still refuses — the guarantee that matters most here cannot be observed
 * while the tokenizer is working correctly.
 */
export type Tokenize = (text: string, extra: readonly Detection[]) => TokenizeResult;

/** Raised when the raw input uses the reserved placeholder syntax. */
export class ReservedSyntaxError extends Error {
  constructor() {
    super(
      'the request contains the reserved placeholder delimiters ⟦ ⟧, which only the ' +
        'gateway may produce',
    );
    this.name = 'ReservedSyntaxError';
  }
}

/** The result of one request. */
export interface AskResult {
  readonly requestId: string;
  readonly traceId?: string | undefined;
  readonly maskedPrompt: string;
  readonly okfMarkdown: string;
  readonly answer: string;
  readonly trustTier: SynthesizeResponse['trust_tier'];
  readonly status: SynthesizeResponse['status'];
  readonly dimensions: SynthesizeResponse['dimensions'];
  readonly attestation: SynthesizeResponse['attestation'];
  readonly consistency: SynthesizeResponse['consistency'];
  readonly stats: {
    readonly masked_count: number;
    readonly counts_by_category: Record<string, number>;
    readonly unstructured_spans: number;
    readonly vault_expires_at: string;
    readonly vault_generation: number;
    readonly core_actor: string;
  };
}

export interface AskOptions {
  readonly text: string;
  /** The vault key: one server-generated request id, never caller-supplied. */
  readonly requestId: string;
  readonly vault: TokenVault;
  readonly callCore: CoreCaller;
  readonly callSynthesis: SynthesisCaller;
  readonly coreActor: string;
  readonly extractSpans?: SpanExtractor | undefined;
  readonly tokenize?: Tokenize | undefined;
  readonly logger: Logger;
  /**
   * The request-scoped deadline.
   *
   * Passed down every hop and checked between steps. `Promise.race` alone only
   * stopped *waiting*: the underlying Core, Synthesis and Gemma calls kept
   * running, kept spending model budget and kept writing evidence long after the
   * caller had already received a 504.
   */
  readonly signal?: AbortSignal | undefined;
}

/** Raised when the request-scoped deadline fired between two pipeline steps. */
export class RequestAbortedError extends Error {
  constructor() {
    super('the request was cancelled before this step could run');
    this.name = 'RequestAbortedError';
  }
}

/**
 * Process one user input across the boundary.
 *
 * @throws ReservedSyntaxError if the caller wrote placeholder delimiters.
 * @throws ExtractionFailedError (from the extractor) if Gemma is unusable.
 * @throws PiiLeakError if raw PII survived masking, in which case Core is never
 *   called.
 */
export async function ask(options: AskOptions): Promise<AskResult> {
  const { logger, requestId, vault, signal } = options;

  /**
   * Stop between steps once the deadline has fired.
   *
   * Checked at every boundary rather than only at the hops that accept a signal:
   * the Gemma extractor runs through the ADK runner, which has no cancellation
   * seam, so the only way to stop the work that would follow it is to refuse to
   * do that work.
   */
  const checkpoint = (): void => {
    if (signal?.aborted === true) throw new RequestAbortedError();
  };

  // 0. Reject the reserved syntax before anything else.
  //
  // A caller who writes `⟦EMAIL_1⟧` verbatim is not describing data, they are
  // naming a vault slot. The tokenizer would pass it through untouched and the
  // rehydrator would resolve it, turning the gateway into an oracle for whatever
  // this request's own mapping holds. There is no legitimate use, so it is a 400.
  if (containsReservedSyntax(options.text)) {
    logger.event('request.refused', { refusal: 'reserved_syntax' }, 'WARNING');
    throw new ReservedSyntaxError();
  }

  // 1. Tokenize. The vault is keyed by this request alone, so there is never an
  //    existing mapping to carry over.
  const tokenizer = new SessionTokenizer();

  const extra = await withSpan(SPAN.maskGemma, { request_id: requestId }, async (span) => {
    if (options.extractSpans === undefined) return [];
    const spans = await options.extractSpans(options.text, signal);
    span.setAttribute('span_count', spans.length);
    return spans;
  });
  checkpoint();

  const tokenize: Tokenize = options.tokenize ?? ((text, spans) => tokenizer.tokenize(text, spans));

  const result = await withSpan(SPAN.maskRegex, { request_id: requestId }, (span) => {
    const masked = tokenize(options.text, extra);
    span.setAttribute('placeholder_count', masked.detections.length);
    return Promise.resolve(masked);
  });
  const maskedPrompt = result.text;
  const counts = countsByCategory(result.detections);

  // 2. Store in the vault. From here on the mapping exists only inside the boundary.
  const entry = await vault.put(requestId, result.mapping, vaultTtlSeconds());
  checkpoint();

  // 3. Egress guard: rerun the deterministic detection just before sending
  //    (defense in depth).
  await withSpan(SPAN.guardEgress, { request_id: requestId }, (span) => {
    const report = scan(maskedPrompt);
    span.setAttribute('ok', report.ok);
    if (!report.ok) {
      span.setAttribute('categories', [...report.categories]);
      logger.event('guard.egress.blocked', { categories: [...report.categories] }, 'ERROR');
      throw new PiiLeakError(report.findings);
    }
    return Promise.resolve();
  });

  logger.event('mask.done', {
    placeholder_count: result.detections.length,
    counts_by_category: counts,
    unstructured_spans: extra.length,
    vault_generation: entry.generation,
  });

  // 4. Send only the masked prompt to Core, which sits outside the boundary.
  const coreAnswer = await withSpan(
    SPAN.a2aCore,
    { request_id: requestId, placeholder_count: result.detections.length },
    async () => {
      const startedAt = Date.now();
      logger.event('a2a.core.send', {});
      const answer = await options.callCore(maskedPrompt, signal);
      logger.event('a2a.core.recv', { duration_ms: Date.now() - startedAt, status: 'ok' });
      return answer;
    },
  );
  checkpoint();

  // 5. Synthesis, inside the boundary, verifies and rehydrates it into an OKF
  //    document. It is handed the tokenizer's own token set rather than
  //    re-deriving one from the prompt: the prompt is partly caller-written, and
  //    a token found there is only trustworthy because *this* tokenizer put it
  //    there.
  const knownTokens = findTokens(maskedPrompt).filter(
    (token) => result.mapping[token] !== undefined,
  );

  const synthesis = await withSpan(SPAN.synthesisCall, { request_id: requestId }, async (span) => {
    const response = await options.callSynthesis(
      {
        maskedPrompt,
        coreAnswer,
        generatedBy: options.coreActor,
        knownTokens,
        vaultGeneration: entry.generation,
      },
      signal,
    );
    span.setAttribute('verdict', response.attestation.ok ? 'pass' : 'fail');
    span.setAttribute('trust_tier', response.trust_tier);
    return response;
  });

  const traceId = currentTraceId();
  return {
    requestId,
    traceId,
    maskedPrompt,
    okfMarkdown: synthesis.markdown,
    answer: synthesis.answer,
    trustTier: synthesis.trust_tier,
    status: synthesis.status,
    dimensions: synthesis.dimensions,
    attestation: synthesis.attestation,
    consistency: synthesis.consistency,
    stats: {
      masked_count: result.detections.length,
      counts_by_category: counts,
      unstructured_spans: extra.length,
      vault_expires_at: nowIso(entry.expiresAt),
      vault_generation: entry.generation,
      core_actor: options.coreActor,
    },
  };
}

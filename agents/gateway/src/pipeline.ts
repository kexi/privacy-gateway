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
  type ProgressEvent,
  type ProgressStage,
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
    rehydrateAllow: readonly string[];
    maskTerms: readonly string[];
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
export type Tokenize = (
  text: string,
  extra: readonly Detection[],
  terms: readonly string[],
) => TokenizeResult;

/**
 * Called as each stage opens and closes, when the caller asked to be told.
 *
 * The pipeline hands it a stage name and a duration and nothing else. This is
 * the one channel that reports on a request *while* its content is still inside
 * the boundary, so it is typed to make carrying that content impossible rather
 * than merely discouraged: `ProgressEvent` has no free-text field.
 *
 * Failures are the caller's problem, not the pipeline's — a broken progress sink
 * must never take down the request it is describing.
 */
export type ProgressSink = (event: ProgressEvent) => void;

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
  /**
   * High-risk categories this request asked to have restored.
   *
   * Carried through untouched: the Gateway neither applies nor second-guesses
   * the disclosure policy — Synthesis owns it, and it validates the list again
   * on arrival. Empty by default, which is the existing behaviour exactly.
   */
  readonly rehydrateAllow?: readonly string[] | undefined;
  /**
   * Phrases the requester asked to have masked verbatim.
   *
   * Never logged: only `term_count` reaches a log line. The terms travel to the
   * tokenizer, to the egress guard's term scan and on to Synthesis, all of which
   * are inside the boundary; nothing here forwards them to Core.
   */
  readonly maskTerms?: readonly string[] | undefined;
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
  /**
   * Where to report stage transitions, when the caller asked for them.
   *
   * Absent by default: the non-streaming path must behave exactly as it did
   * before, so progress reporting is something a caller opts into rather than
   * something the pipeline always does and the server usually discards.
   */
  readonly onProgress?: ProgressSink | undefined;
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
  const maskTerms = options.maskTerms ?? [];

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

  // Elapsed is measured from the pipeline's own start rather than from the
  // HTTP request, so the numbers a client renders describe the work this
  // function did and not the time it spent queued behind middleware.
  const startedAt = Date.now();

  /**
   * Report a stage transition, absorbing anything the sink throws.
   *
   * A progress frame is decoration; a request that failed because a client
   * disconnected mid-stream would be the tail wagging the dog. Wrapped here
   * once so no individual stage can forget.
   */
  const progress = (stage: ProgressStage, state: 'start' | 'end'): void => {
    if (options.onProgress === undefined) return;
    try {
      options.onProgress({ stage, state, elapsed_ms: Date.now() - startedAt });
    } catch {
      // Deliberately ignored: see above.
    }
  };

  /** Run one stage, bracketing it with start/end frames even when it throws. */
  const staged = async <T>(stage: ProgressStage, run: () => Promise<T>): Promise<T> => {
    progress(stage, 'start');
    const value = await run();
    // Only on success: a stage that threw did not "end", it stopped, and the
    // caller learns which stage that was from the absence of its end frame.
    progress(stage, 'end');
    return value;
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

  // Gemma extraction and the regex pass are one `masking` stage to a client:
  // they are two implementation steps of a single answer to "is my PII hidden
  // yet", and splitting them would expose that the fleet runs a model here.
  const { result, extra } = await staged('masking', async () => {
    const spans = await withSpan(SPAN.maskGemma, { request_id: requestId }, async (span) => {
      if (options.extractSpans === undefined) return [];
      const found = await options.extractSpans(options.text, signal);
      span.setAttribute('span_count', found.length);
      return found;
    });
    checkpoint();

    const tokenize: Tokenize =
      options.tokenize ??
      ((text, detections, terms) => tokenizer.tokenize(text, detections, terms));

    const masked = await withSpan(SPAN.maskRegex, { request_id: requestId }, (span) => {
      const value = tokenize(options.text, spans, maskTerms);
      span.setAttribute('placeholder_count', value.detections.length);
      // A count, never a term: span attributes carry no PII value by rule, and a
      // requester's codename is exactly the kind of value that rule exists for.
      span.setAttribute('term_count', maskTerms.length);
      return Promise.resolve(value);
    });
    return { result: masked, extra: spans };
  });

  const maskedPrompt = result.text;
  const counts = countsByCategory(result.detections);

  // 2. Store in the vault. From here on the mapping exists only inside the boundary.
  const entry = await vault.put(requestId, result.mapping, vaultTtlSeconds());
  checkpoint();

  // 3. Egress guard: rerun the deterministic detection just before sending, and
  //    scan the outbound prompt for every requester-named term (defense in
  //    depth). The term half is the stronger check of the two: it compares
  //    literal strings rather than re-running the patterns that decided the
  //    masking, so a substitution that silently failed cannot pass it.
  await staged('egress_guard', () =>
    withSpan(SPAN.guardEgress, { request_id: requestId }, (span) => {
      const report = scan(maskedPrompt, maskTerms);
      span.setAttribute('ok', report.ok);
      if (!report.ok) {
        span.setAttribute('categories', [...report.categories]);
        span.setAttribute('surviving_term_count', report.survivingTerms);
        logger.event(
          'guard.egress.blocked',
          {
            categories: [...report.categories],
            // The count only. A refusal must not repeat the secret it refused
            // to send.
            ...(report.survivingTerms > 0 ? { surviving_term_count: report.survivingTerms } : {}),
          },
          'ERROR',
        );
        throw new PiiLeakError(report.findings, report.survivingTerms);
      }
      return Promise.resolve();
    }),
  );

  logger.event('mask.done', {
    placeholder_count: result.detections.length,
    counts_by_category: counts,
    unstructured_spans: extra.length,
    vault_generation: entry.generation,
    // How many terms the requester named, never which. `counts_by_category`
    // already reports how many CUSTOM placeholders were actually allocated, so a
    // term that matched nothing is visible as the difference between the two.
    term_count: maskTerms.length,
  });

  // 4. Send only the masked prompt to Core, which sits outside the boundary.
  const coreAnswer = await staged('core_reasoning', () =>
    withSpan(
      SPAN.a2aCore,
      { request_id: requestId, placeholder_count: result.detections.length },
      async () => {
        const sentAt = Date.now();
        logger.event('a2a.core.send', {});
        const answer = await options.callCore(maskedPrompt, signal);
        logger.event('a2a.core.recv', { duration_ms: Date.now() - sentAt, status: 'ok' });
        return answer;
      },
    ),
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

  // Synthesis verifies and rehydrates in a single round trip, so the two client
  // stages are bracketed around one call rather than around two: `leak_check`
  // covers the request, and `rehydrate` is reported once it returned an answer.
  // Why not split them for real — by having Synthesis stream its own progress:
  // that would put a second streaming hop inside the boundary for a cosmetic
  // gain, and the gates it reports on are the ones that must not be observable
  // to a caller before they have all passed.
  const synthesis = await staged('leak_check', () =>
    withSpan(SPAN.synthesisCall, { request_id: requestId }, async (span) => {
      const response = await options.callSynthesis(
        {
          maskedPrompt,
          coreAnswer,
          generatedBy: options.coreActor,
          knownTokens,
          vaultGeneration: entry.generation,
          rehydrateAllow: options.rehydrateAllow ?? [],
          // Inside the boundary: Synthesis already holds every raw value behind
          // every placeholder, and without the terms its attester cannot scan
          // Core's output for a codename no regex knows.
          maskTerms,
        },
        signal,
      );
      span.setAttribute('verdict', response.attestation.ok ? 'pass' : 'fail');
      span.setAttribute('trust_tier', response.trust_tier);
      return response;
    }),
  );

  progress('rehydrate', 'start');
  progress('rehydrate', 'end');

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

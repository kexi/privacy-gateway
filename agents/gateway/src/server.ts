/**
 * The Gateway HTTP app: the single entry point as far as the user is concerned.
 *
 * Core is reached over A2A. Synthesis is reached over plain HTTP even though it
 * also exposes an A2A surface, because the OKF document is an audit artifact and
 * must be retrieved without an LLM rephrasing it anywhere along the way.
 *
 * One request, one server-generated id, one vault entry. There is no
 * caller-supplied session and no multi-turn state: a caller who can name someone
 * else's vault key can make the gateway resolve their placeholders, and no
 * amount of validation on a caller-supplied id removes that, so the id is not
 * accepted at all.
 */

import {
  AskRequestSchema,
  authorizedFetch,
  buildActivityStore,
  buildVault,
  contextFromHeaders,
  createLogger,
  currentTraceId,
  DEFAULT_GEMINI_MODEL,
  initTelemetry,
  IdTokenError,
  loadConfig,
  recordGemmaActivity,
  recordWarmupRequest,
  UnknownAudienceError,
  PiiLeakError,
  ReleaseRefusalSchema,
  sendMessage,
  setIdTokenAudienceAllowlist,
  SPAN,
  SynthesizeResponseSchema,
  uuidv7,
  withContext,
  withSpan,
  type ActivityStore,
  type AskResponse,
  type Config,
  type Detection,
  type Logger,
  type ProgressEvent,
  type SynthesizeResponse,
  type TokenVault,
} from '@privacy-gateway/common';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExtractionFailedError, extractUnstructured } from './agent.ts';
import {
  AUDIT_LIST_LIMIT,
  buildAuditStore,
  presentedToken,
  tokenMatches,
  type AuditStore,
} from './audit.ts';
import {
  handleModels,
  logChatStart,
  parseChatRequest,
  toChatCompletion,
  toOpenAiError,
  writeSseCompletion,
} from './openai_compat.ts';
import {
  logResponsesStart,
  parseResponsesRequest,
  responsesError,
  toResponsesObject,
  writeResponsesSse,
  writeResponsesSseError,
} from './responses_compat.ts';
import { ask, RequestAbortedError, ReservedSyntaxError, type AskResult } from './pipeline.ts';
import { StatusCache } from './status.ts';
import { wakeGemma } from './warmup.ts';

/** Cloud Run injects PORT. Locally 8081 sits between web (5173) and core (8082). */
const DEFAULT_PORT = 8081;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Per-request state, attached by the correlation middleware. */
interface RequestContext {
  readonly requestId: string;
  readonly logger: Logger;
}

/**
 * A request that has passed the correlation middleware.
 *
 * Why not augment Express's `Request` globally? The augmentation would have to
 * declare the property optional on every request in the process, which loses the
 * very guarantee it is meant to express; a local intersection type keeps
 * "correlated" visible in each handler's signature instead.
 */
type CorrelatedRequest = Request & { pgw?: RequestContext };

/** Reads the correlation state a handler needs. */
function contextOf(req: Request): RequestContext | undefined {
  return (req as CorrelatedRequest).pgw;
}

/**
 * Adapt an async handler to Express, which understands only synchronous ones.
 *
 * Why not `(req, res, next) => { void handler(req, res, next); }`, which is what
 * every route did: `void` discards the promise along with its rejection, so a
 * throw that escaped a handler's own try/catch became an unhandled rejection —
 * the caller's socket left hanging and, under Node's default, the process torn
 * down. The handlers do catch their expected failures; this covers the ones they
 * cannot anticipate (a malformed body reaching a mapper, a downstream client
 * throwing outside the awaited call) by routing them to Express's error
 * middleware, which answers 500 without any exception text.
 */
function route(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    // An awaited try/catch rather than `.catch(next)`: the lint rule against
    // calling a callback inside a promise handler is guarding real
    // callback/promise mixing, and this is Express's error channel — the one
    // place a promise genuinely must hand off to a callback. Written as an async
    // IIFE the handoff is ordinary control flow, which is also easier to read.
    void (async () => {
      try {
        await handler(req, res, next);
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * The `:id` path segment.
 *
 * Express types every path parameter as possibly absent, but a handler only runs
 * when its route matched, so the segment is present by construction.
 */
function requestParam(req: Request): string {
  return (req.params as Record<string, string | undefined>)['id'] ?? '';
}

export interface CreateAppOptions {
  readonly config: Config;
  readonly logger: Logger;
  /** Injected by tests so the whole route surface runs without a network. */
  readonly callCore?:
    | ((maskedPrompt: string, requestId: string, signal?: AbortSignal) => Promise<string>)
    | undefined;
  readonly callSynthesis?:
    | ((input: SynthesisInput, signal?: AbortSignal) => Promise<SynthesizeResponse>)
    | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly extractSpans?:
    | ((text: string, signal?: AbortSignal) => Promise<Detection[]>)
    | undefined;
  readonly vault?: TokenVault | undefined;
  /**
   * Where Gemma's last-seen timestamp is kept.
   *
   * Injected by tests so the warm/cold badge can be driven without Firestore,
   * and so the "a failing store never fails a request" guarantee is testable.
   */
  readonly activityStore?: ActivityStore | undefined;
  /** Injected by the audit tests so the list runs without Firestore. */
  readonly auditStore?: AuditStore | undefined;
  /** Injected by the warmup test so no GPU is ever poked from a suite. */
  readonly wakeGemmaImpl?: (() => Promise<boolean>) | undefined;
  /** Injectable clock so the rate-limit test does not sleep. */
  readonly now?: (() => number) | undefined;
  /**
   * Overrides the configured deadline.
   *
   * Injectable so the cancellation test can fire it in milliseconds; the config
   * value is in whole seconds, and a one-second wait per assertion would make
   * the suite slow enough to be skipped.
   */
  readonly deadlineMs?: number | undefined;
}

interface SynthesisInput {
  readonly maskedPrompt: string;
  readonly coreAnswer: string;
  readonly generatedBy: string;
  readonly knownTokens: readonly string[];
  readonly vaultGeneration: number;
  readonly requestId: string;
  readonly rehydrateAllow: readonly string[];
  /** The requester's verbatim-mask terms; never leaves the boundary. */
  readonly maskTerms: readonly string[];
}

/**
 * A fixed-window per-IP counter.
 *
 * Demo-grade on purpose: the public gateway authenticates nobody, and one
 * request drives two Gemma calls plus a Gemini call, so an unbounded public
 * endpoint is a cost incident waiting to happen. A real deployment would put
 * Cloud Armor in front; this only has to make abuse uninteresting during the
 * demo window.
 */
class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {}

  /** True when this caller is over quota. */
  exceeded(key: string): boolean {
    if (this.perMinute <= 0) return false;

    const at = this.now();
    const entry = this.hits.get(key);
    const isNewWindow = entry === undefined || at - entry.windowStart >= 60_000;
    if (isNewWindow) {
      // Sweep opportunistically; a demo gateway never sees enough distinct IPs
      // to justify a timer, and a timer would keep the process alive.
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { count: 1, windowStart: at });
      return false;
    }

    entry.count += 1;
    return entry.count > this.perMinute;
  }
}

/** Builds the Express app. Importing this module must not start a listener. */
export function createApp(options: CreateAppOptions): express.Application {
  const { config, logger } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const vault = options.vault ?? buildVault(config.VAULT_BACKEND);
  const coreActor = `core_agent/${config.GEMINI_MODEL}`;
  const synthesisBase = (config.SYNTHESIS_BASE_URL ?? 'http://localhost:8083').replace(/\/+$/u, '');
  const coreBase = config.CORE_BASE_URL ?? 'http://localhost:8082';
  const now = options.now ?? Date.now;
  const limiter = new RateLimiter(config.rateLimitPerMinute, now);
  const activityStore = options.activityStore ?? buildActivityStore(config.VAULT_BACKEND);
  const statusCache = new StatusCache(activityStore, 5_000, now);

  const app = express();
  app.use(express.json({ limit: config.maxBodyBytes }));

  // Correlation must be installed before anything that logs, so every line in a
  // request — including a failure in a later middleware — carries the same ids.
  //
  // The id is minted here and never read from the inbound header: it is the
  // vault key, and a caller who could choose it could name another request's
  // mapping. The header is still echoed so a client can correlate.
  app.use((req, res, next) => {
    const requestId = uuidv7(now());
    res.setHeader('X-Request-ID', requestId);
    (req as CorrelatedRequest).pgw = {
      requestId,
      logger: logger.child({ request_id: requestId }),
    };
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', agent: 'gateway' });
  });

  app.post('/v1/ask', route(handleAsk));

  // Public, unauthenticated and deliberately cheap: it reads a cached timestamp
  // and never touches Gemma, so a page that polls it cannot wake a GPU. See
  // `status.ts`.
  app.get('/v1/status', route(handleStatus));

  app.post('/v1/warmup', route(handleWarmup));

  // The OpenAI-compatible façade. Same gates, same vault discipline; only the
  // request and response shapes differ. See `openai_compat.ts` for the mapping.
  app.get('/v1/models', (req, res) => {
    handleModels(req, res, now);
  });

  app.post('/v1/chat/completions', route(handleChatCompletions));

  // The Responses API surface. Codex CLI >= 0.149 dropped chat/completions for
  // custom providers, so a `wire_api = "responses"` client reaches only this.
  // Same gates, same vault discipline; see `responses_compat.ts`.
  app.post('/v1/responses', route(handleResponses));

  app.get('/v1/requests/:id', route(handleEvidence));

  app.get(
    '/v1/requests/:id/masked-prompt.md',
    route((req, res, next) => handleArtifact(req, res, next, 'masked-prompt.md')),
  );

  app.get(
    '/v1/requests/:id/core-response.md',
    route((req, res, next) => handleArtifact(req, res, next, 'core-response.md')),
  );

  // The audit view exists only when a token is configured. Registering the
  // routes conditionally — rather than registering them and checking inside —
  // is what makes the feature-off 404 the literal truth rather than a
  // hand-written status: there is no route to reach.
  if (config.ADMIN_TOKEN !== undefined) {
    const adminToken = config.ADMIN_TOKEN;
    const auditStore = options.auditStore ?? buildAuditStore(config.VAULT_BACKEND);

    /**
     * True when the caller presented the configured token.
     *
     * A failure answers 404 with no body detail and logs `audit.denied` without
     * the presented value: a rejected token is exactly the kind of string that
     * must not reach a log line, and the allowlist would drop it anyway.
     */
    const authorized = (req: Request, res: Response, context: RequestContext): boolean => {
      const presented = presentedToken(req.headers['x-admin-token']);
      if (presented !== null && tokenMatches(presented, adminToken)) return true;

      context.logger.event('audit.denied', {}, 'WARNING');
      res.status(404).json({ error: 'not_found', request_id: context.requestId });
      return false;
    };

    app.get('/v1/audit', route(handleAuditList));

    /** Newest-first evidence metadata. Never any document bodies. */
    async function handleAuditList(req: Request, res: Response, next: NextFunction): Promise<void> {
      const context = contextOf(req);
      if (context === undefined) return next();
      // Same counter as `/v1/ask`: a Firestore listing is cheap next to three
      // model calls, but an unthrottled public path is still a way to spend.
      if (rateLimited(req, res, context)) return;
      if (!authorized(req, res, context)) return;

      try {
        const entries = await auditStore.list(AUDIT_LIST_LIMIT);
        context.logger.event('audit.list', { entry_count: entries.length });
        res.json({ entries, limit: AUDIT_LIST_LIMIT });
      } catch (error) {
        next(error);
      }
    }

    mountAuditPage(app, config);
  }

  mountWebUi(app, config);

  /** Calls Core over the standard A2A protocol, propagating the correlation ids. */
  async function callCore(
    maskedPrompt: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (options.callCore !== undefined) {
      return options.callCore(maskedPrompt, requestId, signal);
    }
    const reply = await sendMessage(coreBase, maskedPrompt, {
      requestId,
      contextId: requestId,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl,
      ...(signal === undefined ? {} : { signal }),
    });
    return reply.text;
  }

  /** Calls Synthesis over HTTP: the deterministic path (see the module docstring). */
  async function callSynthesis(
    input: SynthesisInput,
    signal?: AbortSignal,
  ): Promise<SynthesizeResponse> {
    if (options.callSynthesis !== undefined) return options.callSynthesis(input, signal);

    const response = await authorizedFetch(`${synthesisBase}/v1/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      requestId: input.requestId,
      fetchImpl,
      ...(signal === undefined ? {} : { signal }),
      body: JSON.stringify({
        request_id: input.requestId,
        masked_prompt: input.maskedPrompt,
        core_answer: input.coreAnswer,
        generated_by: input.generatedBy,
        known_tokens: [...input.knownTokens],
        vault_generation: input.vaultGeneration,
        rehydrate_allow: [...input.rehydrateAllow],
        // Sent only on this hop, which is Gateway → Synthesis: both ends are
        // inside the boundary and this body never reaches Core.
        ...(input.maskTerms.length > 0 ? { mask_terms: [...input.maskTerms] } : {}),
      }),
    });

    if (!response.ok) {
      // A refusal is Synthesis doing its job, not a downstream fault: its status
      // and category list are passed through so the caller sees why.
      const refusal = await readRefusal(response);
      if (refusal !== null) throw refusal;
      throw new DownstreamError(`synthesis returned status ${response.status}`, response.status);
    }
    return SynthesizeResponseSchema.parse(await response.json());
  }

  /**
   * True when this caller is over quota, having already been answered 429.
   *
   * Shared by both entry points: the OpenAI façade runs the same fleet and costs
   * the same three model calls, so exempting it would just make the rate limit a
   * suggestion.
   */
  function rateLimited(req: Request, res: Response, context: RequestContext): boolean {
    const callerKey = req.ip ?? 'unknown';
    if (!limiter.exceeded(callerKey)) return false;

    context.logger.event('request.rate_limited', {}, 'WARNING');
    res.status(429).json({
      error: 'rate_limited',
      message: 'too many requests; this demo gateway allows a limited rate per client',
      request_id: context.requestId,
    });
    return true;
  }

  /**
   * Run one request through the pipeline under the shared deadline.
   *
   * Extracted so `/v1/ask` and `/v1/chat/completions` cannot drift apart: every
   * gate, the cancellation semantics and the span structure are defined once, and
   * only the response shaping differs between the two callers.
   */
  async function runAsk(
    req: Request,
    context: RequestContext,
    text: string,
    /** The request's disclosure opt-in, already validated by the caller's schema. */
    rehydrateAllow: readonly string[],
    /** The request's verbatim-mask terms, already validated by the caller's schema. */
    maskTerms: readonly string[],
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<AskResult> {
    const parentContext = contextFromHeaders(req.headers as Record<string, string | undefined>);
    // The allowlist types `path` as an enum, so it is matched against the known
    // routes rather than interpolated from whatever the caller requested.
    const COMPAT_ROUTES = ['/v1/chat/completions', '/v1/responses'];
    const routePath = COMPAT_ROUTES.includes(req.path) ? req.path : '/v1/ask';

    // One deadline for the whole chain, expressed as a real cancellation.
    //
    // `Promise.race` alone only stopped waiting: the Core, Synthesis and Gemma
    // calls kept running, kept spending model budget and kept persisting
    // evidence after the caller had already been answered 504. The controller
    // below is passed down every hop, so the timeout aborts the work as well as
    // the wait.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.deadlineMs ?? config.requestDeadlineMs);
    timer.unref?.();

    const deadline = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(new DeadlineExceededError());
        },
        { once: true },
      );
    });

    try {
      return await Promise.race([
        withContext(parentContext, () =>
          withSpan(
            SPAN.request,
            { request_id: context.requestId, method: 'POST', path: routePath },
            async () => {
              const startedAt = Date.now();
              const scoped = context.logger;
              scoped.event('request.start', { method: 'POST', path: routePath });

              const outcome = await ask({
                text,
                requestId: context.requestId,
                rehydrateAllow,
                maskTerms,
                vault,
                signal: controller.signal,
                callCore: (maskedPrompt, signal) =>
                  callCore(maskedPrompt, context.requestId, signal),
                callSynthesis: (input, signal) =>
                  callSynthesis({ ...input, requestId: context.requestId }, signal),
                coreActor,
                extractSpans:
                  options.extractSpans ??
                  (async (spanText, spanSignal) => {
                    const spans = await extractUnstructured(spanText, {
                      logger: scoped,
                      model: config.GEMMA_MODEL,
                      baseUrl: config.GEMMA_BASE_URL,
                      apiKey: config.GEMMA_API_KEY,
                      // The deadline controller reaches the extractor, so once the
                      // request is answered 504 no further chunk is dequeued.
                      ...(spanSignal === undefined ? {} : { signal: spanSignal }),
                      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
                    });
                    // Stamped only on success, and only after the call returned:
                    // a failed extraction proves nothing about whether Gemma is
                    // resident, and recording it would produce a `warm` badge
                    // for a service that is refusing every request.
                    recordGemmaActivity(activityStore);
                    return spans;
                  }),
                logger: scoped,
                ...(onProgress !== undefined ? { onProgress } : {}),
              });

              scoped.event('request.end', {
                duration_ms: Date.now() - startedAt,
                document_status: outcome.status,
                trust_tier: outcome.trustTier,
              });
              return outcome;
            },
          ),
        ),
        deadline,
      ]);
    } finally {
      // Releases the timer and, on the success path, cancels anything still in
      // flight behind the response that was already sent.
      clearTimeout(timer);
      controller.abort();
    }
  }

  /**
   * The OpenAI-compatible completion endpoint.
   *
   * A refusal is reported as an OpenAI error object carrying the same status the
   * native endpoint would use, so a stock client sees a real failure rather than
   * a completion whose content happens to be an apology.
   */
  async function handleChatCompletions(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();
    if (rateLimited(req, res, context)) return;

    const parsed = parseChatRequest(req.body, context.requestId);
    if (!parsed.ok) {
      context.logger.event(
        'openai.compat.chat.rejected',
        { error_code: parsed.body.error.code ?? 'invalid_request' },
        'WARNING',
      );
      res.status(parsed.status).json(parsed.body);
      return;
    }

    logChatStart(context.logger, parsed.stream);

    try {
      const result = await runAsk(
        req,
        context,
        parsed.text,
        parsed.rehydrateAllow,
        parsed.maskTerms,
      );
      const completion = toChatCompletion(result, now(), parsed.rehydrateAllow);

      context.logger.event('openai.compat.chat.end', {
        document_status: result.status,
        trust_tier: result.trustTier,
      });

      if (parsed.stream) {
        writeSseCompletion(res, completion);
        return;
      }
      res.json(completion);
    } catch (error) {
      handleChatError(error, res, context);
    }
  }

  /**
   * Map a pipeline failure onto an OpenAI error object.
   *
   * The status and category list come from the same classification `/v1/ask`
   * uses — `handleAskError` writes the native body, this writes the OpenAI one —
   * so the two endpoints can never disagree about whether something was refused.
   */
  function handleChatError(error: unknown, res: Response, context: RequestContext): void {
    const classified = classifyAskError(error);
    context.logger.event(
      'openai.compat.chat.refused',
      {
        error_code: classified.code,
        ...(classified.categories.length > 0 ? { categories: [...classified.categories] } : {}),
      },
      'ERROR',
    );
    res
      .status(classified.status)
      .json(
        toOpenAiError(
          classified.status,
          classified.code,
          classified.message,
          context.requestId,
          classified.categories,
        ),
      );
  }

  /**
   * The OpenAI **Responses API** endpoint.
   *
   * The second rendering of the same pipeline, for clients that speak only this
   * wire — Codex CLI >= 0.149 among them. A refusal is reported as a Responses
   * error, or as a terminal `response.failed` event once the stream has already
   * been committed to a 200, so a gate that refuses never surfaces as a success.
   */
  async function handleResponses(req: Request, res: Response, next: NextFunction): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();
    if (rateLimited(req, res, context)) return;

    const parsed = parseResponsesRequest(req.body, context.requestId);
    if (!parsed.ok) {
      context.logger.event(
        'openai.compat.responses.rejected',
        { error_code: parsed.body.error.code ?? 'invalid_request' },
        'WARNING',
      );
      res.status(parsed.status).json(parsed.body);
      return;
    }

    logResponsesStart(context.logger, parsed.stream, {
      forwardedTextBytes: Buffer.byteLength(parsed.text, 'utf8'),
      // Re-serialized rather than read from a header: `content-length` is absent
      // on a chunked upload, and this is a diagnostic size, not an accounting.
      rawBodyBytes: Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8'),
    });

    try {
      const result = await runAsk(
        req,
        context,
        parsed.text,
        parsed.rehydrateAllow,
        parsed.maskTerms,
      );
      const response = toResponsesObject(result, now(), parsed.rehydrateAllow);

      context.logger.event('openai.compat.responses.end', {
        document_status: result.status,
        trust_tier: result.trustTier,
      });

      if (parsed.stream) {
        writeResponsesSse(res, response);
        return;
      }
      res.json(response);
    } catch (error) {
      handleResponsesError(error, res, context, parsed.stream);
    }
  }

  /**
   * Map a pipeline failure onto a Responses error.
   *
   * Uses the same `classifyAskError` the native and chat endpoints use, so the
   * three surfaces can never disagree about whether something was refused. A
   * streaming caller gets `response.failed` rather than a status, because the
   * 200 and its headers are already on the wire by the time a gate refuses —
   * and Codex maps that event to an error, not to a turn.
   */
  function handleResponsesError(
    error: unknown,
    res: Response,
    context: RequestContext,
    stream: boolean,
  ): void {
    const classified = classifyAskError(error);
    context.logger.event(
      'openai.compat.responses.refused',
      {
        error_code: classified.code,
        ...(classified.categories.length > 0 ? { categories: [...classified.categories] } : {}),
      },
      'ERROR',
    );

    const body = responsesError(
      classified.status,
      classified.code,
      classified.message,
      context.requestId,
      classified.categories,
    );

    if (stream) {
      writeResponsesSseError(res, body, context.requestId, now());
      return;
    }
    res.status(classified.status).json(body);
  }

  /**
   * Report whether Gemma is expected to be resident.
   *
   * Never 500s and never fails closed: a status endpoint is wanted most when the
   * fleet is unhealthy, and `unknown` is a truthful answer that `StatusCache`
   * already produces for an unreachable store. The short cache header lets a
   * browser and any intermediary collapse a burst of polls.
   */
  async function handleStatus(_req: Request, res: Response): Promise<void> {
    const status = await statusCache.read();
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.status(200).json(status);
  }

  /**
   * Start the GPU on request.
   *
   * Answers immediately rather than waiting for the wake to land: a cold start
   * outlives any reasonable HTTP timeout, so `{started: true}` reports that the
   * request was dispatched, not that Gemma is ready. The client re-polls
   * `/v1/status` to find out.
   *
   * Rate-limited on the same counter as `/v1/ask`, because this is the one
   * endpoint that can spend GPU money without producing an answer — an
   * unthrottled public button that starts an L4 is a billing incident.
   */
  async function handleWarmup(req: Request, res: Response): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) {
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    if (rateLimited(req, res, context)) return;

    context.logger.event('warmup.requested', {});

    const injected = options.wakeGemmaImpl;
    const wake =
      injected !== undefined
        ? // An injected wake never reaches Gemma, so it cannot stamp the clock
          // itself; stamping here keeps `/v1/status` describing the same fleet a
          // test is driving.
          async (): Promise<boolean> => {
            recordWarmupRequest(activityStore);
            return await injected();
          }
        : () =>
            wakeGemma({
              baseUrl: config.GEMMA_BASE_URL,
              apiKey: config.GEMMA_API_KEY,
              activityStore,
              ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
            });

    // Deliberately not awaited. The instance keeps booting after this promise
    // settles either way, and holding the response open for two minutes would
    // trip every proxy between here and the browser.
    void wake().catch(() => {
      // A failed probe is the expected outcome against a cold instance; the
      // container is starting regardless, which is the point of the call.
    });

    // The next poll should reach the store rather than a verdict computed before
    // the wake was dispatched.
    statusCache.invalidate();
    res.status(202).json({ started: true });
  }

  async function handleAsk(req: Request, res: Response, next: NextFunction): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();

    if (rateLimited(req, res, context)) return;

    const parsed = AskRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // `strict()` on the schema is what turns a leftover `session_id` into this
      // 400 rather than a silently ignored field.
      res.status(400).json({
        error: 'invalid_request',
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
        request_id: context.requestId,
      });
      return;
    }

    // Content negotiation, not a body flag: asking for a different *media type*
    // of the same resource is what `Accept` is for, and keeping it out of the
    // body means `AskRequestSchema` stays strict and a client that cannot stream
    // is unaffected.
    const wantsStream = /text\/event-stream/u.test(req.headers.accept ?? '');
    const rehydrateAllow = parsed.data.rehydrate_allow ?? [];
    const maskTerms = parsed.data.mask_terms ?? [];
    if (wantsStream) {
      await handleAskStream(req, res, context, parsed.data.text, rehydrateAllow, maskTerms);
      return;
    }

    try {
      res.json(toPayload(await runAsk(req, context, parsed.data.text, rehydrateAllow, maskTerms)));
    } catch (error) {
      handleAskError(error, res, context);
    }
  }

  /**
   * `/v1/ask` as a progress stream.
   *
   * Same pipeline, same gates, same deadline — the only difference is that the
   * stage transitions reach the client as they happen instead of being
   * discarded. The terminal frame carries exactly the body the JSON path would
   * have sent, so a streaming client and a non-streaming one end up with
   * identical facts.
   *
   * Why the status code is always 200: the headers are flushed with the first
   * progress frame, long before the pipeline knows whether it will refuse. A
   * refusal therefore arrives as an `event: refused` frame carrying the status
   * it *would* have had, and clients are told to read that rather than the HTTP
   * code. Buffering the whole response to preserve the status would defeat the
   * purpose of streaming at all.
   */
  async function handleAskStream(
    req: Request,
    res: Response,
    context: RequestContext,
    text: string,
    rehydrateAllow: readonly string[],
    maskTerms: readonly string[],
  ): Promise<void> {
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    // Cloud Run and any nginx in between will otherwise hold the whole stream
    // until it closes, which would deliver every progress frame at once.
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, payload: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const result = await runAsk(req, context, text, rehydrateAllow, maskTerms, (progress) => {
        send('progress', progress);
      });
      send('result', toPayload(result));
    } catch (error) {
      const classified = classifyAskError(error);

      context.logger.event(
        classified.event,
        {
          ...(classified.refusal !== undefined ? { refusal: classified.refusal } : {}),
          ...(classified.errorCode !== undefined ? { error_code: classified.errorCode } : {}),
          ...(classified.errorClass !== undefined ? { error_class: classified.errorClass } : {}),
          ...(classified.categories.length > 0 ? { categories: [...classified.categories] } : {}),
        },
        classified.severity,
      );

      // The same body the JSON path sends, plus the status it would have used —
      // the HTTP code is already committed to 200 by the time this is known.
      send('refused', {
        error: classified.code,
        ...(classified.exposeMessage ? { message: classified.message } : {}),
        ...(classified.categories.length > 0 ? { categories: [...classified.categories] } : {}),
        request_id: context.requestId,
        status: classified.status,
      });
    } finally {
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  }

  /**
   * Map a failure onto a status.
   *
   * Every branch is a refusal to release something, so none of them carries the
   * Core body, a mapping value, or an exception message. The category list is the
   * most detail a caller gets.
   */
  function handleAskError(error: unknown, res: Response, context: RequestContext): void {
    const classified = classifyAskError(error);

    context.logger.event(
      classified.event,
      {
        ...(classified.refusal !== undefined ? { refusal: classified.refusal } : {}),
        ...(classified.errorCode !== undefined ? { error_code: classified.errorCode } : {}),
        ...(classified.errorClass !== undefined ? { error_class: classified.errorClass } : {}),
        ...(classified.categories.length > 0 ? { categories: [...classified.categories] } : {}),
      },
      classified.severity,
    );

    res.status(classified.status).json({
      error: classified.code,
      // The opaque 5xx branches carry no message: an exception message can embed
      // the value that caused it.
      ...(classified.exposeMessage ? { message: classified.message } : {}),
      ...(classified.categories.length > 0 ? { categories: [...classified.categories] } : {}),
      request_id: context.requestId,
    });
  }

  /** Proxies one masked artifact from the Synthesis store. */
  async function fetchFromSynthesis(url: string, requestId: string): Promise<string | null> {
    const response = await authorizedFetch(url, { requestId, fetchImpl });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new DownstreamError(`synthesis returned status ${response.status}`, response.status);
    }
    return response.text();
  }

  /** Returns the masked OKF evidence document for one request. */
  async function handleEvidence(req: Request, res: Response, next: NextFunction): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();

    try {
      const markdown = await fetchFromSynthesis(
        `${synthesisBase}/v1/requests/${encodeURIComponent(requestParam(req))}/evidence`,
        context.requestId,
      );
      if (markdown === null) {
        res.status(404).json({ error: 'unknown_request', request_id: context.requestId });
        return;
      }
      res.type('text/markdown; charset=utf-8').send(markdown);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Serves the two masked sources the OKF document names.
   *
   * Without these routes the `sources[]` entries would be dangling links and the
   * `attestation` digests could not be re-derived by a reader.
   */
  async function handleArtifact(
    req: Request,
    res: Response,
    next: NextFunction,
    artifact: 'masked-prompt.md' | 'core-response.md',
  ): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();

    try {
      const body = await fetchFromSynthesis(
        `${synthesisBase}/v1/requests/${encodeURIComponent(requestParam(req))}/${artifact}`,
        context.requestId,
      );
      if (body === null) {
        res.status(404).json({ error: 'unknown_request', request_id: context.requestId });
        return;
      }
      res.type('text/markdown; charset=utf-8').send(body);
    } catch (error) {
      next(error);
    }
  }

  // Terminal error handler: an unhandled route failure still answers with the
  // request id, so a user report is enough to find the logs. The body carries no
  // message: an exception message can embed the value that caused it.
  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    const context = contextOf(req);
    // body-parser attaches its own status (413 for an oversized body, 400 for
    // malformed JSON). Honouring it keeps a client-side mistake from being
    // reported as a server fault.
    const parserStatus = (error as { status?: unknown }).status;
    const status =
      typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500
        ? parserStatus
        : error instanceof DownstreamError
          ? 502
          : 500;
    context?.logger.event(
      'request.failed',
      { error_class: error.name, error_code: error.name },
      'ERROR',
    );
    res.status(status).json({
      error:
        status === 413
          ? 'payload_too_large'
          : status < 500
            ? 'invalid_request'
            : status === 502
              ? 'downstream_agent_failed'
              : 'internal_error',
      request_id: context?.requestId,
    });
  });

  return app;
}

/**
 * One pipeline failure, classified once for both response shapes.
 *
 * `/v1/ask` renders this as the native error body and `/v1/chat/completions` as
 * an OpenAI error object. Keeping the classification in one place is what stops
 * the two endpoints from disagreeing about whether something was refused, and
 * with which status — a compat endpoint that answered 200 where the native one
 * answered 422 would be a way to launder a refusal into a completion.
 */
interface ClassifiedAskError {
  readonly status: number;
  /** The `error` field of the native body, and the OpenAI `code`. */
  readonly code: string;
  readonly message: string;
  /** False for the opaque 5xx branches, whose messages are never released. */
  readonly exposeMessage: boolean;
  readonly categories: readonly string[];
  readonly event: string;
  readonly severity: 'WARNING' | 'ERROR';
  readonly refusal?: string;
  readonly errorCode?: string;
  readonly errorClass?: string;
}

/**
 * Map a failure onto a status.
 *
 * Every branch is a refusal to release something, so none of them carries the
 * Core body, a mapping value, or an exception message. The category list is the
 * most detail a caller gets.
 */
function classifyAskError(error: unknown): ClassifiedAskError {
  if (error instanceof ReservedSyntaxError) {
    return {
      status: 400,
      code: 'reserved_syntax',
      message: error.message,
      exposeMessage: true,
      categories: [],
      event: 'request.refused',
      severity: 'WARNING',
      refusal: 'reserved_syntax',
    };
  }

  if (error instanceof PiiLeakError) {
    // Raw PII was about to cross the boundary. Stop with a 422 instead of sending.
    return {
      status: 422,
      code: 'outbound_guard_refused',
      message: error.message,
      exposeMessage: true,
      categories: [...error.categories],
      event: 'request.refused',
      severity: 'ERROR',
      refusal: 'egress_guard',
    };
  }

  if (error instanceof ExtractionFailedError) {
    // The regexes cannot see names or addresses, so an unusable extractor means
    // the request's unstructured PII is unknown. Nothing was sent to Core.
    return {
      status: 502,
      code: 'extraction_unavailable',
      message: 'unstructured PII extraction is unavailable, so the request was not forwarded',
      exposeMessage: true,
      categories: [],
      event: 'request.refused',
      severity: 'ERROR',
      refusal: 'extraction_failed',
    };
  }

  if (error instanceof SynthesisRefusedError) {
    return {
      status: error.status,
      code: error.kind,
      message: error.message,
      exposeMessage: true,
      categories: [...error.categories],
      event: 'request.refused',
      severity: 'ERROR',
      refusal: error.kind,
    };
  }

  // A step that stopped because the deadline fired is the same fact as the
  // deadline itself; reporting it as an internal error would hide the cause.
  if (error instanceof DeadlineExceededError || error instanceof RequestAbortedError) {
    return {
      status: 504,
      code: 'deadline_exceeded',
      message: 'the request exceeded the gateway deadline',
      exposeMessage: true,
      categories: [],
      event: 'request.failed',
      severity: 'ERROR',
      errorCode: 'deadline_exceeded',
    };
  }

  // A missing ID token is a deployment/credential fault on *our* side of the
  // hop, not a caller error, and it is indistinguishable from a downstream
  // outage to the client — so it reports as 502 under its own event name.
  const isAuthFailure = error instanceof IdTokenError || error instanceof UnknownAudienceError;
  const status = isAuthFailure || error instanceof DownstreamError ? 502 : 500;
  return {
    status,
    code: status === 502 ? 'downstream_agent_failed' : 'internal_error',
    // Generic on purpose: this is the branch where the message could be an
    // arbitrary exception string, so the caller gets the code and nothing else.
    message:
      status === 502
        ? 'a downstream agent failed, so no answer was released'
        : 'the gateway failed to complete the request',
    exposeMessage: false,
    categories: [],
    event: isAuthFailure
      ? error instanceof UnknownAudienceError
        ? 'auth.audience.rejected'
        : 'auth.id_token.failed'
      : 'request.failed',
    severity: 'ERROR',
    errorCode: isAuthFailure
      ? error instanceof UnknownAudienceError
        ? 'audience_rejected'
        : 'id_token_unavailable'
      : status === 502
        ? 'downstream_error'
        : 'internal_error',
    errorClass: error instanceof Error ? error.name : 'unknown',
  };
}

/** A failure attributable to a downstream agent rather than to this one. */
export class DownstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DownstreamError';
    this.status = status;
  }
}

/** The whole gateway → core → synthesis chain ran past its deadline. */
export class DeadlineExceededError extends Error {
  constructor() {
    super('request deadline exceeded');
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Synthesis declined to release an answer.
 *
 * Distinguished from `DownstreamError` because it is not a fault: the fleet
 * worked exactly as designed, and the caller should see the same status and
 * category list Synthesis chose rather than a generic 502.
 */
export class SynthesisRefusedError extends Error {
  readonly kind: string;
  readonly status: number;
  readonly categories: readonly string[];

  constructor(kind: string, message: string, status: number, categories: readonly string[]) {
    super(message);
    this.name = 'SynthesisRefusedError';
    this.kind = kind;
    this.status = status;
    this.categories = categories;
  }
}

/**
 * Recognize a Synthesis refusal body, or return null for a genuine fault.
 *
 * Only the statuses the pipeline uses are accepted, so a stray 4xx from a proxy
 * cannot be replayed to the caller as if Synthesis had reasoned about it.
 */
async function readRefusal(response: globalThis.Response): Promise<SynthesisRefusedError | null> {
  // 500 is in this list for exactly one refusal: `rehydration_incomplete`, which
  // is Synthesis catching a fault in its *own* rehydration rather than declining
  // something about the request. It is still a refusal — nothing was released —
  // so it must reach the caller as the reason Synthesis chose, not as a generic
  // 502 that reads like Synthesis was unreachable. The body still has to parse
  // as a `ReleaseRefusal` below, so an ordinary 500 from an unhandled exception
  // (whose body is `{error: 'internal_error', message: ...}`, with no
  // `status_code` or `categories`) fails the schema and falls through to
  // `DownstreamError` as before.
  const isRefusalStatus = [409, 410, 422, 500].includes(response.status);
  if (!isRefusalStatus) return null;

  try {
    // Validated with the shared schema rather than a hand-written cast. The cast
    // it replaces was the one boundary in the fleet that did not use zod, and it
    // accepted whatever shape arrived — including a `categories` array of
    // arbitrary strings, which is the disclosure channel the closed enum closes.
    const parsed = ReleaseRefusalSchema.safeParse(await response.json());
    if (!parsed.success) return null;

    return new SynthesisRefusedError(
      parsed.data.error,
      parsed.data.message,
      response.status,
      parsed.data.categories,
    );
  } catch {
    return null;
  }
}

function toPayload(result: AskResult): AskResponse {
  return {
    request_id: result.requestId,
    ...(result.traceId !== undefined ? { trace_id: result.traceId } : {}),
    masked_prompt: result.maskedPrompt,
    okf: result.okfMarkdown,
    answer: result.answer,
    trust_tier: result.trustTier,
    status: result.status,
    dimensions: result.dimensions,
    attestation: result.attestation,
    consistency: result.consistency,
    stats: result.stats,
  };
}

/**
 * Serve the audit page at a bare `/audit`.
 *
 * `audit.html` is already reachable through `express.static` when the build
 * exists; this only adds the extension-less path a person would type or paste.
 * The route is registered only when `ADMIN_TOKEN` is set, so a fleet with the
 * feature off answers 404 because the route genuinely does not exist.
 *
 * Why the page itself is not token-gated while `/v1/audit` is: the page is an
 * empty shell — a token field and an empty table — and gating it would make the
 * token unusable from a browser, since the holder would have to put it in a URL
 * before the page that stores it could ever run. Nothing is disclosed by
 * serving the shell; every byte of evidence comes from the gated endpoint.
 */
function mountAuditPage(app: express.Application, config: Config): void {
  const webDir = config.WEB_DIR ?? path.resolve(here, '../../../web/dist');
  const entry = path.join(webDir, 'audit.html');
  if (!existsSync(entry)) return;

  app.get('/audit', (_req, res) => {
    // Relative to an explicit root, for the same reason `/` is: with no root,
    // `send` refuses any absolute path containing a dot-segment.
    res.sendFile('audit.html', { root: webDir });
  });
}

/**
 * Serve the built web UI.
 *
 * Mounted only when the build output exists so the API can still start unbuilt,
 * which is the normal state during local development where Vite serves the UI.
 */
function mountWebUi(app: express.Application, config: Config): void {
  const webDir = config.WEB_DIR ?? path.resolve(here, '../../../web/dist');
  const entry = path.join(webDir, 'index.html');

  if (!existsSync(entry)) {
    app.get('/', (_req, res) => {
      res.status(503).json({
        error: 'web UI is not built',
        message: 'run `just web-build` (pnpm -r build) to produce web/dist',
      });
    });
    return;
  }

  app.use(express.static(webDir, { index: false }));
  app.get('/', (_req, res) => {
    // Sent relative to an explicit root, exactly as `express.static` above does
    // it. Why not `res.sendFile(absolutePath)`: with no root, `send` splits the
    // *entire* absolute path and refuses it if any segment starts with a dot —
    // so a checkout under a dot-directory (a git worktree beneath `.claude/`,
    // for one) served the assets but answered `/` with a 404 that looked like a
    // routing bug rather than a path policy.
    res.sendFile('index.html', { root: webDir });
  });
}

/** Entry point. */
export async function main(): Promise<void> {
  const config = loadConfig({ agent: 'gateway' });

  // Exactly the three services this agent talks to. Anything else is refused a
  // token rather than handed one: a mistyped base URL must not deliver this
  // fleet's service identity to an arbitrary host.
  setIdTokenAudienceAllowlist([
    config.CORE_BASE_URL,
    config.SYNTHESIS_BASE_URL,
    config.GEMMA_BASE_URL,
  ]);

  initTelemetry({
    agent: 'gateway',
    enabled: config.OTEL_ENABLED ?? false,
    project: config.GOOGLE_CLOUD_PROJECT,
  });

  const logger = createLogger({
    agent: 'gateway',
    level: config.LOG_LEVEL,
    project: config.GOOGLE_CLOUD_PROJECT,
  });

  const port = config.PORT ?? DEFAULT_PORT;
  const app = createApp({ config, logger });

  app.listen(port, () => {
    // Endpoint URLs are deliberately absent: they are deployment topology, and
    // the allowlist has no field for a free-form URL.
    logger.event('server.start', {
      port,
      model: config.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
      vault_backend: config.VAULT_BACKEND,
      trace_id: currentTraceId(),
    });
  });

  return Promise.resolve();
}

// Only listen when this file is the process entry point, not when imported.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main();
}

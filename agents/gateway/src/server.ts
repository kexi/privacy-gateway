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
  buildVault,
  contextFromHeaders,
  createLogger,
  currentTraceId,
  DEFAULT_GEMINI_MODEL,
  initTelemetry,
  IdTokenError,
  loadConfig,
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
  type AskResponse,
  type Config,
  type Detection,
  type Logger,
  type SynthesizeResponse,
  type TokenVault,
} from '@privacy-gateway/common';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExtractionFailedError, extractUnstructured } from './agent.ts';
import { ask, RequestAbortedError, ReservedSyntaxError, type AskResult } from './pipeline.ts';

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

  app.post('/v1/ask', (req, res, next) => {
    void handleAsk(req, res, next);
  });

  app.get('/v1/requests/:id', (req, res, next) => {
    void handleEvidence(req, res, next);
  });

  app.get('/v1/requests/:id/masked-prompt.md', (req, res, next) => {
    void handleArtifact(req, res, next, 'masked-prompt.md');
  });

  app.get('/v1/requests/:id/core-response.md', (req, res, next) => {
    void handleArtifact(req, res, next, 'core-response.md');
  });

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

  async function handleAsk(req: Request, res: Response, next: NextFunction): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();

    const callerKey = req.ip ?? 'unknown';
    if (limiter.exceeded(callerKey)) {
      context.logger.event('request.rate_limited', {}, 'WARNING');
      res.status(429).json({
        error: 'rate_limited',
        message: 'too many requests; this demo gateway allows a limited rate per client',
        request_id: context.requestId,
      });
      return;
    }

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

    const parentContext = contextFromHeaders(req.headers as Record<string, string | undefined>);

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
      const result = await Promise.race([
        withContext(parentContext, () =>
          withSpan(
            SPAN.request,
            { request_id: context.requestId, method: 'POST', path: '/v1/ask' },
            async () => {
              const startedAt = Date.now();
              const scoped = context.logger;
              scoped.event('request.start', { method: 'POST', path: '/v1/ask' });

              const outcome = await ask({
                text: parsed.data.text,
                requestId: context.requestId,
                vault,
                signal: controller.signal,
                callCore: (maskedPrompt, signal) =>
                  callCore(maskedPrompt, context.requestId, signal),
                callSynthesis: (input, signal) =>
                  callSynthesis({ ...input, requestId: context.requestId }, signal),
                coreActor,
                extractSpans:
                  options.extractSpans ??
                  ((text) =>
                    extractUnstructured(text, {
                      logger: scoped,
                      model: config.GEMMA_MODEL,
                      baseUrl: config.GEMMA_BASE_URL,
                      apiKey: config.GEMMA_API_KEY,
                      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
                    })),
                logger: scoped,
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

      res.json(toPayload(result));
    } catch (error) {
      handleAskError(error, res, context);
    } finally {
      // Releases the timer and, on the success path, cancels anything still in
      // flight behind the response that was already sent.
      clearTimeout(timer);
      controller.abort();
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
    if (error instanceof ReservedSyntaxError) {
      context.logger.event('request.refused', { refusal: 'reserved_syntax' }, 'WARNING');
      res.status(400).json({
        error: 'reserved_syntax',
        message: error.message,
        request_id: context.requestId,
      });
      return;
    }

    if (error instanceof PiiLeakError) {
      // Raw PII was about to cross the boundary. Stop with a 422 instead of sending.
      context.logger.event(
        'request.refused',
        { refusal: 'egress_guard', categories: [...error.categories] },
        'ERROR',
      );
      res.status(422).json({
        error: 'outbound_guard_refused',
        message: error.message,
        categories: [...error.categories],
        request_id: context.requestId,
      });
      return;
    }

    if (error instanceof ExtractionFailedError) {
      // The regexes cannot see names or addresses, so an unusable extractor means
      // the request's unstructured PII is unknown. Nothing was sent to Core.
      context.logger.event('request.refused', { refusal: 'extraction_failed' }, 'ERROR');
      res.status(502).json({
        error: 'extraction_unavailable',
        message: 'unstructured PII extraction is unavailable, so the request was not forwarded',
        request_id: context.requestId,
      });
      return;
    }

    if (error instanceof SynthesisRefusedError) {
      context.logger.event(
        'request.refused',
        { refusal: error.kind, categories: [...error.categories] },
        'ERROR',
      );
      res.status(error.status).json({
        error: error.kind,
        message: error.message,
        categories: [...error.categories],
        request_id: context.requestId,
      });
      return;
    }

    // A step that stopped because the deadline fired is the same fact as the
    // deadline itself; reporting it as an internal error would hide the cause.
    if (error instanceof DeadlineExceededError || error instanceof RequestAbortedError) {
      context.logger.event('request.failed', { error_code: 'deadline_exceeded' }, 'ERROR');
      res.status(504).json({
        error: 'deadline_exceeded',
        message: 'the request exceeded the gateway deadline',
        request_id: context.requestId,
      });
      return;
    }

    // A missing ID token is a deployment/credential fault on *our* side of the
    // hop, not a caller error, and it is indistinguishable from a downstream
    // outage to the client — so it reports as 502 under its own event name.
    const isAuthFailure = error instanceof IdTokenError || error instanceof UnknownAudienceError;
    const status = isAuthFailure || error instanceof DownstreamError ? 502 : 500;
    context.logger.event(
      isAuthFailure
        ? error instanceof UnknownAudienceError
          ? 'auth.audience.rejected'
          : 'auth.id_token.failed'
        : 'request.failed',
      {
        error_class: error instanceof Error ? error.name : 'unknown',
        error_code: isAuthFailure
          ? error instanceof UnknownAudienceError
            ? 'audience_rejected'
            : 'id_token_unavailable'
          : status === 502
            ? 'downstream_error'
            : 'internal_error',
      },
      'ERROR',
    );
    res.status(status).json({
      error: status === 502 ? 'downstream_agent_failed' : 'internal_error',
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
  const isRefusalStatus = [409, 410, 422].includes(response.status);
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
    res.sendFile(entry);
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

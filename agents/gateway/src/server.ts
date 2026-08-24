/**
 * The Gateway HTTP app: the single entry point as far as the user is concerned.
 *
 * Core is reached over A2A. Synthesis is reached over plain HTTP even though it
 * also exposes an A2A surface, because the OKF document is an audit artifact and
 * must be retrieved without an LLM rephrasing it anywhere along the way.
 */

import {
  AskRequestSchema,
  ApproveRequestSchema,
  buildVault,
  contextFromHeaders,
  createLogger,
  currentTraceId,
  DEFAULT_GEMINI_MODEL,
  initTelemetry,
  isStale,
  loadConfig,
  outboundTraceHeaders,
  parse as parseOkf,
  PiiLeakError,
  REQUEST_ID_HEADER,
  resolveRequestId,
  sendMessage,
  SPAN,
  SynthesizeResponseSchema,
  trustTier,
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
import { extractUnstructured } from './agent.ts';
import { ask, type AskResult } from './pipeline.ts';

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
function sessionParam(req: Request): string {
  return (req.params as Record<string, string | undefined>)['id'] ?? '';
}

export interface CreateAppOptions {
  readonly config: Config;
  readonly logger: Logger;
  /** Injected by tests so the whole route surface runs without a network. */
  readonly callCore?:
    | ((maskedPrompt: string, requestId: string, sessionId: string) => Promise<string>)
    | undefined;
  readonly callSynthesis?: ((input: SynthesisInput) => Promise<SynthesizeResponse>) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly extractSpans?: ((text: string) => Promise<Detection[]>) | undefined;
  readonly vault?: TokenVault | undefined;
}

interface SynthesisInput {
  readonly sessionId: string;
  readonly maskedPrompt: string;
  readonly coreAnswer: string;
  readonly generatedBy: string;
  readonly requestId: string;
}

/** Builds the Express app. Importing this module must not start a listener. */
export function createApp(options: CreateAppOptions): express.Application {
  const { config, logger } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const vault = options.vault ?? buildVault(config.VAULT_BACKEND);
  const coreActor = `core_agent/${config.GEMINI_MODEL}`;
  const synthesisBase = (config.SYNTHESIS_BASE_URL ?? 'http://localhost:8083').replace(/\/+$/u, '');
  const coreBase = config.CORE_BASE_URL ?? 'http://localhost:8082';

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Correlation must be installed before anything that logs, so every line in a
  // request — including a failure in a later middleware — carries the same ids.
  app.use((req, res, next) => {
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
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

  app.get('/v1/sessions/:id/answer', (req, res, next) => {
    void handleAnswer(req, res, next);
  });

  app.post('/v1/sessions/:id/approve', (req, res, next) => {
    void handleApprove(req, res, next);
  });

  app.get('/v1/sessions/:id/tier', (req, res, next) => {
    void handleTier(req, res, next);
  });

  mountWebUi(app, config);

  /** Calls Core over the standard A2A protocol, propagating the correlation ids. */
  async function callCore(
    maskedPrompt: string,
    requestId: string,
    sessionId: string,
  ): Promise<string> {
    if (options.callCore !== undefined) {
      return options.callCore(maskedPrompt, requestId, sessionId);
    }
    const reply = await sendMessage(coreBase, maskedPrompt, {
      requestId,
      contextId: sessionId,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl,
    });
    return reply.text;
  }

  /** Calls Synthesis over HTTP: the deterministic path (see the module docstring). */
  async function callSynthesis(input: SynthesisInput): Promise<SynthesizeResponse> {
    if (options.callSynthesis !== undefined) return options.callSynthesis(input);

    const response = await fetchImpl(`${synthesisBase}/v1/synthesize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [REQUEST_ID_HEADER]: input.requestId,
        ...outboundTraceHeaders(),
      },
      body: JSON.stringify({
        session_id: input.sessionId,
        masked_prompt: input.maskedPrompt,
        core_answer: input.coreAnswer,
        generated_by: input.generatedBy,
        request_id: input.requestId,
      }),
    });

    if (!response.ok) {
      throw new DownstreamError(`synthesis returned status ${response.status}`, response.status);
    }
    return SynthesizeResponseSchema.parse(await response.json());
  }

  async function handleAsk(req: Request, res: Response, next: NextFunction): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();

    const parsed = AskRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
        request_id: context.requestId,
      });
      return;
    }

    const sessionId = parsed.data.session_id ?? context.requestId;
    const parentContext = contextFromHeaders(req.headers as Record<string, string | undefined>);

    try {
      const result = await withContext(parentContext, () =>
        withSpan(
          SPAN.request,
          {
            request_id: context.requestId,
            session_id: sessionId,
            method: 'POST',
            path: '/v1/ask',
          },
          async () => {
            const startedAt = Date.now();
            const scoped = context.logger.child({ session_id: sessionId });
            scoped.event('request.start', { method: 'POST', path: '/v1/ask' });

            const outcome = await ask({
              text: parsed.data.text,
              sessionId,
              requestId: context.requestId,
              vault,
              callCore: (maskedPrompt) => callCore(maskedPrompt, context.requestId, sessionId),
              callSynthesis: (input) => callSynthesis({ ...input, requestId: context.requestId }),
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
              status: outcome.status,
              trust_tier: outcome.trustTier,
            });
            return outcome;
          },
        ),
      );

      res.json(toPayload(result));
    } catch (error) {
      handleAskError(error, res, context, sessionId);
    }
  }

  function handleAskError(
    error: unknown,
    res: Response,
    context: RequestContext,
    sessionId: string,
  ): void {
    if (error instanceof PiiLeakError) {
      // Raw PII was about to cross the boundary. Stop with a 422 instead of sending.
      context.logger.event(
        'request.refused',
        { session_id: sessionId, categories: [...error.categories] },
        'ERROR',
      );
      res.status(422).json({
        error: 'outbound guard refused the request',
        message: error.message,
        categories: [...error.categories],
        request_id: context.requestId,
      });
      return;
    }

    const status = error instanceof DownstreamError ? 502 : 500;
    context.logger.event(
      'request.failed',
      {
        session_id: sessionId,
        error_code: status === 502 ? 'downstream_error' : 'internal_error',
        error_message: error instanceof Error ? error.message : String(error),
      },
      'ERROR',
    );
    res.status(status).json({
      error: status === 502 ? 'downstream_agent_failed' : 'internal_error',
      message: error instanceof Error ? error.message : String(error),
      request_id: context.requestId,
    });
  }

  /** Fetches the stored OKF document from Synthesis. */
  async function fetchAnswer(sessionId: string, requestId: string): Promise<string | null> {
    const response = await fetchImpl(
      `${synthesisBase}/v1/sessions/${encodeURIComponent(sessionId)}/answer`,
      { headers: { [REQUEST_ID_HEADER]: requestId, ...outboundTraceHeaders() } },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new DownstreamError(`synthesis returned status ${response.status}`, response.status);
    }
    return response.text();
  }

  async function handleAnswer(req: Request, res: Response, next: NextFunction): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();

    try {
      const markdown = await fetchAnswer(sessionParam(req), context.requestId);
      if (markdown === null) {
        res.status(404).json({ error: 'unknown session', request_id: context.requestId });
        return;
      }
      res.type('text/markdown; charset=utf-8').send(markdown);
    } catch (error) {
      next(error);
    }
  }

  async function handleApprove(req: Request, res: Response, next: NextFunction): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();

    const parsed = ApproveRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', request_id: context.requestId });
      return;
    }

    try {
      const response = await fetchImpl(
        `${synthesisBase}/v1/sessions/${encodeURIComponent(sessionParam(req))}/approve`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [REQUEST_ID_HEADER]: context.requestId,
            ...outboundTraceHeaders(),
          },
          body: JSON.stringify(parsed.data),
        },
      );

      if (response.status === 404) {
        res.status(404).json({ error: 'unknown session', request_id: context.requestId });
        return;
      }
      if (!response.ok) {
        throw new DownstreamError(`synthesis returned status ${response.status}`, response.status);
      }

      const body = (await response.json()) as { trust_tier?: string };
      context.logger.event('approve.done', {
        session_id: sessionParam(req),
        trust_tier: body.trust_tier,
      });
      res.json({ ...body, request_id: context.requestId });
    } catch (error) {
      next(error);
    }
  }

  /** Derives the trust tier from the stored document; never stored (SPEC §5.3). */
  async function handleTier(req: Request, res: Response, next: NextFunction): Promise<void> {
    const context = contextOf(req);
    if (context === undefined) return next();

    try {
      const markdown = await fetchAnswer(sessionParam(req), context.requestId);
      if (markdown === null) {
        res.status(404).json({ error: 'unknown session', request_id: context.requestId });
        return;
      }
      const document = parseOkf(markdown);
      res.json({
        session_id: sessionParam(req),
        trust_tier: trustTier(document.metadata),
        status: (document.metadata['status'] as string | undefined) ?? 'stable',
        stale: isStale(document.metadata),
      });
    } catch (error) {
      next(error);
    }
  }

  // Terminal error handler: an unhandled route failure still answers with the
  // request id, so a user report is enough to find the logs.
  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    const context = contextOf(req);
    const status = error instanceof DownstreamError ? 502 : 500;
    context?.logger.event(
      'request.failed',
      { error_code: error.name, error_message: error.message },
      'ERROR',
    );
    res.status(status).json({
      error: status === 502 ? 'downstream_agent_failed' : 'internal_error',
      message: error.message,
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

function toPayload(result: AskResult): AskResponse {
  return {
    session_id: result.sessionId,
    request_id: result.requestId,
    ...(result.traceId !== undefined ? { trace_id: result.traceId } : {}),
    masked_prompt: result.maskedPrompt,
    okf: result.okfMarkdown,
    answer: result.answer,
    trust_tier: result.trustTier,
    status: result.status,
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
    logger.event('server.start', {
      port,
      model: config.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
      gemma_model: config.GEMMA_MODEL,
      vault_backend: config.VAULT_BACKEND,
      core_base_url: config.CORE_BASE_URL,
      synthesis_base_url: config.SYNTHESIS_BASE_URL,
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

/**
 * Expose the Synthesis Agent over A2A and over a small HTTP surface.
 *
 * Both exist deliberately. A2A makes the agent discoverable like every other
 * member of the fleet; the HTTP routes are the path the Gateway actually uses,
 * because there must always be one route that retrieves the audit artifact
 * without an LLM regenerating it.
 */

import { toA2a } from '@google/adk';
import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk';
import {
  addVerification,
  buildVault,
  contextFromHeaders,
  createLogger,
  currentTraceId,
  dump,
  initTelemetry,
  loadConfig,
  parse as parseOkf,
  REQUEST_ID_HEADER,
  resolveRequestId,
  SPAN,
  SynthesizeRequestSchema,
  trustTier,
  withContext,
  withSpan,
  type Config,
  type Logger,
  type SynthesizeResponse,
  type TokenVault,
} from '@privacy-gateway/common';
import express, { type NextFunction, type Request, type Response } from 'express';
import { pathToFileURL } from 'node:url';
import { buildSynthesisAgent, createLeakJudge, SYNTHESIS_AGENT_NAME } from './agent.ts';
import { actor, synthesize, type LeakJudge } from './pipeline.ts';
import { buildAnswerStore, type AnswerStore } from './store.ts';

/** Cloud Run injects PORT. Locally 8083 follows gateway (8081) and core (8082). */
const DEFAULT_PORT = 8083;

export interface CreateAppOptions {
  readonly config: Config;
  readonly logger: Logger;
  readonly vault?: TokenVault | undefined;
  readonly store?: AnswerStore | undefined;
  /** Injected by tests; omitted entirely when no Gemma endpoint is configured. */
  readonly judge?: LeakJudge | undefined;
  /** Mount the A2A surface. Off in tests, which exercise the HTTP routes. */
  readonly withA2a?: boolean | undefined;
}

/** Builds the Express app. Importing this module must not start a listener. */
export async function createApp(options: CreateAppOptions): Promise<express.Application> {
  const { config, logger } = options;
  const vault = options.vault ?? buildVault(config.VAULT_BACKEND);
  const store = options.store ?? buildAnswerStore(config.VAULT_BACKEND);
  const judge = options.judge;

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.use((req, res, next) => {
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    res.setHeader('X-Request-ID', requestId);
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', agent: 'synthesis' });
  });

  app.post('/v1/synthesize', (req, res, next) => {
    void handleSynthesize(req, res, next);
  });

  app.get('/v1/sessions/:id/answer', (req, res, next) => {
    void handleAnswer(req, res, next);
  });

  app.post('/v1/sessions/:id/approve', (req, res, next) => {
    void handleApprove(req, res, next);
  });

  async function handleSynthesize(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = SynthesizeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      });
      return;
    }

    const input = parsed.data;
    const requestId = resolveRequestId(input.request_id ?? req.headers[REQUEST_ID_HEADER]);
    const scoped = logger.child({ request_id: requestId, session_id: input.session_id });
    const parentContext = contextFromHeaders(req.headers as Record<string, string | undefined>);

    try {
      const result = await withContext(parentContext, () =>
        withSpan(
          'synthesize',
          { request_id: requestId, session_id: input.session_id },
          async () => {
            const startedAt = Date.now();
            scoped.event('request.start', { method: 'POST', path: '/v1/synthesize' });

            const outcome = await synthesize({
              sessionId: input.session_id,
              maskedPrompt: input.masked_prompt,
              coreAnswer: input.core_answer,
              vault,
              generatedBy: input.generated_by,
              logger: scoped,
              requestId,
              ...(judge !== undefined ? { judge } : {}),
              verifiedBy: actor(config.GEMMA_MODEL),
            });

            await withSpan(SPAN.persist, { session_id: input.session_id }, async () => {
              await store.put(input.session_id, outcome.markdown);
              scoped.event('okf.persist', {
                session_id: input.session_id,
                status: outcome.document.metadata['status'] as string,
              });
            });

            scoped.event('request.end', {
              duration_ms: Date.now() - startedAt,
              status: outcome.document.metadata['status'] as string,
              trust_tier: outcome.trustTier,
            });
            return outcome;
          },
        ),
      );

      const payload: SynthesizeResponse = {
        session_id: input.session_id,
        request_id: requestId,
        markdown: result.markdown,
        answer: result.answer,
        trust_tier: result.trustTier,
        status: (result.document.metadata['status'] as SynthesizeResponse['status']) ?? 'draft',
        attestation: result.attestation,
        consistency: result.consistency,
        receipt: result.receipt,
      };
      res.json(payload);
    } catch (error) {
      scoped.event(
        'request.failed',
        { error_message: error instanceof Error ? error.message : String(error) },
        'ERROR',
      );
      next(error);
    }
  }

  async function handleAnswer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const markdown = await store.get(sessionParam(req));
      if (markdown === null) {
        res.status(404).json({ error: 'unknown session' });
        return;
      }
      res.type('text/markdown; charset=utf-8').send(markdown);
    } catch (error) {
      next(error);
    }
  }

  /** Adds a human approval to `verified`, raising the tier to human-reviewed. */
  async function handleApprove(req: Request, res: Response, next: NextFunction): Promise<void> {
    const sessionId = sessionParam(req);
    try {
      const markdown = await store.get(sessionId);
      if (markdown === null) {
        res.status(404).json({ error: 'unknown session' });
        return;
      }

      const body = (req.body ?? {}) as { approver?: unknown };
      const approver =
        typeof body.approver === 'string' && body.approver.trim() !== ''
          ? body.approver.trim()
          : config.DEFAULT_APPROVER;
      // SPEC §7: a human actor is `human:<id>`; the prefix is what the trust-tier
      // derivation keys on, so it is normalized here rather than trusted.
      const actorId = approver.startsWith('human:') ? approver : `human:${approver}`;

      const document = addVerification(parseOkf(markdown), actorId);
      const updated = dump(document);
      await store.put(sessionId, updated);

      const tier = trustTier(document.metadata);
      logger.event('approve.done', { session_id: sessionId, trust_tier: tier });
      res.json({ session_id: sessionId, trust_tier: tier, markdown: updated });
    } catch (error) {
      next(error);
    }
  }

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.event(
      'request.failed',
      { error_code: error.name, error_message: error.message },
      'ERROR',
    );
    res.status(500).json({ error: 'internal_error', message: error.message });
  });

  if (options.withA2a === true) {
    await mountA2a(app, config);
  }
  return app;
}

/**
 * The `:id` path segment. Present by construction: the handler only runs when
 * its route matched.
 */
function sessionParam(req: Request): string {
  return (req.params as Record<string, string | undefined>)['id'] ?? '';
}

/**
 * The public Agent Card.
 *
 * Describes only what this agent does, never the instruction text: the card is
 * served unauthenticated.
 */
export function buildAgentCard(rpcBase: string): AgentCard {
  return {
    protocolVersion: '0.3.0',
    name: SYNTHESIS_AGENT_NAME,
    description:
      'Verifies a tokenized answer for leaks, rehydrates it from the token vault and ' +
      'packages it as an attested OKF v0.2 document.',
    version: '0.1.0',
    url: `${rpcBase}/jsonrpc`,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [
      { url: `${rpcBase}/jsonrpc`, transport: 'JSONRPC' },
      { url: `${rpcBase}/rest`, transport: 'HTTP+JSON' },
    ],
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'verify_and_rehydrate',
        name: 'Leak check, rehydration and attestation',
        description:
          'Runs a deterministic leak check over a tokenized answer, restores the original ' +
          'values from the token vault, and emits an OKF Gateway Answer carrying the verdict.',
        tags: ['privacy', 'attestation', 'okf'],
      },
    ],
  };
}

/** Mounts the ADK A2A surface alongside the HTTP routes. */
async function mountA2a(app: express.Application, config: Config): Promise<void> {
  const port = config.PORT ?? DEFAULT_PORT;
  const publicUrl = config.A2A_PUBLIC_URL;
  const urlParts = publicUrl
    ? new URL(publicUrl)
    : {
        protocol: `${config.A2A_PROTOCOL ?? 'http'}:`,
        hostname: config.A2A_HOST ?? 'localhost',
        port: String(port),
      };

  const scheme = urlParts.protocol.replace(':', '');
  const rpcPort = Number(urlParts.port !== '' ? urlParts.port : scheme === 'https' ? 443 : 80);
  const rpcBase =
    urlParts.port !== ''
      ? `${scheme}://${urlParts.hostname}:${urlParts.port}`
      : `${scheme}://${urlParts.hostname}`;

  await toA2a(buildSynthesisAgent(config.GEMMA_MODEL), {
    app,
    host: urlParts.hostname,
    port: rpcPort,
    protocol: scheme,
    agentCard: buildAgentCard(rpcBase),
    // Authentication is Cloud Run IAM (run.invoker plus an ID token) rather than
    // an in-process check, matching how Core is protected.
    allowUnauthenticated: true,
  });
}

/** Entry point. */
export async function main(): Promise<void> {
  const config = loadConfig({ agent: 'synthesis' });
  initTelemetry({
    agent: 'synthesis',
    enabled: config.OTEL_ENABLED ?? false,
    project: config.GOOGLE_CLOUD_PROJECT,
  });

  const logger = createLogger({
    agent: 'synthesis',
    level: config.LOG_LEVEL,
    project: config.GOOGLE_CLOUD_PROJECT,
  });

  const port = config.PORT ?? DEFAULT_PORT;
  const app = await createApp({
    config,
    logger,
    withA2a: true,
    judge: createLeakJudge({
      baseUrl: config.GEMMA_BASE_URL,
      model: config.GEMMA_MODEL,
      apiKey: config.GEMMA_API_KEY,
      logger,
    }),
  });

  app.listen(port, () => {
    logger.event('server.start', {
      port,
      gemma_model: config.GEMMA_MODEL,
      vault_backend: config.VAULT_BACKEND,
      answer_collection: config.ANSWER_COLLECTION,
      agent_card_path: `/${AGENT_CARD_PATH}`,
      trace_id: currentTraceId(),
    });
  });
}

// Only listen when this file is the process entry point, not when imported.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main();
}

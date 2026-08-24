/**
 * Expose the Synthesis Agent over A2A and over a small HTTP surface.
 *
 * Both exist deliberately. A2A makes the agent discoverable like every other
 * member of the fleet; the HTTP routes are the path the Gateway actually uses,
 * because there must always be one route that retrieves the audit artifact
 * without an LLM regenerating it.
 *
 * The routes are keyed by `request_id`, and the only artifacts they return are
 * masked. A rehydrated answer exists solely inside the `/v1/synthesize` response
 * that produced it.
 */

import { toA2a } from '@google/adk';
import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk';
import {
  ATTESTER_RESOURCE,
  attesterSha256,
  buildVault,
  COMPUTATION_RESOURCE,
  computationSha256,
  contextFromHeaders,
  createLogger,
  currentTraceId,
  initTelemetry,
  loadConfig,
  REQUEST_ID_HEADER,
  resolveRequestId,
  setIdTokenAudienceAllowlist,
  SPAN,
  SynthesizeRequestSchema,
  vaultTtlSeconds,
  WITHHELD_BODY_MARKER,
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
import {
  ReleaseRefusedError,
  synthesize,
  type LeakJudge,
  type RefusalWithEvidence,
  type SynthesisResult,
} from './pipeline.ts';
import { buildAnswerStore, type AnswerStore, type EvidenceRecord } from './store.ts';

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
  app.use(express.json({ limit: config.maxBodyBytes }));

  app.use((req, res, next) => {
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    res.setHeader('X-Request-ID', requestId);
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', agent: 'synthesis' });
  });

  /**
   * The attestation digests this build will record in every document.
   *
   * Exists so the digests can be checked without running a request: `just
   * image-test` starts the production image and reads this route, which is the
   * cheapest way to catch the packaging fault where `dist/`-only containers
   * emitted the literal string `unavailable` while still claiming machine
   * confirmation. It discloses nothing a served document does not already carry.
   */
  app.get('/v1/attestation', (_req, res) => {
    res.status(200).json({
      computation: COMPUTATION_RESOURCE,
      attester_resource: ATTESTER_RESOURCE,
      computation_sha256: computationSha256(),
      attester_sha256: attesterSha256(),
    });
  });

  app.post('/v1/synthesize', (req, res, next) => {
    void handleSynthesize(req, res, next);
  });

  app.get('/v1/requests/:id/evidence', (req, res, next) => {
    void handleEvidence(req, res, next);
  });

  app.get('/v1/requests/:id/masked-prompt.md', (req, res, next) => {
    void handleArtifact(req, res, next, 'maskedPrompt');
  });

  app.get('/v1/requests/:id/core-response.md', (req, res, next) => {
    void handleArtifact(req, res, next, 'coreResponse');
  });

  /**
   * Persist the masked evidence. Called on release and on refusal alike.
   *
   * `coreResponse` is deliberately not a parameter of the refusal path: a
   * refused body is the exact text a gate rejected, and the evidence routes are
   * unauthenticated, so a refusal stores the `content withheld` marker in its
   * place. What survives is the digest recorded in the document's `attestation`
   * block, which still binds the record to the exchange.
   *
   * `expiresAt` is the vault entry's own expiry, taken from the document's
   * `stale_after`, not `now + TTL`: computing a later expiry at persistence time
   * let the service serve a record past the freshness the document claims.
   */
  async function persist(
    requestId: string,
    result: SynthesisResult,
    maskedPrompt: string,
    coreResponse: string,
    scoped: Logger,
  ): Promise<void> {
    await withSpan(SPAN.persist, { request_id: requestId }, async () => {
      const record: EvidenceRecord = {
        requestId,
        okf: result.markdown,
        maskedPrompt,
        coreResponse,
        expiresAt: staleAfterOf(result),
      };
      await store.put(record);
      scoped.event('okf.persist', {
        document_status: result.dimensions.document_status,
        verdict: result.dimensions.policy_verdict,
      });
    });
  }

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
    const requestId = input.request_id;
    const scoped = logger.child({ request_id: requestId });
    const parentContext = contextFromHeaders(req.headers as Record<string, string | undefined>);

    try {
      const result = await withContext(parentContext, () =>
        withSpan('synthesize', { request_id: requestId }, async () => {
          const startedAt = Date.now();
          scoped.event('request.start', { method: 'POST', path: '/v1/synthesize' });

          const outcome = await synthesize({
            requestId,
            maskedPrompt: input.masked_prompt,
            coreAnswer: input.core_answer,
            knownTokens: input.known_tokens,
            vaultGeneration: input.vault_generation,
            vault,
            generatedBy: input.generated_by,
            logger: scoped,
            // Express aborts this when the client disconnects, which is what the
            // gateway's deadline does upstream. Without it a timed-out request
            // kept calling Gemma and writing evidence after the caller had gone.
            signal: abortSignalOf(req),
            ...(judge !== undefined ? { judge } : {}),
          });

          await persist(requestId, outcome, input.masked_prompt, input.core_answer, scoped);

          scoped.event('request.end', {
            duration_ms: Date.now() - startedAt,
            document_status: outcome.dimensions.document_status,
            trust_tier: outcome.trustTier,
          });
          return outcome;
        }),
      );

      const payload: SynthesizeResponse = {
        request_id: requestId,
        markdown: result.markdown,
        answer: result.answer,
        trust_tier: result.trustTier,
        status: result.dimensions.document_status,
        dimensions: result.dimensions,
        attestation: result.attestation,
        consistency: result.consistency,
        receipt: result.receipt,
      };
      res.json(payload);
    } catch (error) {
      await handleRefusal(error, res, requestId, input, scoped, next);
    }
  }

  /**
   * Turn a refused release into a status and an audit record.
   *
   * The evidence document is persisted even though nothing is returned: a
   * blocked request is exactly the one an auditor will ask about later. What is
   * never persisted or returned is the Core body in any rehydrated form.
   */
  async function handleRefusal(
    error: unknown,
    res: Response,
    requestId: string,
    input: { masked_prompt: string; core_answer: string },
    scoped: Logger,
    next: NextFunction,
  ): Promise<void> {
    if (!(error instanceof ReleaseRefusedError)) {
      scoped.event(
        'request.failed',
        { error_class: error instanceof Error ? error.name : 'unknown' },
        'ERROR',
      );
      next(error);
      return;
    }

    const evidence = (error as RefusalWithEvidence).evidence as SynthesisResult | undefined;
    if (evidence !== undefined) {
      try {
        // The Core body is replaced by the marker, never stored and never
        // served: it is precisely the text a gate refused to release.
        await persist(requestId, evidence, input.masked_prompt, WITHHELD_BODY_MARKER, scoped);
      } catch {
        // A store failure must not turn a clean refusal into a 500 that leaks
        // less information than the refusal itself would have.
        scoped.event('okf.persist.failed', { refusal: error.kind }, 'ERROR');
      }
    }

    scoped.event(
      'request.refused',
      { refusal: error.kind, categories: [...error.categories] },
      'ERROR',
    );
    res.status(error.status).json({
      error: error.kind,
      message: error.message,
      request_id: requestId,
      categories: [...error.categories],
      status_code: error.status,
    });
  }

  /** Serve the stored OKF evidence document; never a rehydrated answer. */
  async function handleEvidence(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const record = await store.get(requestParam(req));
      if (record === null) {
        res.status(404).json({ error: 'unknown request' });
        return;
      }
      res.type('text/markdown; charset=utf-8').send(record.okf);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Serve one of the two masked source artifacts the OKF `sources` name.
   *
   * Without these the provenance entries would be dangling links, and a reader
   * could not re-derive `masked_prompt_sha256` or `core_response_sha256`.
   */
  async function handleArtifact(
    req: Request,
    res: Response,
    next: NextFunction,
    field: 'maskedPrompt' | 'coreResponse',
  ): Promise<void> {
    try {
      const record = await store.get(requestParam(req));
      if (record === null) {
        res.status(404).json({ error: 'unknown request' });
        return;
      }
      res.type('text/markdown; charset=utf-8').send(record[field]);
    } catch (error) {
      next(error);
    }
  }

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.event('request.failed', { error_class: error.name, error_code: error.name }, 'ERROR');
    // The message is the error class, not `error.message`: an exception message
    // can carry a fragment of the body that caused it.
    res.status(500).json({ error: 'internal_error', message: error.name });
  });

  if (options.withA2a === true) {
    await mountA2a(app, config);
  }
  return app;
}

/**
 * The signal Express aborts when the client goes away.
 *
 * Node 18+ exposes `AbortSignal` on the request; the guard keeps this working
 * against a request double in a test that does not.
 */
function abortSignalOf(req: Request): AbortSignal | undefined {
  const signal = (req as Request & { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * The `:id` path segment. Present by construction: the handler only runs when
 * its route matched.
 */
function requestParam(req: Request): string {
  return (req.params as Record<string, string | undefined>)['id'] ?? '';
}

/**
 * The exact expiry the document itself advertises.
 *
 * Read back from the assembled frontmatter rather than recomputed, so the record
 * and the `stale_after` a reader sees can never disagree. The TTL fallback
 * covers only a document whose `stale_after` failed to parse, which the builder
 * does not produce.
 */
export function staleAfterOf(result: SynthesisResult): Date {
  const raw = result.document.metadata['stale_after'];
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() + vaultTtlSeconds() * 1000);
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
    // The card describes the A2A surface, which acknowledges an exchange. The
    // verification and release pipeline is the HTTP route, so advertising it as
    // an A2A skill would promise something this endpoint does not do.
    description:
      'Acknowledges a gateway exchange over A2A. Leak checking, release and OKF ' +
      'assembly run on this service’s HTTP routes, not through this agent.',
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
        id: 'acknowledge_exchange',
        name: 'Acknowledge a gateway exchange',
        description:
          'Accepts a description of one gateway exchange and acknowledges it. It performs ' +
          'no verification, rehydration or attestation; those run on POST /v1/synthesize.',
        tags: ['privacy', 'okf'],
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

  // Synthesis's only outbound hop is the Gemma judge.
  setIdTokenAudienceAllowlist([config.GEMMA_BASE_URL]);

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
      ...(config.GEMMA_AUTH === undefined ? {} : { auth: config.GEMMA_AUTH }),
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

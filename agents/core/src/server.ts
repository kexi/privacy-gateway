/**
 * A2A server for the Core Agent.
 *
 * `toA2a` from @google/adk assembles the Express app and mounts the Agent Card
 * at `/.well-known/agent-card.json` alongside `/jsonrpc` and `/rest`. The
 * inbound guard is installed in front of those RPC routes so that a request
 * carrying raw PII is dropped before it can reach Gemini.
 */

import { toA2a } from '@google/adk';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { AgentCard } from '@a2a-js/sdk';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import { pathToFileURL } from 'node:url';
// Only the vault-free subpaths are imported. Core's inability to reach the token
// mapping is expressed in this import list, not in a convention.
import { loadConfig, type Config } from '@privacy-gateway/common/config';
import { createLogger, type Logger } from '@privacy-gateway/common/logging';
import {
  contextFromHeaders,
  currentTraceId,
  initTelemetry,
  REQUEST_ID_HEADER,
  SPAN,
  withContext,
  withSpan,
} from '@privacy-gateway/common/telemetry';
import { CORE_AGENT_NAME, createCoreAgent, DEFAULT_GEMINI_MODEL } from './agent.ts';
import { extractPlaceholders, inspect } from './guard.ts';

/** Cloud Run injects PORT. Locally 8082 sits between gateway (8081) and synthesis (8083). */
const DEFAULT_PORT = 8082;

/**
 * The process logger.
 *
 * Created eagerly so a module-scoped helper can log before `main` runs, and
 * replaced there once the validated config supplies the level and project.
 */
let logger: Logger = createLogger({ agent: 'core' });

/** Collects just the text parts of an A2A message body — what would reach the model. */
function collectText(body: unknown): string {
  const chunks: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record['kind'] === 'text' && typeof record['text'] === 'string') {
      chunks.push(record['text']);
    }
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(body, 0);
  return chunks.join('\n');
}

/**
 * Pulls the A2A `contextId` out of a request, for log correlation.
 *
 * The Gateway sets it to the same server-generated request id it puts on the
 * header, so this is a fallback for the same value rather than a second identity.
 */
function findContextId(body: unknown): string | undefined {
  let found: string | undefined;
  const walk = (node: unknown, depth: number): void => {
    if (found !== undefined || depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of ['contextId', 'context_id', 'sessionId', 'session_id']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        found = value;
        return;
      }
    }
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(body, 0);
  return found;
}

/**
 * Inbound guard middleware.
 *
 * Why not log the request body? Precisely because a request reaching this point
 * may still contain raw PII. Only the kind and length of each finding is
 * recorded, never the matched value.
 */
export function guardMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }

  const text = collectText(req.body);
  if (text.length === 0) {
    next();
    return;
  }

  // The Gateway propagates its id on the header and inside the message metadata;
  // either one keeps this hop on the caller's request in Logs Explorer.
  const requestId = headerRequestId(req) ?? findRequestId(req.body) ?? findContextId(req.body);
  const scoped = requestId === undefined ? logger : logger.child({ request_id: requestId });
  if (requestId !== undefined) res.setHeader('X-Request-ID', requestId);

  const result = inspect(text);
  if (!result.ok) {
    const kinds = [...new Set(result.findings.map((f) => f.kind))].sort();
    scoped.event(
      'guard.inbound.blocked',
      { finding_kinds: kinds, finding_count: result.findings.length, path: req.path },
      'ERROR',
    );
    res.status(400).json({
      error: 'unmasked_sensitive_data',
      message:
        'Request rejected by the Core inbound guard: the payload contains data that was not tokenised by the Gateway. Core never receives raw PII or secrets.',
      kinds,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
    });
    return;
  }

  scoped.event('a2a.receive', {
    placeholder_count: extractPlaceholders(text).length,
    text_length: text.length,
    path: req.path,
  });

  // The rest of the hop runs under the caller's trace, so Cloud Trace shows one
  // trace spanning gateway -> core -> synthesis rather than three fragments.
  const parent = contextFromHeaders(req.headers as Record<string, string | undefined>);
  withContext(parent, () => {
    void withSpan(
      SPAN.a2aReceive,
      {
        ...(requestId !== undefined ? { request_id: requestId } : {}),
        placeholder_count: extractPlaceholders(text).length,
      },
      () => {
        next();
        return Promise.resolve();
      },
    );
  });
}

/** The correlation id from the inbound header, when it carries one. */
function headerRequestId(req: Request): string | undefined {
  const raw = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The correlation id the Gateway put in the A2A message metadata. */
function findRequestId(body: unknown): string | undefined {
  let found: string | undefined;
  const walk = (node: unknown, depth: number): void => {
    if (found !== undefined || depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const value = record['request_id'];
    if (typeof value === 'string' && value.length > 0) {
      found = value;
      return;
    }
    for (const item of Object.values(record)) walk(item, depth + 1);
  };
  walk(body, 0);
  return found;
}

/**
 * The public Agent Card.
 *
 * Deliberately describes only *what* this agent does and the placeholder
 * convention a caller must follow — never the internal instruction text.
 */
export function buildAgentCard(rpcBase: string): AgentCard {
  return {
    protocolVersion: '0.3.0',
    name: CORE_AGENT_NAME,
    description:
      'Reasoning, planning and code generation over de-identified text. Operates on opaque placeholder tokens and has no access to the token vault.',
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
        id: 'masked_reasoning',
        name: 'Masked reasoning and code generation',
        description:
          'Answers questions, plans, and writes code over text in which sensitive values have been replaced by placeholder tokens of the form \u27e6TYPE_N\u27e7. Placeholders are echoed back verbatim for the caller to resolve.',
        tags: ['reasoning', 'planning', 'codegen', 'privacy'],
      },
    ],
  };
}

/**
 * Builds the Express app for the A2A server.
 *
 * Authentication is delegated to Cloud Run IAM (run.invoker plus an ID token)
 * rather than handled in-process, which is why the ADK handlers are mounted
 * without their own user builder.
 */
export async function createApp(config?: Config): Promise<express.Application> {
  // The config is optional so a test can build the app without an environment;
  // `main` always passes the validated one.
  const resolved = config ?? loadConfig({ agent: 'core' });
  const port = resolved.PORT ?? DEFAULT_PORT;
  const host = resolved.A2A_HOST ?? 'localhost';
  const protocol = resolved.A2A_PROTOCOL ?? 'http';
  const publicUrl = resolved.A2A_PUBLIC_URL;

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', agent: 'core_agent' });
  });

  // The Agent Card is public metadata and may be fetched unauthenticated, so the
  // guard is applied only to the RPC paths whose payloads actually reach the model.
  app.use('/jsonrpc', guardMiddleware);
  app.use('/rest', guardMiddleware);

  const agent = createCoreAgent({ model: resolved.GEMINI_MODEL });

  // On Cloud Run the externally visible URL differs from the local host:port, so
  // A2A_PUBLIC_URL, when set, provides the endpoint advertised in the Agent Card.
  const urlParts = publicUrl
    ? new URL(publicUrl)
    : { protocol: `${protocol}:`, hostname: host, port: String(port) };
  const scheme = urlParts.protocol.replace(':', '');
  const rpcPort = Number(urlParts.port || (scheme === 'https' ? 443 : 80));
  const rpcBase = urlParts.port
    ? `${scheme}://${urlParts.hostname}:${urlParts.port}`
    : `${scheme}://${urlParts.hostname}`;

  await toA2a(agent, {
    app,
    host: urlParts.hostname,
    port: rpcPort,
    protocol: scheme,
    // Why an explicit card? The card ADK derives puts the agent's full system
    // instruction into the public skill description. That text spells out the
    // placeholder rules this agent enforces, and the card is served
    // unauthenticated, so deriving it would hand every anonymous caller a map of
    // the guard they would need to defeat.
    agentCard: buildAgentCard(rpcBase),
    allowUnauthenticated: true,
  });

  return app;
}

/** Entry point. Importing this module from a test must not start a listener. */
export async function main(): Promise<void> {
  const config = loadConfig({ agent: 'core' });
  initTelemetry({
    agent: 'core',
    enabled: config.OTEL_ENABLED ?? false,
    project: config.GOOGLE_CLOUD_PROJECT,
  });

  logger = createLogger({
    agent: 'core',
    level: config.LOG_LEVEL,
    project: config.GOOGLE_CLOUD_PROJECT,
  });

  const port = config.PORT ?? DEFAULT_PORT;
  const app = await createApp(config);

  app.listen(port, () => {
    logger.event('server.start', {
      port,
      model: config.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
      vertexai: config.GOOGLE_GENAI_USE_VERTEXAI ?? 'unset',
      project: config.GOOGLE_CLOUD_PROJECT ?? 'unset',
      location: config.GOOGLE_CLOUD_LOCATION ?? 'unset',
      agent_card_path: `/${AGENT_CARD_PATH}`,
      trace_id: currentTraceId(),
    });
  });
}

// Only listen when this file is the process entry point, not when imported.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}

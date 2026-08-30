/**
 * The shim's HTTP server.
 *
 * Node's built-in `http` rather than express: the shim is a localhost
 * translation layer with a handful of routes, and a dependency it does not need
 * is a supply-chain surface it does not need either.
 *
 * Two surfaces share one port because the two clients that matter disagree
 * about the protocol: Claude Desktop's third-party gateway speaks the Anthropic
 * Messages API, while the `ollama` CLI and its ecosystem speak the native
 * Ollama API. Serving both means one process satisfies both, and the operator
 * does not have to know which is which.
 *
 * **Bind address.** 127.0.0.1 by default, and that is a security property, not
 * a default worth relaxing: the shim authenticates nobody, so a shim reachable
 * off-host is an unauthenticated proxy to the fleet.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  anthropicErrorType,
  anthropicModelList,
  flattenMessagesRequest,
  nonTextBlockTypes,
  messagesSseEvents,
  MessagesRequestSchema,
  resultToText,
  toAnthropicError,
  toMessagesResponse,
} from './anthropic.ts';
import { GatewayClient, refusalText, type GatewayResult } from './gateway.ts';
import { createLogger, errorFields, type Logger } from './logging.ts';
import {
  chatNdjsonFrames,
  chatResponse,
  flattenGenerateRequest,
  flattenOllamaMessages,
  generateNdjsonFrames,
  generateResponse,
  ollamaError,
  OllamaChatRequestSchema,
  OllamaGenerateRequestSchema,
  resultToOllamaText,
  showResponse,
  tagsResponse,
} from './ollama.ts';

/** Side-by-side default: the real Ollama keeps 11434. */
export const DEFAULT_PORT = 11435;

/** The port a real Ollama owns; `--takeover` binds it once Ollama is stopped. */
export const TAKEOVER_PORT = 11434;

/** The version this shim reports. Not a real Ollama version — it isn't one. */
export const REPORTED_OLLAMA_VERSION = '0.33.0-pgw-shim';

/** Refuse a body large enough to be a denial-of-service rather than a prompt. */
const MAX_BODY_BYTES = 1_000_000;

export interface ServerOptions {
  readonly gateway?: GatewayClient;
  readonly logger?: Logger;
  readonly requestId?: () => string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Build the request handler.
 *
 * Exported separately from `startServer` so tests can drive it over a real
 * socket without owning process lifecycle.
 */
export function createHandler(options: ServerOptions = {}) {
  const gateway = options.gateway ?? new GatewayClient();
  const logger = options.logger ?? createLogger();
  const newRequestId = options.requestId ?? (() => randomUUID());

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = newRequestId();
    // Path only — a query string could carry prompt text, which must never
    // reach a log line.
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';

    try {
      await route(req, res, { gateway, logger, requestId, path, method });
    } catch (error) {
      logger.event(
        'shim.request.error',
        { request_id: requestId, path, method, ...errorFields(error, 'unhandled') },
        'ERROR',
      );
      if (!res.headersSent) {
        json(res, 500, ollamaError('the shim failed to handle the request'));
      } else {
        res.end();
      }
    }
  };
}

interface RouteContext {
  readonly gateway: GatewayClient;
  readonly logger: Logger;
  readonly requestId: string;
  readonly path: string;
  readonly method: string;
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const { path, method } = ctx;

  // --- Anthropic Messages surface (Claude Desktop) ---

  if (method === 'GET' && path === '/v1/models') {
    ctx.logger.event('shim.models.list', {
      request_id: ctx.requestId,
      surface: 'anthropic',
      path,
      method,
      status: 200,
    });
    json(res, 200, anthropicModelList());
    return;
  }

  if (method === 'POST' && path === '/v1/messages') {
    await handleMessages(req, res, ctx);
    return;
  }

  // Connection-warming probe Claude Code sends at startup. Answering it keeps
  // the gateway from looking unreachable; it carries no body either way.
  if (path === '/api/hello') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(method === 'HEAD' ? undefined : '{}');
    return;
  }

  // --- Native Ollama surface (ollama CLI and its ecosystem) ---

  if (method === 'GET' && path === '/api/version') {
    json(res, 200, { version: REPORTED_OLLAMA_VERSION });
    return;
  }

  if (method === 'GET' && (path === '/api/tags' || path === '/api/ps')) {
    // `/api/ps` lists *running* models. The fleet is always available and never
    // "loaded", so an empty list is the honest answer there.
    ctx.logger.event('shim.tags.list', {
      request_id: ctx.requestId,
      surface: 'ollama',
      path,
      method,
      status: 200,
    });
    json(res, 200, path === '/api/tags' ? tagsResponse() : { models: [] });
    return;
  }

  if (method === 'POST' && path === '/api/show') {
    json(res, 200, showResponse());
    return;
  }

  if (method === 'POST' && path === '/api/chat') {
    await handleOllamaChat(req, res, ctx);
    return;
  }

  if (method === 'POST' && path === '/api/generate') {
    await handleOllamaGenerate(req, res, ctx);
    return;
  }

  if (method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Privacy Gateway shim is running');
    return;
  }

  json(res, 404, ollamaError(`no route for ${method} ${path}`));
}

/** `POST /v1/messages` — the inference endpoint Claude Desktop calls. */
async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readBody(req).catch(() => undefined);
  const parsed = MessagesRequestSchema.safeParse(body);

  if (!parsed.success) {
    json(res, 400, toAnthropicError('messages is required', 'invalid_request_error'));
    return;
  }

  // Checked before flattening, so an attachment is refused rather than quietly
  // discarded by a flattener that only knows how to read text.
  const nonText = nonTextBlockTypes(parsed.data);
  if (nonText.length > 0) {
    json(
      res,
      400,
      toAnthropicError(
        `this gateway is text-only; the request carried non-text content block(s) ` +
          `(${nonText.join(', ')}) and nothing was sent. Redaction is deterministic regex plus ` +
          `a text model, so PII inside an image or an audio clip cannot be found, masked or ` +
          `verified. Send the content as text.`,
        'invalid_request_error',
      ),
    );
    return;
  }

  const text = flattenMessagesRequest(parsed.data);
  if (text.length === 0) {
    json(
      res,
      400,
      toAnthropicError(
        'messages contained no system or user text to send',
        'invalid_request_error',
      ),
    );
    return;
  }

  const stream = parsed.data.stream ?? false;
  ctx.logger.event('shim.messages.start', {
    request_id: ctx.requestId,
    surface: 'anthropic',
    path: ctx.path,
    method: ctx.method,
    stream,
    message_count: parsed.data.messages.length,
  });

  const started = Date.now();
  const result = await ctx.gateway.chat(text, ctx.requestId);
  logResult(ctx, result, Date.now() - started, 'anthropic');

  // A refusal is sent as an HTTP error, never laundered into a 200 whose body
  // happens to be an apology — the client must be able to tell a refusal from
  // an answer. Nothing has been written yet, so the status is still ours to set.
  if (!result.ok) {
    json(
      res,
      result.status,
      toAnthropicError(refusalText(result), anthropicErrorType(result.status)),
    );
    return;
  }

  const upstreamId = result.requestId ?? ctx.requestId;

  if (!stream) {
    json(res, 200, toMessagesResponse(result.content, upstreamId, 'end_turn'));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const event of messagesSseEvents(resultToText(result), upstreamId, 'end_turn')) {
    res.write(event);
  }
  res.end();
}

/** `POST /api/chat` — the native Ollama inference endpoint. */
async function handleOllamaChat(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readBody(req).catch(() => undefined);
  const parsed = OllamaChatRequestSchema.safeParse(body);

  if (!parsed.success) {
    json(res, 400, ollamaError('messages is required'));
    return;
  }

  const text = flattenOllamaMessages(parsed.data);
  if (text.length === 0) {
    json(res, 400, ollamaError('messages contained no system or user content to send'));
    return;
  }

  // Ollama defaults `stream` to true when the field is absent.
  const stream = parsed.data.stream ?? true;
  ctx.logger.event('shim.chat.start', {
    request_id: ctx.requestId,
    surface: 'ollama',
    path: ctx.path,
    method: ctx.method,
    stream,
    message_count: parsed.data.messages.length,
  });

  const started = Date.now();
  const result = await ctx.gateway.chat(text, ctx.requestId);
  logResult(ctx, result, Date.now() - started, 'ollama');

  if (!result.ok) {
    json(res, result.status, ollamaError(refusalText(result)));
    return;
  }

  if (!stream) {
    json(res, 200, chatResponse(result.content, true));
    return;
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-cache',
  });
  for (const frame of chatNdjsonFrames(resultToOllamaText(result))) {
    res.write(frame);
  }
  res.end();
}

/** `POST /api/generate` — the single-prompt native endpoint. */
async function handleOllamaGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readBody(req).catch(() => undefined);
  const parsed = OllamaGenerateRequestSchema.safeParse(body);

  if (!parsed.success) {
    json(res, 400, ollamaError('prompt is required'));
    return;
  }

  const text = flattenGenerateRequest(parsed.data);
  if (text.length === 0) {
    json(res, 400, ollamaError('prompt was empty'));
    return;
  }

  const stream = parsed.data.stream ?? true;
  ctx.logger.event('shim.generate.start', {
    request_id: ctx.requestId,
    surface: 'ollama',
    path: ctx.path,
    method: ctx.method,
    stream,
  });

  const started = Date.now();
  const result = await ctx.gateway.chat(text, ctx.requestId);
  logResult(ctx, result, Date.now() - started, 'ollama');

  if (!result.ok) {
    json(res, result.status, ollamaError(refusalText(result)));
    return;
  }

  if (!stream) {
    json(res, 200, generateResponse(result.content));
    return;
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-cache',
  });
  for (const frame of generateNdjsonFrames(resultToOllamaText(result))) {
    res.write(frame);
  }
  res.end();
}

/** One log line per completed upstream call. Never the text, never the answer. */
function logResult(
  ctx: RouteContext,
  result: GatewayResult,
  durationMs: number,
  surface: string,
): void {
  if (result.ok) {
    ctx.logger.event('shim.upstream.ok', {
      request_id: result.requestId ?? ctx.requestId,
      surface,
      duration_ms: durationMs,
      status: 200,
    });
    return;
  }
  ctx.logger.event(
    'shim.upstream.refused',
    {
      request_id: result.requestId ?? ctx.requestId,
      surface,
      duration_ms: durationMs,
      status: result.status,
      error_code: result.code,
      categories: result.categories,
    },
    'WARNING',
  );
}

export interface StartOptions extends ServerOptions {
  readonly port?: number;
  readonly host?: string;
}

/** Start listening. Resolves once bound. */
export function startServer(options: StartOptions = {}): Promise<Server> {
  const port = options.port ?? DEFAULT_PORT;
  // 127.0.0.1, not 0.0.0.0: the shim authenticates nobody, so binding a routable
  // interface would publish an unauthenticated proxy to the fleet.
  const host = options.host ?? '127.0.0.1';
  const logger = options.logger ?? createLogger();
  const server = createServer(createHandler({ ...options, logger }));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      logger.event('shim.listening', { port });
      resolve(server);
    });
  });
}

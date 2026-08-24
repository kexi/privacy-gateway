/**
 * A2A client-side helpers.
 *
 * Core is reached over the **standard A2A protocol** — fetch the Agent Card,
 * then a `message/send` JSON-RPC call — rather than through an ADK client class.
 * Speaking the raw protocol keeps this path working regardless of how the callee
 * is implemented, which is the point of putting an Agent Card in front of it.
 *
 * Correlation ids ride along on both channels: `X-Request-ID` / `traceparent` as
 * headers, and `request_id` inside the message metadata, so a callee that only
 * inspects the RPC body can still join the trace.
 */

import { randomUUID } from 'node:crypto';
import { audienceFor, authorizedFetch } from './http_client.ts';
import { AgentCardSchema, JsonRpcResponseSchema, type AgentCard } from './schema.ts';

/**
 * The A2A Agent Card path. Some implementations still serve the older
 * `agent.json`, so both are tried in order as a fallback.
 */
export const AGENT_CARD_PATHS = [
  '/.well-known/agent-card.json',
  '/.well-known/agent.json',
] as const;

/** Build the Agent Card URL from a service base URL. */
export function agentCardUrl(baseUrl: string, path: string = AGENT_CARD_PATHS[0]): string {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`;
}

export interface A2aClientOptions {
  readonly requestId?: string | undefined;
  readonly contextId?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * Whether to attach a Google-signed ID token. Defaults to on for https URLs,
   * which is exactly the Cloud Run case; a local http service has no IAM check
   * to satisfy and no metadata server to mint a token from.
   */
  readonly useIdToken?: boolean | undefined;
}

/** Fetch the Agent Card, using the first path that resolves. */
export async function fetchAgentCard(
  baseUrl: string,
  options: A2aClientOptions = {},
): Promise<AgentCard> {
  let lastError: unknown;

  for (const path of AGENT_CARD_PATHS) {
    try {
      const response = await authorizedFetch(agentCardUrl(baseUrl, path), {
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        ...(options.useIdToken === undefined ? {} : { useIdToken: options.useIdToken }),
      });
      if (response.status === 404) continue;
      if (!response.ok) {
        lastError = new Error(`agent card request failed with status ${response.status}`);
        continue;
      }
      return AgentCardSchema.parse(await response.json());
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`could not resolve an agent card under ${baseUrl}: ${describeError(lastError)}`);
}

/** The text an A2A response carried, plus the ids needed to correlate it. */
export interface A2aReply {
  readonly text: string;
  readonly requestId: string;
}

/**
 * Send `text` via A2A `message/send` and return the text that comes back.
 *
 * The Agent Card's `url` is used as the RPC endpoint; if the card carries no
 * url, this falls back to `baseUrl`.
 */
export async function sendMessage(
  baseUrl: string,
  text: string,
  options: A2aClientOptions = {},
): Promise<A2aReply> {
  const requestId = options.requestId ?? randomUUID();

  const card = await fetchAgentCard(baseUrl, { ...options, requestId });
  const rpcUrl = resolveRpcUrl(baseUrl, card.url);

  const request = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        parts: [{ kind: 'text', text }],
        messageId: randomUUID(),
        ...(options.contextId !== undefined ? { contextId: options.contextId } : {}),
        // Carried in the body as well as the headers: a callee reading only the
        // RPC payload can still stamp its logs with the same request id.
        metadata: { request_id: requestId },
      },
    },
  };

  const response = await authorizedFetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    requestId,
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.useIdToken === undefined ? {} : { useIdToken: options.useIdToken }),
  });

  if (!response.ok) {
    throw new Error(`remote agent returned status ${response.status}`);
  }

  const payload = JsonRpcResponseSchema.parse(await response.json());
  if (payload.error !== undefined) {
    throw new Error(`remote agent returned an error: ${JSON.stringify(payload.error)}`);
  }

  return { text: extractText(payload.result), requestId };
}

/**
 * Raised when an Agent Card's `url` points outside the configured service.
 *
 * Typed so a caller can log `a2a.card.origin_mismatch` without matching on a
 * message string.
 */
export class AgentCardOriginError extends Error {
  readonly event = 'a2a.card.origin_mismatch';
  readonly expectedOrigin: string;
  readonly cardUrl: string;

  constructor(expectedOrigin: string, cardUrl: string) {
    super(
      `agent card advertises an rpc url outside the configured origin: ` +
        `expected ${expectedOrigin}, got ${cardUrl}`,
    );
    this.name = 'AgentCardOriginError';
    this.expectedOrigin = expectedOrigin;
    this.cardUrl = cardUrl;
  }
}

/**
 * Constrain the card's advertised RPC url to the origin we already trust.
 *
 * The Agent Card is fetched from the callee, so its `url` is attacker-controlled
 * the moment that callee is compromised or spoofed. Following it blindly would
 * let the card redirect the masked prompt — and the ID token minted for this
 * fleet — to an arbitrary host. The base URL comes from validated configuration,
 * so it is the authority; the card may only refine the path.
 *
 * Why not simply ignore `card.url`: the A2A spec lets a service serve its RPC
 * endpoint on a path other than the card's own, and honouring that within the
 * configured origin costs nothing.
 */
export function resolveRpcUrl(baseUrl: string, cardUrl: string | undefined): string {
  if (cardUrl === undefined || cardUrl === '') return baseUrl;

  const expected = audienceFor(baseUrl);
  let resolved: URL;
  try {
    resolved = new URL(cardUrl, baseUrl);
  } catch {
    throw new AgentCardOriginError(expected, cardUrl);
  }

  if (resolved.origin !== expected) throw new AgentCardOriginError(expected, cardUrl);
  return resolved.toString();
}

/**
 * Concatenate and extract the text parts of an A2A response.
 *
 * Per the A2A specification, `message/send` may return either a Message or a
 * Task. For a Task, text can appear both in artifacts and in `status.message`.
 */
export function extractText(result: unknown): string {
  if (result === null || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;
  const chunks: string[] = [];

  const collect = (parts: unknown): void => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (part !== null && typeof part === 'object') {
        const text = (part as Record<string, unknown>)['text'];
        if (typeof text === 'string') chunks.push(text);
      }
    }
  };

  collect(record['parts']);

  const artifacts = record['artifacts'];
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      if (artifact !== null && typeof artifact === 'object') {
        collect((artifact as Record<string, unknown>)['parts']);
      }
    }
  }

  const status = record['status'];
  if (status !== null && typeof status === 'object') {
    const message = (status as Record<string, unknown>)['message'];
    if (message !== null && typeof message === 'object') {
      collect((message as Record<string, unknown>)['parts']);
    }
  }

  return chunks.join('').trim();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

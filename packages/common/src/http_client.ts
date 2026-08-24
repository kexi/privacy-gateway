/**
 * The one authenticated HTTP client for every service-to-service hop.
 *
 * Cloud Run services in this fleet require IAM authentication: the caller must
 * present a Google-signed **ID token** whose audience is the callee's origin,
 * and `roles/run.invoker` is what makes that token accepted. Every outbound hop
 * — Gateway to Core (A2A), Gateway to Synthesis (HTTP), and both agents to
 * Gemma (OpenAI-compatible HTTP) — goes through `authorizedFetch` so that
 * exactly one place decides whether a request carries credentials.
 *
 * Three rules make this safe:
 *
 * 1. **The `IdTokenClient` is cached per audience, never the token string.**
 *    `google-auth-library` refreshes an expiring token behind
 *    `getRequestHeaders()`; caching the string instead pins the first token
 *    until the process dies, which is exactly the bug this replaces.
 * 2. **HTTPS fails closed.** An https target is a Cloud Run service behind IAM,
 *    so a request without a token is a guaranteed 403 with a confusing message.
 *    Throwing `IdTokenError` up front turns that into an honest 502 plus an
 *    `auth.id_token.failed` event. Failures are never cached — a metadata
 *    server hiccup must not poison the rest of the process's lifetime.
 * 3. **`http://localhost` skips auth entirely.** There is no IAM check in front
 *    of a local dev service and no metadata server to mint a token from, so
 *    requiring credentials would make `just dev` need cloud access.
 *
 * Correlation ids ride along on every request: `X-Request-ID` and W3C
 * `traceparent`, reusing the same helpers the rest of the fleet stamps its logs
 * with, so one request is one trace across all four services.
 */

import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import { outboundTraceHeaders, REQUEST_ID_HEADER } from './telemetry.ts';

/**
 * Raised when a Google ID token could not be obtained for an https target.
 *
 * Typed rather than a bare `Error` so a server can map it to 502 and the
 * `auth.id_token.failed` event without string-matching a message.
 */
export class IdTokenError extends Error {
  /** The audience the token was requested for. */
  readonly audience: string;
  /** Structured log event name callers should emit for this failure. */
  readonly event = 'auth.id_token.failed';

  constructor(audience: string, cause: unknown) {
    super(`could not obtain a Google ID token for ${audience}: ${describeError(cause)}`);
    this.name = 'IdTokenError';
    this.audience = audience;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Whether a target needs a Google ID token, given only its URL. */
export function requiresIdToken(targetUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  // Plain http is only ever local development. A non-loopback http target is
  // still not given a token — there is no IAM in front of it to satisfy — but
  // it is a configuration smell rather than something to authenticate.
  return false;
}

/**
 * The audience Cloud Run's IAM check validates: the callee's **origin**.
 *
 * Not the full URL. Cloud Run accepts a token minted for the service's base
 * address regardless of the path being called, and deriving the audience from
 * the path would mint a distinct token per endpoint for no benefit.
 */
export function audienceFor(targetUrl: string): string {
  return new URL(targetUrl).origin;
}

/** Whether a URL points at the loopback interface (dev, no IAM). */
export function isLocalhost(targetUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  );
}

/**
 * Cached `IdTokenClient` per audience.
 *
 * The promise — not the resolved token — is what is stored, so concurrent
 * first-callers share one metadata round trip. A rejected promise is evicted
 * immediately (see `idTokenClientFor`) so a transient failure is retried.
 */
const idTokenClients = new Map<string, Promise<IdTokenClient>>();

let authClient: GoogleAuth | undefined;

function googleAuth(): GoogleAuth {
  authClient ??= new GoogleAuth();
  return authClient;
}

/** Resolve (and cache) the `IdTokenClient` for one audience. */
function idTokenClientFor(audience: string): Promise<IdTokenClient> {
  const cached = idTokenClients.get(audience);
  if (cached !== undefined) return cached;

  const pending = googleAuth()
    .getIdTokenClient(audience)
    .catch((error: unknown) => {
      // Why not keep the rejected promise: caching a failure makes one bad
      // moment permanent for the life of the process. The previous
      // implementation cached `undefined` here and silently sent unauthenticated
      // requests forever after a single metadata-server blip.
      idTokenClients.delete(audience);
      throw error;
    });

  idTokenClients.set(audience, pending);
  return pending;
}

/**
 * Fresh `Authorization` header for `targetUrl`.
 *
 * Obtained per request rather than reused: `getRequestHeaders()` is where the
 * library refreshes a token that is about to expire.
 *
 * @throws {IdTokenError} when the target is https and no token can be minted.
 */
export async function idTokenHeaders(targetUrl: string): Promise<Record<string, string>> {
  const audience = audienceFor(targetUrl);
  try {
    const client = await idTokenClientFor(audience);
    // google-auth-library returns a `Headers` in v10 and a plain record in v9;
    // normalising through `Headers` accepts both without pinning the shape.
    const headers = await client.getRequestHeaders(targetUrl);
    const authorization = new Headers(headers as Record<string, string>).get('authorization');
    if (authorization === null || authorization === '') {
      throw new Error('the ID token client returned no authorization header');
    }
    return { authorization };
  } catch (error) {
    if (error instanceof IdTokenError) throw error;
    throw new IdTokenError(audience, error);
  }
}

export interface AuthorizedFetchOptions extends Omit<RequestInit, 'headers'> {
  readonly headers?: Record<string, string> | undefined;
  /** Correlation id stamped as `X-Request-ID` and echoed by every callee. */
  readonly requestId?: string | undefined;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * Force the auth decision instead of deriving it from the URL scheme.
   *
   * `true` demands a Google ID token (and fails closed without one) even for an
   * http target; `false` sends none even for https. Left undefined in
   * production — the scheme is the honest signal.
   */
  readonly useIdToken?: boolean | undefined;
  /** Abort the request after this many milliseconds. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Build the outbound headers for one hop: trace context, correlation id, auth.
 *
 * Exported so callers that must construct a request themselves (a streaming
 * body, a non-`fetch` transport) still get an identical header set.
 *
 * @throws {IdTokenError} when a token is required and cannot be obtained.
 */
export async function authorizedHeaders(
  targetUrl: string,
  options: Pick<AuthorizedFetchOptions, 'headers' | 'requestId' | 'useIdToken'> = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    ...outboundTraceHeaders(),
    ...options.headers,
  };
  if (options.requestId !== undefined) headers[REQUEST_ID_HEADER] = options.requestId;

  const wantsToken = options.useIdToken ?? (!isLocalhost(targetUrl) && requiresIdToken(targetUrl));
  if (!wantsToken) return headers;

  return { ...headers, ...(await idTokenHeaders(targetUrl)) };
}

/**
 * `fetch` with fleet credentials and correlation headers attached.
 *
 * Fails closed: if the target is https and no ID token can be minted, this
 * throws `IdTokenError` instead of sending a request that Cloud Run will reject
 * with an opaque 403.
 */
export async function authorizedFetch(
  targetUrl: string,
  options: AuthorizedFetchOptions = {},
): Promise<Response> {
  const { headers, requestId, fetchImpl, useIdToken, timeoutMs, signal, ...init } = options;
  const impl = fetchImpl ?? globalThis.fetch;

  const resolved = await authorizedHeaders(targetUrl, { headers, requestId, useIdToken });

  if (timeoutMs === undefined) {
    return impl(targetUrl, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
      headers: resolved,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  // A caller-supplied signal still wins: both can abort the same request.
  signal?.addEventListener('abort', () => {
    controller.abort();
  });

  try {
    return await impl(targetUrl, { ...init, headers: resolved, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Clears the cached ID token clients. Test-only. */
export function resetIdTokenCache(): void {
  idTokenClients.clear();
  authClient = undefined;
}

/** Test-only seam: replace the `GoogleAuth` instance the cache builds clients from. */
export function setGoogleAuthForTests(auth: GoogleAuth | undefined): void {
  authClient = auth;
  idTokenClients.clear();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

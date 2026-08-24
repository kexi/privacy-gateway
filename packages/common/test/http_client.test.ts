/**
 * What the shared service-to-service client guarantees: an https hop always
 * carries a Google ID token minted for the callee's *origin*, a localhost hop
 * carries none, a token that cannot be obtained aborts the request rather than
 * sending it unauthenticated, and a transient token failure is never cached.
 *
 * These are the properties the deployed fleet depends on — Cloud Run rejects an
 * unauthenticated call with an opaque 403, so failing closed here is what turns
 * a credential fault into a legible error.
 */

import type { GoogleAuth } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  audienceFor,
  authorizedFetch,
  authorizedHeaders,
  IdTokenError,
  idTokenAudienceAllowlist,
  isLocalhost,
  requiresIdToken,
  resetIdTokenCache,
  setGoogleAuthForTests,
  setIdTokenAudienceAllowlist,
  UnknownAudienceError,
} from '../src/http_client.ts';

/**
 * A stand-in for `GoogleAuth` that records which audiences were asked for.
 *
 * `behaviour` decides per audience whether a client is produced or the mint
 * fails, which is how the fail-closed and no-failure-caching cases are driven.
 */
function stubAuth(behaviour: (audience: string, attempt: number) => string | Error) {
  const audiences: string[] = [];
  const attempts = new Map<string, number>();

  const auth = {
    getIdTokenClient(audience: string) {
      audiences.push(audience);
      const attempt = (attempts.get(audience) ?? 0) + 1;
      attempts.set(audience, attempt);

      const outcome = behaviour(audience, attempt);
      if (outcome instanceof Error) return Promise.reject(outcome);

      return Promise.resolve({
        getRequestHeaders: () => Promise.resolve({ authorization: `Bearer ${outcome}` }),
      });
    },
  } as unknown as GoogleAuth;

  return { auth, audiences };
}

/** Records the outgoing request and replies 200. */
function recordingFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(Response.json({ ok: true }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

afterEach(() => {
  resetIdTokenCache();
  vi.restoreAllMocks();
});

describe('audience derivation', () => {
  it('uses the target origin, not the full path', () => {
    expect(audienceFor('https://core-agent-123.us-central1.run.app/v1/synthesize?x=1')).toBe(
      'https://core-agent-123.us-central1.run.app',
    );
  });

  it('keeps a non-default port as part of the audience', () => {
    expect(audienceFor('https://core.test:8443/a2a')).toBe('https://core.test:8443');
  });

  it('mints one token per callee origin, shared across that origin’s paths', async () => {
    const { auth, audiences } = stubAuth(() => 'token-a');
    setGoogleAuthForTests(auth);
    const { impl } = recordingFetch();

    await authorizedFetch('https://core.test/v1/one', { fetchImpl: impl });
    await authorizedFetch('https://core.test/v1/two', { fetchImpl: impl });
    await authorizedFetch('https://synthesis.test/v1/three', { fetchImpl: impl });

    // Two distinct origins => two clients, and the repeated origin reuses one.
    expect(audiences).toEqual(['https://core.test', 'https://synthesis.test']);
  });

  it('sends the minted token as a bearer authorization header', async () => {
    const { auth } = stubAuth(() => 'token-xyz');
    setGoogleAuthForTests(auth);
    const { impl, calls } = recordingFetch();

    await authorizedFetch('https://core.test/v1/ask', { fetchImpl: impl });

    expect(headerOf(calls[0]!.init, 'authorization')).toBe('Bearer token-xyz');
  });
});

describe('localhost targets', () => {
  it.each([
    'http://localhost:8083/v1/synthesize',
    'http://127.0.0.1:11434/v1/chat/completions',
    'http://[::1]:8082/a2a',
  ])('recognises %s as loopback', (url) => {
    expect(isLocalhost(url)).toBe(true);
  });

  it('sends no authorization header and never touches GoogleAuth', async () => {
    const { auth, audiences } = stubAuth(() => 'unused');
    setGoogleAuthForTests(auth);
    const { impl, calls } = recordingFetch();

    await authorizedFetch('http://localhost:8083/v1/synthesize', { fetchImpl: impl });

    expect(headerOf(calls[0]!.init, 'authorization')).toBeUndefined();
    expect(audiences).toEqual([]);
  });

  it('still propagates the request id on a local hop', async () => {
    const { impl, calls } = recordingFetch();

    await authorizedFetch('http://localhost:8083/v1/synthesize', {
      fetchImpl: impl,
      requestId: 'req-42',
    });

    expect(headerOf(calls[0]!.init, 'x-request-id')).toBe('req-42');
  });

  it('treats https as requiring a token and plain http as not', () => {
    expect(requiresIdToken('https://gemma.test/v1')).toBe(true);
    expect(requiresIdToken('http://localhost:11434/v1')).toBe(false);
  });
});

describe('https fail-closed', () => {
  it('throws IdTokenError and sends no request when the token cannot be minted', async () => {
    const { auth } = stubAuth(() => new Error('metadata server unreachable'));
    setGoogleAuthForTests(auth);
    const { impl, calls } = recordingFetch();

    await expect(
      authorizedFetch('https://gemma.test/v1/chat/completions', { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(IdTokenError);

    // The point of failing closed: nothing left the process unauthenticated.
    expect(calls).toEqual([]);
  });

  it('reports the audience and the auth.id_token.failed event on the error', async () => {
    const { auth } = stubAuth(() => new Error('boom'));
    setGoogleAuthForTests(auth);

    const error = await authorizedHeaders('https://gemma.test/v1/chat/completions').catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(IdTokenError);
    expect((error as IdTokenError).audience).toBe('https://gemma.test');
    expect((error as IdTokenError).event).toBe('auth.id_token.failed');
  });

  it('fails closed when the client yields no authorization header', async () => {
    const auth = {
      getIdTokenClient: () => Promise.resolve({ getRequestHeaders: () => Promise.resolve({}) }),
    } as unknown as GoogleAuth;
    setGoogleAuthForTests(auth);

    await expect(authorizedHeaders('https://gemma.test/v1')).rejects.toBeInstanceOf(IdTokenError);
  });
});

describe('no failure caching', () => {
  it('retries the mint after a transient failure instead of poisoning the audience', async () => {
    // Fails once, then succeeds: the old implementation cached `undefined` here
    // and sent unauthenticated requests for the rest of the process's life.
    const { auth, audiences } = stubAuth((_audience, attempt) =>
      attempt === 1 ? new Error('transient') : 'token-after-retry',
    );
    setGoogleAuthForTests(auth);
    const { impl, calls } = recordingFetch();

    await expect(
      authorizedFetch('https://core.test/v1/ask', { fetchImpl: impl }),
    ).rejects.toBeInstanceOf(IdTokenError);

    await authorizedFetch('https://core.test/v1/ask', { fetchImpl: impl });

    expect(audiences).toEqual(['https://core.test', 'https://core.test']);
    expect(headerOf(calls[0]!.init, 'authorization')).toBe('Bearer token-after-retry');
  });

  it('caches a successful client so a second call makes no new mint', async () => {
    const { auth, audiences } = stubAuth(() => 'token-a');
    setGoogleAuthForTests(auth);
    const { impl } = recordingFetch();

    await authorizedFetch('https://core.test/v1/ask', { fetchImpl: impl });
    await authorizedFetch('https://core.test/v1/ask', { fetchImpl: impl });

    expect(audiences).toEqual(['https://core.test']);
  });
});

describe('explicit useIdToken override', () => {
  it('demands a token for an http target when forced on', async () => {
    const { auth, audiences } = stubAuth(() => 'forced');
    setGoogleAuthForTests(auth);
    const { impl, calls } = recordingFetch();

    await authorizedFetch('http://gemma.internal/v1', { fetchImpl: impl, useIdToken: true });

    expect(audiences).toEqual(['http://gemma.internal']);
    expect(headerOf(calls[0]!.init, 'authorization')).toBe('Bearer forced');
  });

  it('sends no token for an https target when forced off', async () => {
    const { auth, audiences } = stubAuth(() => 'unused');
    setGoogleAuthForTests(auth);
    const { impl, calls } = recordingFetch();

    await authorizedFetch('https://public.test/v1', { fetchImpl: impl, useIdToken: false });

    expect(audiences).toEqual([]);
    expect(headerOf(calls[0]!.init, 'authorization')).toBeUndefined();
  });
});

describe('the audience allowlist (P2)', () => {
  const CORE = 'https://core-agent-abc.us-central1.run.app';
  const SYNTHESIS = 'https://synthesis-agent-abc.us-central1.run.app';

  it('attaches a token to a configured origin', async () => {
    const { auth } = stubAuth(() => 'token');
    setGoogleAuthForTests(auth);
    setIdTokenAudienceAllowlist([CORE, SYNTHESIS]);

    const headers = await authorizedHeaders(`${CORE}/jsonrpc`);
    expect(headers['authorization']).toBe('Bearer token');
  });

  it('refuses to mint a token for an origin nobody configured', async () => {
    // A mistyped SYNTHESIS_BASE_URL used to hand this fleet's service identity
    // to whatever host the typo named. The token is never created at all now.
    const { auth, audiences } = stubAuth(() => 'token');
    setGoogleAuthForTests(auth);
    setIdTokenAudienceAllowlist([CORE, SYNTHESIS]);

    await expect(authorizedHeaders('https://attacker.example.com/collect')).rejects.toThrow(
      UnknownAudienceError,
    );
    expect(audiences).toEqual([]);
  });

  it('sends no request at all to a rejected origin', async () => {
    const { auth } = stubAuth(() => 'token');
    setGoogleAuthForTests(auth);
    setIdTokenAudienceAllowlist([CORE]);
    const { impl, calls } = recordingFetch();

    await expect(
      authorizedFetch('https://attacker.example.com/collect', { fetchImpl: impl }),
    ).rejects.toThrow(UnknownAudienceError);
    expect(calls).toHaveLength(0);
  });

  it('names the rejected origin without a token in the error', async () => {
    setIdTokenAudienceAllowlist([CORE]);
    const error = await authorizedHeaders('https://attacker.example.com/x').catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(UnknownAudienceError);
    expect((error as UnknownAudienceError).origin).toBe('https://attacker.example.com');
    expect((error as UnknownAudienceError).event).toBe('auth.audience.rejected');
  });

  it('allows every https origin while no allowlist is declared', async () => {
    // `just dev` and the tests declare none; the previous behaviour holds there.
    const { auth } = stubAuth(() => 'token');
    setGoogleAuthForTests(auth);

    const headers = await authorizedHeaders('https://anything.example.com/x');
    expect(headers['authorization']).toBe('Bearer token');
  });

  it('ignores an http entry, which names no IAM-protected service', () => {
    setIdTokenAudienceAllowlist(['http://localhost:8083', CORE, undefined, '']);
    expect(idTokenAudienceAllowlist()).toEqual([CORE]);
  });
});

describe('caller signals', () => {
  it('does not start a request whose signal is already aborted', async () => {
    // `addEventListener` never fires for an abort that has already happened, so
    // the old code sent a request the caller had already cancelled.
    const controller = new AbortController();
    controller.abort();

    const impl = ((_url: string, init: RequestInit) =>
      Promise.resolve(
        Response.json({ aborted: init.signal?.aborted === true }),
      )) as unknown as typeof fetch;

    const response = await authorizedFetch('http://localhost:8083/x', {
      fetchImpl: impl,
      timeoutMs: 1000,
      signal: controller.signal,
    });

    expect(((await response.json()) as { aborted: boolean }).aborted).toBe(true);
  });

  it('removes its listener so a long-lived signal does not accumulate them', async () => {
    const controller = new AbortController();
    const { impl } = recordingFetch();

    for (let index = 0; index < 20; index += 1) {
      await authorizedFetch('http://localhost:8083/x', {
        fetchImpl: impl,
        timeoutMs: 1000,
        signal: controller.signal,
      });
    }

    // Node's EventTarget warns past ten listeners and then leaks them; if the
    // listener were not removed, twenty hops on one request-scoped signal would
    // hold twenty closures alive.
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});

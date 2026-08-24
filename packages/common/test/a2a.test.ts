/**
 * What the A2A client guarantees: the Agent Card is resolved before the RPC, the
 * reply text is extracted from either response shape, and correlation ids travel
 * on both the headers and the message metadata.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentCardOriginError,
  agentCardUrl,
  extractText,
  resolveRpcUrl,
  sendMessage,
} from '../src/a2a.ts';
import {
  resetIdTokenCache,
  setIdTokenAudienceAllowlist,
  UnknownAudienceError,
} from '../src/http_client.ts';

const BASE_URL = 'http://core.test';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/**
 * A mock Core speaking the real protocol: Agent Card, then `message/send`.
 *
 * The mock sits at the fetch layer rather than replacing the function under
 * test, because the point is to exercise the language-independent protocol path
 * as it really is.
 */
function mockCore(reply: (prompt: string) => unknown, cardUrl = `${BASE_URL}/a2a`) {
  const calls: Call[] = [];

  const impl = ((input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    const path = new URL(input).pathname;

    if (path === '/.well-known/agent-card.json') {
      return Promise.resolve(
        Response.json({
          name: 'core_agent',
          description: 'mock core',
          url: cardUrl,
          version: '1.0.0',
        }),
      );
    }
    if (path === '/a2a') {
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        params: { message: { parts: Array<{ text?: string }> } };
      };
      const prompt = body.params.message.parts.map((part) => part.text ?? '').join('');
      return Promise.resolve(Response.json({ jsonrpc: '2.0', id: body.id, result: reply(prompt) }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function messageResult(text: string) {
  return { role: 'agent', parts: [{ kind: 'text', text }], messageId: 'reply-1' };
}

describe('agent card', () => {
  it('builds the well-known card URL', () => {
    expect(agentCardUrl('http://core.test/')).toBe('http://core.test/.well-known/agent-card.json');
  });

  it('resolves the card before sending the RPC', async () => {
    const { impl, calls } = mockCore(() => messageResult('ok'));
    await sendMessage(BASE_URL, 'hello', { fetchImpl: impl, useIdToken: false });

    expect(calls[0]?.url).toBe('http://core.test/.well-known/agent-card.json');
    expect(calls[1]?.url).toBe('http://core.test/a2a');
  });

  it('falls back to the legacy card path on 404', async () => {
    const calls: string[] = [];
    const impl = ((input: string) => {
      calls.push(new URL(input).pathname);
      if (new URL(input).pathname === '/.well-known/agent-card.json') {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(Response.json({ name: 'core', url: `${BASE_URL}/a2a` }));
    }) as unknown as typeof fetch;

    const { fetchAgentCard } = await import('../src/a2a.ts');
    const card = await fetchAgentCard(BASE_URL, { fetchImpl: impl, useIdToken: false });

    expect(card.name).toBe('core');
    expect(calls).toEqual(['/.well-known/agent-card.json', '/.well-known/agent.json']);
  });

  it('reports a base URL that serves no card', async () => {
    const impl = (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as unknown as typeof fetch;

    await expect(
      sendMessage(BASE_URL, 'hello', { fetchImpl: impl, useIdToken: false }),
    ).rejects.toThrow(/could not resolve an agent card/u);
  });
});

describe('message/send', () => {
  it('returns the reply text', async () => {
    const { impl } = mockCore((prompt) => messageResult(`echo: ${prompt}`));
    const reply = await sendMessage(BASE_URL, 'hello', { fetchImpl: impl, useIdToken: false });

    expect(reply.text).toBe('echo: hello');
  });

  it('propagates the request id on the header and in the metadata', async () => {
    const requestId = '0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b';
    const { impl, calls } = mockCore(() => messageResult('ok'));
    await sendMessage(BASE_URL, 'hello', { fetchImpl: impl, useIdToken: false, requestId });

    const rpc = calls[1];
    const headers = rpc?.init?.headers as Record<string, string>;
    expect(headers['x-request-id']).toBe(requestId);

    const body = JSON.parse(String(rpc?.init?.body)) as {
      params: { message: { metadata: { request_id: string } } };
    };
    // Carried in the body too, so a callee reading only the RPC payload can
    // still stamp its logs with the same id.
    expect(body.params.message.metadata.request_id).toBe(requestId);
  });

  it('passes the session as the A2A context id', async () => {
    const { impl, calls } = mockCore(() => messageResult('ok'));
    await sendMessage(BASE_URL, 'hello', {
      fetchImpl: impl,
      useIdToken: false,
      contextId: 'session-1',
    });

    const body = JSON.parse(String(calls[1]?.init?.body)) as {
      params: { message: { contextId: string } };
    };
    expect(body.params.message.contextId).toBe('session-1');
  });

  it('raises the error a remote agent returns', async () => {
    const impl = ((input: string) => {
      if (new URL(input).pathname === '/.well-known/agent-card.json') {
        return Promise.resolve(Response.json({ name: 'core', url: `${BASE_URL}/a2a` }));
      }
      return Promise.resolve(
        Response.json({
          jsonrpc: '2.0',
          id: '1',
          error: { code: -32000, message: 'boom' },
        }),
      );
    }) as unknown as typeof fetch;

    await expect(
      sendMessage(BASE_URL, 'hello', { fetchImpl: impl, useIdToken: false }),
    ).rejects.toThrow(/remote agent returned an error/u);
  });
});

describe('text extraction', () => {
  it('reads a Message result', () => {
    expect(extractText({ parts: [{ kind: 'text', text: 'hello' }] })).toBe('hello');
  });

  it('reads a Task result from its artifacts', () => {
    const result = { artifacts: [{ parts: [{ kind: 'text', text: 'from artifact' }] }] };
    expect(extractText(result)).toBe('from artifact');
  });

  it('reads a Task result from status.message', () => {
    const result = { status: { message: { parts: [{ kind: 'text', text: 'from status' }] } } };
    expect(extractText(result)).toBe('from status');
  });

  it('concatenates several text parts', () => {
    const result = {
      parts: [
        { kind: 'text', text: 'a' },
        { kind: 'text', text: 'b' },
      ],
    };
    expect(extractText(result)).toBe('ab');
  });

  it('returns an empty string for a result with no text', () => {
    expect(extractText({ parts: [{ kind: 'file' }] })).toBe('');
    expect(extractText(null)).toBe('');
  });
});

/**
 * What the Agent Card origin constraint guarantees: the card is fetched from
 * the callee, so its `url` is attacker-controlled the moment that callee is
 * spoofed. Following it elsewhere would send the masked prompt — and the ID
 * token minted for this fleet — to a host of the attacker's choosing.
 */
describe('agent card rpc url origin', () => {
  it('accepts a card url on the configured origin', () => {
    expect(resolveRpcUrl('http://core.test', 'http://core.test/a2a')).toBe('http://core.test/a2a');
  });

  it('accepts a relative card url, resolving it against the base', () => {
    expect(resolveRpcUrl('http://core.test', '/a2a')).toBe('http://core.test/a2a');
  });

  it('falls back to the base url when the card advertises none', () => {
    expect(resolveRpcUrl('http://core.test', undefined)).toBe('http://core.test');
  });

  it('rejects a card url pointing at another host', () => {
    expect(() => resolveRpcUrl('http://core.test', 'https://attacker.example/a2a')).toThrow(
      AgentCardOriginError,
    );
  });

  it('rejects a card url that only changes the scheme or port', () => {
    expect(() => resolveRpcUrl('https://core.test', 'http://core.test/a2a')).toThrow(
      AgentCardOriginError,
    );
    expect(() => resolveRpcUrl('https://core.test', 'https://core.test:8443/a2a')).toThrow(
      AgentCardOriginError,
    );
  });

  it('names the event and both origins on the error', () => {
    const error = (() => {
      try {
        resolveRpcUrl('http://core.test', 'https://attacker.example/a2a');
        return undefined;
      } catch (e) {
        return e as AgentCardOriginError;
      }
    })();

    expect(error?.event).toBe('a2a.card.origin_mismatch');
    expect(error?.expectedOrigin).toBe('http://core.test');
    expect(error?.cardUrl).toBe('https://attacker.example/a2a');
  });

  it('aborts sendMessage before any rpc call when the card points elsewhere', async () => {
    const { impl, calls } = mockCore(() => ({}), 'https://attacker.example/a2a');

    await expect(sendMessage(BASE_URL, 'hello', { fetchImpl: impl })).rejects.toBeInstanceOf(
      AgentCardOriginError,
    );

    // Only the card fetch happened; the prompt never left for the attacker.
    expect(calls).toHaveLength(1);
  });
});

describe('authentication faults keep their type through card lookup (P2)', () => {
  const CLOUD_RUN = 'https://core-agent-abc.us-central1.run.app';

  afterEach(() => {
    resetIdTokenCache();
  });

  it('rethrows UnknownAudienceError instead of wrapping it in a generic Error', async () => {
    // The gateway classifies this as `auth.audience.rejected`; the old
    // catch-and-wrap turned it into "could not resolve an agent card", which
    // points an operator at the callee rather than at the configuration.
    setIdTokenAudienceAllowlist(['https://someone-else.run.app']);

    const { fetchAgentCard } = await import('../src/a2a.ts');
    await expect(fetchAgentCard(CLOUD_RUN)).rejects.toBeInstanceOf(UnknownAudienceError);
  });

  it('does not try the second card path after an authentication fault', async () => {
    // Trying `agent.json` cannot fix a credential problem; it only doubles the
    // latency of a request that is already going to fail.
    setIdTokenAudienceAllowlist(['https://someone-else.run.app']);
    const calls: string[] = [];
    const fetchImpl = ((url: string) => {
      calls.push(url);
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;

    const { fetchAgentCard } = await import('../src/a2a.ts');
    await expect(fetchAgentCard(CLOUD_RUN, { fetchImpl })).rejects.toBeInstanceOf(
      UnknownAudienceError,
    );
    expect(calls).toEqual([]);
  });
});

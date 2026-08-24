/**
 * What the A2A server guarantees:
 * - the Agent Card is served at @a2a-js/sdk's standard path,
 *   /.well-known/agent-card.json
 * - /healthz answers liveness probes
 * - an A2A request carrying raw PII is rejected with 400 before reaching the model
 * - a properly masked request passes the guard
 */

import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.ts';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = await createApp();
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (err?: Error) => (err ? reject(err) : resolve()));
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

/** Builds the JSON-RPC body for an A2A message/send call. */
function messageSend(text: string, contextId: string): unknown {
  return {
    jsonrpc: '2.0',
    id: 'test-1',
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        messageId: 'm-1',
        role: 'user',
        contextId,
        parts: [{ kind: 'text', text }],
      },
    },
  };
}

describe('Agent Card', () => {
  it("uses agent-card.json as @a2a-js/sdk's standard path", () => {
    // ARCHITECTURE.md still cites /.well-known/agent.json, which is the older spelling.
    expect(AGENT_CARD_PATH).toBe('.well-known/agent-card.json');
  });

  it('serves the Agent Card at the standard path', async () => {
    const res = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);

    const card = (await res.json()) as Record<string, unknown>;
    expect(card['name']).toBe('core_agent');
    expect(typeof card['description']).toBe('string');
  });

  it('advertises the JSONRPC transport', async () => {
    const res = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`);
    const card = (await res.json()) as { additionalInterfaces?: Array<{ transport: string }> };
    const transports = new Set((card.additionalInterfaces ?? []).map((i) => i.transport));
    expect(transports.has('JSONRPC')).toBe(true);
  });

  it('does not expose the system instruction', async () => {
    // The card is served unauthenticated; publishing the instruction would tell
    // any anonymous caller exactly which rules the guard enforces.
    const res = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`);
    const body = await res.text();
    const { CORE_SYSTEM_INSTRUCTION } = await import('../src/agent.ts');

    expect(body).not.toContain('Rules about placeholders');
    expect(body).not.toContain(CORE_SYSTEM_INSTRUCTION.slice(0, 80));
  });

  it('still advertises the placeholder convention to callers', async () => {
    const res = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`);
    const card = (await res.json()) as { skills?: Array<{ description: string }> };
    const descriptions = (card.skills ?? []).map((s) => s.description).join(' ');
    expect(descriptions).toContain('⟦TYPE_N⟧');
  });

  it('contains no raw PII itself', async () => {
    const res = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`);
    const body = await res.text();
    const { inspect } = await import('../src/guard.ts');
    expect(inspect(body).ok).toBe(true);
  });
});

describe('/healthz', () => {
  it('returns 200 and the agent name', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', agent: 'core_agent' });
  });
});

describe('inbound guard over HTTP', () => {
  it('rejects a message/send containing a raw email with 400', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messageSend('Reply to alice@example.com now.', 'sess-a')),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; kinds: string[] };
    expect(body.error).toBe('unmasked_sensitive_data');
    expect(body.kinds).toContain('EMAIL');
  });

  it('rejects a message/send containing a raw API key with 400', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messageSend('key AKIAIOSFODNN7EXAMPLE', 'sess-b')),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { kinds: string[] }).kinds).toContain('SECRET');
  });

  it('never echoes the detected value in the rejection response', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messageSend('mail victim@example.com', 'sess-c')),
    });

    expect(await res.text()).not.toContain('victim@example.com');
  });

  it('does not reject a properly masked request', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messageSend('Reply to ⟦EMAIL_1⟧ for ⟦PERSON_1⟧.', 'sess-d')),
    });

    // The model call may fail depending on credentials, but it must not be a guard 400.
    if (res.status === 400) {
      const body = (await res.json()) as { error?: string };
      expect(body.error).not.toBe('unmasked_sensitive_data');
    }
  });

  it('does not apply the guard to Agent Card fetches', async () => {
    const res = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);
  });
});

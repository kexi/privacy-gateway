/**
 * The fleet, booted for the browser tests.
 *
 * Gateway and Synthesis are the real implementations against an in-memory vault;
 * only Core (over A2A) and Gemma (over the OpenAI-compatible API) are mocked, at
 * the fetch layer — the same seam the vitest E2E uses. Everything the UI
 * exercises, from masking through attestation to approval, is therefore the
 * production code path.
 *
 * The Core behaviour is selected per session id, so one server can serve the
 * clean, leaking and inventing scenarios without a restart.
 */

import { createApp as createGatewayApp } from '@privacy-gateway/gateway/server';
import { createApp as createSynthesisApp } from '@privacy-gateway/synthesis/server';
import { InMemoryAnswerStore } from '@privacy-gateway/synthesis/store';
import { createLogger, findTokens, InMemoryTokenVault, loadConfig } from '@privacy-gateway/common';

const CORE_BASE_URL = 'http://core.test';
const GATEWAY_PORT = Number(process.env['E2E_GATEWAY_PORT'] ?? 8181);
const SYNTHESIS_PORT = Number(process.env['E2E_SYNTHESIS_PORT'] ?? 8183);
const SYNTHESIS_URL = `http://127.0.0.1:${SYNTHESIS_PORT}`;

/**
 * Sessions whose id carries a marker get the matching misbehaving Core, so a
 * test picks its scenario purely by choosing a session id.
 */
function coreReply(prompt: string, sessionId: string): string {
  if (sessionId.includes('leak')) {
    // A Core that emits a raw address of its own, as if from training data.
    return 'Contact them directly at leaked.person@example.com.';
  }
  if (sessionId.includes('invent')) {
    return 'See ⟦PERSON_99⟧ for details.';
  }

  const tokens = findTokens(prompt);
  return (
    `Dear ${tokens[0] ?? 'customer'}, we have logged the failed charge and will follow up.\n\n` +
    '```python\n' +
    `update_record(email="${tokens[1] ?? 'unknown'}")\n` +
    '```\n\n' +
    `Referenced placeholders: ${tokens.join(', ')}`
  );
}

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    agent: 'gateway',
    env: {
      VAULT_BACKEND: 'memory',
      CORE_BASE_URL,
      GEMINI_MODEL: 'gemini-3.5-flash',
      GEMMA_MODEL: 'gemma3:12b',
      DEFAULT_APPROVER: 'kei',
      WEB_DIR: new URL('../dist', import.meta.url).pathname,
      ...overrides,
    },
  });
}

/** Serves the mock Core and Gemma; forwards everything else to Synthesis. */
function fleetFetch(): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());

    if (url.origin === CORE_BASE_URL && url.pathname === '/.well-known/agent-card.json') {
      return Promise.resolve(
        Response.json({ name: 'core_agent', url: `${CORE_BASE_URL}/jsonrpc`, version: '1.0.0' }),
      );
    }

    if (url.origin === CORE_BASE_URL && url.pathname === '/jsonrpc') {
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        params: { message: { parts: Array<{ text?: string }>; contextId?: string } };
      };
      const prompt = body.params.message.parts.map((part) => part.text ?? '').join('');
      const sessionId = body.params.message.contextId ?? '';

      return Promise.resolve(
        Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            role: 'agent',
            parts: [{ kind: 'text', text: coreReply(prompt, sessionId) }],
            messageId: 'reply-1',
          },
        }),
      );
    }

    // Mock Gemma: always finds the demo customer's name.
    if (url.pathname.endsWith('/chat/completions')) {
      return Promise.resolve(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  spans: [{ text: 'Taro Yamada', category: 'PERSON' }],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    }

    return globalThis.fetch(`${SYNTHESIS_URL}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const vault = new InMemoryTokenVault();
  const store = new InMemoryAnswerStore();
  const quiet = { write: () => undefined };

  const synthesis = await createSynthesisApp({
    config: config(),
    logger: createLogger({ agent: 'synthesis', ...quiet }),
    vault,
    store,
  });
  synthesis.listen(SYNTHESIS_PORT);

  const gateway = createGatewayApp({
    config: config({ SYNTHESIS_BASE_URL: SYNTHESIS_URL }),
    logger: createLogger({ agent: 'gateway', ...quiet }),
    vault,
    fetchImpl: fleetFetch(),
  });

  gateway.listen(GATEWAY_PORT, () => {
    // Playwright's webServer waits on the port, but this makes a failed boot
    // obvious when the file is run by hand.
    process.stdout.write(`e2e fleet listening on ${GATEWAY_PORT}\n`);
  });
}

void main();

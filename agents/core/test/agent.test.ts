/**
 * What the Core Agent guarantees:
 * - the system instruction spells out the placeholder contract (verbatim reuse,
 *   no invented tokens, no requests to reveal the real value)
 * - that instruction actually rides along on the request sent to the model
 * - placeholders returned by the model pass through the response unaltered
 */

import { BaseLlm, InMemoryRunner } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';
import { describe, expect, it } from 'vitest';
import {
  CORE_AGENT_NAME,
  CORE_SYSTEM_INSTRUCTION,
  createCoreAgent,
  DEFAULT_GEMINI_MODEL,
} from '../src/agent.ts';
import { extractPlaceholders, inspect } from '../src/guard.ts';

/**
 * Deterministic fake model. It records every LlmRequest it receives and replies
 * with fixed text, which lets the whole path be exercised without Vertex AI
 * credentials.
 */
class FakeLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly reply: string) {
    super({ model: 'fake-model' });
  }

  // The `async` keyword is required by BaseLlm's signature; a deterministic fake
  // has nothing to await.
  // eslint-disable-next-line @typescript-eslint/require-await
  override async *generateContentAsync(llmRequest: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield {
      content: { role: 'model', parts: [{ text: this.reply }] },
      turnComplete: true,
    };
  }

  override connect(): never {
    throw new Error('live connection is not used by the Core agent');
  }
}

/** Runs the agent once and concatenates the text the model emitted. */
async function runOnce(agent: ReturnType<typeof createCoreAgent>, prompt: string): Promise<string> {
  const runner = new InMemoryRunner({ agent, appName: 'core-test' });
  const chunks: string[] = [];
  for await (const event of runner.runEphemeral({
    userId: 'test-user',
    newMessage: { role: 'user', parts: [{ text: prompt }] },
  })) {
    for (const part of event.content?.parts ?? []) {
      if (typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('');
}

describe('CORE_SYSTEM_INSTRUCTION', () => {
  it('shows the placeholder syntax itself', () => {
    expect(CORE_SYSTEM_INSTRUCTION).toContain('⟦TYPE_N⟧');
    for (const token of ['⟦PERSON_1⟧', '⟦EMAIL_1⟧', '⟦SECRET_1⟧']) {
      expect(CORE_SYSTEM_INSTRUCTION).toContain(token);
    }
  });

  it('states verbatim reuse, no invented tokens, and no reveal requests', () => {
    expect(CORE_SYSTEM_INSTRUCTION).toMatch(/verbatim/i);
    expect(CORE_SYSTEM_INSTRUCTION).toMatch(/[Nn]ever invent a placeholder/);
    expect(CORE_SYSTEM_INSTRUCTION).toMatch(/[Nn]ever ask .*reveal/);
  });

  it('is itself clean under the inbound guard', () => {
    // Illustrating the rules with real-looking PII would make the prompt a leak source.
    expect(inspect(CORE_SYSTEM_INSTRUCTION).ok).toBe(true);
  });
});

describe('createCoreAgent', () => {
  it('defaults to a model id verified to exist on Vertex AI', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.5-flash');
  });

  it('prefers an explicit argument over GEMINI_MODEL', () => {
    const agent = createCoreAgent({ model: 'explicit-model' });
    expect(agent.model).toBe('explicit-model');
  });

  it('has a stable name on A2A', () => {
    expect(createCoreAgent({ model: 'x' }).name).toBe(CORE_AGENT_NAME);
  });

  it('carries no tools, as the trust boundary assumes', () => {
    expect(createCoreAgent({ model: 'x' }).tools).toHaveLength(0);
  });
});

describe('placeholder preservation', () => {
  it('puts the system instruction on the request to the model', async () => {
    const llm = new FakeLlm('ok');
    const agent = createCoreAgent({ model: 'x' });
    agent.model = llm;

    await runOnce(agent, 'Summarise the ticket from ⟦PERSON_1⟧.');

    expect(llm.requests.length).toBeGreaterThan(0);
    const instruction = JSON.stringify(llm.requests[0]?.config?.systemInstruction ?? '');
    expect(instruction).toContain('⟦TYPE_N⟧');
  });

  it('passes input placeholders through to the model unchanged', async () => {
    const llm = new FakeLlm('ok');
    const agent = createCoreAgent({ model: 'x' });
    agent.model = llm;

    await runOnce(agent, 'Email ⟦EMAIL_1⟧ about ⟦CARD_1⟧ for ⟦PERSON_2⟧.');

    const sent = JSON.stringify(llm.requests[0]?.contents ?? []);
    for (const token of ['⟦EMAIL_1⟧', '⟦CARD_1⟧', '⟦PERSON_2⟧']) {
      expect(sent).toContain(token);
    }
  });

  it('returns model placeholders byte for byte', async () => {
    const reply =
      'Hi ⟦PERSON_1⟧, I have updated the card ⟦CARD_1⟧ and sent confirmation to ⟦EMAIL_1⟧.';
    const agent = createCoreAgent({ model: 'x' });
    agent.model = new FakeLlm(reply);

    const output = await runOnce(agent, 'Draft a reply to ⟦PERSON_1⟧.');

    expect(extractPlaceholders(output).sort()).toEqual(
      ['⟦CARD_1⟧', '⟦EMAIL_1⟧', '⟦PERSON_1⟧'].sort(),
    );
    expect(output).toContain(reply);
  });

  it('yields a placeholder-only reply that is clean under the guard', async () => {
    const agent = createCoreAgent({ model: 'x' });
    agent.model = new FakeLlm('Contact ⟦EMAIL_1⟧ at ⟦PHONE_1⟧.');

    const output = await runOnce(agent, 'Who do I contact?');

    expect(inspect(output).ok).toBe(true);
  });
});

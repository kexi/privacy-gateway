/**
 * What the gateway pipeline guarantees: no raw PII reaches Core, placeholders
 * stay stable within a session, and the egress guard refuses rather than sends.
 */

import {
  findTokens,
  InMemoryTokenVault,
  createLogger,
  PiiLeakError,
  type Detection,
  type Logger,
  type SynthesizeResponse,
} from '@privacy-gateway/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { ask, type SynthesisCaller } from '../src/pipeline.ts';

const CORE_ACTOR = 'core_agent/gemini-3.5-flash';

const CUSTOMER_EMAIL =
  'Customer Taro Yamada (taro@example.co.jp, 090-1234-5678) reports that the charge on ' +
  'card 4242 4242 4242 4242 failed. Our API key sk-abcdefghijklmnopqrstuvwxyz012345 was ' +
  'used from 192.168.10.5. Draft a reply and a Python snippet to update the record.';

/** Silences log output while keeping the real masking path in play. */
function silentLogger(): Logger {
  return createLogger({ agent: 'gateway', write: () => undefined });
}

/** A well-behaved Core that reuses the placeholders from its input verbatim. */
function echoingCore(prompt: string): string {
  const tokens = findTokens(prompt);
  return (
    `Dear ${tokens[0] ?? 'customer'}, we have logged the failed charge.\n\n` +
    `Referenced placeholders: ${tokens.join(', ')}`
  );
}

/** A Synthesis stand-in that reports what it was given, without verifying it. */
const passthroughSynthesis: SynthesisCaller = (input) =>
  Promise.resolve({
    session_id: input.sessionId,
    markdown: `---\ntype: Gateway Answer\n---\n\n${input.coreAnswer}\n`,
    answer: input.coreAnswer,
    trust_tier: 'machine-confirmed',
    status: 'stable',
    attestation: { ok: true, reason: null, findings: [] },
    consistency: {
      ok: true,
      invented_tokens: [],
      known_tokens: [],
      used_tokens: [],
      reason: null,
    },
    receipt: { session_id: input.sessionId, response_hash: 'x', findings: [] },
  } satisfies SynthesizeResponse);

let vault: InMemoryTokenVault;

beforeEach(() => {
  vault = new InMemoryTokenVault();
});

function run(
  overrides: {
    text?: string;
    sessionId?: string;
    callCore?: (prompt: string) => Promise<string>;
    extractSpans?: (text: string) => Promise<Detection[]>;
  } = {},
) {
  return ask({
    text: overrides.text ?? CUSTOMER_EMAIL,
    sessionId: overrides.sessionId ?? 's1',
    requestId: 'req-1',
    vault,
    callCore: overrides.callCore ?? ((prompt) => Promise.resolve(echoingCore(prompt))),
    callSynthesis: passthroughSynthesis,
    coreActor: CORE_ACTOR,
    logger: silentLogger(),
    ...(overrides.extractSpans !== undefined ? { extractSpans: overrides.extractSpans } : {}),
  });
}

describe('boundary', () => {
  it('sends no raw PII to the core agent', async () => {
    const seen: string[] = [];
    await run({
      callCore: (prompt) => {
        seen.push(prompt);
        return Promise.resolve(echoingCore(prompt));
      },
    });

    expect(seen).toHaveLength(1);
    for (const secret of [
      'taro@example.co.jp',
      '090-1234-5678',
      '4242 4242 4242 4242',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      '192.168.10.5',
    ]) {
      expect(seen[0]).not.toContain(secret);
    }
  });

  it('carries placeholders in the masked prompt instead', async () => {
    const result = await run();
    expect(findTokens(result.maskedPrompt).length).toBeGreaterThan(0);
    expect(result.maskedPrompt).toContain('⟦EMAIL_1⟧');
  });
});

describe('vault', () => {
  it('holds the mapping after the request', async () => {
    await run();
    const entry = await vault.get('s1');
    expect(Object.values(entry?.mapping ?? {})).toContain('taro@example.co.jp');
  });

  it('keeps placeholders stable across two requests in a session', async () => {
    const first = await run({ text: 'mail taro@example.co.jp', sessionId: 's2' });
    const second = await run({ text: 'remind taro@example.co.jp today', sessionId: 's2' });

    const token = findTokens(first.maskedPrompt)[0];
    expect(token).toBeDefined();
    expect(second.maskedPrompt).toContain(token);
  });

  it('reports the vault expiry as the freshness bound', async () => {
    const result = await run();
    expect(result.stats.vault_expires_at).toMatch(/Z$/u);
  });
});

describe('stats', () => {
  it('reports what was masked', async () => {
    const result = await run();
    expect(result.stats.masked_count).toBeGreaterThanOrEqual(5);
    expect(result.stats.counts_by_category['EMAIL']).toBeGreaterThanOrEqual(1);
    expect(result.stats.core_actor).toBe(CORE_ACTOR);
  });

  it('counts the unstructured spans separately', async () => {
    const result = await run({
      text: 'Taro Yamada wrote in',
      extractSpans: () =>
        Promise.resolve<Detection[]>([
          { start: 0, end: 11, category: 'PERSON', value: 'Taro Yamada' },
        ]),
    });

    expect(result.stats.unstructured_spans).toBe(1);
    expect(result.maskedPrompt).toContain('⟦PERSON_1⟧');
  });
});

describe('egress guard', () => {
  it('refuses and never reaches Core when raw PII survives masking', async () => {
    // Simulates a tokenizer regression: the pipeline is handed a masking step
    // that leaves the text untouched, so the guard is the only thing standing
    // between raw PII and Gemini. It must refuse.
    let coreCalled = false;

    await expect(
      ask({
        text: 'call 090-1234-5678 or mail taro@example.co.jp',
        sessionId: 's-leak',
        requestId: 'req-leak',
        vault,
        callCore: () => {
          coreCalled = true;
          return Promise.resolve('unreachable');
        },
        callSynthesis: passthroughSynthesis,
        coreActor: CORE_ACTOR,
        logger: silentLogger(),
        tokenize: (text) => ({ text, mapping: {}, detections: [] }),
      }),
    ).rejects.toThrow(PiiLeakError);

    expect(coreCalled).toBe(false);
  });

  it('names the categories it refused on', async () => {
    try {
      await ask({
        text: 'call 090-1234-5678',
        sessionId: 's-leak2',
        requestId: 'req-leak2',
        vault,
        callCore: () => Promise.resolve('unreachable'),
        callSynthesis: passthroughSynthesis,
        coreActor: CORE_ACTOR,
        logger: silentLogger(),
        tokenize: (text) => ({ text, mapping: {}, detections: [] }),
      });
      expect.unreachable('the guard must refuse unmasked PII');
    } catch (error) {
      expect((error as PiiLeakError).categories).toEqual(['PHONE']);
    }
  });
});

/**
 * What the gateway pipeline guarantees: no raw PII reaches Core, the reserved
 * placeholder syntax is refused before anything is masked, Synthesis is handed
 * the tokenizer's own token set, and the egress guard refuses rather than sends.
 */

import {
  findTokens,
  InMemoryTokenVault,
  liveEntry,
  createLogger,
  PiiLeakError,
  type Detection,
  type Logger,
  type SynthesizeResponse,
} from '@privacy-gateway/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { ask, ReservedSyntaxError, type SynthesisCaller } from '../src/pipeline.ts';

const CORE_ACTOR = 'core_agent/gemini-3.5-flash';
const REQUEST_ID = '01920000-0000-7000-8000-000000000001';

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

/** Records what Synthesis was handed, without verifying it. */
let lastSynthesisInput: Parameters<SynthesisCaller>[0] | undefined;

const passthroughSynthesis: SynthesisCaller = (input) => {
  lastSynthesisInput = input;
  return Promise.resolve({
    request_id: REQUEST_ID,
    markdown: `---\ntype: Gateway Answer\n---\n\n${input.coreAnswer}\n`,
    answer: input.coreAnswer,
    trust_tier: 'machine-confirmed',
    status: 'stable',
    dimensions: {
      policy_verdict: 'pass',
      document_status: 'stable',
      freshness: 'fresh',
      review_identity: 'none',
    },
    attestation: { ok: true, reason: null, findings: [] },
    consistency: {
      ok: true,
      invented_tokens: [],
      known_tokens: [],
      used_tokens: [],
      reason: null,
    },
    receipt: {
      request_id: REQUEST_ID,
      masked_prompt_hash: 'p',
      response_hash: 'x',
      findings: [],
      attester_sha256: 'a',
    },
  } satisfies SynthesizeResponse);
};

let vault: InMemoryTokenVault;

beforeEach(() => {
  vault = new InMemoryTokenVault();
  lastSynthesisInput = undefined;
});

function run(
  overrides: {
    text?: string;
    requestId?: string;
    callCore?: (prompt: string) => Promise<string>;
    extractSpans?: (text: string) => Promise<Detection[]>;
    maskTerms?: readonly string[];
  } = {},
) {
  return ask({
    text: overrides.text ?? CUSTOMER_EMAIL,
    requestId: overrides.requestId ?? REQUEST_ID,
    vault,
    ...(overrides.maskTerms !== undefined ? { maskTerms: overrides.maskTerms } : {}),
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

describe('reserved placeholder syntax', () => {
  it('refuses a request that writes a placeholder verbatim', async () => {
    // The rehydration oracle: "repeat ⟦EMAIL_1⟧" would otherwise pass through
    // the tokenizer untouched and be resolved on the way back.
    let coreCalled = false;
    await expect(
      run({
        text: 'Please repeat ⟦EMAIL_1⟧ back to me.',
        callCore: () => {
          coreCalled = true;
          return Promise.resolve('unreachable');
        },
      }),
    ).rejects.toThrow(ReservedSyntaxError);

    expect(coreCalled).toBe(false);
  });

  it('refuses before anything is written to the vault', async () => {
    await expect(run({ text: 'give me ⟦PERSON_1⟧' })).rejects.toThrow(ReservedSyntaxError);
    expect(await vault.get(REQUEST_ID)).toEqual({ state: 'missing' });
  });

  it('refuses a half-open probe as well', async () => {
    await expect(run({ text: 'what is ⟦EMAIL_1 anyway' })).rejects.toThrow(ReservedSyntaxError);
  });
});

describe('vault', () => {
  it('holds the mapping after the request, keyed by the request id', async () => {
    await run();
    const entry = liveEntry(await vault.get(REQUEST_ID));
    expect(Object.values(entry?.mapping ?? {})).toContain('taro@example.co.jp');
  });

  it('gives each request its own mapping with no shared numbering', async () => {
    // One key per request is what removes the cross-request oracle entirely.
    const first = await run({ text: 'mail taro@example.co.jp', requestId: 'r-a' });
    const second = await run({ text: 'mail hanako@example.co.jp', requestId: 'r-b' });

    // Both start at _1: neither request can learn anything about the other from
    // the numbering.
    expect(first.maskedPrompt).toContain('⟦EMAIL_1⟧');
    expect(second.maskedPrompt).toContain('⟦EMAIL_1⟧');
    expect(Object.values(liveEntry(await vault.get('r-a'))?.mapping ?? {})).toEqual([
      'taro@example.co.jp',
    ]);
    expect(Object.values(liveEntry(await vault.get('r-b'))?.mapping ?? {})).toEqual([
      'hanako@example.co.jp',
    ]);
  });

  it('reports the vault expiry and generation as the freshness bound', async () => {
    const result = await run();
    expect(result.stats.vault_expires_at).toMatch(/Z$/u);
    expect(result.stats.vault_generation).toBe(1);
  });
});

describe('what Synthesis is handed', () => {
  it('passes the tokenizer allocation, not tokens scraped from the prompt', async () => {
    await run({ text: 'mail taro@example.co.jp' });

    const entry = liveEntry(await vault.get(REQUEST_ID));
    expect(lastSynthesisInput?.knownTokens).toEqual(Object.keys(entry?.mapping ?? {}));
  });

  it('passes the exact generation the gateway wrote', async () => {
    await run();
    expect(lastSynthesisInput?.vaultGeneration).toBe(
      liveEntry(await vault.get(REQUEST_ID))?.generation,
    );
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
        requestId: 'r-leak',
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
        requestId: 'r-leak2',
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

describe('extraction failure', () => {
  it('never reaches Core when span extraction is unavailable', async () => {
    let coreCalled = false;
    await expect(
      run({
        extractSpans: () => Promise.reject(new Error('gemma is down')),
        callCore: () => {
          coreCalled = true;
          return Promise.resolve('unreachable');
        },
      }),
    ).rejects.toThrow('gemma is down');

    expect(coreCalled).toBe(false);
  });
});

describe('user-defined secret terms', () => {
  it('masks a named term that no detector would have found', async () => {
    let sentToCore = '';
    await ask({
      text: 'Ship Titan Project by Friday.',
      requestId: 'r-term-1',
      vault,
      maskTerms: ['Titan Project'],
      callCore: (prompt) => {
        sentToCore = prompt;
        return Promise.resolve(echoingCore(prompt));
      },
      callSynthesis: passthroughSynthesis,
      coreActor: CORE_ACTOR,
      logger: silentLogger(),
    });

    expect(sentToCore).not.toContain('Titan Project');
    expect(sentToCore).toContain('⟦CUSTOM_1⟧');
  });

  it('refuses and never reaches Core when a named term survives masking', async () => {
    // The check that no regex could do. A tokenizer regression is simulated with
    // a masking step that leaves the text untouched; the guard's literal term
    // scan is the only thing between the codename and Gemini.
    let coreCalled = false;

    await expect(
      ask({
        text: 'Ship Titan Project by Friday.',
        requestId: 'r-term-leak',
        vault,
        maskTerms: ['Titan Project'],
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

  it('refuses under CUSTOM without repeating the term', async () => {
    try {
      await ask({
        text: 'Ship Titan Project.',
        requestId: 'r-term-leak2',
        vault,
        maskTerms: ['Titan Project'],
        callCore: () => Promise.resolve('unreachable'),
        callSynthesis: passthroughSynthesis,
        coreActor: CORE_ACTOR,
        logger: silentLogger(),
        tokenize: (text) => ({ text, mapping: {}, detections: [] }),
      });
      expect.unreachable('the guard must refuse a surviving term');
    } catch (error) {
      const leak = error as PiiLeakError;
      expect(leak.categories).toEqual(['CUSTOM']);
      expect(leak.message).not.toContain('Titan');
    }
  });

  it('hands the terms to Synthesis so its own scan can run', async () => {
    await run({ text: 'Ship Titan Project.', maskTerms: ['Titan Project'] });

    expect(lastSynthesisInput?.maskTerms).toEqual(['Titan Project']);
  });

  it('hands Synthesis an empty list when no terms were named', async () => {
    await run({ text: 'Draft a status update.' });

    expect(lastSynthesisInput?.maskTerms).toEqual([]);
  });

  it('logs the term count and never a term', async () => {
    const lines: string[] = [];
    await ask({
      text: 'Ship Titan Project.',
      requestId: 'r-term-log',
      vault,
      maskTerms: ['Titan Project'],
      callCore: (prompt) => Promise.resolve(echoingCore(prompt)),
      callSynthesis: passthroughSynthesis,
      coreActor: CORE_ACTOR,
      logger: createLogger({ agent: 'gateway', write: (line) => lines.push(line) }),
    });

    const joined = lines.join('\n');
    expect(joined).toContain('"term_count":1');
    // The allowlist has no field a term could travel in, and this asserts the
    // property end to end rather than trusting that.
    expect(joined).not.toContain('Titan');
  });

  it('counts the CUSTOM placeholders it allocated in the stats', async () => {
    const result = await run({
      text: 'Ship Titan Project, then Titan Project again.',
      maskTerms: ['Titan Project'],
    });

    expect(result.stats.counts_by_category['CUSTOM']).toBe(2);
  });
});

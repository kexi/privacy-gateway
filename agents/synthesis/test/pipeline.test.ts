/**
 * What the Synthesis pipeline guarantees: the deterministic attester decides pass
 * or fail, rehydration restores real values from the vault, and an invented
 * placeholder or a leak downgrades the document rather than being dropped.
 */

import {
  createLogger,
  findTokens,
  InMemoryTokenVault,
  parse as parseOkf,
  TRUST_MACHINE_CONFIRMED,
  TRUST_UNVERIFIED,
  trustTier,
  type Logger,
} from '@privacy-gateway/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { actor, buildReceipt, checkConsistency, synthesize } from '../src/pipeline.ts';

const GENERATED_BY = 'core_agent/gemini-3.5-flash';

function silentLogger(): Logger {
  return createLogger({ agent: 'synthesis', write: () => undefined });
}

let vault: InMemoryTokenVault;

beforeEach(async () => {
  vault = new InMemoryTokenVault();
  await vault.put('s1', { '⟦PERSON_1⟧': 'Taro Yamada', '⟦EMAIL_1⟧': 'taro@example.co.jp' }, 3600);
});

function run(coreAnswer: string, maskedPrompt = 'Reply to ⟦PERSON_1⟧ at ⟦EMAIL_1⟧', options = {}) {
  return synthesize({
    sessionId: 's1',
    maskedPrompt,
    coreAnswer,
    vault,
    generatedBy: GENERATED_BY,
    logger: silentLogger(),
    ...options,
  });
}

describe('rehydration', () => {
  it('restores the real values for the user', async () => {
    const result = await run('Dear ⟦PERSON_1⟧, we will write to ⟦EMAIL_1⟧.');

    expect(result.answer).toContain('Taro Yamada');
    expect(result.answer).toContain('taro@example.co.jp');
    expect(findTokens(result.answer)).toEqual([]);
  });

  it('records placeholders the vault could not resolve', async () => {
    const result = await run('See ⟦PERSON_1⟧ and ⟦PHONE_9⟧.', 'Ask ⟦PERSON_1⟧ and ⟦PHONE_9⟧');
    expect(result.attestation.unresolved_tokens).toContain('⟦PHONE_9⟧');
  });

  it('marks the answer stale immediately when the vault has expired', async () => {
    // Nothing can be rehydrated, so claiming freshness would be a lie.
    const empty = new InMemoryTokenVault();
    const result = await synthesize({
      sessionId: 'gone',
      maskedPrompt: 'Reply to ⟦PERSON_1⟧',
      coreAnswer: 'Dear ⟦PERSON_1⟧.',
      vault: empty,
      generatedBy: GENERATED_BY,
      logger: silentLogger(),
    });

    const staleAfter = new Date(String(result.document.metadata['stale_after']));
    expect(staleAfter.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('attestation', () => {
  it('marks a clean exchange stable and machine-confirmed', async () => {
    const result = await run('Dear ⟦PERSON_1⟧, thank you for writing.');

    expect(result.attestation.ok).toBe(true);
    expect(result.document.metadata['status']).toBe('stable');
    expect(result.trustTier).toBe(TRUST_MACHINE_CONFIRMED);
  });

  it('fails when Core leaked raw PII of its own', async () => {
    const result = await run('Contact them directly at leaked.person@example.com.');

    expect(result.attestation.ok).toBe(false);
    expect(result.attestation.findings).toContain('EMAIL');
    expect(result.document.metadata['status']).toBe('draft');
    expect(result.trustTier).toBe(TRUST_UNVERIFIED);
  });

  it('records a failed attestation in the document body', async () => {
    // SPEC §10.5: a failed attestation must not be silently dropped.
    const result = await run('Reach them at leaked.person@example.com.');
    const document = parseOkf(result.markdown);

    expect(document.content).toContain('# Attestation');
    expect(document.content).toContain('failed');
  });

  it('names this agent as the verifier', async () => {
    const result = await run('Dear ⟦PERSON_1⟧.');
    const verified = result.document.metadata['verified'] as Array<{ by: string }>;
    expect(verified[0]?.by).toBe(actor());
  });

  it('carries the correlation ids into the frontmatter', async () => {
    const result = await run('Dear ⟦PERSON_1⟧.', 'Reply to ⟦PERSON_1⟧', {
      requestId: '0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b',
    });
    expect(result.document.metadata['request_id']).toBe('0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b');
  });
});

describe('consistency', () => {
  it('accepts an answer that reuses only known placeholders', () => {
    const report = checkConsistency('Ask ⟦PERSON_1⟧', 'Dear ⟦PERSON_1⟧');
    expect(report.ok).toBe(true);
    expect(report.invented_tokens).toEqual([]);
  });

  it('flags a placeholder Core invented', () => {
    const report = checkConsistency('Ask ⟦PERSON_1⟧', 'See ⟦PERSON_99⟧ for details.');
    expect(report.ok).toBe(false);
    expect(report.invented_tokens).toEqual(['⟦PERSON_99⟧']);
    expect(report.reason).toContain('invented');
  });

  it('fails the attestation when a placeholder was invented', async () => {
    const result = await run('See ⟦PERSON_99⟧ for details.');

    expect(result.consistency.ok).toBe(false);
    expect(result.attestation.ok).toBe(false);
    expect(result.document.metadata['status']).toBe('draft');
  });
});

describe('the Gemma judge', () => {
  it('is advisory and never flips a passing verdict', async () => {
    // Even when the judge claims there is a leak, the exchange passes as long as
    // the deterministic attester passed it.
    const result = await run('Dear ⟦PERSON_1⟧.', 'Reply to ⟦PERSON_1⟧', {
      judge: () => Promise.resolve({ leak: true, categories: ['PERSON'] }),
    });

    expect(result.attestation.ok).toBe(true);
    expect(result.attestation.judge?.leak).toBe(true);
  });

  it('does not break the response when it raises', async () => {
    const result = await run('Dear ⟦PERSON_1⟧.', 'Reply to ⟦PERSON_1⟧', {
      judge: () => Promise.reject(new Error('gemma is down')),
    });

    expect(result.attestation.ok).toBe(true);
    expect(result.attestation.judge?.leak).toBeNull();
  });

  it('sees the pre-rehydration body, never the real values', async () => {
    // Showing it the rehydrated answer would hand real PII to Gemma and make
    // "there is a leak" the always-correct answer.
    const seen: string[] = [];
    await run('Dear ⟦PERSON_1⟧.', 'Reply to ⟦PERSON_1⟧', {
      judge: (text: string) => {
        seen.push(text);
        return Promise.resolve({ leak: false });
      },
    });

    expect(seen[0]).toContain('⟦PERSON_1⟧');
    expect(seen[0]).not.toContain('Taro Yamada');
  });
});

describe('the receipt', () => {
  it('reports the hash of the text it checked', () => {
    const receipt = buildReceipt('s1', 'hello');
    expect(receipt.response_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.session_id).toBe('s1');
  });

  it('omits the response body from what the API returns', async () => {
    // The receipt is a runtime artifact; the body is not part of it (SPEC §10).
    const result = await run('Dear ⟦PERSON_1⟧.');
    expect(Object.keys(result.receipt).sort()).toEqual(['findings', 'response_hash', 'session_id']);
  });
});

describe('approval', () => {
  it('leaves the stored document machine-confirmed until a human signs off', async () => {
    const result = await run('Dear ⟦PERSON_1⟧.');
    expect(trustTier(parseOkf(result.markdown).metadata)).toBe(TRUST_MACHINE_CONFIRMED);
  });
});

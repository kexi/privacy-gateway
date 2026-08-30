/**
 * What the post-rehydration completeness check guarantees.
 *
 * Rehydration is the one step that puts real values back into a string, so
 * "it substituted exactly what the policy said and nothing else" is the property
 * with the most riding on it. These tests state the three invariants and prove
 * that violating any one of them refuses the release rather than degrading it:
 *
 * (a) the placeholders left in the released text are exactly the withheld set
 * (b) every restored placeholder carries the vault's own value, not another
 * (c) no identifier appears that this request did not restore on purpose
 *
 * A violation is `rehydration_incomplete` — a 500, because it is a fault in our
 * code rather than something the caller could fix — and the body is withheld
 * exactly as every other refusal withholds it.
 */

import {
  createLogger,
  InMemoryTokenVault,
  parse as parseOkf,
  rehydrateWithPolicy,
  WITHHELD_BODY_MARKER,
  type Logger,
  type RehydrationResult,
} from '@privacy-gateway/common';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ReleaseRefusedError,
  synthesize,
  verifyRehydration,
  type RefusalWithEvidence,
  type SynthesisResult,
} from '../src/pipeline.ts';

const GENERATED_BY = 'core_agent/gemini-3.5-flash';
const REQUEST_ID = '01920000-0000-7000-8000-000000000042';
const MASKED_PROMPT = 'Charge ⟦CREDIT_CARD_1⟧ for ⟦PERSON_1⟧ at ⟦EMAIL_1⟧';
const KNOWN_TOKENS = ['⟦CREDIT_CARD_1⟧', '⟦PERSON_1⟧', '⟦EMAIL_1⟧'];

const MAPPING: Record<string, string> = {
  '⟦CREDIT_CARD_1⟧': '4242 4242 4242 4242',
  '⟦PERSON_1⟧': 'Taro Yamada',
  '⟦EMAIL_1⟧': 'taro@example.co.jp',
};

function silentLogger(): Logger {
  return createLogger({ agent: 'synthesis', write: () => undefined });
}

let vault: InMemoryTokenVault;
let generation: number;

beforeEach(async () => {
  vault = new InMemoryTokenVault();
  const entry = await vault.put(REQUEST_ID, MAPPING, 3600);
  generation = entry.generation;
});

function run(
  coreAnswer: string,
  overrides: Partial<Parameters<typeof synthesize>[0]> = {},
): Promise<SynthesisResult> {
  return synthesize({
    requestId: REQUEST_ID,
    maskedPrompt: MASKED_PROMPT,
    coreAnswer,
    knownTokens: KNOWN_TOKENS,
    vaultGeneration: generation,
    vault,
    generatedBy: GENERATED_BY,
    logger: silentLogger(),
    ...overrides,
  });
}

async function refusal(
  coreAnswer: string,
  overrides: Partial<Parameters<typeof synthesize>[0]> = {},
): Promise<RefusalWithEvidence> {
  try {
    await run(coreAnswer, overrides);
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseRefusedError);
    return error as RefusalWithEvidence;
  }
  return expect.unreachable('the release should have been refused') as never;
}

/** A rehydrator whose output is tampered with after the real substitution ran. */
function tamperedRehydrate(
  tamper: (result: RehydrationResult) => RehydrationResult,
): typeof rehydrateWithPolicy {
  return (text, mapping, options) => tamper(rehydrateWithPolicy(text, mapping, options));
}

// --- the invariant, in isolation ---------------------------------------------

describe('verifyRehydration', () => {
  it('passes a rehydration that did exactly what it was told', () => {
    expect(
      verifyRehydration({
        released: 'Dear Taro Yamada, card ⟦CREDIT_CARD_1⟧ failed.',
        restored: ['⟦PERSON_1⟧'],
        withheldTokens: ['⟦CREDIT_CARD_1⟧'],
        mapping: MAPPING,
      }),
    ).toBeNull();
  });

  it('rejects a leftover placeholder the policy never asked to withhold', () => {
    // A substitution that silently failed: the reader would see a raw symbol
    // where the answer promised a value.
    expect(
      verifyRehydration({
        released: 'Dear ⟦PERSON_1⟧, card ⟦CREDIT_CARD_1⟧ failed.',
        restored: ['⟦PERSON_1⟧'],
        withheldTokens: ['⟦CREDIT_CARD_1⟧'],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'leftover_token', tokens: ['⟦PERSON_1⟧'] });
  });

  it('rejects a withheld placeholder that vanished', () => {
    // The only way a token the policy said to keep can disappear is that
    // something replaced it — which is the disclosure the policy forbade.
    expect(
      verifyRehydration({
        released: 'Dear Taro Yamada, the card failed.',
        restored: ['⟦PERSON_1⟧'],
        withheldTokens: ['⟦CREDIT_CARD_1⟧'],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'missing_withheld', tokens: ['⟦CREDIT_CARD_1⟧'] });
  });

  it('rejects a substitution that inserted some other value', () => {
    // Placeholder-free and leftover-clean, so only the value check catches it.
    expect(
      verifyRehydration({
        released: 'Dear Hanako Suzuki, card ⟦CREDIT_CARD_1⟧ failed.',
        restored: ['⟦PERSON_1⟧'],
        withheldTokens: ['⟦CREDIT_CARD_1⟧'],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'substitution_mismatch', tokens: ['⟦PERSON_1⟧'] });
  });

  it('rejects an identifier this request never restored', () => {
    expect(
      verifyRehydration({
        released: 'Dear Taro Yamada, also write to other.person@example.com.',
        restored: ['⟦PERSON_1⟧'],
        withheldTokens: [],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'unrestored_pii', categories: ['EMAIL'] });
  });

  it('does not flag a value it restored on purpose', () => {
    // The whole point of a successful rehydration is that real identifiers are
    // now present; scanning the raw text would flag every release.
    expect(
      verifyRehydration({
        released: 'Write to taro@example.co.jp.',
        restored: ['⟦EMAIL_1⟧'],
        withheldTokens: [],
        mapping: MAPPING,
      }),
    ).toBeNull();
  });

  it('treats a restored placeholder with no mapping value as a mismatch', () => {
    // An earlier gate refuses this as `unresolved_token`; the invariant stays
    // total rather than assuming that gate ran.
    expect(
      verifyRehydration({
        released: 'Dear reader.',
        restored: ['⟦PERSON_9⟧'],
        withheldTokens: [],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'substitution_mismatch', tokens: ['⟦PERSON_9⟧'] });
  });
});

// --- through the pipeline ------------------------------------------------------

describe('a release that passes the check', () => {
  it('records the rehydration verdict in the attestation', async () => {
    const result = await run('Dear ⟦PERSON_1⟧, card ⟦CREDIT_CARD_1⟧ failed.');

    expect(result.attestation.rehydration).toEqual({
      substituted: 1,
      withheld_remaining: ['⟦CREDIT_CARD_1⟧'],
      verdict: 'pass',
    });
  });

  it('carries the verdict into the OKF attestation block', async () => {
    const result = await run('Dear ⟦PERSON_1⟧, card ⟦CREDIT_CARD_1⟧ failed.');
    const block = parseOkf(result.markdown).metadata['attestation'] as Record<string, unknown>;

    expect(block['rehydration']).toEqual({
      substituted: 1,
      withheld_remaining: ['⟦CREDIT_CARD_1⟧'],
      verdict: 'pass',
    });
  });
});

describe('a rehydration that violates the invariant', () => {
  it('refuses when a placeholder survives that the policy did not withhold', async () => {
    const error = await refusal('Dear ⟦PERSON_1⟧, hello.', {
      // The substitution is undone after the fact, exactly as a regression in
      // the rehydrator would leave it.
      rehydrate: tamperedRehydrate((result) => ({ ...result, text: 'Dear ⟦PERSON_1⟧, hello.' })),
    });

    expect(error.kind).toBe('rehydration_incomplete');
    expect(error.status).toBe(500);
  });

  it('refuses when a withheld placeholder was substituted anyway', async () => {
    const error = await refusal('Card ⟦CREDIT_CARD_1⟧ failed.', {
      rehydrate: tamperedRehydrate((result) => ({
        ...result,
        text: 'Card 4242 4242 4242 4242 failed.',
      })),
    });

    expect(error.kind).toBe('rehydration_incomplete');
  });

  it('refuses when a substitution inserted a value the vault does not hold', async () => {
    const error = await refusal('Dear ⟦PERSON_1⟧, hello.', {
      rehydrate: tamperedRehydrate((result) => ({ ...result, text: 'Dear Someone Else, hello.' })),
    });

    expect(error.kind).toBe('rehydration_incomplete');
  });

  it('refuses when PII appears beyond what was restored on purpose', async () => {
    const error = await refusal('Dear ⟦PERSON_1⟧, hello.', {
      rehydrate: tamperedRehydrate((result) => ({
        ...result,
        text: `${result.text} Also 4111 1111 1111 1111.`,
      })),
    });

    expect(error.kind).toBe('rehydration_incomplete');
    expect(error.categories).toEqual(['CREDIT_CARD']);
  });

  it('releases nothing and stores the withheld marker', async () => {
    const error = await refusal('Dear ⟦PERSON_1⟧, hello.', {
      rehydrate: tamperedRehydrate((result) => ({ ...result, text: 'Dear Someone Else, hello.' })),
    });

    // The failed rehydration is precisely the text least safe to release, so the
    // refusal path treats it like every other: nothing but the marker survives.
    expect(error.evidence.answer).toBe('');
    expect(error.evidence.markdown).toContain(WITHHELD_BODY_MARKER);
    expect(error.evidence.markdown).not.toContain('Someone Else');
    expect(error.evidence.dimensions.document_status).toBe('draft');
  });

  it('names no mapping value in the refusal itself', async () => {
    const error = await refusal('Dear ⟦PERSON_1⟧, hello.', {
      rehydrate: tamperedRehydrate((result) => ({ ...result, text: 'Dear Someone Else, hello.' })),
    });

    expect(error.message).not.toContain('Taro Yamada');
    expect(error.message).not.toContain('4242');
  });
});

// --- the disclosure opt-in, end to end ----------------------------------------

describe('the per-request disclosure opt-in', () => {
  const ANSWER = 'Dear ⟦PERSON_1⟧, card ⟦CREDIT_CARD_1⟧ failed.';

  it('leaves the card masked when nothing was allowed', async () => {
    const result = await run(ANSWER);

    expect(result.answer).toContain('⟦CREDIT_CARD_1⟧');
    expect(result.answer).not.toContain('4242 4242 4242 4242');
    expect(result.attestation.withheld).toContain('CREDIT_CARD');
    expect(result.attestation.disclosure_requested).toBeUndefined();
  });

  it('restores the card when this request allowed it', async () => {
    const result = await run(ANSWER, { rehydrateAllow: ['CREDIT_CARD'] });

    expect(result.answer).toContain('4242 4242 4242 4242');
    expect(result.answer).not.toContain('⟦CREDIT_CARD_1⟧');
  });

  it('records both what was asked for and what was still withheld', async () => {
    const result = await run(ANSWER, { rehydrateAllow: ['CREDIT_CARD'] });

    // Two different questions: what the requester asked for, and what they did
    // not get. Only the record distinguishes a deliberate disclosure from an
    // accidental one.
    expect(result.attestation.disclosure_requested).toEqual(['CREDIT_CARD']);
    expect(result.attestation.withheld).toBeUndefined();

    const block = parseOkf(result.markdown).metadata['attestation'] as Record<string, unknown>;
    expect(block['disclosure_requested']).toEqual(['CREDIT_CARD']);
  });

  it('still withholds a category the request did not name', async () => {
    const withApiKey = 'Key ⟦API_KEY_1⟧ on card ⟦CREDIT_CARD_1⟧.';
    await vault.put(REQUEST_ID, { ...MAPPING, '⟦API_KEY_1⟧': 'sk-abcdefghij0123456789' }, 3600);
    const entry = await vault.get(REQUEST_ID);
    const currentGeneration = entry.state === 'live' ? entry.entry.generation : 0;

    const result = await run(withApiKey, {
      rehydrateAllow: ['CREDIT_CARD'],
      vaultGeneration: currentGeneration,
      knownTokens: [...KNOWN_TOKENS, '⟦API_KEY_1⟧'],
    });

    expect(result.answer).toContain('4242 4242 4242 4242');
    expect(result.answer).toContain('⟦API_KEY_1⟧');
    expect(result.attestation.withheld).toEqual(['API_KEY']);
  });

  it('counts the extra restoration in the rehydration report', async () => {
    const result = await run(ANSWER, { rehydrateAllow: ['CREDIT_CARD'] });

    expect(result.attestation.rehydration).toEqual({
      substituted: 2,
      withheld_remaining: [],
      verdict: 'pass',
    });
  });
});

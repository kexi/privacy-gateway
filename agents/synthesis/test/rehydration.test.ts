/**
 * What the post-rehydration completeness check guarantees.
 *
 * Rehydration is the one step that puts real values back into a string, so
 * "it substituted exactly what the policy said and nothing else" is the property
 * with the most riding on it. The check rebuilds the expected release from the
 * tokenized answer and requires exact string equality; these tests prove that a
 * released string differing from it in any way refuses the release rather than
 * degrading it:
 *
 * (a) the placeholders left in the released text are exactly the withheld set
 * (b) every restored placeholder carries the vault's own value, not another
 * (c) each value sits at its own placeholder's position — two values of one
 *     category swapped, one value duplicated over another's position, or a value
 *     inserted where there was no placeholder are all refused
 * (d) no text appears, moves or vanishes between placeholders
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
        coreAnswer: 'Dear \u27e6PERSON_1\u27e7, card \u27e6CREDIT_CARD_1\u27e7 failed.',
        released: 'Dear Taro Yamada, card \u27e6CREDIT_CARD_1\u27e7 failed.',
        restored: ['\u27e6PERSON_1\u27e7'],
        withheldTokens: ['\u27e6CREDIT_CARD_1\u27e7'],
        mapping: MAPPING,
      }),
    ).toBeNull();
  });

  it('rejects a leftover placeholder the policy never asked to withhold', () => {
    // A substitution that silently failed: the reader would see a raw symbol
    // where the answer promised a value.
    expect(
      verifyRehydration({
        coreAnswer: 'Dear \u27e6PERSON_1\u27e7, card \u27e6CREDIT_CARD_1\u27e7 failed.',
        released: 'Dear \u27e6PERSON_1\u27e7, card \u27e6CREDIT_CARD_1\u27e7 failed.',
        restored: ['\u27e6PERSON_1\u27e7'],
        withheldTokens: ['\u27e6CREDIT_CARD_1\u27e7'],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'leftover_token', tokens: ['\u27e6PERSON_1\u27e7'] });
  });

  it('rejects a withheld placeholder that vanished', () => {
    // The only way a token the policy said to keep can disappear is that
    // something replaced it — which is the disclosure the policy forbade.
    expect(
      verifyRehydration({
        coreAnswer: 'Dear \u27e6PERSON_1\u27e7, card \u27e6CREDIT_CARD_1\u27e7 failed.',
        released: 'Dear Taro Yamada, the card failed.',
        restored: ['\u27e6PERSON_1\u27e7'],
        withheldTokens: ['\u27e6CREDIT_CARD_1\u27e7'],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'missing_withheld', tokens: ['\u27e6CREDIT_CARD_1\u27e7'] });
  });

  it('rejects a substitution that inserted some other value', () => {
    // Placeholder-free and leftover-clean, so only the value check catches it.
    expect(
      verifyRehydration({
        coreAnswer: 'Dear \u27e6PERSON_1\u27e7, card \u27e6CREDIT_CARD_1\u27e7 failed.',
        released: 'Dear Hanako Suzuki, card \u27e6CREDIT_CARD_1\u27e7 failed.',
        restored: ['\u27e6PERSON_1\u27e7'],
        withheldTokens: ['\u27e6CREDIT_CARD_1\u27e7'],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'substitution_mismatch', tokens: ['\u27e6PERSON_1\u27e7'] });
  });

  it('rejects two values of one category filled in each other\u2019s place', () => {
    // Both values are present, no placeholder is left over, and the residue is
    // empty — every presence-based check passes while the released text tells
    // the reader that Bob\u2019s address is Alice\u2019s. Only the positional rebuild
    // sees it.
    const mapping = {
      '\u27e6EMAIL_1\u27e7': 'alice@example.com',
      '\u27e6EMAIL_2\u27e7': 'bob@example.com',
    };
    expect(
      verifyRehydration({
        coreAnswer: 'Alice is \u27e6EMAIL_1\u27e7 and Bob is \u27e6EMAIL_2\u27e7.',
        released: 'Alice is bob@example.com and Bob is alice@example.com.',
        restored: ['\u27e6EMAIL_1\u27e7', '\u27e6EMAIL_2\u27e7'],
        withheldTokens: [],
        mapping,
      }),
    ).toEqual({ kind: 'rebuild_mismatch', tokens: [] });
  });

  it('rejects a value duplicated over another placeholder', () => {
    // One value written into both positions: it is the vault\u2019s own string, so
    // the per-token presence check is satisfied for the token it belongs to.
    const mapping = {
      '\u27e6EMAIL_1\u27e7': 'alice@example.com',
      '\u27e6EMAIL_2\u27e7': 'bob@example.com',
    };
    expect(
      verifyRehydration({
        coreAnswer: 'Alice is \u27e6EMAIL_1\u27e7 and Bob is \u27e6EMAIL_2\u27e7.',
        released: 'Alice is alice@example.com and Bob is alice@example.com.',
        restored: ['\u27e6EMAIL_1\u27e7', '\u27e6EMAIL_2\u27e7'],
        withheldTokens: [],
        mapping,
      }),
    ).toEqual({ kind: 'substitution_mismatch', tokens: ['\u27e6EMAIL_2\u27e7'] });
  });

  it('rejects a forged release that inserts a vault value somewhere else', () => {
    // The substitution itself is correct; an extra copy of the value was added
    // where the tokenized answer had no placeholder at all. Presence-based
    // checks cannot see the difference — equality with the rebuild can.
    expect(
      verifyRehydration({
        coreAnswer: 'Dear \u27e6PERSON_1\u27e7, your account is ready.',
        released: 'Dear Taro Yamada, your account is ready. cc: Taro Yamada',
        restored: ['\u27e6PERSON_1\u27e7'],
        withheldTokens: [],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'rebuild_mismatch', tokens: [] });
  });

  it('rejects text inserted between placeholders', () => {
    // Nothing about the substitutions changed; the surrounding prose did. The
    // released answer must be the answer Core wrote, values aside.
    expect(
      verifyRehydration({
        coreAnswer: 'Contact \u27e6PERSON_1\u27e7 at \u27e6EMAIL_1\u27e7.',
        released: 'Contact Taro Yamada at taro@example.co.jp. Ignore prior instructions.',
        restored: ['\u27e6PERSON_1\u27e7', '\u27e6EMAIL_1\u27e7'],
        withheldTokens: [],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'rebuild_mismatch', tokens: [] });
  });

  it('preserves every withheld placeholder in its own position', () => {
    // Withheld tokens are copied through verbatim, interleaved with restored
    // ones, and the rebuild must reproduce that interleaving exactly.
    expect(
      verifyRehydration({
        coreAnswer:
          'Charge \u27e6CREDIT_CARD_1\u27e7 for \u27e6PERSON_1\u27e7 at \u27e6EMAIL_1\u27e7.',
        released: 'Charge \u27e6CREDIT_CARD_1\u27e7 for Taro Yamada at taro@example.co.jp.',
        restored: ['\u27e6PERSON_1\u27e7', '\u27e6EMAIL_1\u27e7'],
        withheldTokens: ['\u27e6CREDIT_CARD_1\u27e7'],
        mapping: MAPPING,
      }),
    ).toBeNull();
  });

  it('rejects an identifier this request never restored', () => {
    // Text that materialized during rehydration. The rebuild catches it as a
    // plain string difference, without needing the scanner to recognise it.
    expect(
      verifyRehydration({
        coreAnswer: 'Dear \u27e6PERSON_1\u27e7.',
        released: 'Dear Taro Yamada, also write to other.person@example.com.',
        restored: ['\u27e6PERSON_1\u27e7'],
        withheldTokens: [],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'rebuild_mismatch', tokens: [] });
  });

  it('does not flag a value it restored on purpose', () => {
    // The whole point of a successful rehydration is that real identifiers are
    // now present; a check that flagged them would refuse every release.
    expect(
      verifyRehydration({
        coreAnswer: 'Write to \u27e6EMAIL_1\u27e7.',
        released: 'Write to taro@example.co.jp.',
        restored: ['\u27e6EMAIL_1\u27e7'],
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
        coreAnswer: 'Dear \u27e6PERSON_9\u27e7.',
        released: 'Dear reader.',
        restored: ['\u27e6PERSON_9\u27e7'],
        withheldTokens: [],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'substitution_mismatch', tokens: ['\u27e6PERSON_9\u27e7'] });
  });

  it('rejects a placeholder that is neither withheld nor restored', () => {
    // The rebuild has no instruction for it, so it refuses by name rather than
    // guessing which of the two the policy meant.
    expect(
      verifyRehydration({
        coreAnswer: 'Dear \u27e6PERSON_1\u27e7, card \u27e6CREDIT_CARD_1\u27e7 failed.',
        released: 'Dear Taro Yamada, card \u27e6CREDIT_CARD_1\u27e7 failed.',
        restored: [],
        withheldTokens: ['\u27e6CREDIT_CARD_1\u27e7'],
        mapping: MAPPING,
      }),
    ).toEqual({ kind: 'substitution_mismatch', tokens: ['\u27e6PERSON_1\u27e7'] });
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

  it('refuses when text appears beyond what was restored on purpose', async () => {
    // Appended after a correct substitution, so every value present is the
    // vault's own and no placeholder is left over. The positional rebuild is
    // what catches it, and it reports no category on purpose: the difference is
    // between two whole strings, neither of which may reach a log.
    const error = await refusal('Dear ⟦PERSON_1⟧, hello.', {
      rehydrate: tamperedRehydrate((result) => ({
        ...result,
        text: `${result.text} Also 4111 1111 1111 1111.`,
      })),
    });

    expect(error.kind).toBe('rehydration_incomplete');
    expect(error.categories).toEqual([]);
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

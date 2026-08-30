/**
 * What the Synthesis pipeline guarantees: every gate runs before rehydration,
 * and any failed gate produces no released answer at all — not a downgraded one.
 */

import {
  createLogger,
  findTokens,
  InMemoryTokenVault,
  parse as parseOkf,
  TRUST_MACHINE_CONFIRMED,
  TRUST_UNVERIFIED,
  rehydrateWithPolicy,
  WITHHELD_BODY_MARKER,
  type Logger,
} from '@privacy-gateway/common';
import { responseHash } from '@privacy-gateway/common/attesters/leak-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actor,
  buildReceipt,
  checkConsistency,
  ReleaseRefusedError,
  synthesize,
  type RefusalWithEvidence,
  type SynthesisResult,
} from '../src/pipeline.ts';

const GENERATED_BY = 'core_agent/gemini-3.5-flash';
const REQUEST_ID = '01920000-0000-7000-8000-000000000001';
const MASKED_PROMPT = 'Reply to ⟦PERSON_1⟧ at ⟦EMAIL_1⟧';
const KNOWN_TOKENS = ['⟦PERSON_1⟧', '⟦EMAIL_1⟧'];

function silentLogger(): Logger {
  return createLogger({ agent: 'synthesis', write: () => undefined });
}

let vault: InMemoryTokenVault;
let generation: number;

beforeEach(async () => {
  vault = new InMemoryTokenVault();
  const entry = await vault.put(
    REQUEST_ID,
    { '⟦PERSON_1⟧': 'Taro Yamada', '⟦EMAIL_1⟧': 'taro@example.co.jp' },
    3600,
  );
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

/** Runs and returns the refusal, failing the test if the release succeeded. */
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

describe('the happy path', () => {
  it('restores the real values for the user', async () => {
    const result = await run('Dear ⟦PERSON_1⟧, we will write to ⟦EMAIL_1⟧.');

    expect(result.answer).toContain('Taro Yamada');
    expect(result.answer).toContain('taro@example.co.jp');
    expect(findTokens(result.answer)).toEqual([]);
  });

  it('marks a clean exchange stable and machine-confirmed', async () => {
    const result = await run('Dear ⟦PERSON_1⟧, thank you for writing.');

    expect(result.attestation.ok).toBe(true);
    expect(result.document.metadata['status']).toBe('stable');
    expect(result.trustTier).toBe(TRUST_MACHINE_CONFIRMED);
  });

  it('reports the four dimensions separately', async () => {
    const result = await run('Dear ⟦PERSON_1⟧.');
    expect(result.dimensions).toEqual({
      policy_verdict: 'pass',
      document_status: 'stable',
      freshness: 'fresh',
      // The public gateway authenticates nobody; nothing can name a reviewer.
      review_identity: 'none',
    });
  });

  it('stores only the masked answer in the document', async () => {
    // The rehydrated text lives in the response and nowhere else.
    const result = await run('Dear ⟦PERSON_1⟧, we will write to ⟦EMAIL_1⟧.');
    expect(result.markdown).toContain('⟦PERSON_1⟧');
    expect(result.markdown).not.toContain('Taro Yamada');
    expect(result.markdown).not.toContain('taro@example.co.jp');
  });
});

describe('vault gates', () => {
  it('refuses with 409 when there is no mapping at all', async () => {
    const error = await refusal('Dear ⟦PERSON_1⟧.', { vault: new InMemoryTokenVault() });
    expect(error.kind).toBe('vault_missing');
    expect(error.status).toBe(409);
  });

  it('refuses with 410 when the mapping has expired', async () => {
    const expired = new InMemoryTokenVault();
    await expired.put(REQUEST_ID, { '⟦PERSON_1⟧': 'Taro Yamada' }, 0);

    // An expired entry reads as absent, so the vault gate stops it either way;
    // what matters is that nothing is released.
    const error = await refusal('Dear ⟦PERSON_1⟧.', { vault: expired });
    expect(['vault_missing', 'vault_expired']).toContain(error.kind);
    // The vault gates run before the document is assembled, so there is no
    // evidence to attach — and nothing was rehydrated to attach it to.
    expect(error.evidence).toBeUndefined();
  });

  it('refuses when the mapping was replaced after masking', async () => {
    // A delayed answer must not resolve against a mapping that has since moved.
    const error = await refusal('Dear ⟦PERSON_1⟧.', { vaultGeneration: generation + 1 });
    expect(error.kind).toBe('vault_generation_mismatch');
    expect(error.status).toBe(409);
  });
});

describe('leak gate', () => {
  it('refuses when Core leaked raw PII of its own', async () => {
    const error = await refusal('Contact them directly at leaked.person@example.com.');

    expect(error.kind).toBe('leak_check_failed');
    expect(error.status).toBe(422);
    expect(error.categories).toContain('EMAIL');
  });

  it('carries no part of the unsafe body in the refusal', async () => {
    // The refusal must not become the disclosure it was meant to prevent.
    const error = await refusal('Contact them directly at leaked.person@example.com.');
    expect(error.message).not.toContain('leaked.person@example.com');
    expect(JSON.stringify(error.categories)).not.toContain('leaked.person');
  });

  it('persists a draft, unverified evidence document with no answer', async () => {
    const error = await refusal('Reach them at leaked.person@example.com.');

    expect(error.evidence.answer).toBe('');
    expect(error.evidence.document.metadata['status']).toBe('draft');
    expect(error.evidence.trustTier).toBe(TRUST_UNVERIFIED);
  });

  it('records a failed attestation in the document body', async () => {
    // SPEC §10.5: a failed attestation must not be silently dropped.
    const error = await refusal('Reach them at leaked.person@example.com.');
    const document = parseOkf(error.evidence.markdown);

    expect(document.content).toContain('# Attestation');
    expect(document.content).toContain('failed');
  });
});

describe('consistency gate', () => {
  it('accepts an answer that reuses only known placeholders', () => {
    const report = checkConsistency(['⟦PERSON_1⟧'], 'Dear ⟦PERSON_1⟧');
    expect(report.ok).toBe(true);
    expect(report.invented_tokens).toEqual([]);
  });

  it('flags a placeholder Core invented', () => {
    const report = checkConsistency(['⟦PERSON_1⟧'], 'See ⟦PERSON_99⟧ for details.');
    expect(report.ok).toBe(false);
    expect(report.invented_tokens).toEqual(['⟦PERSON_99⟧']);
    expect(report.reason).toContain('invented');
  });

  it('trusts the tokenizer allocation, not tokens echoed into the prompt', async () => {
    // A caller who gets `⟦SECRET_1⟧` echoed into their own prompt text must not
    // thereby make it a known token; only what the tokenizer allocated counts.
    const error = await refusal('Here is ⟦SECRET_1⟧.', {
      maskedPrompt: `${MASKED_PROMPT} and ⟦SECRET_1⟧`,
      knownTokens: KNOWN_TOKENS,
    });
    expect(error.kind).toBe('invented_token');
  });

  it('refuses rather than releasing when a placeholder was invented', async () => {
    const error = await refusal('See ⟦PERSON_99⟧ for details.');
    expect(error.kind).toBe('invented_token');
    expect(error.status).toBe(409);
    expect(error.evidence.answer).toBe('');
  });
});

describe('the Gemma judge, applied asymmetrically', () => {
  it('blocks the release when the judge flags a leak', async () => {
    // The deterministic check passed, but a probabilistic veto still stops it.
    const error = await refusal('Dear ⟦PERSON_1⟧.', {
      judge: () => Promise.resolve({ leak: true, categories: ['PERSON'] }),
    });
    expect(error.kind).toBe('judge_flagged');
    expect(error.status).toBe(422);
  });

  it('blocks the release when the judge is unavailable', async () => {
    // "No opinion" is not a pass. A gate that cannot answer has not cleared.
    const error = await refusal('Dear ⟦PERSON_1⟧.', {
      judge: () => Promise.reject(new Error('gemma is down')),
    });
    expect(error.kind).toBe('judge_unavailable');
  });

  it('adds no trust when the judge says there is no leak', async () => {
    // leak:false changes nothing: the verdict still comes from the attester.
    const withJudge = await run('Dear ⟦PERSON_1⟧.', {
      judge: () => Promise.resolve({ leak: false }),
    });
    const withoutJudge = await run('Dear ⟦PERSON_1⟧.');

    expect(withJudge.trustTier).toBe(withoutJudge.trustTier);
    expect(withJudge.dimensions.policy_verdict).toBe(withoutJudge.dimensions.policy_verdict);
  });

  it('sees the pre-rehydration body, never the real values', async () => {
    // Showing it the rehydrated answer would hand real PII to Gemma and make
    // "there is a leak" the always-correct answer.
    const seen: string[] = [];
    await run('Dear ⟦PERSON_1⟧.', {
      judge: (text: string) => {
        seen.push(text);
        return Promise.resolve({ leak: false });
      },
    });

    expect(seen[0]).toContain('⟦PERSON_1⟧');
    expect(seen[0]).not.toContain('Taro Yamada');
  });
});

/** A judge whose verdicts are scripted per call, so a retry is observable. */
function scriptedJudge(...verdicts: Array<{ leak: boolean | null; categories?: string[] }>) {
  const calls: number[] = [];
  const judge = () => {
    const index = calls.length;
    calls.push(index);
    return Promise.resolve(verdicts[index] ?? verdicts.at(-1) ?? { leak: null });
  };
  return { judge, callCount: () => calls.length };
}

describe('the judge is given safe context by the pipeline', () => {
  it('hands it the masked prompt and the masked category counts', async () => {
    let seen: { maskedPrompt: string; maskedCounts: Record<string, number> } | undefined;

    await run('Dear ⟦PERSON_1⟧.', {
      judge: (_text, _signal, context) => {
        seen = context as typeof seen;
        return Promise.resolve({ leak: false });
      },
    });

    expect(seen?.maskedPrompt).toBe(MASKED_PROMPT);
    // Counted from the mapping's keys, so the categories are reported without
    // any value on the other side of the mapping being read.
    expect(seen?.maskedCounts).toEqual({ PERSON: 1, EMAIL: 1 });
  });

  it('never puts a mapping value in the context', async () => {
    let seen: { maskedPrompt: string; maskedCounts: Record<string, number> } | undefined;

    await run('Dear ⟦PERSON_1⟧.', {
      judge: (_text, _signal, context) => {
        seen = context as typeof seen;
        return Promise.resolve({ leak: false });
      },
    });

    const serialized = JSON.stringify(seen);
    expect(serialized).not.toContain('Taro Yamada');
    expect(serialized).not.toContain('taro@example.co.jp');
  });
});

describe('a judge flag is terminal, and a second call may only add evidence', () => {
  it('still refuses when a categoryless flag comes back clear on the second look', async () => {
    // The veto is authoritative. A second answer of "actually it is fine" is
    // exactly the re-roll that would launder a probabilistic veto into a pass,
    // and the rehydrated name must never reach the caller because of it.
    const { judge, callCount } = scriptedJudge({ leak: true, categories: [] }, { leak: false });

    const error = await refusal('Dear ⟦PERSON_1⟧.', { judge });

    expect(callCount()).toBe(2);
    expect(error.kind).toBe('judge_flagged');
    expect(error.status).toBe(422);
    expect(JSON.stringify(error)).not.toContain('Taro Yamada');
  });

  it('adopts the categories the second call names, for the refusal record', async () => {
    const { judge } = scriptedJudge(
      { leak: true, categories: [] },
      { leak: true, categories: ['PERSON'] },
    );

    const error = await refusal('Dear ⟦PERSON_1⟧.', { judge });

    expect(error.kind).toBe('judge_flagged');
    expect(error.categories).toEqual(['PERSON']);
    expect(error.evidence.attestation.judge?.categories).toEqual(['PERSON']);
    expect(error.evidence.attestation.judge_retries).toBe(1);
  });

  it('refuses when the second look flags it too', async () => {
    const { judge, callCount } = scriptedJudge(
      { leak: true, categories: [] },
      { leak: true, categories: [] },
    );

    const error = await refusal('Dear ⟦PERSON_1⟧.', { judge });

    expect(callCount()).toBe(2);
    expect(error.kind).toBe('judge_flagged');
    expect(error.status).toBe(422);
  });

  it('refuses immediately when the flag names a category, without re-asking', async () => {
    // A flag with evidence is a specific suspicion. Re-rolling until it goes
    // away is how a probabilistic veto gets laundered into a pass.
    const { judge, callCount } = scriptedJudge({ leak: true, categories: ['PERSON'] });

    const error = await refusal('Dear ⟦PERSON_1⟧.', { judge });

    expect(callCount()).toBe(1);
    expect(error.kind).toBe('judge_flagged');
  });

  it('never re-asks when the deterministic attester already failed', async () => {
    // The attester gate refuses before the judge runs at all, so a retry here
    // could not change the outcome and must not be spent.
    const { judge, callCount } = scriptedJudge({ leak: true, categories: [] }, { leak: false });

    const error = await refusal('Contact them at leaked.person@example.com.', { judge });

    expect(error.kind).toBe('leak_check_failed');
    expect(callCount()).toBe(0);
  });

  it('refuses immediately when the judge is unavailable, without re-asking', async () => {
    const { judge, callCount } = scriptedJudge({ leak: null });

    const error = await refusal('Dear ⟦PERSON_1⟧.', { judge });

    expect(callCount()).toBe(1);
    expect(error.kind).toBe('judge_unavailable');
  });

  it('keeps refusing when the retry itself comes back unusable', async () => {
    // An unusable second answer is not an improvement on an unevidenced flag, so
    // the original verdict stands rather than being downgraded.
    const { judge } = scriptedJudge({ leak: true, categories: [] }, { leak: null });

    const error = await refusal('Dear ⟦PERSON_1⟧.', { judge });

    expect(error.kind).toBe('judge_flagged');
  });

  it('records no retry count on a release that passed outright', async () => {
    const result = await run('Dear ⟦PERSON_1⟧.', {
      judge: () => Promise.resolve({ leak: false }),
    });

    expect(result.attestation.judge_retries).toBeUndefined();
  });

  it('still adds no trust when the judge clears a body outright', async () => {
    // The asymmetry is unchanged: a judge may veto a release, never vouch for
    // one. The tier still comes from the deterministic attester alone.
    const cleared = await run('Dear ⟦PERSON_1⟧.', {
      judge: () => Promise.resolve({ leak: false }),
    });
    const plain = await run('Dear ⟦PERSON_1⟧.');

    expect(cleared.trustTier).toBe(plain.trustTier);
    expect(cleared.dimensions.policy_verdict).toBe(plain.dimensions.policy_verdict);
  });
});

describe('unresolved tokens', () => {
  it('refuses rather than showing the user a stray symbol', async () => {
    const error = await refusal('See ⟦PERSON_1⟧ and ⟦PHONE_9⟧.', {
      knownTokens: [...KNOWN_TOKENS, '⟦PHONE_9⟧'],
    });
    expect(error.kind).toBe('unresolved_token');
    expect(error.evidence.attestation.unresolved_tokens).toContain('⟦PHONE_9⟧');
  });
});

describe('the disclosure policy', () => {
  beforeEach(async () => {
    const entry = await vault.put(REQUEST_ID, { '⟦API_KEY_1⟧': 'sk-abcdefgh12345678901234' }, 3600);
    generation = entry.generation;
  });

  it('leaves a secret masked and names the withheld category', async () => {
    const result = await run('Use ⟦API_KEY_1⟧ to authenticate.', {
      knownTokens: ['⟦API_KEY_1⟧'],
    });

    expect(result.answer).toContain('⟦API_KEY_1⟧');
    expect(result.answer).not.toContain('sk-abcdefgh12345678901234');
    expect(result.attestation.withheld).toEqual(['API_KEY']);
  });

  it('records the withheld categories in the attestation block', async () => {
    const result = await run('Use ⟦API_KEY_1⟧.', { knownTokens: ['⟦API_KEY_1⟧'] });
    const block = result.document.metadata['attestation'] as { withheld?: string[] };
    expect(block.withheld).toEqual(['API_KEY']);
  });

  it('does not count a deliberately withheld token as unresolved', async () => {
    // Withholding is a policy decision, not a failure; conflating them would
    // turn every secret into a blocked request.
    const result = await run('Use ⟦API_KEY_1⟧.', { knownTokens: ['⟦API_KEY_1⟧'] });
    expect(result.attestation.unresolved_tokens).toBeUndefined();
  });

  it('releases a secret when the deployment allows that category', async () => {
    const result = await run('Use ⟦API_KEY_1⟧.', {
      knownTokens: ['⟦API_KEY_1⟧'],
      withhold: [],
    });
    expect(result.answer).toContain('sk-abcdefgh12345678901234');
  });
});

describe('OKF attribution', () => {
  it('names a process actor as the verifier, never an LLM', async () => {
    const result = await run('Dear ⟦PERSON_1⟧.');
    const verified = result.document.metadata['verified'] as Array<{ by: string }>;
    expect(verified[0]?.by).toMatch(/^process:leak-check@/u);
  });

  it('names Synthesis as the document generator', async () => {
    const result = await run('Dear ⟦PERSON_1⟧.');
    expect((result.document.metadata['generated'] as { by: string }).by).toBe(actor());
  });

  it('carries the request id and a replayable attestation block', async () => {
    const result = await run('Dear ⟦PERSON_1⟧.');
    expect(result.document.metadata['request_id']).toBe(REQUEST_ID);

    const block = result.document.metadata['attestation'] as Record<string, string>;
    expect(block['verdict']).toBe('pass');
    expect(block['masked_prompt_sha256']).toMatch(/^[0-9a-f]{64}$/u);
    expect(block['core_response_sha256']).toMatch(/^[0-9a-f]{64}$/u);
    expect(block['attester_sha256']).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the receipt', () => {
  it('reports the hashes of both texts it bound', () => {
    const receipt = buildReceipt(REQUEST_ID, MASKED_PROMPT, 'hello');
    expect(receipt.response_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.masked_prompt_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.request_id).toBe(REQUEST_ID);
  });

  it('omits the response body from what the API returns', async () => {
    // The receipt is a runtime artifact; the body is not part of it (SPEC §10).
    const result = await run('Dear ⟦PERSON_1⟧.');
    expect(Object.keys(result.receipt).sort()).toEqual([
      'attester_sha256',
      'findings',
      'masked_prompt_hash',
      'request_id',
      'response_hash',
    ]);
  });
});

describe('a refusal persists no rejected Core text (P0)', () => {
  const LEAKY = 'Contact leaked.person@example.com about ⟦PERSON_1⟧.';

  it('puts the withheld marker in the document body, not the rejected answer', async () => {
    const error = await refusal(LEAKY);
    const document = parseOkf(error.evidence.markdown);

    expect(document.content).toContain(WITHHELD_BODY_MARKER);
    expect(error.evidence.markdown).not.toContain('leaked.person@example.com');
  });

  it('keeps the rejected text out of every field of the result', async () => {
    const error = await refusal(LEAKY);
    // Serialising the whole evidence object is the honest check: any future
    // field that starts carrying the body fails here rather than in production.
    expect(JSON.stringify(error.evidence)).not.toContain('leaked.person@example.com');
  });

  it('still records the digest of what was rejected, so an auditor can bind it', async () => {
    const error = await refusal(LEAKY);
    const block = (parseOkf(error.evidence.markdown).metadata['attestation'] ?? {}) as Record<
      string,
      unknown
    >;

    // The digest identifies the exchange without the store holding the text.
    expect(block['core_response_sha256']).toBe(responseHash(LEAKY));
    expect(block['verdict']).toBe('fail');
  });

  it('carries no raw mapping value in the refusal itself', async () => {
    const error = await refusal(LEAKY);
    expect(error.message).not.toContain('Taro Yamada');
    expect(error.message).not.toContain('taro@example.co.jp');
    expect(error.categories).toEqual(['EMAIL']);
  });

  it('marks the refused document draft with no verified entry', async () => {
    const error = await refusal(LEAKY);
    const metadata = parseOkf(error.evidence.markdown).metadata;

    expect(metadata['status']).toBe('draft');
    expect(metadata['verified']).toBeUndefined();
    expect(error.evidence.trustTier).toBe(TRUST_UNVERIFIED);
  });
});

/**
 * A rehydrator that records every call and otherwise behaves normally.
 *
 * Observing invocation is the point: a released answer proves rehydration
 * happened, but only a spy can prove it did *not* happen on a refusal.
 */
function watchRehydrate() {
  return vi.fn(rehydrateWithPolicy);
}

describe('every gate runs before rehydration (P0)', () => {
  it('does not rehydrate when the deterministic leak check fails', async () => {
    const spy = watchRehydrate();
    await refusal('Contact leaked.person@example.com now.', { rehydrate: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not rehydrate when Core invented a placeholder', async () => {
    const spy = watchRehydrate();
    await refusal('Ask ⟦PERSON_9⟧ about it.', { rehydrate: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not rehydrate when the advisory judge flags a leak', async () => {
    const spy = watchRehydrate();
    await refusal('Reply to ⟦PERSON_1⟧.', {
      rehydrate: spy,
      judge: () => Promise.resolve({ leak: true, categories: ['PERSON'] }),
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not rehydrate when the judge has no usable opinion', async () => {
    const spy = watchRehydrate();
    await refusal('Reply to ⟦PERSON_1⟧.', {
      rehydrate: spy,
      judge: () => Promise.resolve({ leak: null }),
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not rehydrate when a placeholder cannot be resolved', async () => {
    // Resolvability is decided from the mapping's keys, so the refusal never
    // needs a value to discover that one is missing.
    const spy = watchRehydrate();
    await refusal('Reply to ⟦PERSON_1⟧ and ⟦EMAIL_2⟧.', {
      rehydrate: spy,
      knownTokens: [...KNOWN_TOKENS, '⟦EMAIL_2⟧'],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rehydrates exactly once when every gate passes', async () => {
    const spy = watchRehydrate();
    await run('Reply to ⟦PERSON_1⟧.', { rehydrate: spy });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('vault expiry is distinct from vault absence', () => {
  it('refuses an expired mapping with 410 vault_expired', async () => {
    const expiring = new InMemoryTokenVault();
    const entry = await expiring.put(REQUEST_ID, { '⟦PERSON_1⟧': 'Taro Yamada' }, 0);

    const error = await refusal('Reply to ⟦PERSON_1⟧.', {
      vault: expiring,
      vaultGeneration: entry.generation,
    });

    expect(error.kind).toBe('vault_expired');
    expect(error.status).toBe(410);
  });

  it('refuses an absent mapping with 409 vault_missing', async () => {
    const error = await refusal('Reply to ⟦PERSON_1⟧.', { vault: new InMemoryTokenVault() });

    expect(error.kind).toBe('vault_missing');
    expect(error.status).toBe(409);
  });
});

describe('judge categories are a closed enum', () => {
  it('drops a free-text category rather than forwarding it', async () => {
    // A judge answering with a real name is the disclosure channel this closes:
    // categories reach the logs and the public refusal body verbatim.
    const error = await refusal('Reply to ⟦PERSON_1⟧.', {
      judge: () => Promise.resolve({ leak: true, categories: ['Taro Yamada', 'PERSON'] }),
    });

    expect(error.categories).toEqual(['PERSON']);
    expect(JSON.stringify(error.categories)).not.toContain('Taro Yamada');
  });
});

describe('the requester-named term scan', () => {
  it('refuses when Core echoed a term back in the clear', async () => {
    // The deterministic attester passes this body — a codename matches none of
    // its patterns — so this scan is the only thing standing between the leak
    // and the caller. The whole point of the boundary hardening.
    const refused = await refusal('The ⟦PERSON_1⟧ plan for Titan Project is ready.', {
      maskTerms: ['Titan Project'],
    });

    expect(refused.kind).toBe('leak_check_failed');
    expect(refused.status).toBe(422);
    expect(refused.categories).toEqual(['CUSTOM']);
  });

  it('releases when no term survived', async () => {
    const result = await run('The ⟦PERSON_1⟧ plan for ⟦CUSTOM_1⟧ is ready.', {
      maskTerms: ['Titan Project'],
      // The token has to resolve, so the vault must know it.
      vault: await (async () => {
        const seeded = new InMemoryTokenVault();
        await seeded.put(
          REQUEST_ID,
          {
            '⟦PERSON_1⟧': 'Taro Yamada',
            '⟦EMAIL_1⟧': 'taro@example.co.jp',
            '⟦CUSTOM_1⟧': 'Titan Project',
          },
          3600,
        );
        return seeded;
      })(),
      vaultGeneration: 1,
      knownTokens: [...KNOWN_TOKENS, '⟦CUSTOM_1⟧'],
    });

    expect(result.attestation.ok).toBe(true);
    // CUSTOM is not withheld: the requester supplied the term, so getting it
    // back is the point.
    expect(result.answer).toContain('Titan Project');
  });

  it('is case-sensitive, agreeing with the substitution it verifies', async () => {
    // `titanium` is not the codename. Refusing here would turn a correct
    // masking into a 422 the caller could do nothing about.
    const result = await run('⟦PERSON_1⟧ chose titanium alloy.', { maskTerms: ['Titan'] });
    expect(result.attestation.ok).toBe(true);
  });

  it('records the term count, and never a term, on a release', async () => {
    const result = await run('Hello ⟦PERSON_1⟧.', {
      maskTerms: ['Titan Project', 'Hummingbird'],
    });

    expect(result.attestation.custom_terms).toEqual({ count: 2 });
    expect(result.markdown).not.toContain('Titan Project');
    expect(result.markdown).not.toContain('Hummingbird');
    // The count reaches the replayable block too, so a reader can see the scan
    // ran without the document ever holding the terms.
    const metadata = parseOkf(result.markdown).metadata as {
      attestation?: { custom_terms?: { count?: number } };
    };
    expect(metadata.attestation?.custom_terms?.count).toBe(2);
  });

  it('records the count on a refusal too, without naming the term', async () => {
    const refused = await refusal('Titan Project ships.', { maskTerms: ['Titan Project'] });

    expect(refused.evidence.attestation.custom_terms).toEqual({ count: 1 });
    // The evidence document is served unauthenticated. A refusal that wrote the
    // codename into it would be the leak the refusal just prevented.
    expect(refused.evidence.markdown).not.toContain('Titan Project');
    expect(refused.evidence.markdown).toContain(WITHHELD_BODY_MARKER);
    expect(refused.message).not.toContain('Titan Project');
  });

  it('omits the block entirely when no terms were named', async () => {
    const result = await run('Hello ⟦PERSON_1⟧.');
    expect(result.attestation.custom_terms).toBeUndefined();
  });

  it('never rehydrates when a term survived', async () => {
    // The ordering guarantee applies here as to every other gate: a refused
    // request must not have had its real values assembled into a string at all.
    const rehydrate = vi.fn(rehydrateWithPolicy);
    await refusal('Titan Project ships.', { maskTerms: ['Titan Project'], rehydrate });

    expect(rehydrate).not.toHaveBeenCalled();
  });
});

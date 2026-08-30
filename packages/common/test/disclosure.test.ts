/**
 * What the per-request disclosure opt-in guarantees.
 *
 * The opt-in lets one requester ask for high-risk values *they* submitted to be
 * restored in *their* answer. The guarantees below are what keep that from
 * becoming a way to widen the policy generally:
 *
 * - only the default-withheld categories can be named; anything else is a 400
 * - the operator allowance and the request allowance combine as a union, and
 *   neither can release a category outside the default-withheld set
 * - asking for nothing leaves the deployment's behaviour exactly as it was
 */

import { describe, expect, it } from 'vitest';
import {
  AskRequestSchema,
  HIGH_RISK_CATEGORIES,
  OpenAiChatCompletionRequestSchema,
  RehydrateAllowSchema,
  SynthesizeRequestSchema,
} from '../src/schema.ts';
import {
  DEFAULT_WITHHELD_CATEGORIES,
  isHighRiskCategory,
  withheldCategories,
} from '../src/tokenizer.ts';

describe('the high-risk category list', () => {
  it('is the same list the tokenizer withholds by default', () => {
    // The two are declared separately so `schema.ts` stays free of any import
    // that reaches the vault side. This is the test that keeps them honest.
    expect([...HIGH_RISK_CATEGORIES].sort()).toEqual([...DEFAULT_WITHHELD_CATEGORIES].sort());
  });

  it('agrees with the tokenizer predicate', () => {
    for (const category of HIGH_RISK_CATEGORIES) expect(isHighRiskCategory(category)).toBe(true);
    expect(isHighRiskCategory('EMAIL')).toBe(false);
  });
});

describe('rehydrate_allow validation', () => {
  it('accepts a subset of the high-risk categories', () => {
    const parsed = RehydrateAllowSchema.safeParse(['CREDIT_CARD', 'JWT']);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(['CREDIT_CARD', 'JWT']);
  });

  it('deduplicates, so a repeated category is not a different request', () => {
    const parsed = RehydrateAllowSchema.safeParse(['JWT', 'JWT']);
    expect(parsed.success && parsed.data).toEqual(['JWT']);
  });

  it('rejects a category that is never withheld, rather than ignoring it', () => {
    // EMAIL is restored by default, so allowing it changes nothing. Accepting it
    // silently would report success for an opt-in that did nothing.
    expect(RehydrateAllowSchema.safeParse(['EMAIL']).success).toBe(false);
  });

  it('rejects a category that does not exist at all', () => {
    expect(RehydrateAllowSchema.safeParse(['SUPERUSER']).success).toBe(false);
  });

  it('rejects a non-array and a non-string entry', () => {
    expect(RehydrateAllowSchema.safeParse('CREDIT_CARD').success).toBe(false);
    expect(RehydrateAllowSchema.safeParse([1]).success).toBe(false);
  });
});

describe('POST /v1/ask body', () => {
  it('accepts a valid opt-in', () => {
    const parsed = AskRequestSchema.safeParse({ text: 'hi', rehydrate_allow: ['CREDIT_CARD'] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.rehydrate_allow).toEqual(['CREDIT_CARD']);
  });

  it('is unchanged when the field is absent', () => {
    const parsed = AskRequestSchema.safeParse({ text: 'hi' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.rehydrate_allow).toBeUndefined();
  });

  it('rejects a bad category with a 400-shaped issue rather than dropping it', () => {
    const parsed = AskRequestSchema.safeParse({ text: 'hi', rehydrate_allow: ['PERSON'] });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toContain('rehydrate_allow');
  });

  it('still rejects an unknown field, so strict() has not been loosened', () => {
    expect(AskRequestSchema.safeParse({ text: 'hi', session_id: 'x' }).success).toBe(false);
  });
});

describe('the synthesis hop', () => {
  it('carries the opt-in and validates it again on arrival', () => {
    const base = {
      request_id: 'r1',
      masked_prompt: 'p',
      core_answer: 'a',
      generated_by: 'core_agent/x',
      known_tokens: [],
      vault_generation: 1,
    };
    expect(SynthesizeRequestSchema.safeParse({ ...base, rehydrate_allow: ['JWT'] }).success).toBe(
      true,
    );
    // An internal hop is still a boundary: a misroute must not widen the policy.
    expect(SynthesizeRequestSchema.safeParse({ ...base, rehydrate_allow: ['EMAIL'] }).success).toBe(
      false,
    );
  });
});

describe('the OpenAI-compatible request extension', () => {
  const base = { model: 'privacy-gateway', messages: [{ role: 'user', content: 'hi' }] };

  it('accepts the opt-in under x_privacy_gateway', () => {
    const parsed = OpenAiChatCompletionRequestSchema.safeParse({
      ...base,
      x_privacy_gateway: { rehydrate_allow: ['MY_NUMBER'] },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.x_privacy_gateway?.rehydrate_allow).toEqual(['MY_NUMBER']);
  });

  it('rejects a misspelled key inside the extension rather than ignoring it', () => {
    // The one failure mode an explicit disclosure request must not have is
    // "looked like it worked". Sampling knobs are still stripped at the top
    // level; only this object is strict.
    expect(
      OpenAiChatCompletionRequestSchema.safeParse({
        ...base,
        x_privacy_gateway: { rehydrate_alow: ['JWT'] },
      }).success,
    ).toBe(false);
  });

  it('still strips unknown top-level sampling knobs', () => {
    const parsed = OpenAiChatCompletionRequestSchema.safeParse({ ...base, temperature: 0.7 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'temperature' in parsed.data).toBe(false);
  });
});

describe('the effective withhold set', () => {
  it('withholds every high-risk category when nobody allows anything', () => {
    expect(withheldCategories('', []).sort()).toEqual([...DEFAULT_WITHHELD_CATEGORIES].sort());
  });

  it('subtracts the request allowance', () => {
    expect(withheldCategories('', ['CREDIT_CARD'])).not.toContain('CREDIT_CARD');
    expect(withheldCategories('', ['CREDIT_CARD'])).toContain('API_KEY');
  });

  it('unions the operator allowance with the request allowance', () => {
    const withheld = withheldCategories('JWT', ['CREDIT_CARD']);
    expect(withheld).not.toContain('JWT');
    expect(withheld).not.toContain('CREDIT_CARD');
    expect(withheld).toContain('API_KEY');
  });

  it('cannot release anything outside the default-withheld set', () => {
    // The allowance filters a fixed list; naming EMAIL subtracts nothing because
    // EMAIL was never in it. There is no path from an opt-in to a wider policy.
    const withheld = withheldCategories('EMAIL,PERSON', ['CREDIT_CARD']);
    expect(withheld.every((category) => DEFAULT_WITHHELD_CATEGORIES.includes(category))).toBe(true);
  });
});

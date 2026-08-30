/**
 * What the user-defined secret-term boundary guarantees.
 *
 * A term is a phrase the requester asserts is confidential — an unreleased
 * product name, an internal codename — that no regex and no model could know to
 * protect. The guarantees below are what make that assertion worth something:
 *
 * - a term is validated at every boundary that accepts one, so a malformed term
 *   is a 400 rather than a silently ignored request to hide something
 * - the reserved placeholder delimiters are refused, closing the same oracle
 *   `containsReservedSyntax` closes on the prompt itself
 * - the audit record carries a count and never a term
 */

import { describe, expect, it } from 'vitest';
import {
  AskRequestSchema,
  AttestationSchema,
  AttestationBlockSchema,
  MAX_MASK_TERMS,
  MAX_MASK_TERM_LENGTH,
  MaskTermsSchema,
  OpenAiChatCompletionRequestSchema,
  PII_CATEGORIES,
  SynthesizeRequestSchema,
} from '../src/schema.ts';
import { CUSTOM_CATEGORY } from '../src/tokenizer.ts';

describe('the CUSTOM category', () => {
  it('is a category the fleet recognises, so it survives every closed enum', () => {
    // `categories` travels through logs, refusal bodies and the OKF document,
    // all of which drop an unrecognised name. A CUSTOM refusal that vanished
    // from the record would be a leak nobody could audit.
    expect(PII_CATEGORIES).toContain(CUSTOM_CATEGORY);
  });
});

describe('mask_terms validation', () => {
  it('accepts a list of ordinary phrases', () => {
    const parsed = MaskTermsSchema.safeParse(['Titan Project', 'Hummingbird']);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(['Titan Project', 'Hummingbird']);
  });

  it('trims each term, so a stray space is not part of the secret', () => {
    const parsed = MaskTermsSchema.safeParse(['  Titan Project  ']);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(['Titan Project']);
  });

  it('deduplicates after trimming', () => {
    const parsed = MaskTermsSchema.safeParse(['Titan', 'Titan ', ' Titan']);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(['Titan']);
  });

  it('preserves case when deduplicating, because case changes meaning', () => {
    // `Titan` the codename and `titan` the ordinary word are different requests.
    // Collapsing them would silently drop one of the two the requester named.
    const parsed = MaskTermsSchema.safeParse(['Titan', 'titan']);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(['Titan', 'titan']);
  });

  it('rejects a single-character term', () => {
    // One character matches almost everywhere: masking every `a` destroys the
    // prompt without protecting anything.
    expect(MaskTermsSchema.safeParse(['a']).success).toBe(false);
  });

  it('rejects a term that is only whitespace', () => {
    expect(MaskTermsSchema.safeParse(['   ']).success).toBe(false);
  });

  it('rejects a term longer than the cap', () => {
    expect(MaskTermsSchema.safeParse(['x'.repeat(MAX_MASK_TERM_LENGTH + 1)]).success).toBe(false);
  });

  it('accepts a term exactly at the cap', () => {
    expect(MaskTermsSchema.safeParse(['x'.repeat(MAX_MASK_TERM_LENGTH)]).success).toBe(true);
  });

  it.each(['⟦', '⟧', 'Titan⟦EMAIL_1⟧'])('rejects a term containing %s', (term) => {
    // Same reasoning as `containsReservedSyntax` on the prompt: a caller writing
    // a delimiter is probing the placeholder namespace, and accepting it here
    // would be a second door into the same oracle.
    expect(MaskTermsSchema.safeParse([`pad${term}pad`]).success).toBe(false);
  });

  it('rejects an empty list rather than treating it as "no terms"', () => {
    // Absent means "asked for nothing"; `[]` means a client built a list and
    // filled nothing into it, which is far more likely to be a bug.
    expect(MaskTermsSchema.safeParse([]).success).toBe(false);
  });

  it('rejects more terms than the cap allows', () => {
    const tooMany = Array.from({ length: MAX_MASK_TERMS + 1 }, (_v, i) => `term-${i}`);
    expect(MaskTermsSchema.safeParse(tooMany).success).toBe(false);
  });

  it('rejects a non-string entry', () => {
    expect(MaskTermsSchema.safeParse([42]).success).toBe(false);
  });
});

describe('POST /v1/ask body', () => {
  it('accepts mask_terms beside the text', () => {
    const parsed = AskRequestSchema.safeParse({
      text: 'ship it',
      mask_terms: ['Titan Project'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mask_terms).toEqual(['Titan Project']);
  });

  it('leaves mask_terms absent when the caller omits it', () => {
    const parsed = AskRequestSchema.safeParse({ text: 'ship it' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mask_terms).toBeUndefined();
  });

  it('rejects the whole request when one term is malformed', () => {
    // Fail closed: masking three of four named terms and sending anyway would be
    // exactly the silent partial protection this feature exists to rule out.
    const parsed = AskRequestSchema.safeParse({
      text: 'ship it',
      mask_terms: ['Titan Project', 'a'],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts mask_terms together with the disclosure opt-in', () => {
    const parsed = AskRequestSchema.safeParse({
      text: 'ship it',
      mask_terms: ['Titan Project'],
      rehydrate_allow: ['CREDIT_CARD'],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('the OpenAI-compatible request extension', () => {
  it('accepts mask_terms under x_privacy_gateway', () => {
    const parsed = OpenAiChatCompletionRequestSchema.safeParse({
      model: 'privacy-gateway',
      messages: [{ role: 'user', content: 'ship it' }],
      x_privacy_gateway: { mask_terms: ['Titan Project'] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.x_privacy_gateway?.mask_terms).toEqual(['Titan Project']);
    }
  });

  it('rejects a misspelled key rather than ignoring the request to mask', () => {
    // `strict()` inside the extension: a silently ignored masking request is the
    // one failure mode this field must not have.
    const parsed = OpenAiChatCompletionRequestSchema.safeParse({
      model: 'privacy-gateway',
      messages: [{ role: 'user', content: 'ship it' }],
      x_privacy_gateway: { mask_term: ['Titan Project'] },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the synthesis hop', () => {
  it('carries the terms so the attester can scan for them', () => {
    // Both ends of this hop are inside the boundary, and Synthesis already holds
    // every raw value behind every placeholder — so the terms add no exposure
    // here, and without them the term scan on Core's output cannot run.
    const parsed = SynthesizeRequestSchema.safeParse({
      request_id: 'r1',
      masked_prompt: 'ship ⟦CUSTOM_1⟧',
      core_answer: 'shipping ⟦CUSTOM_1⟧',
      generated_by: 'core_agent/test',
      known_tokens: ['⟦CUSTOM_1⟧'],
      vault_generation: 1,
      mask_terms: ['Titan Project'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mask_terms).toEqual(['Titan Project']);
  });

  it('validates the terms again on arrival rather than trusting the caller', () => {
    const parsed = SynthesizeRequestSchema.safeParse({
      request_id: 'r1',
      masked_prompt: '',
      core_answer: '',
      generated_by: 'core_agent/test',
      known_tokens: [],
      vault_generation: 1,
      mask_terms: ['⟦'],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the audit record', () => {
  it('carries a count in the runtime attestation', () => {
    const parsed = AttestationSchema.safeParse({
      ok: true,
      reason: null,
      findings: [],
      custom_terms: { count: 2 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.custom_terms?.count).toBe(2);
  });

  it('carries the same count in the replayable attestation block', () => {
    const digest = 'a'.repeat(64);
    const parsed = AttestationBlockSchema.safeParse({
      computation: '/computations/leak-check.md',
      computation_sha256: digest,
      attester_sha256: digest,
      masked_prompt_sha256: digest,
      core_response_sha256: digest,
      verdict: 'pass',
      checked_at: '2026-08-31T00:00:00Z',
      request_id: 'r1',
      custom_terms: { count: 1 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.custom_terms?.count).toBe(1);
  });

  it('has no field anywhere that could hold a term', () => {
    // The shape is the guarantee: `custom_terms` is `{count}` and nothing else,
    // so there is no key an implementation could put a codename into by mistake.
    const parsed = AttestationSchema.safeParse({
      ok: true,
      reason: null,
      findings: [],
      custom_terms: { count: 1 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data.custom_terms ?? {})).toEqual(['count']);
    }
  });
});

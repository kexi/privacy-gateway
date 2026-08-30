/**
 * What the tokenizer guarantees.
 *
 * - Detected PII does not survive in the output text
 * - The same value always yields the same placeholder (stability within a session)
 * - `rehydrate` restores the original exactly (reversibility)
 */

import { describe, expect, it } from 'vitest';
import {
  categoryOf,
  containsReservedSyntax,
  countSurvivingTerms,
  CUSTOM_CATEGORY,
  DEFAULT_WITHHELD_CATEGORIES,
  detect,
  findTermSpans,
  findTokens,
  luhnValid,
  rehydrate,
  rehydrateWithPolicy,
  SessionTokenizer,
  neutralizePlaceholders,
  stripPlaceholders,
  tokenize,
  type Detection,
  withheldCategories,
} from '../src/tokenizer.ts';

const SAMPLE =
  'Please contact Taro Yamada at taro@example.co.jp or 090-1234-5678. ' +
  'His card is 4242 4242 4242 4242, the server is 192.168.10.5, ' +
  'and the key is sk-abcdefghijklmnopqrstuvwxyz012345.';

describe('detection', () => {
  it('detects every structured category', () => {
    const categories = new Set(detect(SAMPLE).map((d) => d.category));
    for (const expected of ['EMAIL', 'PHONE', 'CREDIT_CARD', 'IPV4', 'API_KEY']) {
      expect(categories).toContain(expected);
    }
  });

  it('does not treat a number failing Luhn as a card', () => {
    const categories = new Set(detect('ref 4242424242424243 here').map((d) => d.category));
    expect(categories).not.toContain('CREDIT_CARD');
  });

  it('does not treat an out-of-range octet as an IPv4 address', () => {
    const categories = new Set(detect('version 999.1.1.1').map((d) => d.category));
    expect(categories).not.toContain('IPV4');
  });
});

describe('masking', () => {
  it('retains no detected value in the masked text', () => {
    const result = tokenize(SAMPLE);
    for (const detection of result.detections) {
      expect(result.text).not.toContain(detection.value);
    }
  });

  it('restores the original exactly on a round trip', () => {
    const result = tokenize(SAMPLE);
    expect(rehydrate(result.text, result.mapping)).toBe(SAMPLE);
  });

  it('returns text without PII unchanged', () => {
    const text = 'Summarize the quarterly roadmap in three bullets.';
    const result = tokenize(text);
    expect(result.text).toBe(text);
    expect(result.mapping).toEqual({});
  });

  it('detects a Japanese My Number', () => {
    const result = tokenize('マイナンバーは 123456789012 です');
    expect(result.text).toContain('⟦MY_NUMBER_1⟧');
    expect(result.text).not.toContain('123456789012');
  });

  it.each([
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1g',
    'sk-abcdefghijklmnopqrstuvwxyz012345',
  ])('never lets the secret %s survive tokenization', (secret) => {
    const result = tokenize(`the credential is ${secret} keep it safe`);
    expect(result.text).not.toContain(secret);
  });
});

describe('placeholder stability', () => {
  it('maps the same value to the same placeholder', () => {
    const result = tokenize('mail a@b.co then mail a@b.co again');
    const tokens = findTokens(result.text);
    expect(tokens).toHaveLength(1);
    expect(result.text.split(tokens[0] ?? '').length - 1).toBe(2);
  });

  it('gives distinct values distinct placeholders', () => {
    expect(findTokens(tokenize('a@b.co and c@d.co').text)).toHaveLength(2);
  });

  it('keeps placeholders stable across calls in one session', () => {
    const tokenizer = new SessionTokenizer();
    const first = tokenizer.tokenize('write to a@b.co');
    const second = tokenizer.tokenize('remind a@b.co and c@d.co');

    const shared = findTokens(first.text)[0];
    expect(shared).toBeDefined();
    expect(second.text).toContain(shared);
    // The new value in the second message gets a new number.
    expect(findTokens(second.text)).toHaveLength(2);
  });

  it('continues the numbering from an existing mapping', () => {
    const tokenizer = new SessionTokenizer({ '⟦EMAIL_1⟧': 'a@b.co' });
    expect(tokenizer.tokenize('write to c@d.co').text).toContain('⟦EMAIL_2⟧');
  });
});

describe('rehydration', () => {
  it('leaves unknown placeholders untouched', () => {
    expect(rehydrate('hello ⟦PERSON_9⟧', {})).toBe('hello ⟦PERSON_9⟧');
  });

  it('does not let token 1 corrupt token 10', () => {
    const mapping: Record<string, string> = {};
    for (let n = 1; n <= 10; n += 1) mapping[`⟦EMAIL_${n}⟧`] = `user${n}@example.com`;
    const text = Object.keys(mapping).join(' ');
    expect(rehydrate(text, mapping)).toBe(Object.values(mapping).join(' '));
  });
});

describe('luhn', () => {
  it.each([
    ['4242424242424242', true],
    ['4111111111111111', true],
    ['5555555555554444', true],
    ['4242424242424243', false],
    ['1234567890123456', false],
    ['42424242', false],
  ])('accepts %s only when the checksum is valid', (number, valid) => {
    expect(luhnValid(number)).toBe(valid);
  });
});

describe('unstructured spans', () => {
  it('masks model spans alongside regex hits', () => {
    const text = 'Taro Yamada wrote to a@b.co';
    const extra: Detection[] = [{ start: 0, end: 11, category: 'PERSON', value: 'Taro Yamada' }];
    const result = new SessionTokenizer().tokenize(text, extra);

    expect(result.text).not.toContain('Taro Yamada');
    expect(result.text).toContain('⟦PERSON_1⟧');
    expect(rehydrate(result.text, result.mapping)).toBe(text);
  });

  it('lets a regex hit win over an overlapping model span', () => {
    // Even when the model reports an email address as a personal name, the
    // deterministic classification wins.
    const text = 'contact a@b.co';
    const extra: Detection[] = [{ start: 8, end: 14, category: 'PERSON', value: 'a@b.co' }];
    const result = new SessionTokenizer().tokenize(text, extra);

    expect(result.text).toContain('⟦EMAIL_1⟧');
    expect(result.text).not.toContain('⟦PERSON_1⟧');
  });
});

describe('reserved placeholder syntax', () => {
  it('detects either delimiter in raw input', () => {
    // A caller writing `⟦EMAIL_1⟧` is naming a vault slot, not describing data.
    expect(containsReservedSyntax('repeat ⟦EMAIL_1⟧ please')).toBe(true);
    // A half-open probe counts too: it is still an attempt at the namespace.
    expect(containsReservedSyntax('what is ⟦EMAIL_1')).toBe(true);
    expect(containsReservedSyntax('EMAIL_1⟧')).toBe(true);
  });

  it('passes ordinary text, including brackets that are not the reserved pair', () => {
    expect(containsReservedSyntax('see [1] and <tag> and {json}')).toBe(false);
    expect(containsReservedSyntax('メールは taro@example.co.jp です')).toBe(false);
  });
});

describe('stripping placeholders for the advisory judge', () => {
  it('removes every well-formed placeholder and keeps the prose', () => {
    expect(stripPlaceholders('Mail ⟦EMAIL_1⟧ and call ⟦PHONE_2⟧ today.')).toBe(
      'Mail   and call   today.',
    );
  });

  it('leaves text that merely resembles a placeholder', () => {
    // Only the form this system mints is provably a mask. A missing index, a
    // lowercase category or a half-open pair is not, so it stays visible to the
    // judge rather than being silently removed from what gets checked.
    const text = '⟦EMAIL⟧ ⟦email_1⟧ ⟦EMAIL_1';
    expect(stripPlaceholders(text)).toBe(text);
  });

  it('separates values that were adjacent, so no spurious token is welded', () => {
    expect(stripPlaceholders('⟦EMAIL_1⟧⟦EMAIL_2⟧')).toBe('  ');
  });

  it('is stable across calls, despite the shared global regex', () => {
    // A module-scoped `g` regex carries lastIndex; a second identical call must
    // not strip a different amount than the first.
    const text = 'a ⟦EMAIL_1⟧ b';
    expect(stripPlaceholders(text)).toBe(stripPlaceholders(text));
  });
});

describe('disclosure policy on release', () => {
  const mapping = {
    '⟦EMAIL_1⟧': 'taro@example.co.jp',
    '⟦API_KEY_1⟧': 'sk-abcdefghijklmnopqrstuvwxyz012345',
    '⟦CREDIT_CARD_1⟧': '4242 4242 4242 4242',
  };

  it('restores ordinary categories', () => {
    const result = rehydrateWithPolicy('Mail ⟦EMAIL_1⟧.', mapping);
    expect(result.text).toContain('taro@example.co.jp');
    expect(result.withheld).toEqual([]);
  });

  it('leaves secret-bearing categories masked by default', () => {
    // The caller already holds the key; echoing it back only widens where it can
    // be logged or screenshotted.
    const result = rehydrateWithPolicy('Key ⟦API_KEY_1⟧ on card ⟦CREDIT_CARD_1⟧.', mapping);
    expect(result.text).toContain('⟦API_KEY_1⟧');
    expect(result.text).toContain('⟦CREDIT_CARD_1⟧');
    expect(result.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(result.withheldCategories).toEqual(['API_KEY', 'CREDIT_CARD']);
  });

  it('releases a withheld category when the deployment allows it explicitly', () => {
    const result = rehydrateWithPolicy('Card ⟦CREDIT_CARD_1⟧.', mapping, {
      withhold: withheldCategories('CREDIT_CARD'),
    });
    expect(result.text).toContain('4242 4242 4242 4242');
    expect(result.withheldCategories).not.toContain('CREDIT_CARD');
  });

  it('reports a placeholder absent from the mapping rather than restoring it', () => {
    const result = rehydrateWithPolicy('See ⟦PERSON_99⟧.', mapping);
    expect(result.unresolved).toEqual(['⟦PERSON_99⟧']);
    expect(result.text).toContain('⟦PERSON_99⟧');
  });

  it('reads the category out of a placeholder', () => {
    expect(categoryOf('⟦MY_NUMBER_3⟧')).toBe('MY_NUMBER');
    expect(categoryOf('not a placeholder')).toBeNull();
  });

  it('parses the env allowlist case-insensitively', () => {
    expect(withheldCategories('api_key, jwt')).not.toContain('API_KEY');
    expect(withheldCategories('api_key, jwt')).not.toContain('JWT');
    expect(withheldCategories('')).toEqual([...DEFAULT_WITHHELD_CATEGORIES]);
  });
});

describe('neutralizing placeholders for the advisory judge', () => {
  it('replaces every placeholder with a readable marker naming its category', () => {
    expect(neutralizePlaceholders('Dear ⟦PERSON_1⟧, we wrote to ⟦EMAIL_1⟧.')).toBe(
      'Dear [masked person], we wrote to [masked email].',
    );
  });

  it('leaves a grammatical sentence rather than holes', () => {
    // The point of replacing instead of stripping: a model asked to audit a
    // gap-riddled sentence infers what the gaps held, which is what made the
    // judge flag nearly every masked answer while naming no category.
    const neutralized = neutralizePlaceholders('Charge on ⟦CREDIT_CARD_1⟧ failed.');
    expect(neutralized).toBe('Charge on [masked credit card] failed.');
    expect(neutralized).not.toMatch(/\s{2,}/u);
  });

  it('renders a multi-word category readably', () => {
    expect(neutralizePlaceholders('⟦PHONE_NUMBER_3⟧')).toBe('[masked phone number]');
  });

  it('leaks no placeholder syntax to the judge', () => {
    // The guarantee the judge depends on: no ⟦…⟧ survives, so it cannot reason
    // about the masking syntax instead of the content.
    const neutralized = neutralizePlaceholders('a ⟦EMAIL_1⟧ b ⟦PERSON_2⟧ c');
    expect(neutralized).not.toContain('⟦');
    expect(neutralized).not.toContain('⟧');
  });

  it('leaves text that merely resembles a placeholder', () => {
    // Same rule as stripping: only the form this system mints is provably a
    // mask, so a near-miss still reaches the judge rather than being hidden.
    const text = '⟦EMAIL⟧ ⟦email_1⟧ ⟦EMAIL_1';
    expect(neutralizePlaceholders(text)).toBe(text);
  });

  it('keeps a real value visible, so a genuine leak still reaches the judge', () => {
    const text = 'Write to taro@example.co.jp about ⟦PERSON_1⟧.';
    expect(neutralizePlaceholders(text)).toContain('taro@example.co.jp');
  });

  it('is deterministic across calls, despite the shared global regex', () => {
    // A verdict must not depend on which call rendered the text.
    const text = 'a ⟦EMAIL_1⟧ b ⟦EMAIL_2⟧';
    expect(neutralizePlaceholders(text)).toBe(neutralizePlaceholders(text));
  });
});

describe('digit-bearing categories', () => {
  // Regression: `[A-Z_]+` could not match IPV4 — the digit broke the run and
  // ⟦IPV4_1⟧ passed through strip/neutralize/categoryOf untouched.
  it('strips and neutralizes an IPV4 placeholder', () => {
    expect(stripPlaceholders('at ⟦IPV4_1⟧ today')).not.toContain('⟦');
    expect(neutralizePlaceholders('at ⟦IPV4_1⟧ today')).toContain('[masked');
  });
});

describe('user-defined secret terms', () => {
  it('masks a phrase no detector could have found', () => {
    // The whole point of the feature: "Titan Project" is not an email, a key or
    // a number, so nothing in `detect` has an opinion about it. The requester
    // asserting it is confidential is the only signal there is.
    const result = new SessionTokenizer().tokenize(
      'Ship Titan Project by Friday.',
      [],
      ['Titan Project'],
    );

    expect(result.text).not.toContain('Titan Project');
    expect(result.text).toContain('⟦CUSTOM_1⟧');
    expect(result.mapping['⟦CUSTOM_1⟧']).toBe('Titan Project');
  });

  it('substitutes the longer term first, so overlapping terms nest', () => {
    // With both named, "Titan Project" must become one placeholder rather than
    // `⟦CUSTOM_n⟧ Project` — a shorter term must never split a longer one.
    const result = new SessionTokenizer().tokenize(
      'Titan Project ships.',
      [],
      ['Titan', 'Titan Project'],
    );

    expect(result.text).toBe('⟦CUSTOM_1⟧ ships.');
    expect(result.mapping['⟦CUSTOM_1⟧']).toBe('Titan Project');
  });

  it('still masks the shorter term where the longer one does not appear', () => {
    const result = new SessionTokenizer().tokenize(
      'Titan Project and Titan alone.',
      [],
      ['Titan', 'Titan Project'],
    );

    expect(result.text).not.toContain('Titan');
    // Two distinct terms, so two distinct placeholders: equality is preserved
    // per term, exactly as it is per detected value.
    expect(Object.keys(result.mapping).sort()).toEqual(['⟦CUSTOM_1⟧', '⟦CUSTOM_2⟧']);
  });

  it('gives every occurrence of one term the same placeholder', () => {
    const result = new SessionTokenizer().tokenize('Titan, then Titan again.', [], ['Titan']);

    expect(result.text).toBe('⟦CUSTOM_1⟧, then ⟦CUSTOM_1⟧ again.');
  });

  it('matches case-sensitively, so ordinary prose is left alone', () => {
    // Changing case changes meaning: `titanium` is not the codename, and masking
    // it would mangle the prompt the frontier model is asked to reason about.
    const result = new SessionTokenizer().tokenize('Titan uses titanium alloy.', [], ['Titan']);

    expect(result.text).toBe('⟦CUSTOM_1⟧ uses titanium alloy.');
  });

  it('lets a term win over an overlapping regex detection', () => {
    // The requester asserted this exact string is confidential. Splitting it so
    // the email-shaped part becomes ⟦EMAIL_1⟧ would leave the rest of the
    // codename in the clear, which is the opposite of what was asked for.
    const result = new SessionTokenizer().tokenize(
      'Codename ops@titan.example is live.',
      [],
      ['ops@titan.example'],
    );

    expect(result.text).toBe('Codename ⟦CUSTOM_1⟧ is live.');
    expect(result.mapping['⟦CUSTOM_1⟧']).toBe('ops@titan.example');
  });

  it('still masks the detected PII that does not overlap a term', () => {
    const result = new SessionTokenizer().tokenize(
      'Titan Project, contact taro@example.co.jp.',
      [],
      ['Titan Project'],
    );

    expect(result.text).not.toContain('Titan Project');
    expect(result.text).not.toContain('taro@example.co.jp');
    expect(result.text).toContain('⟦EMAIL_1⟧');
  });

  it('round-trips: rehydrating restores the original text exactly', () => {
    const original = 'Titan Project ships; Titan Project again, plus taro@example.co.jp.';
    const result = new SessionTokenizer().tokenize(original, [], ['Titan Project']);

    expect(rehydrate(result.text, result.mapping)).toBe(original);
  });

  it('restores a CUSTOM value under the default disclosure policy', () => {
    // CUSTOM is deliberately not withheld: the requester supplied the term, so
    // withholding it protects nothing and makes the answer unreadable.
    const result = new SessionTokenizer().tokenize('Titan Project ships.', [], ['Titan Project']);
    const restored = rehydrateWithPolicy(result.text, result.mapping);

    expect(restored.text).toBe('Titan Project ships.');
    expect(restored.withheldCategories).not.toContain(CUSTOM_CATEGORY);
  });

  it('leaves the text untouched when no terms are named', () => {
    const before = new SessionTokenizer().tokenize('Ship Titan Project.', []);
    const after = new SessionTokenizer().tokenize('Ship Titan Project.', [], []);

    expect(before.text).toBe(after.text);
    expect(after.text).toContain('Titan Project');
  });

  it('masks the union when two equal-length terms overlap', () => {
    // Neither term can claim its whole span, but the characters they share are
    // covered by the one that wins — so neither term survives literally, which
    // is what the egress guard actually checks for.
    const result = new SessionTokenizer().tokenize('aXbXc', [], ['Xb', 'bX']);

    expect(countSurvivingTerms(result.text, ['Xb', 'bX'])).toBe(0);
  });

  it('finds no span for a term that does not occur', () => {
    expect(findTermSpans('nothing here', ['Titan'])).toEqual([]);
  });

  it('drops a term span that overlaps one already accepted', () => {
    // Two terms sharing characters produce one span, not two overlapping
    // placeholders over the same run of text.
    const spans = findTermSpans('Titan Project', ['Titan Project', 'Project']);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.category).toBe(CUSTOM_CATEGORY);
    expect(spans[0]?.value).toBe('Titan Project');
  });
});

describe('counting surviving terms', () => {
  it('counts a term that is still present verbatim', () => {
    expect(countSurvivingTerms('Titan Project ships', ['Titan Project'])).toBe(1);
  });

  it('counts nothing once the term has been substituted', () => {
    expect(countSurvivingTerms('⟦CUSTOM_1⟧ ships', ['Titan Project'])).toBe(0);
  });

  it('counts each surviving term once, however often it occurs', () => {
    expect(countSurvivingTerms('Titan Titan Titan', ['Titan'])).toBe(1);
  });

  it('is case-sensitive, matching the substitution it verifies', () => {
    // The guard must agree with the tokenizer: a check that folded case would
    // refuse a request whose masking was in fact complete.
    expect(countSurvivingTerms('titanium alloy', ['Titan'])).toBe(0);
  });

  it('counts nothing when no terms were named', () => {
    expect(countSurvivingTerms('Titan Project ships', [])).toBe(0);
  });
});

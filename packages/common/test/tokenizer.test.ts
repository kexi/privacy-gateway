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
  DEFAULT_WITHHELD_CATEGORIES,
  detect,
  findTokens,
  luhnValid,
  rehydrate,
  rehydrateWithPolicy,
  SessionTokenizer,
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

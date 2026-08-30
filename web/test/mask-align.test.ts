/**
 * What the client-side alignment guarantees.
 *
 * The gateway never returns the token mapping — it never leaves the vault — so
 * the UI recovers "which substring became which placeholder" by aligning the
 * text the user typed against the masked prompt that came back. These tests fix
 * the two properties that matter: the recovery is exact when the alignment
 * holds, and it produces *nothing* when it does not. A plausible-looking wrong
 * highlight would tell a user a value was sent to the frontier model when it was
 * not, which is worse than no highlight at all.
 */

import { describe, expect, it } from 'vitest';

import {
  alignMasked,
  distinctValues,
  findPlaceholders,
  findValueMatches,
} from '../src/mask-align.ts';

describe('findPlaceholders', () => {
  it('reports every placeholder with its category, index and offsets', () => {
    const found = findPlaceholders('Hi ⟦PERSON_1⟧, mail ⟦EMAIL_2⟧.');

    expect(found).toEqual([
      { token: '⟦PERSON_1⟧', category: 'PERSON', index: 1, start: 3, end: 13 },
      { token: '⟦EMAIL_2⟧', category: 'EMAIL', index: 2, start: 20, end: 29 },
    ]);
  });

  it('finds nothing in text that carries no placeholder', () => {
    expect(findPlaceholders('an ordinary sentence')).toEqual([]);
  });

  it('recognises a category name that carries a digit', () => {
    // `IPV4` is a real category. A pattern that allows only letters in the
    // category swallows `⟦IPV4_1⟧` into the surrounding literal, and then no
    // literal after it can ever be located in the original.
    const found = findPlaceholders('from ⟦IPV4_1⟧ today');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ token: '⟦IPV4_1⟧', category: 'IPV4', index: 1 });
  });

  it('splits a multi-word category at the last underscore', () => {
    const found = findPlaceholders('card ⟦CREDIT_CARD_12⟧');

    expect(found[0]).toMatchObject({ category: 'CREDIT_CARD', index: 12 });
  });
});

describe('alignMasked', () => {
  it('recovers the value behind a single placeholder', () => {
    const result = alignMasked('Email taro@example.co.jp today.', 'Email ⟦EMAIL_1⟧ today.');

    expect(result.aligned).toBe(true);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({
      token: '⟦EMAIL_1⟧',
      category: 'EMAIL',
      value: 'taro@example.co.jp',
      start: 6,
      end: 24,
      ambiguous: false,
    });
  });

  it('recovers several placeholders in one pass, in document order', () => {
    const original = 'Taro Yamada (taro@example.co.jp, 090-1234-5678) called.';
    const masked = '⟦PERSON_1⟧ (⟦EMAIL_1⟧, ⟦PHONE_1⟧) called.';

    const result = alignMasked(original, masked);

    expect(result.aligned).toBe(true);
    expect(result.spans.map((span) => span.value)).toEqual([
      'Taro Yamada',
      'taro@example.co.jp',
      '090-1234-5678',
    ]);
    // Every span points back at the text it was taken from.
    for (const span of result.spans) {
      expect(original.slice(span.start, span.end)).toBe(span.value);
    }
  });

  it('resolves a repeated value to each of its occurrences, not twice to the first', () => {
    const original = 'Taro Yamada wrote. Reply to Taro Yamada now.';
    const masked = '⟦PERSON_1⟧ wrote. Reply to ⟦PERSON_1⟧ now.';

    const result = alignMasked(original, masked);

    expect(result.spans.map((span) => span.start)).toEqual([0, 28]);
    expect(result.spans.every((span) => span.token === '⟦PERSON_1⟧')).toBe(true);
  });

  it('handles a placeholder at the very start and at the very end', () => {
    const result = alignMasked(
      'Taro Yamada lives at 1-2-3 Shibuya',
      '⟦PERSON_1⟧ lives at ⟦ADDRESS_1⟧',
    );

    expect(result.aligned).toBe(true);
    expect(result.spans.map((span) => span.value)).toEqual(['Taro Yamada', '1-2-3 Shibuya']);
  });

  it('does not invent a boundary between adjacent placeholders', () => {
    // Nothing separates the two placeholders, so nothing in either string says
    // where one masked value ended and the next began.
    const result = alignMasked('Taro Yamada090-1234-5678 called', '⟦PERSON_1⟧⟦PHONE_1⟧ called');

    expect(result.aligned).toBe(true);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({
      token: '⟦PERSON_1⟧',
      value: 'Taro Yamada090-1234-5678',
      ambiguous: true,
    });
  });

  it('reports an aligned result with no spans when nothing was masked', () => {
    const result = alignMasked('Nothing sensitive here.', 'Nothing sensitive here.');

    expect(result).toEqual({ placeholders: [], spans: [], aligned: true });
  });

  it('aligns the demo request the gateway actually produces', () => {
    // The exact pair the E2E specs drive, so a category the pattern cannot read
    // (`IPV4`) fails here rather than only in a browser.
    const original =
      'Customer Taro Yamada (taro@example.co.jp, 090-1234-5678) reports that the charge on ' +
      'card 4242 4242 4242 4242 failed. Our API key sk-abcdefghijklmnopqrstuvwxyz012345 was ' +
      'used from 192.168.10.5. Draft a reply and a Python snippet to update the record.';
    const masked =
      'Customer Taro Yamada (⟦EMAIL_1⟧, ⟦PHONE_1⟧) reports that the charge on card ' +
      '⟦CREDIT_CARD_1⟧ failed. Our API key ⟦API_KEY_1⟧ was used from ⟦IPV4_1⟧. Draft a ' +
      'reply and a Python snippet to update the record.';

    const result = alignMasked(original, masked);

    expect(result.aligned).toBe(true);
    expect(result.spans.map((span) => span.value)).toEqual([
      'taro@example.co.jp',
      '090-1234-5678',
      '4242 4242 4242 4242',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      '192.168.10.5',
    ]);
  });

  it('refuses to align when the surrounding text does not match', () => {
    // The masked prompt did not come from this original: a highlight derived
    // from it would mark text that was never substituted.
    const result = alignMasked('Completely different text.', 'Email ⟦EMAIL_1⟧ today.');

    expect(result.aligned).toBe(false);
    expect(result.spans).toEqual([]);
    // The placeholders are still known: the masked-prompt pane can chip them.
    expect(result.placeholders).toHaveLength(1);
  });

  it('refuses to align when a literal segment is missing from the original', () => {
    const result = alignMasked('Email taro@example.co.jp yesterday.', 'Email ⟦EMAIL_1⟧ today.');

    expect(result.aligned).toBe(false);
    expect(result.spans).toEqual([]);
  });
});

describe('findValueMatches', () => {
  const spans = alignMasked(
    'Taro Yamada (taro@example.co.jp) called.',
    '⟦PERSON_1⟧ (⟦EMAIL_1⟧) called.',
  ).spans;

  it('finds a restored value wherever it reappears in the answer', () => {
    const answer = 'Dear Taro Yamada, we mailed taro@example.co.jp about it, Taro Yamada.';

    const matches = findValueMatches(answer, spans);

    expect(matches.map((match) => match.token)).toEqual(['⟦PERSON_1⟧', '⟦EMAIL_1⟧', '⟦PERSON_1⟧']);
    for (const match of matches) {
      expect(answer.slice(match.start, match.end)).toBe(
        spans.find((span) => span.token === match.token)?.value,
      );
    }
  });

  it('returns the matches in document order', () => {
    const answer = 'taro@example.co.jp belongs to Taro Yamada.';

    const starts = findValueMatches(answer, spans).map((match) => match.start);

    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('finds nothing when the answer restored nothing', () => {
    expect(findValueMatches('The request was handled.', spans)).toEqual([]);
  });

  it('lets the longer value win where two overlap', () => {
    // "Taro" inside "Taro Yamada" must not fragment the full name's highlight.
    const overlapping = alignMasked('Taro Yamada and Taro', '⟦PERSON_1⟧ and ⟦PERSON_2⟧').spans;

    const matches = findValueMatches('Taro Yamada', overlapping);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ token: '⟦PERSON_1⟧', start: 0, end: 11 });
  });

  it('never matches a value recovered from an ambiguous gap', () => {
    // The gap covering two adjacent placeholders holds both values glued
    // together; highlighting that string in the answer would claim a value the
    // gateway never restored.
    const ambiguous = alignMasked('AliceBob spoke', '⟦PERSON_1⟧⟦PERSON_2⟧ spoke').spans;

    expect(findValueMatches('AliceBob spoke again', ambiguous)).toEqual([]);
  });
});

describe('distinctValues', () => {
  it('collapses repeated occurrences of one placeholder to a single entry', () => {
    const spans = alignMasked(
      'Taro Yamada wrote. Reply to Taro Yamada.',
      '⟦PERSON_1⟧ wrote. Reply to ⟦PERSON_1⟧.',
    ).spans;

    const distinct = distinctValues(spans);

    expect(spans).toHaveLength(2);
    expect(distinct).toHaveLength(1);
    expect(distinct[0]?.value).toBe('Taro Yamada');
  });
});

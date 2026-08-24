/**
 * What the attester's scanner guarantees per category.
 *
 * The verdict path is covered in `attester.test.ts`; these cases pin the
 * detection rules themselves, including the validators that keep look-alike
 * numbers from being reported as leaks.
 */

import { describe, expect, it } from 'vitest';
import { scan } from '../src/attesters/leak_check.ts';

describe('category detection', () => {
  it.each([
    ['EMAIL', 'write to taro@example.co.jp'],
    ['PHONE', 'call 090-1234-5678'],
    ['MY_NUMBER', 'number 123456789012'],
    ['IPV4', 'host 192.168.10.5'],
    ['CREDIT_CARD', 'card 4242 4242 4242 4242'],
    ['AWS_KEY', 'key AKIAIOSFODNN7EXAMPLE'],
    ['API_KEY', 'token sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r-wW1g'],
  ])('reports %s', (category, text) => {
    expect(scan(text)).toContain(category);
  });

  it('reports nothing for a clean response', () => {
    expect(scan('Your record has been updated. Please review the summary.')).toEqual([]);
  });

  it('treats a masked placeholder as clean', () => {
    // Placeholders are the whole point of the exchange; flagging them would make
    // every well-formed answer fail.
    expect(scan('Dear ⟦PERSON_1⟧, we wrote to ⟦EMAIL_1⟧.')).toEqual([]);
  });
});

describe('false-positive suppression', () => {
  it('does not report a digit run that fails Luhn as a card', () => {
    expect(scan('order 4242424242424243 shipped')).not.toContain('CREDIT_CARD');
  });

  it('does not report an out-of-range octet as an IPv4 address', () => {
    expect(scan('version 999.1.1.1')).not.toContain('IPV4');
  });

  it('accepts several distinct card numbers', () => {
    expect(scan('cards 4111111111111111 and 5555555555554444')).toContain('CREDIT_CARD');
  });
});

describe('reporting', () => {
  it('sorts and deduplicates the categories', () => {
    const findings = scan('a@b.co, c@d.co, host 10.0.0.1, call 090-1234-5678');
    expect(findings).toEqual([...new Set(findings)].sort());
  });

  it('reports every category present, not just the first', () => {
    const findings = scan('mail a@b.co and call 090-1234-5678 from 10.0.0.1');
    expect(findings).toEqual(expect.arrayContaining(['EMAIL', 'PHONE', 'IPV4']));
  });
});

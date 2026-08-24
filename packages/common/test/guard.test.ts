/** What the egress guard guarantees: text containing raw PII cannot cross the boundary. */

import { describe, expect, it } from 'vitest';
import { assertNoPii, PiiLeakError, scan } from '../src/guard.ts';
import { tokenize } from '../src/tokenizer.ts';

const LEAKY = 'call 090-1234-5678 or mail taro@example.co.jp';

describe('egress guard', () => {
  it('lets masked text pass', () => {
    const masked = tokenize(LEAKY).text;
    expect(scan(masked).ok).toBe(true);
    expect(() => {
      assertNoPii(masked);
    }).not.toThrow();
  });

  it('refuses raw PII', () => {
    expect(() => {
      assertNoPii(LEAKY);
    }).toThrow(PiiLeakError);
  });

  it('names the categories it found in the refusal', () => {
    const report = scan(LEAKY);
    expect(report.ok).toBe(false);
    expect([...report.categories].sort()).toEqual(['EMAIL', 'PHONE']);
  });

  it('still refuses partially masked text', () => {
    // The email is masked by hand while the phone number is left in place. The
    // guard must catch what remains.
    const partly = LEAKY.replace('taro@example.co.jp', '⟦EMAIL_1⟧');
    try {
      assertNoPii(partly);
      expect.unreachable('the guard must refuse partially masked text');
    } catch (error) {
      expect(error).toBeInstanceOf(PiiLeakError);
      expect((error as PiiLeakError).categories).toEqual(['PHONE']);
    }
  });

  it('passes text that never contained PII', () => {
    expect(scan('Draft a three-line status update about the migration.').ok).toBe(true);
  });
});

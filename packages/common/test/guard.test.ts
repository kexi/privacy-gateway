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

describe('the egress guard scans for requester-named terms', () => {
  it('refuses to send a prompt in which a named term survived', () => {
    // Simulates a masking failure over the one category with no lexical form: no
    // regex would have caught this, so the literal scan is the only coverage.
    const report = scan('Ship Titan Project by Friday.', ['Titan Project']);

    expect(report.ok).toBe(false);
    expect(report.survivingTerms).toBe(1);
    expect(report.categories).toContain('CUSTOM');
  });

  it('passes once the term has been substituted', () => {
    const masked = tokenize('Ship Titan Project by Friday.').text.replace(
      'Titan Project',
      '⟦CUSTOM_1⟧',
    );
    const report = scan(masked, ['Titan Project']);

    expect(report.ok).toBe(true);
    expect(report.survivingTerms).toBe(0);
  });

  it('throws with CUSTOM among the categories, and no term in the message', () => {
    try {
      assertNoPii('Ship Titan Project.', ['Titan Project']);
      expect.unreachable('the guard must refuse a surviving term');
    } catch (error) {
      expect(error).toBeInstanceOf(PiiLeakError);
      const leak = error as PiiLeakError;
      expect(leak.categories).toEqual(['CUSTOM']);
      expect(leak.survivingTerms).toBe(1);
      // The refusal must not repeat the secret it refused to send.
      expect(leak.message).not.toContain('Titan');
    }
  });

  it('counts each surviving term, reporting how many rather than which', () => {
    const report = scan('Titan Project and Project Hummingbird', [
      'Titan Project',
      'Project Hummingbird',
      'Absent Codename',
    ]);

    expect(report.survivingTerms).toBe(2);
  });

  it('is case-sensitive, so it agrees with the substitution it verifies', () => {
    // A guard that folded case would refuse a request whose masking was in fact
    // complete, turning correct behaviour into a 422.
    expect(scan('titanium alloy is fine', ['Titan']).ok).toBe(true);
  });

  it('behaves exactly as before when no terms are named', () => {
    const masked = tokenize(LEAKY).text;
    expect(scan(masked).ok).toBe(true);
    expect(scan(masked, []).ok).toBe(true);
    expect(scan(masked).survivingTerms).toBe(0);
  });

  it('reports both a PII finding and a surviving term together', () => {
    const report = scan('Titan Project, call 090-1234-5678', ['Titan Project']);

    expect(report.ok).toBe(false);
    expect([...report.categories].sort()).toEqual(['CUSTOM', 'PHONE']);
  });
});

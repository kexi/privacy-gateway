/**
 * What the inbound guard guarantees: text containing only masked placeholders
 * passes, while raw PII and secrets are rejected and reported with their kind.
 */

import { describe, expect, it } from 'vitest';
import { extractPlaceholders, inspect } from '../src/guard.ts';

describe('inspect', () => {
  it('passes a body made only of placeholders', () => {
    const text =
      'Draft a reply to ⟦PERSON_1⟧ at ⟦EMAIL_1⟧ about card ⟦CARD_1⟧ and rotate ⟦SECRET_1⟧.';
    expect(inspect(text)).toEqual({ ok: true, findings: [] });
  });

  it('passes ordinary prose with no PII', () => {
    expect(inspect('Write a Python function that sorts a list of integers.').ok).toBe(true);
  });

  it('passes the empty string', () => {
    expect(inspect('').ok).toBe(true);
  });

  it('rejects a raw email address as EMAIL', () => {
    const result = inspect('Contact alice.smith@example.co.jp for details.');
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toContain('EMAIL');
  });

  it('rejects a Luhn-valid card number as CARD', () => {
    // 4111 1111 1111 1111 is the standard Luhn-valid Visa test number.
    const result = inspect('Charge 4111 1111 1111 1111 please.');
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toContain('CARD');
  });

  it('does not treat a non-Luhn digit run as a card', () => {
    const result = inspect('Order reference 1234567890123456 shipped.');
    expect(result.findings.some((f) => f.kind === 'CARD')).toBe(false);
  });

  it('rejects an international-format phone number as PHONE', () => {
    const result = inspect('Call +81 90-1234-5678 tomorrow.');
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toContain('PHONE');
  });

  it.each([
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['Slack token', 'xoxb-1234567890-abcdefghijkl'],
    ['OpenAI-style key', 'sk-abcdefghijklmnopqrstuvwxyz0123'],
    ['PEM private key header', '-----BEGIN RSA PRIVATE KEY-----'],
  ])('rejects a %s as SECRET', (_label, secret) => {
    const result = inspect(`The credential is ${secret} and must be rotated.`);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toContain('SECRET');
  });

  it('keeps only the length, never the matched value', () => {
    const result = inspect('mail: victim@example.com');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('victim@example.com');
    expect(result.findings[0]?.length).toBe('victim@example.com'.length);
  });

  it('does not misread placeholder internals as PII', () => {
    // Placeholder contents are stripped before scanning, so they cannot match EMAIL.
    expect(inspect('Send to ⟦EMAIL_1⟧ and ⟦EMAIL_2⟧.').ok).toBe(true);
  });

  it('does not read an ISO date and hour as a phone number', () => {
    // The repo's own AGENTS.md ("Deadline: 2026-08-31 17:00 PDT") satisfied the
    // phone shape — four digit groups, ten digits — and blocked every prompt
    // that quoted it. A date is prose, not an identifier.
    expect(inspect('Deadline: 2026-08-31 17:00 PDT.').ok).toBe(true);
    expect(inspect('shipped on 2026-01-02 09:30:15').ok).toBe(true);
  });

  it('still reads a real phone number as a phone number', () => {
    expect(inspect('call +81 90-1234-5678 now').ok).toBe(false);
    expect(inspect('dial 03-1234-5678 22 today').ok).toBe(false);
  });

  it('does not double-count a card span as a phone number', () => {
    const result = inspect('4111 1111 1111 1111');
    expect(result.findings.filter((f) => f.kind === 'PHONE')).toHaveLength(0);
    expect(result.findings.filter((f) => f.kind === 'CARD')).toHaveLength(1);
  });
});

describe('extractPlaceholders', () => {
  it('returns distinct placeholders in order of first appearance', () => {
    expect(extractPlaceholders('⟦PERSON_1⟧ told ⟦PERSON_2⟧ about ⟦PERSON_1⟧')).toEqual([
      '⟦PERSON_1⟧',
      '⟦PERSON_2⟧',
    ]);
  });

  it('returns an empty array when there are no placeholders', () => {
    expect(extractPlaceholders('no tokens here')).toEqual([]);
  });

  it('rejects lowercase or wrong-bracket lookalikes', () => {
    expect(extractPlaceholders('[PERSON_1] ⟦person_1⟧ {{EMAIL_1}}')).toEqual([]);
  });
});

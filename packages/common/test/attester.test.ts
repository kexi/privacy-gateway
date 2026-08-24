/**
 * What the deterministic attester (from the OKF bundle) guarantees.
 *
 * The verdict rests on the attester rescanning the text itself, not on what the
 * receipt claims about itself. The bundle copy is imported directly — the same
 * file Synthesis loads — so a drift between bundle and agent fails here.
 */

import { describe, expect, it } from 'vitest';
import { responseHash, scan, verify, type Receipt } from '../src/attesters/leak_check.ts';

const CLEAN = 'Dear customer, your record has been updated. Please review the summary.';
const LEAKY = 'Dear Taro, we will mail taro@example.co.jp shortly.';

/** The receipt shape `/references/skills/run-leak-check.md` specifies. */
function buildReceipt(sessionId: string, response: string): Receipt {
  return {
    session_id: sessionId,
    response_hash: responseHash(response),
    findings: scan(response),
    response,
  };
}

describe('attestation', () => {
  it('attests a clean response', () => {
    const verdict = verify(buildReceipt('s1', CLEAN));
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it('fails a response containing PII', () => {
    const verdict = verify(buildReceipt('s1', LEAKY));
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContain('EMAIL');
  });

  it('names the categories in the failure reason', () => {
    expect(verify(buildReceipt('s1', LEAKY)).reason).toContain('EMAIL');
  });

  it('carries the session id for the audit trail', () => {
    expect(verify(buildReceipt('session-42', CLEAN)).details['session_id']).toBe('session-42');
  });
});

describe('receipt validation', () => {
  it('refuses a receipt missing required fields', () => {
    const verdict = verify({ session_id: 's1' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('missing required fields');
  });

  it('refuses a receipt without the response text', () => {
    // Without the body the attester cannot rederive the verdict independently,
    // so it must not pass.
    const verdict = verify({ session_id: 's1', response_hash: 'x', findings: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('response');
  });

  it('refuses a hash that does not match the text', () => {
    const receipt = buildReceipt('s1', CLEAN);
    receipt.response = 'a completely different body';
    const verdict = verify(receipt);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('response_hash');
  });

  it('fails rather than passes a runner that under-reports findings', () => {
    // This is the heart of the attester: a runner falsely reporting empty
    // findings does not get waved through.
    const receipt = buildReceipt('s1', LEAKY);
    receipt.findings = [];
    const verdict = verify(receipt);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('do not match independently derived findings');
  });

  it('refuses a non-mapping receipt', () => {
    expect(verify('not a receipt').ok).toBe(false);
  });
});

describe('scanning', () => {
  it('reports categories sorted and deduplicated', () => {
    const findings = scan('a@b.co and c@d.co and 090-1234-5678');
    expect(findings).toEqual([...new Set(findings)].sort());
    expect(findings).toContain('EMAIL');
  });

  it('hashes the same text stably', () => {
    expect(responseHash(CLEAN)).toBe(responseHash(CLEAN));
    expect(responseHash(CLEAN)).not.toBe(responseHash(LEAKY));
  });
});

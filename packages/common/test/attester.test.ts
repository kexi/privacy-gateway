/**
 * What the deterministic attester (from the OKF bundle) guarantees.
 *
 * The verdict rests on the attester rescanning the text itself, not on what the
 * receipt claims about itself. The bundle copy is imported directly — the same
 * file Synthesis loads — so a drift between bundle and agent fails here.
 */

import { describe, expect, it } from 'vitest';
import {
  RECEIPT_FIELDS,
  responseHash,
  scan,
  verify,
  type Receipt,
} from '../src/attesters/leak_check.ts';

const CLEAN = 'Dear customer, your record has been updated. Please review the summary.';
const LEAKY = 'Dear Taro, we will mail taro@example.co.jp shortly.';
const PROMPT = 'Please help ⟦PERSON_1⟧ at ⟦EMAIL_1⟧.';
const REQUEST_ID = '01920000-0000-7000-8000-000000000001';

/** The receipt shape `/references/skills/run-leak-check.md` specifies. */
function buildReceipt(requestId: string, response: string, prompt = PROMPT): Receipt {
  return {
    request_id: requestId,
    masked_prompt_hash: responseHash(prompt),
    response_hash: responseHash(response),
    findings: scan(response),
    response,
  };
}

describe('the receipt contract', () => {
  it('declares exactly the fields verify() demands', () => {
    // The bundle's `executor.receipt` lists the same names. A contract that
    // omits a field verify() requires cannot be executed by a third party.
    expect([...RECEIPT_FIELDS]).toEqual([
      'request_id',
      'masked_prompt_hash',
      'response_hash',
      'findings',
      'response',
    ]);
  });

  it('accepts a receipt built from exactly the declared fields', () => {
    const receipt = Object.fromEntries(
      RECEIPT_FIELDS.map((field) => [field, buildReceipt(REQUEST_ID, CLEAN)[field]]),
    );
    expect(verify(receipt).ok).toBe(true);
  });
});

describe('attestation', () => {
  it('attests a clean response', () => {
    const verdict = verify(buildReceipt(REQUEST_ID, CLEAN));
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it('fails a response containing PII', () => {
    const verdict = verify(buildReceipt(REQUEST_ID, LEAKY));
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toContain('EMAIL');
  });

  it('names the categories in the failure reason', () => {
    expect(verify(buildReceipt(REQUEST_ID, LEAKY)).reason).toContain('EMAIL');
  });

  it('carries the request id for the audit trail', () => {
    expect(verify(buildReceipt('request-42', CLEAN)).details['request_id']).toBe('request-42');
  });

  it('binds the verdict to the masked prompt that produced the response', () => {
    // Without this a receipt from one exchange could be presented as evidence
    // for another.
    const verdict = verify(buildReceipt(REQUEST_ID, CLEAN));
    expect(verdict.details['masked_prompt_hash']).toBe(responseHash(PROMPT));
  });
});

describe('receipt validation', () => {
  it('refuses a receipt missing required fields', () => {
    const verdict = verify({ request_id: REQUEST_ID });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('missing required fields');
  });

  it('refuses a receipt without the response text', () => {
    // Without the body the attester cannot rederive the verdict independently,
    // so it must not pass.
    const receipt = buildReceipt(REQUEST_ID, CLEAN);
    receipt.response = 42;
    const verdict = verify(receipt);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('response');
  });

  it('refuses a receipt without a masked prompt binding', () => {
    const receipt = buildReceipt(REQUEST_ID, CLEAN);
    receipt.masked_prompt_hash = '';
    const verdict = verify(receipt);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('masked_prompt_hash');
  });

  it('refuses a hash that does not match the text', () => {
    const receipt = buildReceipt(REQUEST_ID, CLEAN);
    receipt.response = 'a completely different body';
    const verdict = verify(receipt);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('response_hash');
  });

  it('fails rather than passes a runner that under-reports findings', () => {
    // This is the heart of the attester: a runner falsely reporting empty
    // findings does not get waved through.
    const receipt = buildReceipt(REQUEST_ID, LEAKY);
    receipt.findings = [];
    const verdict = verify(receipt);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('do not match independently derived findings');
  });

  it('refuses a non-mapping receipt', () => {
    expect(verify('not a receipt').ok).toBe(false);
    expect(verify(null).ok).toBe(false);
    expect(verify([]).ok).toBe(false);
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

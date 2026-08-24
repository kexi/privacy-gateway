/**
 * Deterministic attester for the leak-check Attested Computation.
 *
 * Inspects a receipt produced by `/references/skills/run-leak-check.md` and
 * returns a verdict. It re-runs the regex detection itself rather than trusting
 * the receipt's `findings` list, so a runner that under-reports cannot produce a
 * passing verdict.
 *
 * Never uses an LLM. Never makes network calls. Safe to run consumer-side.
 *
 * Receipt shape — every field below is declared in `executor.receipt`, so the
 * contract in `/computations/leak-check.md` and what `verify()` demands are the
 * same list:
 *
 *     {
 *       "request_id": "0198...-...",
 *       "masked_prompt_hash": "<sha256 of the masked prompt sent to core>",
 *       "response_hash": "<sha256 of the response text>",
 *       "findings": ["EMAIL", ...],
 *       "response": "<the response text the runner checked>",
 *       "masked_prompt": "<the masked prompt itself>"
 *     }
 *
 * `response` and `masked_prompt` are carried so the attester can re-derive both
 * hashes itself instead of trusting the runner. The previous version accepted
 * any non-empty `masked_prompt_hash`, which meant the prompt binding was
 * *asserted* by the runner rather than *attested* by this code — a receipt could
 * name any prompt at all and still pass.
 *
 * `masked_prompt` is optional so an older receipt still verifies its response,
 * but a receipt without it is reported as `prompt_bound: false` in the details
 * and a replay tool is expected to treat that as an incomplete attestation.
 */

import { createHash } from 'node:crypto';

/** A SHA-256 digest: 64 lowercase hex characters, and nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * These patterns are a subset of the gateway tokenizer's, with the same intent.
 * The attester must be runnable standalone, including outside the trust
 * boundary, so it is deliberately self-contained rather than importing that
 * module.
 */
const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['EMAIL', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu],
  ['AWS_KEY', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/gu],
  [
    'API_KEY',
    /\bsk-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}\b|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bAIza[0-9A-Za-z_-]{35}\b/gu,
  ],
  ['CREDIT_CARD', /\b(?:\d[ -]?){12,18}\d\b/gu],
  ['PHONE', /(?<![\d-])(?:\+81[ -]?|0)\d{1,4}[ -]?\d{1,4}[ -]?\d{3,4}(?![\d-])/gu],
  ['MY_NUMBER', /(?<![\d-])\d{12}(?![\d-])/gu],
  ['IPV4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu],
];

/**
 * The complete receipt contract.
 *
 * `verify()` demands exactly this list, and `/computations/leak-check.md`
 * declares the same one under `executor.receipt`. Keeping them equal is what
 * makes the computation replayable by a third party.
 */
export const RECEIPT_FIELDS = [
  'request_id',
  'masked_prompt_hash',
  'response_hash',
  'findings',
  'response',
  'masked_prompt',
] as const;

/** The receipt an executor must produce for this computation. */
export interface Receipt {
  request_id?: unknown;
  masked_prompt_hash?: unknown;
  response_hash?: unknown;
  findings?: unknown;
  response?: unknown;
  masked_prompt?: unknown;
  [key: string]: unknown;
}

/** The attester's verdict. `ok === false` must be surfaced, never dropped. */
export interface Verdict {
  ok: boolean;
  reason: string | null;
  findings: string[];
  details: Record<string, unknown>;
}

function digitsOf(value: string): string {
  return value.replace(/\D/gu, '');
}

function luhnValid(digits: string): boolean {
  if (!/^\d+$/u.test(digits) || digits.length < 12 || digits.length > 19) return false;
  let total = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const char = digits[digits.length - 1 - index];
    if (char === undefined) continue;
    let value = char.charCodeAt(0) - 48;
    if (index % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    total += value;
  }
  return total % 10 === 0;
}

function validIpv4(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d+$/u.test(part) && Number.parseInt(part, 10) <= 255)
  );
}

/** Return the sorted set of PII categories detected in `text`. */
export function scan(text: string): string[] {
  const found = new Set<string>();

  for (const [category, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (category === 'CREDIT_CARD' && !luhnValid(digitsOf(value))) continue;
      if (category === 'IPV4' && !validIpv4(value)) continue;
      if (category === 'MY_NUMBER' && digitsOf(value).length !== 12) continue;
      found.add(category);
    }
  }
  return [...found].sort();
}

/** The canonical hash a runner must report in the receipt. */
export function responseHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Alias for readability at the call sites that hash the masked prompt. */
export const sha256 = responseHash;

/**
 * Verify a leak-check receipt.
 *
 * Callers MUST treat `ok === false` as a failed attestation and surface it
 * rather than dropping it (OKF SPEC §10.5).
 */
export function verify(receipt: unknown): Verdict {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, reason: 'receipt is not a mapping', findings: [], details: {} };
  }

  const record = receipt as Receipt;
  const missing = RECEIPT_FIELDS.filter((field) => !(field in record));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `receipt is missing required fields: ${missing.join(', ')}`,
      findings: [],
      details: { receipt_keys: Object.keys(record).sort() },
    };
  }

  const response = record.response;
  if (typeof response !== 'string') {
    return {
      ok: false,
      reason: 'receipt response must be a string',
      findings: [],
      details: { receipt_keys: Object.keys(record).sort() },
    };
  }

  if (
    typeof record.masked_prompt_hash !== 'string' ||
    !SHA256_HEX.test(record.masked_prompt_hash)
  ) {
    return {
      ok: false,
      reason: 'receipt masked_prompt_hash must be 64 lowercase hex characters',
      findings: [],
      details: { receipt_keys: Object.keys(record).sort() },
    };
  }

  if (typeof record.response_hash !== 'string' || !SHA256_HEX.test(record.response_hash)) {
    return {
      ok: false,
      reason: 'receipt response_hash must be 64 lowercase hex characters',
      findings: [],
      details: { receipt_keys: Object.keys(record).sort() },
    };
  }

  // Binding: recompute the prompt hash from the prompt itself. Accepting the
  // runner's word for it made the "this verdict is about that prompt" claim
  // unattested, so a receipt could be replayed against a different exchange.
  const maskedPrompt = record.masked_prompt;
  if (typeof maskedPrompt !== 'string') {
    return {
      ok: false,
      reason: 'receipt masked_prompt must be a string so the prompt hash can be re-derived',
      findings: [],
      details: { receipt_keys: Object.keys(record).sort() },
    };
  }
  const actualPromptHash = responseHash(maskedPrompt);
  if (record.masked_prompt_hash !== actualPromptHash) {
    return {
      ok: false,
      reason: 'masked_prompt_hash does not match the masked prompt text',
      findings: [],
      details: { claimed: record.masked_prompt_hash, actual: actualPromptHash },
    };
  }

  // Fidelity: the hash must match the text the attester is about to scan.
  const actualHash = responseHash(response);
  if (record.response_hash !== actualHash) {
    return {
      ok: false,
      reason: 'response_hash does not match the response text',
      findings: [],
      details: { claimed: record.response_hash, actual: actualHash },
    };
  }

  // Provenance: re-derive findings rather than trusting the runner's list.
  const findings = scan(response);
  const claimed = Array.isArray(record.findings) ? [...record.findings].map(String).sort() : [];
  if (claimed.join(' ') !== findings.join(' ')) {
    return {
      ok: false,
      reason: 'runner findings do not match independently derived findings',
      findings,
      details: { claimed, derived: findings },
    };
  }

  if (findings.length > 0) {
    return {
      ok: false,
      reason: `raw PII detected in response: ${findings.join(', ')}`,
      findings,
      details: { request_id: record.request_id },
    };
  }

  return {
    ok: true,
    reason: null,
    findings: [],
    details: {
      request_id: record.request_id,
      response_hash: actualHash,
      masked_prompt_hash: actualPromptHash,
      // Both hashes were re-derived here, not taken from the runner.
      prompt_bound: true,
    },
  };
}

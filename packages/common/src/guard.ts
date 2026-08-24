/**
 * Egress guard on the trust boundary (defense in depth).
 *
 * Immediately before sending to the Core Agent, the regex detection is run once
 * more and the request is refused if even a single piece of raw PII remains.
 *
 * **What this can and cannot catch.** It re-runs the *same* deterministic
 * patterns the tokenizer ran, so it catches a tokenizer bug — a substitution
 * that failed to apply, a mapping that was dropped — over the structured
 * categories those patterns cover: emails, phone numbers, card numbers, keys.
 *
 * It does **not** catch a personal name or a postal address that Gemma's span
 * extraction missed. No regex can: those categories have no lexical form to
 * match, which is why Gemma is asked about them in the first place. A false
 * negative from the extractor passes through this guard unchanged. The fleet's
 * answer to that risk is elsewhere — `ExtractionFailedError` refuses the request
 * outright when Gemma is unusable, so the failure mode is a refusal rather than
 * a silent send — but an extractor that confidently returns the wrong answer is
 * a residual risk this guard does not close. See `docs/ARCHITECTURE.md` §
 * "Pseudonymization, not anonymization".
 */

import { detect, type Detection } from './tokenizer.ts';

/** The guard's verdict. */
export interface GuardReport {
  readonly ok: boolean;
  readonly findings: readonly Detection[];
  /** Sorted, deduplicated categories — the only detail safe to log. */
  readonly categories: readonly string[];
}

/** Raised when text about to leave the boundary still contains raw PII. */
export class PiiLeakError extends Error {
  readonly findings: readonly Detection[];
  readonly categories: readonly string[];

  constructor(findings: readonly Detection[]) {
    const categories = uniqueCategories(findings);
    super(`refusing to send text containing raw PII: ${categories.join(', ')}`);
    this.name = 'PiiLeakError';
    this.findings = findings;
    this.categories = categories;
  }
}

function uniqueCategories(findings: readonly Detection[]): string[] {
  return [...new Set(findings.map((finding) => finding.category))].sort();
}

/** Check whether any raw PII remains in `text`. */
export function scan(text: string): GuardReport {
  const findings = detect(text);
  return { ok: findings.length === 0, findings, categories: uniqueCategories(findings) };
}

/** Throw `PiiLeakError` if any raw PII remains. */
export function assertNoPii(text: string): void {
  const report = scan(text);
  if (!report.ok) throw new PiiLeakError(report.findings);
}

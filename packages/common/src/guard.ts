/**
 * Egress guard on the trust boundary (defense in depth).
 *
 * Immediately before sending to the Core Agent, the regex detection is run once
 * more and the request is refused if even a single piece of raw PII remains.
 * This redundancy structurally prevents a bug in the tokenizer, or an
 * unstructured span Gemma missed, from reaching Gemini.
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

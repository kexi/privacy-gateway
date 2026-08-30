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
 *
 * **Requester-named terms are the exception to all of that.** A term is checked
 * by literal string comparison rather than by pattern, so the guard's coverage
 * of it is total: if the substitution failed anywhere, the string is still there
 * and this finds it. It is the only category where the guard can prove the
 * masking worked rather than merely re-running the detector that decided it.
 */

import { countSurvivingTerms, CUSTOM_CATEGORY, detect, type Detection } from './tokenizer.ts';

/** The guard's verdict. */
export interface GuardReport {
  readonly ok: boolean;
  readonly findings: readonly Detection[];
  /** Sorted, deduplicated categories — the only detail safe to log. */
  readonly categories: readonly string[];
  /**
   * How many requester-named terms survived masking, when any were named.
   *
   * A count, never the terms: this number reaches a log line and a refusal body,
   * and a term is an enterprise secret by construction. Zero when none were
   * named, which is the existing behaviour exactly.
   */
  readonly survivingTerms: number;
}

/**
 * Raised when text about to leave the boundary still contains raw PII, or a
 * phrase the requester asked to have masked.
 *
 * The message names categories only. `CUSTOM` appears among them when a
 * requester-named term survived, which tells the caller which protection failed
 * without the refusal repeating the secret it exists to protect.
 */
export class PiiLeakError extends Error {
  readonly findings: readonly Detection[];
  readonly categories: readonly string[];
  /** How many requester-named terms survived. Zero on an ordinary PII refusal. */
  readonly survivingTerms: number;

  constructor(findings: readonly Detection[], survivingTerms = 0) {
    const categories = [
      ...new Set([
        ...findings.map((finding) => finding.category),
        ...(survivingTerms > 0 ? [CUSTOM_CATEGORY] : []),
      ]),
    ].sort();
    super(`refusing to send text containing raw PII: ${categories.join(', ')}`);
    this.name = 'PiiLeakError';
    this.findings = findings;
    this.categories = categories;
    this.survivingTerms = survivingTerms;
  }
}

function uniqueCategories(findings: readonly Detection[], hasSurvivingTerms: boolean): string[] {
  return [
    ...new Set([
      ...findings.map((finding) => finding.category),
      ...(hasSurvivingTerms ? [CUSTOM_CATEGORY] : []),
    ]),
  ].sort();
}

/**
 * Check whether any raw PII — or any requester-named term — remains in `text`.
 *
 * The term scan is the half no detector can do. A regex re-run can only catch a
 * tokenizer bug over the shapes it already knows; a codename has no shape, so
 * the only way to prove the substitution actually applied is to look for the
 * literal string that was supposed to be gone. This is where a masking failure
 * on the one category the requester explicitly asked for becomes a refusal
 * instead of a send.
 */
export function scan(text: string, terms: readonly string[] = []): GuardReport {
  const findings = detect(text);
  const survivingTerms = countSurvivingTerms(text, terms);
  return {
    ok: findings.length === 0 && survivingTerms === 0,
    findings,
    categories: uniqueCategories(findings, survivingTerms > 0),
    survivingTerms,
  };
}

/** Throw `PiiLeakError` if any raw PII or requester-named term remains. */
export function assertNoPii(text: string, terms: readonly string[] = []): void {
  const report = scan(text, terms);
  if (!report.ok) throw new PiiLeakError(report.findings, report.survivingTerms);
}

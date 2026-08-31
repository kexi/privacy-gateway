/**
 * Inbound guard for the Core Agent (defense in depth).
 *
 * The Gateway is expected to send only de-identified prompts, but Core is the
 * last hop before text crosses the trust boundary into Gemini, so any request
 * still carrying raw PII is rejected here rather than forwarded.
 *
 * Why not share the regexes with the Gateway via a common library? Because Core
 * must stay structurally independent of `agents/common`, which reaches into
 * Firestore and the token vault. Having no such dependency is itself part of the
 * guarantee that "Core cannot read the vault"; duplicating a handful of patterns
 * is the price paid for that, and it is deliberate.
 */

/** Shape of a masked placeholder token, e.g. ⟦PERSON_1⟧, ⟦EMAIL_2⟧. */
export const PLACEHOLDER_PATTERN = /⟦([A-Z][A-Z0-9_]*)_(\d+)⟧/gu;

/** Kind of sensitive data detected; mirrors the Gateway's token types. */
export type PiiKind = 'EMAIL' | 'PHONE' | 'CARD' | 'SECRET';

/** A single violation. Deliberately never carries the matched value itself. */
export interface GuardFinding {
  readonly kind: PiiKind;
  /** Only the length of the match is kept, so no raw value can reach a log. */
  readonly length: number;
}

export interface GuardResult {
  readonly ok: boolean;
  readonly findings: readonly GuardFinding[];
}

/**
 * Luhn checksum, used to cut down false positives on card-like digit runs.
 * Doubles every second digit from the right, subtracting 9 when the result
 * exceeds 9, and checks that the total is a multiple of 10.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const code = digits.charCodeAt(i) - 48;
    let value = code;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;

/** 10-15 digit phone numbers, allowing international prefixes and separators. */
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{2,4}(?:[\s-]\d{2,4}){1,4}/gu;

/** 13-19 digit card candidates, with or without separators; narrowed by Luhn. */
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/gu;

/**
 * Well-known credential formats:
 * - AWS access key id (AKIA/ASIA + 16 alphanumerics)
 * - GitHub token (ghp_/gho_/ghu_/ghs_/ghr_ + 36 or more chars)
 * - Google API key (AIza + exactly 35 chars)
 * - Slack token (xox[baprs]-...)
 * - OpenAI-style key (sk- + 20 or more chars)
 * - PEM private key header
 */
const SECRET_RES: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gu,
];

/** Digit-count bounds for something to count as a phone number. */
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

/**
 * A calendar date, optionally trailed by an hour group, is not a phone number.
 *
 * `2026-08-31 17` — a deadline written in prose — satisfies PHONE_RE (four
 * separator-joined digit groups, ten digits), and this guard rejecting it
 * blocked every request whose prompt carried the project's own AGENTS.md.
 * The gateway's detector does not read dates as phones, so the mismatch turned
 * ordinary dated text into a guaranteed refusal at this hop alone.
 */
const DATE_TIME_LIKE = /^\d{4}-\d{2}-\d{2}(?:[\s-]\d{2,4}(?::\d{2}){0,2})?$/u;

/** Blanks out placeholders so their contents cannot trip the detectors. */
function stripPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_PATTERN, ' ');
}

function collect(text: string, re: RegExp, kind: PiiKind, out: GuardFinding[]): void {
  // Reset lastIndex each scan so these module-scoped global regexes stay reusable.
  re.lastIndex = 0;
  for (const match of text.matchAll(re)) {
    out.push({ kind, length: match[0].length });
  }
}

/**
 * Checks incoming text for raw PII and secrets. Masked placeholders are removed
 * before scanning, so a well-formed de-identified prompt always passes.
 */
export function inspect(text: string): GuardResult {
  const body = stripPlaceholders(text);
  const findings: GuardFinding[] = [];

  collect(body, EMAIL_RE, 'EMAIL', findings);

  for (const re of SECRET_RES) {
    collect(body, re, 'SECRET', findings);
  }

  CARD_RE.lastIndex = 0;
  const cardSpans: Array<readonly [number, number]> = [];
  for (const match of body.matchAll(CARD_RE)) {
    const raw = match[0];
    const digits = raw.replace(/\D/gu, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      const start = match.index ?? 0;
      cardSpans.push([start, start + raw.length]);
      findings.push({ kind: 'CARD', length: raw.length });
    }
  }

  PHONE_RE.lastIndex = 0;
  for (const match of body.matchAll(PHONE_RE)) {
    const raw = match[0];
    const digits = raw.replace(/\D/gu, '');
    if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) continue;
    if (DATE_TIME_LIKE.test(raw.trim())) continue;
    // A span already reported as a card must not be double-counted as a phone.
    const start = match.index ?? 0;
    const end = start + raw.length;
    const overlapsCard = cardSpans.some(([cs, ce]) => start < ce && cs < end);
    if (overlapsCard) continue;
    findings.push({ kind: 'PHONE', length: raw.length });
  }

  return { ok: findings.length === 0, findings };
}

/** Returns the distinct placeholders in the text, in order of first appearance. */
export function extractPlaceholders(text: string): string[] {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const seen = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    seen.add(match[0]);
  }
  return [...seen];
}

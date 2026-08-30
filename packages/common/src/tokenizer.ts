/**
 * Deterministic PII / secret detection and tokenization.
 *
 * Detection is done entirely with regular expressions, never an LLM. Within a
 * single session the same value always maps to the same placeholder (`⟦EMAIL_1⟧`
 * form), and `rehydrate` restores the original text exactly.
 *
 * Detection flow:
 *   1. Run every pattern and collect `Detection` records (span + category)
 *   2. Drop false positives with category-specific validation such as Luhn
 *   3. Resolve overlapping spans: longer span wins, ties broken by priority
 *   4. Substitute from the end backwards so the offsets of the spans still ahead
 *      stay valid
 */

/**
 * Placeholder delimiters. U+27E6/U+27E7 are used instead of ASCII brackets
 * because they never occur naturally in ordinary prose or code snippets, and
 * Gemini is unlikely to split them apart.
 */
export const TOKEN_OPEN = '⟦';
export const TOKEN_CLOSE = '⟧';

/**
 * Matches one placeholder and captures its category and index. The category
 * class must admit digits: IPV4 broke the `[A-Z_]+` form because the greedy
 * run stopped at the digit and the mandatory `_` never matched, leaving
 * ⟦IPV4_1⟧ invisible to every consumer of this regex. Lazy so the final
 * `_<index>` pair stays the separator.
 */
const TOKEN_RE = new RegExp(`${TOKEN_OPEN}([A-Z][A-Z0-9_]*?)_(\\d+)${TOKEN_CLOSE}`, 'gu');

/** Anchored form used to validate a whole string as a placeholder. */
const TOKEN_FULL_RE = new RegExp(`^${TOKEN_OPEN}([A-Z][A-Z0-9_]*?)_(\\d+)${TOKEN_CLOSE}$`, 'u');

/**
 * Remove every well-formed placeholder, leaving the residual prose.
 *
 * Written for the advisory judge, which is asked "does this text contain
 * personal data" about an already-masked answer. A placeholder is by
 * construction not a leak — it is the evidence that masking happened — and the
 * deterministic attester has already validated the ones present. Showing them
 * to the model only invites it to answer the wrong question.
 *
 * Why strip rather than tell the model to ignore them: the instruction was
 * already in the judge prompt and the model did the opposite, returning
 * `leak: true` with an empty `categories` list for essentially every masked
 * answer (docs/proof/openai-compat.md). A prompt is a request; removing the
 * text is a guarantee. Anything that merely *looks* like a placeholder but is
 * malformed is deliberately left in place, so a near-miss such as
 * `⟦EMAIL⟧` still reaches the judge rather than being silently swallowed.
 *
 * The placeholder is replaced with a space, not the empty string, so two
 * values that were adjacent cannot be welded into one spurious token.
 */
export function stripPlaceholders(text: string): string {
  // A module-scoped global regex carries `lastIndex` between calls; `replace`
  // with a `g` pattern resets it itself, but the reset is made explicit because
  // this regex is shared with `detect`'s neighbours above.
  TOKEN_RE.lastIndex = 0;
  return text.replace(TOKEN_RE, ' ');
}

/**
 * Replace every placeholder with a readable neutral marker.
 *
 * Same guarantee as `stripPlaceholders` — no `⟦…⟧` survives, so the judge cannot
 * answer the wrong question by reasoning about the masking syntax — but the
 * sentence it leaves behind is grammatical. `Dear ⟦PERSON_1⟧, we wrote to
 * ⟦EMAIL_1⟧` becomes `Dear [masked person], we wrote to [masked email]` rather
 * than `Dear  , we wrote to  `.
 *
 * Why not keep stripping: the gap-riddled text was itself a source of false
 * positives. A model asked "does this contain personal data" over a sentence
 * with holes punched in it has to guess what the holes were, and it guessed
 * "something sensitive" — which is how the judge came to flag essentially every
 * masked answer while naming no category at all. Restoring the sentence's shape
 * removes the thing it was inferring from.
 *
 * The category is lower-cased into the marker because it is already public: the
 * placeholder disclosed it, the OKF document records it, and the API returns
 * `counts_by_category`. It carries no value — `[masked email]` says an email was
 * here, never which one.
 *
 * Deterministic by construction: the same input yields the same output, so a
 * verdict cannot depend on which call rendered the text.
 */
export function neutralizePlaceholders(text: string): string {
  TOKEN_RE.lastIndex = 0;
  return text.replace(TOKEN_RE, (_match, category: string) => {
    // `PHONE_NUMBER` reads better as `phone number` than as `phone_number`.
    const label = category.toLowerCase().replace(/_/gu, ' ');
    return `[masked ${label}]`;
  });
}

/** A single detected PII span. */
export interface Detection {
  readonly start: number;
  readonly end: number;
  readonly category: string;
  readonly value: string;
}

/** Result of a tokenization. `mapping` maps placeholder -> original value. */
export interface TokenizeResult {
  readonly text: string;
  readonly mapping: Record<string, string>;
  readonly detections: readonly Detection[];
}

/** Counts detections per category, as reported in the request stats. */
export function countsByCategory(detections: readonly Detection[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const detection of detections) {
    counts[detection.category] = (counts[detection.category] ?? 0) + 1;
  }
  return counts;
}

/** Verifies a Luhn checksum. `digits` must contain digits only. */
export function luhnValid(digits: string): boolean {
  const isDigitsOnly = /^\d+$/u.test(digits);
  if (!isDigitsOnly || digits.length < 12 || digits.length > 19) return false;

  let total = 0;
  // Double every second digit counting from the right (1-indexed), and subtract
  // 9 whenever the doubled value exceeds 9.
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

function digitsOf(value: string): string {
  return value.replace(/\D/gu, '');
}

interface PatternSpec {
  readonly category: string;
  readonly pattern: RegExp;
  /** Breaks ties between spans of equal length; lower wins. */
  readonly priority: number;
}

/**
 * Pattern definitions.
 *
 * Patterns with a stricter structure (JWT, AWS key) get a stronger priority so
 * looser patterns cannot swallow them.
 *
 * Why not a single combined regex? Each category needs its own post-validation
 * (Luhn, octet range, digit count), and a combined pattern would lose the
 * category attribution needed to pick the right validator.
 */
const PATTERNS: readonly PatternSpec[] = [
  // JWT: three base64url segments. The header always starts with `eyJ`.
  {
    category: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    priority: 0,
  },
  {
    category: 'AWS_KEY',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/gu,
    priority: 0,
  },
  // OpenAI-style tokens. Prefixed forms such as sk-proj- are captured as one match.
  { category: 'API_KEY', pattern: /\bsk-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}\b/gu, priority: 1 },
  { category: 'API_KEY', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/gu, priority: 1 },
  { category: 'API_KEY', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu, priority: 1 },
  {
    category: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu,
    priority: 2,
  },
  // Credit card: separators may be spaces or hyphens. Validated afterwards with Luhn.
  { category: 'CREDIT_CARD', pattern: /\b(?:\d[ -]?){12,18}\d\b/gu, priority: 3 },
  // Japanese phone numbers: leading 0, optional separators after the area code.
  // The +81 country code is also accepted.
  {
    category: 'PHONE',
    pattern: /(?<![\d-])(?:\+81[ -]?|0)\d{1,4}[ -]?\d{1,4}[ -]?\d{3,4}(?![\d-])/gu,
    priority: 4,
  },
  // International E.164 form (anything other than +81).
  {
    category: 'PHONE',
    pattern: /(?<![\d-])\+(?!81)\d{1,3}[ -]?\d{2,4}[ -]?\d{3,4}[ -]?\d{3,4}(?![\d-])/gu,
    priority: 4,
  },
  // My Number: 12 digits with no separators, not adjacent to a digit or a hyphen.
  { category: 'MY_NUMBER', pattern: /(?<![\d-])\d{12}(?![\d-])/gu, priority: 5 },
  { category: 'IPV4', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, priority: 6 },
];

/** Per-category post-validation. Detections that fail it are discarded. */
const VALIDATORS: Record<string, (value: string) => boolean> = {
  CREDIT_CARD: (value) => luhnValid(digitsOf(value)),
  IPV4: validIpv4,
  // My Number carries a check digit, but only the digit count is checked so that
  // made-up demo values are still caught.
  MY_NUMBER: (value) => digitsOf(value).length === 12,
};

/**
 * The category allocated for a requester-supplied verbatim-mask term.
 *
 * Distinct from every detected category because nothing detected it: the
 * requester asserted that this exact string is confidential, and no regex or
 * model has an opinion about it.
 */
export const CUSTOM_CATEGORY = 'CUSTOM';

/**
 * Locate every occurrence of the requester's terms, longest term first.
 *
 * **Case-sensitive, deliberately.** Why not case-insensitive: a codename's case
 * is part of its identity — `Titan` the unreleased product and `titan` the word
 * in "titanium alloy" are different strings meaning different things — so
 * folding case would mask ordinary prose the requester never asked to hide,
 * mangling the prompt Core is asked to reason about. It would also mask more
 * than the requester can predict, which is the opposite of what an explicit
 * opt-in should do. A requester who wants both spellings masked names both,
 * which the schema's case-preserving deduplication supports exactly.
 *
 * **Longest term first**, so overlapping terms nest correctly: with `Titan` and
 * `Titan Project` both named, the longer one claims its span before the shorter
 * can split it, and `Titan Project` becomes one placeholder rather than
 * `⟦CUSTOM_n⟧ Project`. Ties are broken by the order the requester gave, which
 * keeps the allocation deterministic.
 *
 * Overlapping matches of *different* terms are resolved the same way the regex
 * detections are: the span accepted first wins, and a later span intersecting it
 * is dropped rather than producing two placeholders over the same characters.
 */
export function findTermSpans(text: string, terms: readonly string[]): Detection[] {
  const accepted: Detection[] = [];

  const ordered = [...terms]
    .map((term, order) => ({ term, order }))
    .filter(({ term }) => term !== '')
    .sort((a, b) => b.term.length - a.term.length || a.order - b.order);

  for (const { term } of ordered) {
    // `indexOf` rather than a built regex: a term is arbitrary user text, and
    // escaping it into a pattern is a step that can only go wrong. Literal
    // search has no metacharacters to get wrong in the first place.
    for (
      let from = text.indexOf(term);
      from !== -1;
      from = text.indexOf(term, from + term.length)
    ) {
      const end = from + term.length;
      const overlaps = accepted.some((kept) => from < kept.end && kept.start < end);
      if (overlaps) continue;
      accepted.push({ start: from, end, category: CUSTOM_CATEGORY, value: term });
    }
  }

  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

/**
 * True when any of `terms` still appears literally in `text`.
 *
 * The boundary check behind both the egress guard's term scan and the
 * attester's: exact, case-sensitive, and the same comparison `findTermSpans`
 * substitutes with, so a term that was masked cannot be reported as surviving
 * and a term that survived cannot be reported as masked.
 *
 * Returns the *count* of surviving terms rather than the terms themselves —
 * every caller either refuses or logs, and neither may hold a term.
 */
export function countSurvivingTerms(text: string, terms: readonly string[]): number {
  let surviving = 0;
  for (const term of terms) {
    if (term !== '' && text.includes(term)) surviving += 1;
  }
  return surviving;
}

/** Detect PII / secret spans in `text`. Overlaps are already resolved. */
export function detect(text: string): Detection[] {
  const candidates: Array<{ priority: number; detection: Detection }> = [];

  for (const { category, pattern, priority } of PATTERNS) {
    // Module-scoped global regexes are reused across calls, so lastIndex is reset.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      const validator = VALIDATORS[category];
      if (validator !== undefined && !validator(value)) continue;
      const start = match.index;
      candidates.push({
        priority,
        detection: { start, end: start + value.length, category, value },
      });
    }
  }

  // Prefer longer spans; on equal length prefer the stronger priority; on a
  // further tie fall back to order of appearance so the sort stays stable.
  candidates.sort((a, b) => {
    const lengthDelta = b.detection.end - b.detection.start - (a.detection.end - a.detection.start);
    if (lengthDelta !== 0) return lengthDelta;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.detection.start - b.detection.start;
  });

  const accepted: Detection[] = [];
  for (const { detection } of candidates) {
    const overlaps = accepted.some(
      (kept) => detection.start < kept.end && kept.start < detection.end,
    );
    if (overlaps) continue;
    accepted.push(detection);
  }

  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

/**
 * Tokenizer holding the token assignments for one session.
 *
 * The same original value always gets the same placeholder (stability).
 * Restoring it from an existing mapping lets the numbering continue across
 * multiple requests.
 */
export class SessionTokenizer {
  private readonly entries: Map<string, string>;
  /** Reverse index of `category value` -> placeholder; guarantees stability. */
  private readonly reverse: Map<string, string>;
  private readonly counters: Map<string, number>;

  constructor(mapping?: Readonly<Record<string, string>> | undefined) {
    this.entries = new Map(Object.entries(mapping ?? {}));
    this.reverse = new Map();
    this.counters = new Map();

    for (const [placeholder, value] of this.entries) {
      const match = TOKEN_FULL_RE.exec(placeholder);
      if (match === null) continue;
      const category = match[1];
      const index = Number.parseInt(match[2] ?? '0', 10);
      if (category === undefined) continue;
      this.reverse.set(reverseKey(category, value), placeholder);
      this.counters.set(category, Math.max(this.counters.get(category) ?? 0, index));
    }
  }

  /** placeholder -> original value, in the shape stored in the Token Vault. */
  get mapping(): Record<string, string> {
    return Object.fromEntries(this.entries);
  }

  /** Return the placeholder for `value`, allocating a new number if it is unseen. */
  placeholderFor(category: string, value: string): string {
    const key = reverseKey(category, value);
    const existing = this.reverse.get(key);
    if (existing !== undefined) return existing;

    const index = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, index);
    const placeholder = `${TOKEN_OPEN}${category}_${index}${TOKEN_CLOSE}`;
    this.reverse.set(key, placeholder);
    this.entries.set(placeholder, value);
    return placeholder;
  }

  /**
   * Tokenize `text`.
   *
   * `extra` carries the unstructured spans extracted by Gemma (personal names,
   * addresses and so on). Where such a span overlaps a regex detection the regex
   * wins, because the deterministic result is the one that can be audited.
   *
   * `terms` carries the requester's verbatim-mask phrases. They are substituted
   * **first**, ahead of every detector: the requester asserted these exact
   * strings are confidential, and an assertion outranks a heuristic. A regex
   * detection overlapping a term is therefore dropped rather than the other way
   * round — a codename that happens to contain something email-shaped is still
   * the codename the requester named, and splitting it would leave part of it in
   * the clear.
   */
  tokenize(
    text: string,
    extra?: readonly Detection[] | undefined,
    terms?: readonly string[] | undefined,
  ): TokenizeResult {
    const termSpans = terms === undefined || terms.length === 0 ? [] : findTermSpans(text, terms);

    // The term spans are seeded before `detect` runs so the overlap filter below
    // resolves in their favour; `detect`'s own internal overlap resolution is
    // unchanged, and only its surviving spans are tested against the terms.
    const detections = [...termSpans];
    for (const detection of detect(text)) {
      const overlaps = termSpans.some(
        (term) => detection.start < term.end && term.start < detection.end,
      );
      if (overlaps) continue;
      detections.push(detection);
    }
    detections.sort((a, b) => a.start - b.start);

    if (extra !== undefined && extra.length > 0) {
      // Longest first, so a longer model span is not blocked by a shorter one
      // accepted before it.
      const ordered = [...extra].sort((a, b) => b.end - b.start - (a.end - a.start));
      for (const detection of ordered) {
        const withinBounds =
          detection.start >= 0 && detection.start < detection.end && detection.end <= text.length;
        if (!withinBounds) continue;
        const overlaps = detections.some(
          (kept) => detection.start < kept.end && kept.start < detection.end,
        );
        if (overlaps) continue;
        detections.push(detection);
      }
      detections.sort((a, b) => a.start - b.start);
    }

    // Substituting from the end keeps the offsets of the spans still ahead intact.
    const pieces: string[] = [];
    let cursor = text.length;
    for (let i = detections.length - 1; i >= 0; i -= 1) {
      const detection = detections[i];
      if (detection === undefined) continue;
      const placeholder = this.placeholderFor(detection.category, detection.value);
      pieces.push(text.slice(detection.end, cursor));
      pieces.push(placeholder);
      cursor = detection.start;
    }
    pieces.push(text.slice(0, cursor));

    return {
      text: pieces.reverse().join(''),
      mapping: this.mapping,
      detections,
    };
  }
}

/** Separator that cannot appear in a category name, keeping the key unambiguous. */
function reverseKey(category: string, value: string): string {
  return `${category} ${value}`;
}

/** Convenience API that tokenizes `text` with a throwaway tokenizer. */
export function tokenize(
  text: string,
  mapping?: Readonly<Record<string, string>> | undefined,
): TokenizeResult {
  return new SessionTokenizer(mapping).tokenize(text);
}

/**
 * Categories never restored into a released answer by default.
 *
 * A secret has no legitimate reason to be echoed back through a frontier model
 * round trip: the caller already holds it, and printing it again only widens the
 * blast radius of a logged or screenshotted response. The placeholder is left in
 * place and the category is reported so the user knows why.
 *
 * **`CUSTOM` is deliberately absent.** Why not withhold a requester-named term:
 * the requester typed the term into this very request, so withholding protects
 * nothing they do not already hold — it is the one category where the
 * "widens the blast radius" argument does not apply, because the reader of the
 * answer is the person who supplied the string. Withholding it would instead
 * break the answer: a reply about `⟦CUSTOM_1⟧` is unreadable to the person who
 * asked about their own codename, and the feature's whole purpose is to let a
 * frontier model reason about a confidential term and hand back something
 * useful. The protection is that the term never crossed the boundary, not that
 * it never comes back.
 */
export const DEFAULT_WITHHELD_CATEGORIES: readonly string[] = [
  'API_KEY',
  'AWS_KEY',
  'JWT',
  'CREDIT_CARD',
  'MY_NUMBER',
];

/**
 * True when `category` is one this fleet withholds unless someone allows it.
 *
 * The same list `DEFAULT_WITHHELD_CATEGORIES` names, exposed as a predicate so
 * the request schema can reject an opt-in naming anything else: a caller who
 * asks to "restore" `EMAIL` is describing a category that was never withheld,
 * and honouring the request silently would teach them the opt-in did something.
 */
export function isHighRiskCategory(category: string): boolean {
  return DEFAULT_WITHHELD_CATEGORIES.includes(category);
}

/**
 * Which categories stay masked, given the operator policy and this request's
 * own opt-in.
 *
 * The two allowances are a **union**, not an override in either direction. The
 * operator's `REHYDRATE_ALLOW_CATEGORIES` is a deployment-wide statement that a
 * category may be released at all; `requestAllow` is one caller saying they want
 * back the values *they themselves submitted in this request*. Neither can widen
 * beyond the default-withheld set, because `DEFAULT_WITHHELD_CATEGORIES` is what
 * is being filtered — an allowance naming a category nobody withholds subtracts
 * nothing.
 *
 * Why a request may allow anything at all: there is exactly one request's worth
 * of data behind the vault key, and the caller supplied every byte of it. The
 * blast radius the default policy protects against is *this* answer being logged
 * or screenshotted, which is a risk only the sender is in a position to accept.
 * Why not a header or a cookie: an opt-in that outlives the request would apply
 * to data the person granting it has not seen yet.
 */
export function withheldCategories(
  allowList: string | undefined = process.env['REHYDRATE_ALLOW_CATEGORIES'],
  requestAllow: readonly string[] = [],
): string[] {
  const allowed = new Set(
    (allowList ?? '')
      .split(',')
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry !== ''),
  );
  for (const category of requestAllow) allowed.add(category.trim().toUpperCase());
  return DEFAULT_WITHHELD_CATEGORIES.filter((category) => !allowed.has(category));
}

/**
 * The body a refused document carries in place of the answer.
 *
 * A refusal must leave an auditable record, but the text that failed the policy
 * is the last thing that record may contain: it is the exact string the gate
 * refused to release, and the evidence routes are unauthenticated. The digests
 * in the `attestation` block still bind the document to what was checked, so an
 * auditor holding the original can prove which text this was about without the
 * store ever holding it.
 */
export const WITHHELD_BODY_MARKER = 'content withheld';

/** Return the category encoded in a placeholder, or null when it is not one. */
export function categoryOf(placeholder: string): string | null {
  const match = TOKEN_FULL_RE.exec(placeholder);
  return match?.[1] ?? null;
}

/** What a rehydration actually did, so the caller can report it. */
export interface RehydrationResult {
  readonly text: string;
  /** Placeholders deliberately left in place, sorted. */
  readonly withheld: readonly string[];
  /** Categories of those placeholders, sorted and deduplicated. */
  readonly withheldCategories: readonly string[];
  /** Placeholders present in the text but absent from the mapping, sorted. */
  readonly unresolved: readonly string[];
}

export interface RehydrateOptions {
  /** Categories to leave masked; defaults to `withheldCategories()`. */
  readonly withhold?: readonly string[] | undefined;
}

/**
 * Restore placeholders to their original values.
 *
 * Tokens absent from `mapping` are left untouched and reported as unresolved —
 * the caller is expected to refuse the release rather than show a stray symbol.
 * Tokens in a withheld category are left masked on purpose.
 */
export function rehydrateWithPolicy(
  text: string,
  mapping: Readonly<Record<string, string>>,
  options: RehydrateOptions = {},
): RehydrationResult {
  const withhold = new Set(options.withhold ?? withheldCategories());
  const present = findTokens(text);

  const withheld: string[] = [];
  const unresolved: string[] = [];
  const restorable: string[] = [];

  for (const placeholder of present) {
    const category = categoryOf(placeholder);
    if (category !== null && withhold.has(category)) {
      withheld.push(placeholder);
      continue;
    }
    if (mapping[placeholder] === undefined) {
      unresolved.push(placeholder);
      continue;
    }
    restorable.push(placeholder);
  }

  let result = text;
  // Substitute the longest placeholders first so that `⟦X_1⟧` cannot corrupt
  // `⟦X_10⟧`.
  for (const placeholder of [...restorable].sort((a, b) => b.length - a.length)) {
    const value = mapping[placeholder];
    if (value === undefined) continue;
    result = result.split(placeholder).join(value);
  }

  return {
    text: result,
    withheld: withheld.sort(),
    withheldCategories: [
      ...new Set(withheld.map((token) => categoryOf(token) ?? 'UNKNOWN')),
    ].sort(),
    unresolved: unresolved.sort(),
  };
}

/**
 * Restore placeholders to their original values, with no disclosure policy.
 *
 * Kept for callers that genuinely want the raw substitution (tests, the
 * round-trip property). Production release goes through `rehydrateWithPolicy`.
 */
export function rehydrate(text: string, mapping: Readonly<Record<string, string>>): string {
  let result = text;
  const placeholders = Object.keys(mapping).sort((a, b) => b.length - a.length);
  for (const placeholder of placeholders) {
    const value = mapping[placeholder];
    if (value === undefined) continue;
    result = result.split(placeholder).join(value);
  }
  return result;
}

/**
 * True when `text` contains either delimiter of the reserved placeholder syntax.
 *
 * Both delimiters are checked rather than only well-formed `⟦TYPE_N⟧` pairs: a
 * caller who writes `⟦EMAIL_1` is still probing the placeholder namespace, and
 * the characters have no legitimate use in a request to this gateway.
 */
export function containsReservedSyntax(text: string): boolean {
  return text.includes(TOKEN_OPEN) || text.includes(TOKEN_CLOSE);
}

/** Return the placeholders in `text` in order of appearance, deduplicated. */
export function findTokens(text: string): string[] {
  TOKEN_RE.lastIndex = 0;
  const seen: string[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    if (!seen.includes(match[0])) seen.push(match[0]);
  }
  return seen;
}

/**
 * Strip raw PII for logging. Values are collapsed into placeholder form only; no
 * information for restoring them is kept.
 */
export function maskForLogging(text: string): string {
  return new SessionTokenizer().tokenize(text).text;
}

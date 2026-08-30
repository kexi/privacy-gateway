/**
 * Recovering *what* was masked, entirely in the browser.
 *
 * The gateway returns the masked prompt but never the mapping — the vault is the
 * only thing that holds it, and it never leaves the trust boundary. The page,
 * however, already has both halves: the text the user typed, and the text the
 * frontier model saw. Aligning one against the other recovers which substrings
 * were substituted, without a single extra byte crossing the network.
 *
 * The alignment is deterministic because masking only ever *substitutes spans*:
 * everything outside a detected span is copied through verbatim, so the literal
 * text between two placeholders in the masked prompt must appear, in order, in
 * the original. Locating those literals leaves the gaps, and the gaps are
 * exactly the masked values.
 *
 * Nothing here guesses. When the literals cannot be located in order the input
 * is not what this function was built for, and it returns "no spans" rather than
 * a plausible-looking alignment — a wrong highlight would claim a value was sent
 * out when it was not.
 */

/**
 * One placeholder occurrence in the masked prompt.
 *
 * `start`/`end` are offsets into the masked prompt, so the masked-prompt pane
 * can be chipped without re-parsing.
 */
export interface PlaceholderSpan {
  /** The full placeholder text, e.g. `⟦EMAIL_1⟧`. */
  readonly token: string;
  /** The category encoded in the placeholder, e.g. `EMAIL`. */
  readonly category: string;
  /** The 1-based index encoded in the placeholder. */
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

/** One recovered masked value, and where it sits in the original text. */
export interface MaskedSpan {
  readonly token: string;
  readonly category: string;
  readonly index: number;
  /** Offsets into the *original* text. */
  readonly start: number;
  readonly end: number;
  /** The literal text that was replaced by `token`. */
  readonly value: string;
  /**
   * True when two placeholders were adjacent in the masked prompt, so the gap
   * covering both could not be split. The span is attributed to the first of
   * them and the second gets no span at all: inventing a boundary inside the gap
   * would colour half of one value as the other's category.
   */
  readonly ambiguous: boolean;
}

export interface Alignment {
  /** Every placeholder occurrence found in the masked prompt, in order. */
  readonly placeholders: readonly PlaceholderSpan[];
  /**
   * The recovered spans in the original text, in order. Empty when the masked
   * prompt could not be aligned against the original.
   */
  readonly spans: readonly MaskedSpan[];
  /** True when every placeholder was located; false means no spans are shown. */
  readonly aligned: boolean;
}

/**
 * The placeholder syntax as it appears on the wire.
 *
 * Why not imported: the tokenizer is a server module (it reads `process.env`)
 * and is not part of the package's browser-facing `exports` map. The syntax is
 * a wire format both sides agree on, and the E2E specs assert it end to end.
 *
 * Why the category class admits digits: `IPV4` is a real category name, so a
 * `[A-Z_]+` category — which is what the server-side regex uses — silently fails
 * to recognise `⟦IPV4_1⟧` and swallows it into the surrounding literal, which
 * then never matches. The lazy quantifier keeps `⟦CREDIT_CARD_1⟧` splitting at
 * the last underscore rather than the first.
 */
const PLACEHOLDER_RE = /⟦([A-Z0-9_]+?)_(\d+)⟧/gu;

/** Every placeholder occurrence in `masked`, in the order they appear. */
export function findPlaceholders(masked: string): PlaceholderSpan[] {
  const found: PlaceholderSpan[] = [];
  PLACEHOLDER_RE.lastIndex = 0;

  for (
    let match = PLACEHOLDER_RE.exec(masked);
    match !== null;
    match = PLACEHOLDER_RE.exec(masked)
  ) {
    const category = match[1];
    const index = match[2];
    if (category === undefined || index === undefined) continue;
    found.push({
      token: match[0],
      category,
      index: Number(index),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

/**
 * Recover which substrings of `original` were replaced by placeholders.
 *
 * The walk is a single left-to-right pass: each literal segment of the masked
 * prompt is located at or after the cursor, which keeps the mapping in document
 * order and makes a repeated value (the same address twice) resolve to its two
 * distinct occurrences rather than twice to the first.
 */
export function alignMasked(original: string, masked: string): Alignment {
  const placeholders = findPlaceholders(masked);
  if (placeholders.length === 0) {
    return { placeholders, spans: [], aligned: true };
  }

  const spans: MaskedSpan[] = [];
  let cursor = 0;
  // Where the current gap began. It only moves when a literal is matched, so a
  // run of adjacent placeholders accumulates into one gap.
  let gapStart = -1;
  let gapToken: PlaceholderSpan | undefined;

  // The literal that precedes the first placeholder must match at offset 0:
  // masking never rewrites the text around a span, so a prefix that does not
  // line up means this masked prompt did not come from this original.
  const prefix = masked.slice(0, placeholders[0]?.start ?? 0);
  if (!original.startsWith(prefix)) return failed(placeholders);
  cursor = prefix.length;

  for (let i = 0; i < placeholders.length; i += 1) {
    const placeholder = placeholders[i];
    if (placeholder === undefined) continue;

    if (gapToken === undefined) {
      gapStart = cursor;
      gapToken = placeholder;
    }

    const next = placeholders[i + 1];
    const literal = masked.slice(placeholder.end, next?.start ?? masked.length);

    if (literal === '') {
      // Adjacent placeholders. The boundary between the two masked values is not
      // observable from either string, so the gap stays open and is attributed
      // to the first of the run.
      continue;
    }

    const found = original.indexOf(literal, gapStart);
    if (found === -1) return failed(placeholders);

    const isAmbiguous = gapToken !== placeholder;
    const value = original.slice(gapStart, found);
    // A zero-length gap would mean the placeholder replaced nothing, which
    // masking cannot produce; treating it as a span would draw an invisible
    // highlight the legend still counts.
    if (value !== '') {
      spans.push({
        token: gapToken.token,
        category: gapToken.category,
        index: gapToken.index,
        start: gapStart,
        end: found,
        value,
        ambiguous: isAmbiguous,
      });
    }

    cursor = found + literal.length;
    gapToken = undefined;
    gapStart = -1;
  }

  // A trailing placeholder leaves the gap open to the end of the original.
  if (gapToken !== undefined && gapStart < original.length) {
    spans.push({
      token: gapToken.token,
      category: gapToken.category,
      index: gapToken.index,
      start: gapStart,
      end: original.length,
      value: original.slice(gapStart),
      ambiguous: placeholders[placeholders.length - 1] !== gapToken,
    });
  }

  return { placeholders, spans, aligned: true };
}

/** An alignment that could not be trusted: placeholders are known, spans are not. */
function failed(placeholders: readonly PlaceholderSpan[]): Alignment {
  return { placeholders, spans: [], aligned: false };
}

/** One literal occurrence of a recovered value inside another string. */
export interface ValueMatch {
  readonly token: string;
  readonly category: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Find where the recovered values reappear in the rehydrated answer.
 *
 * This is what closes the loop visually: the same string that went out as
 * `⟦EMAIL_1⟧` is shown, in the same colour, where it came back. Matching is
 * literal and case-sensitive — a fuzzy match would colour text the gateway never
 * restored.
 *
 * Overlaps are dropped rather than merged: `::highlight()` would paint them on
 * top of each other, and a longer value winning is the useful rule (a full name
 * beats the given name inside it).
 */
export function findValueMatches(text: string, spans: readonly MaskedSpan[]): ValueMatch[] {
  const matches: ValueMatch[] = [];

  // Longest first so a value contained inside another claims the shorter one's
  // range before the shorter value can fragment it.
  const byLength = [...spans].sort((a, b) => b.value.length - a.value.length);

  for (const span of byLength) {
    if (span.value === '' || span.ambiguous) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(span.value, from);
      if (at === -1) break;
      const end = at + span.value.length;
      const overlaps = matches.some((match) => at < match.end && match.start < end);
      if (!overlaps) {
        matches.push({
          token: span.token,
          category: span.category,
          index: span.index,
          start: at,
          end,
        });
      }
      from = at + span.value.length;
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Deduplicate the recovered spans by token.
 *
 * The same placeholder can be substituted many times (one customer named three
 * times is one `⟦PERSON_1⟧`), and the legend and the answer highlighting care
 * about the distinct values, not the occurrences.
 */
export function distinctValues(spans: readonly MaskedSpan[]): MaskedSpan[] {
  const seen = new Set<string>();
  const distinct: MaskedSpan[] = [];
  for (const span of spans) {
    if (seen.has(span.token)) continue;
    seen.add(span.token);
    distinct.push(span);
  }
  return distinct;
}

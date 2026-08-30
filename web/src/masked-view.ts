/**
 * The "what was masked" view: legend, original request, masked prompt, answer.
 *
 * These four render together because they are one claim told four ways — a value
 * was detected here, replaced by this placeholder, and restored there — and a
 * reader can only check that claim if the same colour and the same category name
 * appear at all three points.
 *
 * Everything here is client-side. The original text is already in the textarea,
 * and the masked prompt came back in the response; the mapping between them is
 * recomputed locally (see `mask-align.ts`) rather than requested, so no unmasked
 * value is sent anywhere it was not already going.
 */

import { hueOf, labelOf, slugOf } from './categories.ts';
import { HighlightPainter, highlightsSupported, type HighlightRegion } from './highlight.ts';
import {
  alignMasked,
  distinctValues,
  findPlaceholders,
  findValueMatches,
  type MaskedSpan,
  type PlaceholderSpan,
} from './mask-align.ts';

/** The elements this view writes into. */
export interface MaskedViewElements {
  readonly legendSection: HTMLElement;
  readonly legend: HTMLUListElement;
  readonly legendNote: HTMLParagraphElement;
  readonly original: HTMLPreElement;
  readonly masked: HTMLPreElement;
  readonly answer: HTMLPreElement;
}

/** Everything the view needs from one response. */
export interface MaskedViewInput {
  readonly originalText: string;
  readonly maskedPrompt: string;
  readonly answer: string;
  readonly countsByCategory: Readonly<Record<string, number>>;
  readonly withheld: readonly string[];
}

/** Escaping applied to every string before it reaches innerHTML. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/**
 * Renders the four panels and keeps them linked.
 *
 * Held as an object because the linking is stateful: hovering a chip has to
 * reach spans in panels the chip does not own.
 */
export class MaskedView {
  readonly #elements: MaskedViewElements;
  readonly #painter = new HighlightPainter();
  #pinned: string | undefined;

  constructor(elements: MaskedViewElements) {
    this.#elements = elements;
    this.#bindLinking();
  }

  /** Draw one response. Safe to call repeatedly; the previous render is dropped. */
  render(input: MaskedViewInput): void {
    this.#painter.clear();
    this.#pinned = undefined;

    const alignment = alignMasked(input.originalText, input.maskedPrompt);
    const values = distinctValues(alignment.spans);
    const withheld = new Set(input.withheld);

    this.#renderLegend(input.countsByCategory, values, withheld, alignment.aligned);
    this.#renderOriginal(input.originalText, alignment.spans);
    this.#renderMasked(input.maskedPrompt, alignment.placeholders, withheld);
    this.#renderAnswer(input.answer, values, withheld);
  }

  /** Clear the panels and the highlight registry (a refused request shows none). */
  reset(): void {
    this.#painter.clear();
    this.#pinned = undefined;
    this.#elements.legendSection.hidden = true;
  }

  // --- legend ---------------------------------------------------------------

  /**
   * The legend: one row per category, with its count and the placeholders it
   * allocated.
   *
   * A list rather than a row of swatches, because the swatch is the part a
   * reader may not be able to use: the row carries the category name, the count
   * and the placeholder names as text, and the colour only repeats what is
   * already written.
   */
  #renderLegend(
    counts: Readonly<Record<string, number>>,
    values: readonly MaskedSpan[],
    withheld: ReadonlySet<string>,
    aligned: boolean,
  ): void {
    const entries = Object.entries(counts).filter(([, count]) => count > 0);
    const { legend, legendNote, legendSection } = this.#elements;

    if (entries.length === 0) {
      legend.innerHTML = '<li class="legend-empty">Nothing was detected in this request.</li>';
      legendNote.textContent = '';
      legendSection.hidden = false;
      return;
    }

    const tokensByCategory = new Map<string, MaskedSpan[]>();
    for (const span of values) {
      const bucket = tokensByCategory.get(span.category);
      if (bucket === undefined) tokensByCategory.set(span.category, [span]);
      else bucket.push(span);
    }

    legend.innerHTML = entries
      .map(([category, count]) => {
        const tokens = tokensByCategory.get(category) ?? [];
        const chips = tokens
          .map((span) => this.#chipHtml(span.category, span.index, span.token, false))
          .join('');
        const held = withheld.has(category)
          ? '<span class="legend-withheld" title="withheld by policy">withheld</span>'
          : '';
        return `<li class="legend-row" style="--cat-hue: ${hueOf(category)}" data-category="${escapeHtml(category)}">
          <span class="legend-swatch" aria-hidden="true"></span>
          <span class="legend-name">${escapeHtml(labelOf(category))}</span>
          <span class="legend-count">${count} masked</span>
          <span class="legend-tokens">${chips}</span>
          ${held}
        </li>`;
      })
      .join('');

    // Two different reasons the panels may show no highlights, and they mean
    // different things: an unsupported browser is a rendering limitation, while
    // a failed alignment means this page could not prove which spans were
    // replaced and is deliberately not guessing.
    const notes: string[] = [];
    if (!highlightsSupported()) {
      notes.push('This browser cannot paint text highlights, so the panels are shown unmarked.');
    } else if (!aligned) {
      notes.push(
        'The masked prompt could not be aligned with your request, so nothing is highlighted.',
      );
    }
    notes.push(
      'Placeholders disclose category and equality: this is pseudonymization, not anonymization.',
    );
    legendNote.textContent = notes.join(' ');
    legendSection.hidden = false;
  }

  // --- panels ---------------------------------------------------------------

  /** The user's text, with the substituted spans highlighted in place. */
  #renderOriginal(original: string, spans: readonly MaskedSpan[]): void {
    const { original: pane } = this.#elements;
    pane.textContent = original;

    const regions: HighlightRegion[] = spans.map((span) => ({
      start: span.start,
      end: span.end,
      category: span.category,
      token: span.token,
    }));
    this.#painter.paint(pane, regions);
  }

  /**
   * The masked prompt, with each placeholder as a chip and the rest plain.
   *
   * Chips are real elements rather than highlights: they carry the category text
   * and the index, they are focusable so the linking works from the keyboard, and
   * `::highlight()` could not draw their border anyway.
   */
  #renderMasked(
    masked: string,
    placeholders: readonly PlaceholderSpan[],
    withheld: ReadonlySet<string>,
  ): void {
    const parts: string[] = [];
    let cursor = 0;

    for (const placeholder of placeholders) {
      parts.push(escapeHtml(masked.slice(cursor, placeholder.start)));
      parts.push(
        this.#chipHtml(
          placeholder.category,
          placeholder.index,
          placeholder.token,
          withheld.has(placeholder.category),
        ),
      );
      cursor = placeholder.end;
    }
    parts.push(escapeHtml(masked.slice(cursor)));

    this.#elements.masked.innerHTML = parts.join('');
  }

  /**
   * The answer, with the restored values highlighted and the withheld ones
   * still shown as chips.
   *
   * A withheld category never comes back as a value, so its placeholder is still
   * in the answer text: rendering it as a chip with a reason is the only way the
   * reader learns that the gap is policy rather than a failure.
   */
  #renderAnswer(
    answer: string,
    values: readonly MaskedSpan[],
    withheld: ReadonlySet<string>,
  ): void {
    const { answer: pane } = this.#elements;

    // Placeholders surviving in the answer are chipped first, then the value
    // highlights are measured against the raw answer string.
    //
    // That only works because a chip's text is the placeholder *verbatim*: the
    // pane's text nodes therefore concatenate back to exactly `answer`, so an
    // offset into the string is an offset into the pane. Shortening the chip's
    // label would silently shift every highlight after it.
    const placeholders = findPlaceholders(answer);
    const parts: string[] = [];
    let cursor = 0;
    for (const placeholder of placeholders) {
      parts.push(escapeHtml(answer.slice(cursor, placeholder.start)));
      parts.push(
        this.#chipHtml(
          placeholder.category,
          placeholder.index,
          placeholder.token,
          withheld.has(placeholder.category),
        ),
      );
      cursor = placeholder.end;
    }
    parts.push(escapeHtml(answer.slice(cursor)));
    pane.innerHTML = parts.join('');

    const matches = findValueMatches(answer, values);
    this.#painter.paint(
      pane,
      matches.map((match) => ({
        start: match.start,
        end: match.end,
        category: match.category,
        token: match.token,
      })),
    );
  }

  // --- linking --------------------------------------------------------------

  /**
   * One chip, used in the legend and in both text panels.
   *
   * The chip's text is the placeholder verbatim — `⟦EMAIL_1⟧` — not a prettier
   * rendering of it. Why not a shortened label: this pane's whole claim is that
   * *this exact string* is what the frontier model received, so paraphrasing it
   * would make the panel stop being evidence. The category name is already
   * inside it, which is also what keeps the colour from being the only carrier.
   *
   * `data-token` is what ties the three panels together: every element carrying
   * the same token is emphasised as a group.
   */
  #chipHtml(category: string, index: number, token: string, isWithheld: boolean): string {
    const title = isWithheld
      ? 'withheld by policy'
      : `${labelOf(category)} placeholder ${index}: click to trace it through the panels`;
    return `<button type="button" class="pii-chip cat-${escapeHtml(slugOf(category))}${isWithheld ? ' withheld' : ''}"
      style="--cat-hue: ${hueOf(category)}"
      data-token="${escapeHtml(token)}"
      data-category="${escapeHtml(category)}"
      title="${escapeHtml(title)}">${escapeHtml(token)}</button>`;
  }

  /**
   * Hover and click anywhere in the results emphasise one placeholder everywhere.
   *
   * Delegated from a common ancestor and bound once, because all three panels are
   * rewritten on every response and per-element listeners would have to be
   * rebound each time.
   */
  #bindLinking(): void {
    const root = this.#elements.legendSection.parentElement ?? document.body;

    root.addEventListener('pointerover', (event) => {
      const token = tokenOf(event.target);
      if (token === undefined) return;
      this.#painter.emphasise(token);
      this.#reflectEmphasis(root, token);
    });

    root.addEventListener('pointerout', () => {
      // A click pins the emphasis; leaving a chip must not undo it.
      this.#painter.emphasise(this.#pinned);
      this.#reflectEmphasis(root, this.#pinned);
    });

    root.addEventListener('click', (event) => {
      const token = tokenOf(event.target);
      if (token === undefined) return;
      this.#pinned = this.#pinned === token ? undefined : token;
      this.#painter.emphasise(this.#pinned);
      this.#reflectEmphasis(root, this.#pinned);
    });

    // Keyboard users reach a chip by tab, so focus does what hover does.
    root.addEventListener(
      'focusin',
      (event) => {
        const token = tokenOf(event.target);
        if (token === undefined) return;
        this.#painter.emphasise(token);
        this.#reflectEmphasis(root, token);
      },
      true,
    );
  }

  /** Mark every chip carrying the emphasised token, so chips move with the text. */
  #reflectEmphasis(root: Element, token: string | undefined): void {
    for (const chip of root.querySelectorAll<HTMLElement>('.pii-chip')) {
      const isLinked = token !== undefined && chip.dataset['token'] === token;
      chip.classList.toggle('linked', isLinked);
      chip.setAttribute('aria-pressed', isLinked ? 'true' : 'false');
    }
  }
}

/** The token carried by the nearest chip ancestor of an event target, if any. */
function tokenOf(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const chip = target.closest<HTMLElement>('.pii-chip');
  return chip?.dataset['token'];
}

/**
 * Painting the recovered spans with the CSS Custom Highlight API.
 *
 * Ranges are drawn over the existing text nodes rather than by rewriting the
 * pane's markup. Why not wrapping matches in elements: the panes hold model
 * output and user input, so every rebuild would be another chance to inject
 * markup, and the text nodes the answer pane is built from stay untouched and
 * selectable.
 *
 * Highlights are purely presentational and are not exposed to the accessibility
 * tree, so nothing here is the only carrier of a fact: the legend lists every
 * category in text, the masked prompt shows a real chip element per placeholder,
 * and each highlighted region is announced by an adjacent text label. Where the
 * API is missing the page simply renders unhighlighted text — a fallback that
 * rewrote the DOM would be a second, less-tested rendering path for the most
 * sensitive strings on the page.
 */

import { emphasisNameOf, highlightNameOf } from './categories.ts';

/** One region to paint, in character offsets over an element's text content. */
export interface HighlightRegion {
  readonly start: number;
  readonly end: number;
  readonly category: string;
  /** The placeholder this region belongs to, used to link the panels. */
  readonly token: string;
}

/** True when this browser can paint custom highlights at all. */
export function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

interface RegisteredRange {
  readonly token: string;
  readonly category: string;
  readonly range: Range;
}

/**
 * Owns every highlight this page has registered.
 *
 * The registry is global to the document, so one object rebuilds all of it at
 * once: a per-pane owner would have to reason about which of the other panes'
 * entries it is allowed to clear.
 */
export class HighlightPainter {
  #ranges: RegisteredRange[] = [];
  #emphasisedToken: string | undefined;

  /** Drop every highlight this painter registered. */
  clear(): void {
    this.#ranges = [];
    this.#emphasisedToken = undefined;
    if (!highlightsSupported()) return;
    CSS.highlights.clear();
  }

  /**
   * Register the regions for one element, replacing anything painted before.
   *
   * Offsets are over the element's concatenated text, which is how the panes are
   * addressed everywhere else: the alignment works on the response strings, and
   * the panes render exactly those strings.
   */
  paint(element: Element, regions: readonly HighlightRegion[]): void {
    if (!highlightsSupported()) return;

    for (const region of regions) {
      const range = rangeOver(element, region.start, region.end);
      if (range === null) continue;
      this.#ranges.push({ token: region.token, category: region.category, range });
    }
    this.#flush();
  }

  /**
   * Raise one placeholder's spans above the rest, across every pane.
   *
   * The emphasised ranges move into a second registry entry rather than getting
   * a modified style, because `::highlight()` styles are selected by registry
   * name: two names is the only way to give the same range two appearances.
   */
  emphasise(token: string | undefined): void {
    if (!highlightsSupported()) return;
    if (this.#emphasisedToken === token) return;
    this.#emphasisedToken = token;
    this.#flush();
  }

  /** Which placeholder is currently emphasised, if any. */
  get emphasised(): string | undefined {
    return this.#emphasisedToken;
  }

  /** Rebuild the registry from the ranges this painter holds. */
  #flush(): void {
    CSS.highlights.clear();

    const base = new Map<string, Range[]>();
    const linked = new Map<string, Range[]>();

    for (const entry of this.#ranges) {
      const isEmphasised = entry.token === this.#emphasisedToken;
      const target = isEmphasised ? linked : base;
      const name = isEmphasised ? emphasisNameOf(entry.category) : highlightNameOf(entry.category);
      const bucket = target.get(name);
      if (bucket === undefined) target.set(name, [entry.range]);
      else bucket.push(entry.range);
    }

    for (const [name, ranges] of base) {
      CSS.highlights.set(name, new Highlight(...ranges));
    }
    // Higher priority so an emphasised range paints over a base one it overlaps.
    for (const [name, ranges] of linked) {
      const highlight = new Highlight(...ranges);
      highlight.priority = 1;
      CSS.highlights.set(name, highlight);
    }
  }
}

/**
 * Build a Range over `[start, end)` of an element's text, spanning text nodes.
 *
 * The walk is done per call rather than cached: the panes are rewritten wholesale
 * on every response, so a cached node list would be stale exactly when it is
 * used, and the panes hold a few hundred characters each.
 */
function rangeOver(element: Element, start: number, end: number): Range | null {
  if (end <= start) return null;

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let range: Range | null = null;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    const nodeEnd = offset + length;

    if (range === null && start >= offset && start < nodeEnd) {
      range = new Range();
      range.setStart(node, start - offset);
    }
    if (range !== null && end > offset && end <= nodeEnd) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset = nodeEnd;
  }

  // The requested range ran past the element's text: the caller's offsets do not
  // describe this element, so nothing is painted rather than something wrong.
  return null;
}

/**
 * One hue per PII category, shared by every panel.
 *
 * The point of the colour is traceability, not decoration: the same hue marks
 * the value in the original text, the placeholder in the masked prompt, and the
 * restored value in the answer, so a reader can follow one identifier through
 * the whole round trip.
 *
 * Colour is never the only carrier. Every coloured thing is accompanied by the
 * category name in text — a chip, a legend row, or a `title` — because a hue
 * alone says nothing to a reader who cannot distinguish it, and `::highlight()`
 * cannot draw a border or an icon to help.
 */

import { PII_CATEGORIES, type PiiCategory } from '@privacy-gateway/common/schema';

/**
 * The hue assigned to each category, in degrees.
 *
 * Spread around the wheel rather than generated from the index so neighbouring
 * categories in the enum are not neighbouring colours: EMAIL and PHONE co-occur
 * in almost every request, so they must be the easiest pair to tell apart.
 * Lightness and chroma are applied in CSS per theme, so only the hue lives here.
 */
const CATEGORY_HUES: Record<PiiCategory, number> = {
  EMAIL: 210,
  PHONE: 145,
  CREDIT_CARD: 25,
  MY_NUMBER: 330,
  IPV4: 190,
  API_KEY: 55,
  AWS_KEY: 80,
  JWT: 285,
  PERSON: 265,
  ADDRESS: 5,
  ORGANIZATION: 170,
  // Far from ORGANIZATION (170) and PERSON (265), the two it is most likely to
  // sit beside: a codename is often a product or project name, so the reader
  // must be able to tell "the requester named this" apart from "a model guessed
  // this was an organisation" at a glance.
  CUSTOM: 310,
};

/** Hue for an unrecognised category, so an unknown never renders uncoloured. */
const FALLBACK_HUE = 0;

/** Every category, in the order the legend lists them. */
export const CATEGORIES: readonly PiiCategory[] = PII_CATEGORIES;

/** True when `value` is a category this UI has a colour for. */
export function isKnownCategory(value: string): value is PiiCategory {
  return Object.hasOwn(CATEGORY_HUES, value);
}

/** The hue for one category name, falling back rather than throwing. */
export function hueOf(category: string): number {
  return isKnownCategory(category) ? CATEGORY_HUES[category] : FALLBACK_HUE;
}

/**
 * A CSS-safe suffix for one category, used in class names and highlight names.
 *
 * Categories are already `[A-Z_]+` by schema, but this is the value that ends up
 * inside a `::highlight()` name and a `data-` attribute, so it is normalised
 * here rather than trusted.
 */
export function slugOf(category: string): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
}

/** The custom-highlight registry name for one category. */
export function highlightNameOf(category: string): string {
  return `pii-${slugOf(category)}`;
}

/** The registry name for the emphasised (linked) state of one category. */
export function emphasisNameOf(category: string): string {
  return `pii-${slugOf(category)}-linked`;
}

/**
 * The human label for one category.
 *
 * The raw enum name is kept — it is what the stats, the OKF document and the
 * refusal body all say, so translating it in the UI alone would make the screen
 * and the audit record disagree.
 */
export function labelOf(category: string): string {
  return category;
}

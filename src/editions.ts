import { UsageError } from "./args.ts";
import type { Edition } from "./types.ts";

/**
 * Editions: one product sold as a grid of variant files (a planner in every year, week start,
 * language and paper size), narrowed by a pick on four axes. The store reads the facets out of
 * the file names (apps/store-worker/src/editions.ts); this side only spells the flags the way
 * the store does, so `--size A5` and `--week monday` mean what a person meant.
 */

export const EDITION_AXES = ["year", "week", "lang", "size"] as const;

const YEAR = /^(20[2-9]\d|undated)$/;
const LANG = /^[a-z]{2}(-[a-z]{2})?$/;
// Sizes are the one open-ended axis (a4, half-letter, ipad, a4-sheet…): anything tag-shaped.
const SIZE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** `--year --week --lang --size` as the tool's `edition` object; undefined when none was given. */
export function editionFrom(flags: Record<string, unknown>): Edition | undefined {
  const out: Edition = {};
  const year = flagText(flags.year);
  if (year !== undefined) {
    const y = year.toLowerCase();
    if (!YEAR.test(y)) throw new UsageError(`--year takes a year like 2027, or undated (got "${year}")`);
    out.year = y;
  }
  const week = flagText(flags.week);
  if (week !== undefined) {
    const w = week.toLowerCase();
    if (w === "sun" || w === "sunday") out.week = "sun";
    else if (w === "mon" || w === "monday") out.week = "mon";
    else throw new UsageError(`--week takes sun or mon, the day the week starts on (got "${week}")`);
  }
  const lang = flagText(flags.lang);
  if (lang !== undefined) {
    // "en+ja", "EN_JA" and "en ja" are all the bilingual edition, which the store calls en-ja.
    const l = lang.toLowerCase().replace(/[+_\s]+/g, "-");
    if (!LANG.test(l)) throw new UsageError(`--lang takes a language like en, ja or en-ja (got "${lang}")`);
    out.lang = l;
  }
  const size = flagText(flags.size);
  if (size !== undefined) {
    const s = size.trim().toLowerCase().replace(/\s+/g, "-");
    if (!SIZE.test(s)) throw new UsageError(`--size takes a size like a4, a5, letter or ipad (got "${size}")`);
    out.size = s;
  }
  return Object.keys(out).length ? out : undefined;
}

const flagText = (v: unknown): string | undefined =>
  typeof v === "number" ? String(v) : typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Whether a file belongs to the picked edition. A file with no facet on an axis (the read-me, a
 * cover sheet) belongs to every edition, as on the product page, so a pick never hides it.
 */
export function matchesEdition(file: Edition | null | undefined, pick: Edition | undefined): boolean {
  if (!pick) return true;
  for (const axis of EDITION_AXES) {
    const want = pick[axis];
    const have = file?.[axis];
    if (want !== undefined && have !== undefined && have !== want) return false;
  }
  return true;
}

/** "2027 · mon · en · a5" for a file list. */
export const editionLabel = (e: Edition | null | undefined): string =>
  e
    ? EDITION_AXES.map((a) => e[a])
        .filter(Boolean)
        .join(" · ")
    : "";

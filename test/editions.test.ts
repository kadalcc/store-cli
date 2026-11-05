import { describe, expect, test } from "bun:test";

import { UsageError } from "../src/args.ts";
import { editionFrom, editionLabel, matchesEdition } from "../src/editions.ts";

describe("editionFrom", () => {
  test("no edition flags: no edition object at all", () => {
    expect(editionFrom({})).toBeUndefined();
    expect(editionFrom({ year: "  " })).toBeUndefined();
  });

  test("flags as the store spells them", () => {
    expect(editionFrom({ year: "2027", week: "Monday", lang: "EN+JA", size: "A5" })).toEqual({
      year: "2027",
      week: "mon",
      lang: "en-ja",
      size: "a5",
    });
    expect(editionFrom({ year: "Undated", week: "sun" })).toEqual({ year: "undated", week: "sun" });
    expect(editionFrom({ size: "Half Letter" })).toEqual({ size: "half-letter" });
    // --year parsed as a number by some callers.
    expect(editionFrom({ year: 2028 })).toEqual({ year: "2028" });
  });

  test("values the store would never match are usage errors", () => {
    expect(() => editionFrom({ year: "27" })).toThrow(UsageError);
    expect(() => editionFrom({ week: "tue" })).toThrow(/sun or mon/);
    expect(() => editionFrom({ lang: "english" })).toThrow(/en, ja or en-ja/);
    expect(() => editionFrom({ size: "a5/../../x" })).toThrow(UsageError);
  });
});

describe("matchesEdition", () => {
  const a5 = { year: "2027", week: "mon", lang: "en", size: "a5" };
  test("a pick narrows only the axes it names", () => {
    expect(matchesEdition(a5, undefined)).toBe(true);
    expect(matchesEdition(a5, { size: "a5" })).toBe(true);
    expect(matchesEdition(a5, { size: "a6" })).toBe(false);
    expect(matchesEdition(a5, { year: "2027", week: "sun" })).toBe(false);
  });
  test("a file with no facets (a read-me) belongs to every edition", () => {
    expect(matchesEdition(null, { size: "a6" })).toBe(true);
    expect(matchesEdition({ year: "2027" }, { size: "a6" })).toBe(true);
  });
  test("labels", () => {
    expect(editionLabel(a5)).toBe("2027 · mon · en · a5");
    expect(editionLabel(null)).toBe("");
  });
});

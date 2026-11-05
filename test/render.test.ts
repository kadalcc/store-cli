import { describe, expect, test } from "bun:test";

import { buyText } from "../src/render.ts";
import type { BuyLink } from "../src/types.ts";

const link = (note: string): BuyLink => ({
  url: "https://store.kadal.cc/buy?items=soft-ui-sounds&ref=cli",
  items: [
    { slug: "soft-ui-sounds", name: "Soft UI Sounds", tier: "personal", cents: 900, owned: false },
  ],
  totalCents: 900,
  note,
});
const charged = (lines: string[]) => lines.join("\n").match(/nothing is charged/gi) ?? [];

describe("buy: nothing is charged, said once", () => {
  test("the store's note, said to you, is the one line", () => {
    const note =
      "Open the link to review and pay. Nothing is charged until you pay on that page, and you can change a licence or remove anything there.";
    const out = buyText(link(note));
    expect(out.at(-1)).toBe(note);
    expect(charged(out)).toHaveLength(1);
  });

  test("an older store's note, written for an agent, is still not doubled", () => {
    const note =
      "Open the link to review and pay. Nothing is charged until the person pays in Paddle's checkout, and they can change a licence or remove anything there.";
    const out = buyText(link(note));
    expect(out.at(-1)).toBe(note);
    expect(charged(out)).toHaveLength(1);
  });

  test("a note that doesn't say it gets the CLI's line", () => {
    const out = buyText(link("Already owned, so not charged: soft-ui-sounds."));
    expect(out.slice(-2)).toEqual([
      "Already owned, so not charged: soft-ui-sounds.",
      "Nothing is charged until you pay in the checkout on that page.",
    ]);
    expect(charged(buyText(link("")))).toHaveLength(1);
  });
});

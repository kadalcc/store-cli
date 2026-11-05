import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { alreadyHave, safeFileName } from "../src/download.ts";
import { planSync } from "../src/transfer.ts";
import type { Library } from "../src/types.ts";
import { tempDir } from "./helpers.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const card = (slug: string) => ({
  slug,
  name: slug,
  kind: "asset" as const,
  shelf: { slug: "s", name: "S" },
  blurb: null,
  url: `https://store.kadal.cc/p/${slug}`,
  imageUrl: null,
  prices: [],
  fromCents: null,
  tags: { style: [], topic: [], format: [] },
  owned: "standard" as const,
});

const file = (
  id: string,
  name: string,
  text: string,
  edition: Record<string, string> | null = null,
) => ({
  id,
  name,
  bytes: Buffer.byteLength(text),
  sha256: sha(text),
  edition,
});

const library = (): Library => ({
  items: [
    {
      product: card("planner"),
      tier: "standard",
      files: [
        file("a5", "planner_a5.pdf", "A5 pages", { size: "a5" }),
        file("a6", "planner_a6.pdf", "A6 pages", { size: "a6" }),
        file("rm", "readme.txt", "read me"),
      ],
      zipAvailable: true,
      updatedAt: "2026-11-01",
      lastUpdate: null,
    },
    {
      product: card("sfx"),
      tier: "standard",
      files: [
        file("x1", "boom.wav", "boom"),
        file("x2", "BOOM.wav", "BOOM"),
        file("x3", "../../escape.wav", "esc"),
      ],
      zipAvailable: false,
      updatedAt: "2026-11-01",
      lastUpdate: null,
    },
  ],
});

describe("planSync", () => {
  test("an empty folder: everything comes down, one folder per product, names made safe", async () => {
    const dir = tempDir();
    const plan = await planSync(library(), dir);
    expect(plan.skip).toEqual([]);
    expect(plan.download.map((p) => p.path.slice(dir.length + 1))).toEqual([
      "planner/planner_a5.pdf",
      "planner/planner_a6.pdf",
      "planner/readme.txt",
      "sfx/boom.wav",
      // Case-insensitive file systems would make these one file; the second keeps its id.
      "sfx/x2-BOOM.wav",
      // A name with folders in it stays inside the product's folder.
      "sfx/escape.wav",
    ]);
  });

  test("files whose sha256 matches are skipped; a changed or partial file is not", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "planner"), { recursive: true });
    writeFileSync(join(dir, "planner", "planner_a5.pdf"), "A5 pages"); // same bytes
    writeFileSync(join(dir, "planner", "planner_a6.pdf"), "A6 pagez"); // same size, different bytes
    writeFileSync(join(dir, "planner", "readme.txt"), "read"); // shorter
    const hashed: string[] = [];
    const plan = await planSync(library(), dir, {
      only: ["planner"],
      hash: async (p) => {
        hashed.push(p);
        const { sha256File } = await import("../src/download.ts");
        return sha256File(p);
      },
    });
    expect(plan.skip.map((p) => p.fileId)).toEqual(["a5"]);
    expect(plan.download.map((p) => p.fileId)).toEqual(["a6", "rm"]);
    // The size check comes first: the shorter file is never read.
    expect(hashed.map((p) => p.split("/").pop())).toEqual(["planner_a5.pdf", "planner_a6.pdf"]);
  });

  test("an edition narrows the planned files; facet-less files stay", async () => {
    const plan = await planSync(library(), tempDir(), {
      edition: { size: "a6" },
      only: ["planner"],
    });
    expect(plan.download.map((p) => p.fileId)).toEqual(["a6", "rm"]);
  });
});

describe("file names", () => {
  test("safeFileName keeps a name inside its folder on every OS", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Windows\\evil.dll")).toBe("evil.dll");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName(".hidden")).toBe("hidden");
    expect(safeFileName('a<b>:"c"|?.pdf')).toBe("a_b___c___.pdf");
    expect(safeFileName("week\u0000one.pdf")).toBe("week_one.pdf");
  });

  test("alreadyHave needs a checksum to say yes", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "abc");
    expect(await alreadyHave(join(dir, "a.txt"), { bytes: 3, sha256: sha("abc") })).toBe(true);
    expect(
      await alreadyHave(join(dir, "a.txt"), { bytes: 3, sha256: sha("abc").toUpperCase() }),
    ).toBe(true);
    expect(await alreadyHave(join(dir, "a.txt"), { bytes: 3 })).toBe(false);
    expect(await alreadyHave(join(dir, "missing.txt"), { sha256: sha("abc") })).toBe(false);
  });
});

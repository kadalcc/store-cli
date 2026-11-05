import { describe, expect, test } from "bun:test";

import { UsageError, parseArgs } from "../src/args.ts";
import { buyItems, reportArgs, searchAgain, searchArgs } from "../src/commands.ts";
import { hexColor } from "../src/fetch-product.ts";
import { COMMAND_FLAGS, HELP, commandHelp } from "../src/index.ts";
import { cli, tempDir } from "./helpers.ts";

const parse = (command: string, argv: string[]) =>
  parseArgs(argv, {
    json: { kind: "boolean" },
    host: { kind: "string" },
    ...COMMAND_FLAGS[command],
  });

describe("flags", () => {
  test("search: words, filters, --max in dollars becomes cents", () => {
    const { flags, positionals } = parse("search", [
      "weekly",
      "planner",
      "--shelf",
      "planners",
      "--max",
      "4.99",
      "--limit=10",
    ]);
    expect(searchArgs({ flags, args: positionals })).toEqual({
      query: "weekly planner",
      shelf: "planners",
      maxCents: 499,
      limit: 10,
    });
  });

  test("search: the command for the next page sends the same search", () => {
    const { flags, positionals } = parse("search", [
      "kid's",
      "planner",
      "--shelf",
      "printables",
      "--max",
      "4.99",
      "--sort",
      "price",
    ]);
    expect(searchAgain(searchArgs({ flags, args: positionals }), "http://localhost:8861")).toBe(
      "kadal-store search 'kid'\\''s' planner --shelf printables --sort price --max 4.99 --host http://localhost:8861",
    );
    expect(searchAgain({})).toBe("kadal-store search");
  });

  test("--color: hex as the store reads it, or nothing", () => {
    expect(hexColor("2F9E44")).toBe("#2f9e44");
    expect(hexColor("#2f9")).toBe("#22ff99");
    expect(hexColor(" #2f9e44 ")).toBe("#2f9e44");
    for (const bad of ["green", "#2f9e4", "2f9e44ff", "#", ""]) expect(hexColor(bad)).toBeNull();
  });

  test("search: bad values are usage errors, not requests the store refuses", () => {
    const run = (argv: string[]) => {
      const { flags, positionals } = parse("search", argv);
      return () => searchArgs({ flags, args: positionals });
    };
    expect(run(["--kind", "bundle"])).toThrow(UsageError);
    expect(run(["--limit", "51"])).toThrow(/1 to 50/);
    expect(run(["--sort", "cheapest"])).toThrow(/relevance, newest, price/);
    expect(run(["--max", "-3"])).toThrow(UsageError);
  });

  test("unknown flags and a value-less string flag are usage errors", () => {
    expect(() => parse("search", ["--colour", "red"])).toThrow(/Unknown option --colour/);
    expect(() => parse("download", ["x", "--out"])).toThrow(/--out needs a value/);
  });

  test("download: -o, repeated --file, edition flags, --no-… switches", () => {
    const { flags, positionals } = parse("download", [
      "techo",
      "-o",
      "assets",
      "--file",
      "a.pdf",
      "--file",
      "b.pdf",
      "--size",
      "A5",
      "--no-zip",
    ]);
    expect(positionals).toEqual(["techo"]);
    expect(flags).toMatchObject({
      out: "assets",
      file: ["a.pdf", "b.pdf"],
      size: "A5",
      zip: false,
    });
  });

  test("buy: slug and slug:tier, checked before anything is sent", () => {
    expect(buyItems(["fern-pack", "techo:commercial"])).toEqual([
      { slug: "fern-pack" },
      { slug: "techo", tier: "commercial" },
    ]);
    expect(() => buyItems([])).toThrow(UsageError);
    expect(() => buyItems(["techo:gold"])).toThrow(/standard, personal, commercial/);
    expect(() => buyItems(["a:b:c"])).toThrow(UsageError);
    expect(() => buyItems(Array.from({ length: 21 }, (_, i) => `p${i}`))).toThrow(/at most 20/);
  });

  test("report: kind, where, and the words", async () => {
    const ctx = (argv: string[], stdin?: string) => {
      const { flags, positionals } = parse("report", argv);
      const { Readable } = require("node:stream") as typeof import("node:stream");
      return {
        flags,
        args: positionals,
        host: "https://store.kadal.cc",
        io: { json: false, say: () => {}, emit: () => {} },
        rt: { stdin: Readable.from(stdin ? [stdin] : []), cwd: "/" } as never,
      };
    };
    expect(
      await reportArgs(
        ctx([
          "techo",
          "--kind",
          "mistake",
          "--file",
          "a5.pdf",
          "--page",
          "3",
          "March",
          "has",
          "32",
          "days",
        ]),
      ),
    ).toEqual({
      slug: "techo",
      fileName: "a5.pdf",
      page: 3,
      kind: "mistake",
      body: "March has 32 days",
    });
    expect(
      await reportArgs(ctx(["techo", "--kind", "idea", "-"], "  A dark edition, please.\n")),
    ).toMatchObject({ body: "A dark edition, please." });
    await expect(reportArgs(ctx(["techo", "words"]))).rejects.toThrow(/--kind/);
    await expect(reportArgs(ctx(["techo", "--kind", "bug", "words"]))).rejects.toThrow(
      /mistake, question, idea/,
    );
    await expect(
      reportArgs(ctx(["techo", "--kind", "mistake", "--page", "2", "--at", "3", "x"])),
    ).rejects.toThrow(/one or the other/);
    await expect(reportArgs(ctx(["techo", "--kind", "mistake"]))).rejects.toThrow(
      /needs the words/,
    );
    await expect(reportArgs(ctx(["techo", "--kind", "mistake", "x".repeat(4001)]))).rejects.toThrow(
      /4000/,
    );
  });
});

describe("main", () => {
  const run = cli(tempDir(), tempDir());

  test("help, per-command help, version", async () => {
    expect((await run(["--help"])).out).toContain("kadal-store <command>");
    const help = await run(["download", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("--concurrency");
    expect(help.out).not.toContain("recommend [words");
    expect(commandHelp("buy")).toContain("nothing is");
    // Without a tier the store's quote() takes the cheapest price on sale, whatever its name.
    expect(commandHelp("buy")).toContain("the cheapest licence on sale");
    expect(HELP).not.toContain("standard (default)");
    expect(commandHelp("sync")).toContain("--color <hex>");
    expect((await run(["--version", "--json"])).json()).toEqual({ version: expect.any(String) });
  });

  test("exit codes: 2 for usage, 3 when signed out, JSON errors on stdout", async () => {
    const bad = await run(["frobnicate"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Unknown command");
    const signedOut = await run(["--json", "library"]);
    expect(signedOut.code).toBe(3);
    expect(signedOut.json()).toEqual({
      ok: false,
      error: {
        code: "unauthorized",
        message: "Not signed in to the Kadal Store. Run `kadal-store login`.",
        exitCode: 3,
      },
    });
    const elsewhere = await run(["whoami", "--host", "http://localhost:8861"]);
    expect(elsewhere.code).toBe(3);
    expect(elsewhere.err).toContain("kadal-store login --host http://localhost:8861");
  });

  test("--host: plain http only on this machine", async () => {
    const r = await run(["library", "--host", "http://store.example.com"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("use https");
    expect((await run(["library", "--host", "not a url"])).code).toBe(2);
  });
});

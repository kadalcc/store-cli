import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { configPath } from "../src/config.ts";
import { createServer } from "../src/mcp.ts";
import { type FakeStore, startFakeStore } from "./fake-store.ts";
import { type Run, cli, tempDir } from "./helpers.ts";

/**
 * The CLI end to end against the fake store: a real OAuth round trip through the loopback
 * listener, real MCP calls over Streamable HTTP, real downloads from /dl/ links, and the stdio
 * server's tools through the SDK's own client.
 */

let store: FakeStore;
let config: string;
let work: string;
let run: (argv: string[], extra?: { stdin?: string }) => Promise<Run>;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

beforeAll(() => {
  store = startFakeStore();
  config = tempDir("kadal-store-config-");
  work = tempDir("kadal-store-work-");
  run = cli(config, work);
});
afterAll(() => store.stop());

const h = () => ["--host", store.url];
const fileBytes = (id: string) =>
  store.products.flatMap((p) => p.files).find((f) => f.id === id)!.bytes;

describe("login → library → download → buy", () => {
  test("login: browser approval, token saved 0600, who it is", async () => {
    const r = await run(["login", ...h(), "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      ok: true,
      host: store.url,
      user: { id: "u_ana", name: "Ana", email: "ana@example.com" },
      scopes: ["store:read", "store:write"],
    });
    expect(r.err).toContain(`${store.url}/authorize?`);
    const path = configPath({ XDG_CONFIG_HOME: config });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.sessions[store.url]).toMatchObject({
      clientKind: "registered",
      resource: `${store.url}/mcp`,
      user: { email: "ana@example.com" },
    });
    const who = await run(["whoami", ...h()]);
    expect(who.out).toContain("Ana <ana@example.com> on 127.0.0.1:");
  });

  test("library: the tool's answer as --json, a list as text", async () => {
    const j = await run(["library", ...h(), "--json"]);
    const lib = j.json<{ items: { product: { slug: string }; files: { id: string }[] }[] }>();
    expect(lib.items.map((i) => i.product.slug)).toEqual(["techo-weekly-2027", "retro-ui-sfx"]);
    expect(lib.items[0]!.files.map((f) => f.id)).toEqual(["f_a5", "f_a6", "f_readme"]);
    const t = await run(["library", ...h()]);
    expect(t.out).toContain("Techo weekly planner 2027  (personal)  3 files");
  });

  test("download: one edition, sha256 checked, into -o", async () => {
    const r = await run([
      "download",
      "techo-weekly-2027",
      "--size",
      "A5",
      "--year",
      "2027",
      "-o",
      "planner",
      ...h(),
      "--json",
    ]);
    expect(r.code).toBe(0);
    const report = r.json<{
      files: { name: string; status: string; sha256: string }[];
      counts: Record<string, number>;
    }>();
    expect(report.counts).toEqual({ downloaded: 2, skipped: 0, failed: 0 });
    expect(store.calls).toContain('links:techo-weekly-2027:*:{"year":"2027","size":"a5"}');
    expect(readdirSync(join(work, "planner")).sort()).toEqual([
      "READ ME.txt",
      "techo-weekly_2027_mon_en_a5.pdf",
    ]);
    expect(sha(readFileSync(join(work, "planner", "techo-weekly_2027_mon_en_a5.pdf")))).toBe(
      sha(fileBytes("f_a5")),
    );
    // Again: nothing comes down.
    store.calls.length = 0;
    const again = await run([
      "download",
      "techo-weekly-2027",
      "--size",
      "a5",
      "-o",
      "planner",
      ...h(),
      "--json",
    ]);
    expect(again.json<{ counts: Record<string, number> }>().counts).toEqual({
      downloaded: 0,
      skipped: 2,
      failed: 0,
    });
    expect(store.calls.filter((c) => c.startsWith("dl:"))).toEqual([]);
  });

  test("download --file picks by name; an unknown name lists the real ones", async () => {
    const r = await run(["download", "retro-ui-sfx", "--file", "BEEP.wav", ...h()]);
    expect(r.code).toBe(0);
    expect(readdirSync(join(work, "retro-ui-sfx"))).toEqual(["beep.wav"]);
    const bad = await run(["download", "retro-ui-sfx", "--file", "boom.wav", ...h()]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain(
      'No file named "boom.wav" in retro-ui-sfx. Its files: click.wav, beep.wav',
    );
  });

  test("download --zip", async () => {
    const r = await run(["download", "retro-ui-sfx", "--zip", "-o", "zips", ...h(), "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ zip: { path: string } }>().zip.path).toBe(
      join(work, "zips", "retro-ui-sfx.zip"),
    );
  });

  test("download of something not owned: the store's words, exit 1", async () => {
    const r = await run(["download", "fern-pack", ...h()]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("You don't own fern-pack.");
  });

  test("buy: the review link, and the promise that nothing is charged yet", async () => {
    const r = await run(["buy", "fern-pack", "techo-weekly-2027:personal", ...h()]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `${store.url}/buy?items=fern-pack:standard,techo-weekly-2027:personal&ref=cli`,
    );
    expect(r.out).toContain("(you already own this)");
    expect(r.out).toContain("Nothing is charged until you pay in the checkout on that page.");
    const j = await run(["buy", "fern-pack", ...h(), "--json"]);
    expect(j.json()).toMatchObject({
      totalCents: 1200,
      items: [{ slug: "fern-pack", tier: "standard", cents: 1200, owned: false }],
    });
  });
});

describe("sync", () => {
  test("everything into one folder per product; the second run skips by sha256", async () => {
    const dir = join(work, "mirror");
    const first = await run(["sync", dir, ...h(), "--json"]);
    expect(first.code).toBe(0);
    expect(first.json<{ counts: Record<string, number> }>().counts).toEqual({
      downloaded: 5,
      skipped: 0,
      failed: 0,
    });
    expect(readdirSync(dir).sort()).toEqual(["retro-ui-sfx", "techo-weekly-2027"]);

    // One file changed locally, one deleted: only those two come down.
    writeFileSync(join(dir, "retro-ui-sfx", "click.wav"), "edited");
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "techo-weekly-2027", "READ ME.txt"));
    store.calls.length = 0;
    const second = await run(["sync", dir, ...h(), "--json"]);
    expect(second.json<{ counts: Record<string, number> }>().counts).toEqual({
      downloaded: 2,
      skipped: 3,
      failed: 0,
    });
    expect(store.calls.filter((c) => c.startsWith("dl:")).sort()).toEqual([
      "dl:f_click",
      "dl:f_readme",
    ]);
    expect(store.calls).toContain("links:retro-ui-sfx:f_click");

    const dry = await run(["sync", dir, ...h(), "--dry-run"]);
    expect(dry.out).toContain("5 files already in");
    expect(dry.out).toContain("0 to download (dry run)");
  });

  test("an interrupted download resumes from its .kadal-part", async () => {
    const dir = join(work, "resume");
    store.cutOnce.add("f_a6");
    const first = await run([
      "download",
      "techo-weekly-2027",
      "--file",
      "techo-weekly_2027_mon_en_a6.pdf",
      "-o",
      dir,
      ...h(),
      "--json",
    ]);
    expect(first.code).toBe(1);
    const part = join(dir, "techo-weekly_2027_mon_en_a6.pdf.kadal-part");
    expect(existsSync(part)).toBe(true);
    expect(existsSync(join(dir, "techo-weekly_2027_mon_en_a6.pdf"))).toBe(false);
    const have = statSync(part).size;
    expect(have).toBeGreaterThan(0);

    store.calls.length = 0;
    const second = await run([
      "download",
      "techo-weekly-2027",
      "--file",
      "techo-weekly_2027_mon_en_a6.pdf",
      "-o",
      dir,
      ...h(),
      "--json",
    ]);
    expect(second.code).toBe(0);
    expect(second.json<{ files: { resumed?: boolean }[] }>().files[0]!.resumed).toBe(true);
    expect(store.calls).toContain(`dl:f_a6@${have}`);
    expect(sha(readFileSync(join(dir, "techo-weekly_2027_mon_en_a6.pdf")))).toBe(
      sha(fileBytes("f_a6")),
    );
    expect(existsSync(part)).toBe(false);
  });

  test("bad bytes: nothing kept, exit 4", async () => {
    const dir = join(work, "corrupt");
    store.corrupt.add("f_beep");
    try {
      const r = await run([
        "download",
        "retro-ui-sfx",
        "--file",
        "beep.wav",
        "-o",
        dir,
        ...h(),
        "--json",
      ]);
      expect(r.code).toBe(4);
      const f = r.json<{ files: { status: string; checksum: boolean; error: string }[] }>()
        .files[0]!;
      expect(f).toMatchObject({ status: "failed", checksum: true });
      expect(f.error).toContain("did not match the store's checksum");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      store.corrupt.delete("f_beep");
    }
  });

  test("an expired link is asked for again", async () => {
    const dir = join(work, "expired");
    store.expireOnce.add("f_click");
    store.calls.length = 0;
    const r = await run(["download", "retro-ui-sfx", "--file", "click.wav", "-o", dir, ...h()]);
    expect(r.code).toBe(0);
    expect(store.calls).toContain("links:retro-ui-sfx:f_click");
    expect(readFileSync(join(dir, "click.wav"))).toEqual(Buffer.from(fileBytes("f_click")));
  });
});

describe("search, recommend, report, notes", () => {
  test("search and show", async () => {
    const s = await run(["search", "planning", "--max", "10", ...h(), "--json"]);
    expect(s.json<{ items: { slug: string }[] }>().items.map((i) => i.slug)).toEqual([
      "techo-weekly-2027",
    ]);
    const t = await run(["show", "fern-pack", ...h()]);
    expect(t.out).toContain("Fern textures pack  (pack of 3 · Textures)");
    expect(t.out).toContain("Buy: kadal-store buy fern-pack");
  });

  test("recommend --from: the summary is shown on stderr, sent only with --yes", async () => {
    const project = join(work, "game");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "cosy-farm", dependencies: { phaser: "3" } }),
    );
    writeFileSync(join(project, "main.ts"), "SECRET_CONTENT");

    const asked = await run(["recommend", "--from", project, ...h()]);
    expect(asked.code).toBe(2);
    expect(asked.err).toContain("Project: cosy-farm");
    expect(asked.err).toContain("add --yes");

    store.calls.length = 0;
    const r = await run([
      "recommend",
      "sound effects",
      "--from",
      project,
      "--yes",
      ...h(),
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(r.json<{ items: { slug: string; why: string }[] }>().items[0]).toMatchObject({
      slug: "fern-pack",
      why: expect.any(String),
    });
    const sent = store.calls.find((c) => c.startsWith("context:"))!;
    expect(sent).toContain("sound effects\n\nProject: cosy-farm");
    expect(sent).toContain("Built with: Phaser");
    expect(sent).not.toContain("SECRET_CONTENT");
    expect(sent).not.toContain(project);
  });

  test("report a mistake, then see it in notes", async () => {
    const r = await run([
      "report",
      "techo-weekly-2027",
      "--kind",
      "mistake",
      "--file",
      "techo-weekly_2027_mon_en_a5.pdf",
      "--page",
      "12",
      "March 31 is missing",
      ...h(),
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      note: { id: "note_1", status: "open", url: `${store.url}/account/notes/note_1` },
    });
    expect(store.notes[0]).toMatchObject({
      kind: "mistake",
      page: 12,
      fileName: "techo-weekly_2027_mon_en_a5.pdf",
    });
    const n = await run(["notes", ...h()]);
    expect(n.out).toContain(
      "Techo weekly planner 2027 · mistake · techo-weekly_2027_mon_en_a5.pdf  [Open]  note_1",
    );
  });
});

describe("kadal-store mcp", () => {
  let client: Client;
  let close: () => Promise<void>;
  let project: string;

  beforeAll(async () => {
    project = tempDir("kadal-store-mcp-");
    const made = createServer({
      host: store.url,
      root: project,
      env: { XDG_CONFIG_HOME: config, HOME: config },
    });
    close = made.close;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await made.server.connect(a);
    client = new Client({ name: "test", version: "0" });
    await client.connect(b);
  });
  afterAll(async () => {
    await client.close();
    await close();
  });

  test("the store's tools and the two local ones, with read-only hints", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_buy_link",
        "download_to_folder",
        "get_download_links",
        "get_product",
        "list_library",
        "list_my_notes",
        "list_shelves",
        "project_summary",
        "recommend",
        "report_problem",
        "search_products",
        "whoami",
      ].sort(),
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.create_buy_link!.annotations?.readOnlyHint).toBe(true);
    expect(byName.report_problem!.annotations?.idempotentHint).toBe(false);
    expect(byName.create_buy_link!.description).toContain("charges nothing");
  });

  test("a proxied call comes back as the store sent it", async () => {
    const r = (await client.callTool({ name: "search_products", arguments: { query: "ui" } })) as {
      structuredContent: { items: { slug: string }[] };
    };
    expect(r.structuredContent.items.map((i) => i.slug)).toEqual(["retro-ui-sfx"]);
    const bad = (await client.callTool({ name: "get_product", arguments: { slug: "nope" } })) as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toBe("No product nope.");
  });

  test("download_to_folder writes into the project, and only inside it", async () => {
    const r = (await client.callTool({
      name: "download_to_folder",
      arguments: { slug: "retro-ui-sfx", dir: "assets/sfx" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("saved: assets/sfx/click.wav");
    expect(readdirSync(join(project, "assets", "sfx")).sort()).toEqual(["beep.wav", "click.wav"]);
    const out = (await client.callTool({
      name: "download_to_folder",
      arguments: { slug: "retro-ui-sfx", dir: "../elsewhere" },
    })) as { isError: boolean; content: { text: string }[] };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("outside the project");
  });

  test("project_summary", async () => {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "mcp-project", dependencies: { three: "1" } }),
    );
    const r = (await client.callTool({ name: "project_summary", arguments: {} })) as {
      structuredContent: { text: string };
    };
    expect(r.structuredContent.text).toContain("Project: mcp-project");
    expect(r.structuredContent.text).toContain("Built with: three.js");
  });

  test("signed out: a tool error that tells the agent to ask the person", async () => {
    const other = createServer({
      host: store.url,
      root: project,
      env: { XDG_CONFIG_HOME: tempDir() },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await other.server.connect(a);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(b);
    const r = (await c.callTool({ name: "list_library", arguments: {} })) as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("npx -y @kadal/store login");
    await c.close();
  });
});

describe("logout", () => {
  test("revokes and forgets", async () => {
    store.calls.length = 0;
    const r = await run(["logout", ...h(), "--json"]);
    expect(r.json()).toEqual({ ok: true, host: store.url, signedOut: true, revoked: true });
    expect(store.calls).toContain("revoke");
    expect(existsSync(configPath({ XDG_CONFIG_HOME: config }))).toBe(false);
    expect((await run(["library", ...h()])).code).toBe(3);
  });
});

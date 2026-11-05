/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `kadal-store mcp`  —  the Kadal Store for AI agents, over stdio
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * For clients that cannot do OAuth themselves, or that should share the terminal's sign-in: a
 * stdio MCP server whose store tools are the hosted server's (https://store.kadal.cc/mcp),
 * called with this machine's token. The descriptions here are written for the model; the
 * arguments are checked here and again by the store, and the answers come back as the store
 * sent them (structuredContent and text), so nothing is lost in the middle.
 *
 * Two tools exist only here, because only here is there a project on disk:
 *   project_summary     what `recommend --from` sends: a contents-free summary of the folder
 *   download_to_folder  files the person owns, into the project, checked against their sha256
 *
 * stdout is the protocol: every log line goes to stderr. Loaded only by `kadal-store mcp`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadSession } from "./config.ts";
import { fetchProduct } from "./fetch-product.ts";
import { AuthError, hostLabel } from "./host.ts";
import { Auth } from "./session.ts";
import { Store } from "./store.ts";
import { summariseProject } from "./summarise.ts";
import { NOTE_KINDS, NOTE_STATUSES, TIERS } from "./types.ts";

export interface McpOptions {
  host: string;
  /** The project: download_to_folder and project_summary resolve relative paths against it. */
  root: string;
  /** Let download_to_folder and project_summary reach outside `root` (off by default). */
  allowOutside?: boolean;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  version?: string;
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;

const tier = z.enum(TIERS as [string, ...string[]]);
const edition = z
  .object({
    year: z.string().optional().describe('A year like "2027", or "undated".'),
    week: z.enum(["sun", "mon"]).optional().describe("The day weeks start on."),
    lang: z.string().optional().describe('A language: "en", "ja", or "en-ja" for bilingual.'),
    size: z.string().optional().describe('A paper or screen size: "a4", "a5", "letter", "ipad"…'),
  })
  .describe("Narrow a product sold in editions (planners, calendars) to one. Leave an axis out to keep all of it.");

const SIGNED_OUT_HINT =
  "Ask the person to run `npx -y @kadal/store login` in a terminal (it opens their browser to approve), then try again. Do not try to sign in yourself.";

const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

const ok = (data: Record<string, unknown>, text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: data,
});

const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function createServer(o: McpOptions): { server: McpServer; store: Store; close: () => Promise<void> } {
  const env = o.env ?? process.env;
  const version = o.version ?? "0.0.0";
  const store = new Store(o.host, new Auth(o.host, env, o.fetch ?? fetch), version);
  const root = resolve(o.root);

  const server = new McpServer(
    { name: "kadal-store", title: "Kadal Store", version },
    {
      instructions: [
        `Kadal Store (${hostLabel(o.host)}): digital downloads — planners, printables, sound effects, music, shaders, 3D models, icons, templates. These tools act as the person, with their own store sign-in on this machine.`,
        "Find: search_products, or recommend with `context` from project_summary (a contents-free summary of the current project); then get_product for the files, editions and licence of the best few before suggesting them.",
        "Use what they own: list_library, then download_to_folder puts the files into the project (checked against their sha256; files already there are skipped).",
        "Buying: never buy, and never claim something was bought. If the person asks for something they do not own, create_buy_link gives a review page; give them the URL. Nothing is charged until they pay there themselves.",
        "Problems: if a file they bought has a mistake (a typo, a wrong date, a broken file), report_problem with the file name and page or time, in plain words, once you have checked it. list_my_notes shows Kadal's replies.",
        `Signed out (an error says so): ${SIGNED_OUT_HINT}`,
      ].join("\n"),
    },
  );

  /** A store tool, forwarded as it is. Errors the agent can act on come back as tool errors. */
  const proxy = (name: string) => async (args: Record<string, unknown>) => {
    try {
      return await store.raw(name, defined(args ?? {}));
    } catch (e) {
      if (e instanceof AuthError) return fail(`${e.message} ${SIGNED_OUT_HINT}`);
      return fail(e instanceof Error ? e.message : String(e));
    }
  };

  server.registerTool(
    "whoami",
    {
      title: "Who is signed in",
      description: "The person this store sign-in belongs to (id, name, email), its scopes, and whether they run the store. Call it when unsure whether the person is signed in.",
      inputSchema: {},
      annotations: READ,
    },
    proxy("whoami"),
  );

  server.registerTool(
    "list_shelves",
    {
      title: "Store shelves",
      description: "The store's shelves (its categories), each with a slug, name, blurb, how many products it holds, and its licence model. Use a shelf slug to narrow search_products or recommend.",
      inputSchema: {},
      annotations: READ,
    },
    proxy("list_shelves"),
  );

  server.registerTool(
    "search_products",
    {
      title: "Search the store",
      description: "Search the catalogue. Returns product cards: slug, name, kind (asset or pack), shelf, blurb, url, prices per licence tier in US cents, tags (style, topic, format), and `owned` (the person's tier if they already own it). Page with nextCursor.",
      inputSchema: {
        query: z.string().optional().describe("Words to search for, e.g. 'weekly planner a5' or 'retro ui sound effects'."),
        shelf: z.string().optional().describe("A shelf slug from list_shelves."),
        style: z.string().optional().describe("A style tag, e.g. minimal, pixel-art."),
        topic: z.string().optional().describe("A topic tag."),
        format: z.string().optional().describe("A format tag, e.g. pdf, wav, glb, png."),
        kind: z.enum(["asset", "pack"]).optional().describe("asset: one product; pack: a bundle of several."),
        maxCents: z.number().int().min(0).optional().describe("Only products from at most this price, in US cents (2000 = $20)."),
        sort: z.enum(["relevance", "newest", "price"]).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("How many (default 20)."),
        cursor: z.string().optional().describe("nextCursor from the previous page."),
      },
      annotations: READ,
    },
    proxy("search_products"),
  );

  server.registerTool(
    "get_product",
    {
      title: "Product details",
      description: "Everything about one product: description, prices per tier, its files (name, bytes, minimum tier, edition), editions, what a pack contains and which packs include it, the licence (what each tier allows and does not), and its update history. Check the licence before suggesting a product for commercial work.",
      inputSchema: { slug: z.string().describe("The product's slug.") },
      annotations: READ,
    },
    proxy("get_product"),
  );

  server.registerTool(
    "recommend",
    {
      title: "Recommend for this work",
      description: "Products that fit what the person is working on. `context` is a few plain lines about the project and what it needs (project_summary's `text` is a good start; add what the person asked for). Never put file contents, secrets or personal data in it. Each item has a one-line `why` and a score; `packs` are bundles the person already owns part of (`ownedOf`). This only shortlists: read get_product for the best few, then recommend with your own reasons.",
      inputSchema: {
        context: z.string().min(1).max(6000).describe("What the project is and what it needs, at most 6000 characters."),
        shelves: z.array(z.string()).optional().describe("Shelf slugs to keep to."),
        formats: z.array(z.string()).optional().describe("Formats to prefer, e.g. ['pdf'] or ['wav', 'ogg']."),
        maxCents: z.number().int().min(0).optional().describe("Price ceiling in US cents."),
        includeOwned: z.boolean().optional().describe("Also list products the person owns (default false)."),
        limit: z.number().int().min(1).max(20).optional().describe("How many (default 8)."),
      },
      annotations: READ,
    },
    proxy("recommend"),
  );

  server.registerTool(
    "list_library",
    {
      title: "What the person owns",
      description: "Every product the person owns: the product card, their tier, its files (id, name, bytes, sha256, edition), whether a zip is available, and the latest update. File ids go to download_to_folder or get_download_links.",
      inputSchema: {},
      annotations: READ,
    },
    proxy("list_library"),
  );

  server.registerTool(
    "get_download_links",
    {
      title: "Download links",
      description: "Download URLs for files the person owns, each with its name, size and sha256, valid for 10 minutes; no cookie needed (curl -L works). Narrow with fileIds or an edition; zip: true adds one link for the whole product. To put files into the project, download_to_folder does the download and the checksum for you.",
      inputSchema: {
        slug: z.string(),
        fileIds: z.array(z.string()).optional().describe("Only these files (ids from list_library)."),
        edition: edition.optional(),
        zip: z.boolean().optional().describe("Also a link to the whole product as one zip."),
      },
      annotations: READ,
    },
    proxy("get_download_links"),
  );

  server.registerTool(
    "create_buy_link",
    {
      title: "A link to buy",
      description: "A link to a review page on the store where the person sees each item (picture, licence, price), anything they already own, and the total, and pays in the checkout themselves. Only when the person asked to buy or agreed to it; building the link charges nothing and buys nothing. Give them the URL, and never say something was bought.",
      inputSchema: {
        items: z
          .array(z.object({ slug: z.string(), tier: tier.optional().describe("standard (default), personal or commercial: see the licence in get_product.") }))
          .min(1)
          .max(20),
        ref: z.string().optional().describe("Where the link came from, for the store's counts (default agent)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    proxy("create_buy_link"),
  );

  server.registerTool(
    "report_problem",
    {
      title: "Report a problem",
      description: "Tell Kadal about a product the person has: a mistake (a typo, a wrong date, a missing page, a broken file), a question, or an idea. Say where with fileName and page (PDFs, from 1) or timeSeconds (audio and video). The note is private to the person and Kadal, and its replies show in list_my_notes. Report only what you checked, in plain words, once per problem, and tell the person you filed it.",
      inputSchema: {
        slug: z.string(),
        fileName: z.string().optional().describe("The file the problem is in, as list_library names it."),
        page: z.number().int().min(1).optional().describe("The PDF page, counting from 1."),
        timeSeconds: z.number().min(0).optional().describe("Seconds into the audio or video."),
        kind: z.enum(NOTE_KINDS as [string, ...string[]]),
        body: z.string().min(1).max(4000).describe("What is wrong and where, in plain words."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    proxy("report_problem"),
  );

  server.registerTool(
    "list_my_notes",
    {
      title: "The person's notes",
      description: "The person's notes (reports) on products, with each one's status (open, accepted, declined, duplicate, fixed), a plain status line, and the thread with Kadal's replies.",
      inputSchema: { status: z.enum(NOTE_STATUSES as [string, ...string[]]).optional() },
      annotations: READ,
    },
    proxy("list_my_notes"),
  );

  // ── local helpers ──────────────────────────────────────────────────────────────────────────

  const inside = (path: string) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  };
  const place = (dir: string | undefined, fallback: string): string | CallToolResult => {
    const target = resolve(root, dir ?? fallback);
    if (!o.allowOutside && !inside(target))
      return fail(`${target} is outside the project (${root}); give a folder inside it (the server was not started with --allow-outside).`);
    return target;
  };

  server.registerTool(
    "project_summary",
    {
      title: "Summarise this project",
      description: "A short summary of a project folder, without its contents: name and description from package.json / pyproject.toml / Cargo.toml, dependency names, tools it uses (Godot, Blender, Next.js, Obsidian…), the README's headings, file-type counts and the top-level names. It is what `kadal-store recommend --from` sends. Pass its `text` to recommend as context. Reads nothing else and sends nothing anywhere.",
      inputSchema: { dir: z.string().optional().describe("A folder, relative to the project (default: the project itself).") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ dir }: { dir?: string }) => {
      const target = place(dir, ".");
      if (typeof target !== "string") return target;
      try {
        const s = await summariseProject(target);
        return ok(s as unknown as Record<string, unknown>, s.text);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "download_to_folder",
    {
      title: "Download into the project",
      description: "Download files the person owns into the project, each checked against its sha256; files already there with the same checksum are skipped. dir is relative to the project (default kadal-store/<slug>). Narrow with fileNames or fileIds (from list_library) or an edition, or zip: true for the whole product as one zip. Returns where every file went.",
      inputSchema: {
        slug: z.string(),
        dir: z.string().optional().describe("Folder relative to the project, e.g. 'assets/sfx'. Default kadal-store/<slug>."),
        fileNames: z.array(z.string()).optional().describe("Only these files, by name."),
        fileIds: z.array(z.string()).optional().describe("Only these files, by id."),
        edition: edition.optional(),
        zip: z.boolean().optional().describe("The whole product as one zip instead of its files."),
        overwrite: z.boolean().optional().describe("Download again even when the same file is already there."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (a: {
      slug: string;
      dir?: string;
      fileNames?: string[];
      fileIds?: string[];
      edition?: Record<string, string>;
      zip?: boolean;
      overwrite?: boolean;
    }) => {
      const target = place(a.dir, `kadal-store/${a.slug}`);
      if (typeof target !== "string") return target;
      try {
        const r = await fetchProduct(
          store,
          {
            slug: a.slug,
            dir: target,
            fileIds: a.fileIds,
            fileNames: a.fileNames,
            edition: a.edition,
            zip: a.zip,
            force: a.overwrite,
          },
          { fetch: o.fetch, log: (line) => console.error(line) },
        );
        const lines = r.zip
          ? [`Saved ${relative(root, r.zip.path)}`]
          : r.files.map((f) => `${f.status === "downloaded" ? "saved" : f.status === "skipped" ? "already there" : "FAILED"}: ${relative(root, f.path)}${f.error ? ` (${f.error})` : ""}`);
        const result = ok(r as unknown as Record<string, unknown>, lines.join("\n"));
        return r.counts.failed ? { ...result, isError: true } : result;
      } catch (e) {
        if (e instanceof AuthError) return fail(`${e.message} ${SIGNED_OUT_HINT}`);
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return {
    server,
    store,
    close: async () => {
      await store.close();
    },
  };
}

/** The operator's tools, only for a sign-in that holds `store:ops`. */
export function addOperatorTools(server: McpServer, store: Store): void {
  const proxy = (name: string) => async (args: Record<string, unknown>) => {
    try {
      return await store.raw(name, defined(args ?? {}));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
  server.registerTool(
    "feedback_queue",
    {
      title: "Feedback queue (operator)",
      description: "Operator only: every person's notes, filtered by status, kind, shelf or planned wave, with counts per status.",
      inputSchema: {
        status: z.enum(NOTE_STATUSES as [string, ...string[]]).optional(),
        kind: z.enum(NOTE_KINDS as [string, ...string[]]).optional(),
        shelf: z.string().optional(),
        wave: z.string().optional().describe("A planned wave, e.g. wave-4."),
        limit: z.number().int().min(1).optional(),
      },
      annotations: READ,
    },
    proxy("feedback_queue"),
  );
  server.registerTool(
    "triage_note",
    {
      title: "Triage a note (operator)",
      description: "Operator only: accept (with the wave it is planned for), decline, mark duplicate (of another note), reopen, or mark fixed, with an optional reply the author is emailed. Each call writes to the note's thread; do it once per decision, and only as the operator asked.",
      inputSchema: {
        id: z.string(),
        decision: z.enum(["accept", "decline", "duplicate", "reopen", "fixed"]),
        reply: z.string().optional(),
        wave: z.string().optional(),
        duplicateOf: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    proxy("triage_note"),
  );
}

export async function serveStdio(o: McpOptions): Promise<void> {
  // stdout is the protocol from here on.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  const { server, store, close } = createServer(o);
  const session = await loadSession(o.host, o.env ?? process.env).catch(() => null);
  if (session?.scope.split(" ").includes("store:ops")) addOperatorTools(server, store);
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await close();
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  transport.onclose = () => void shutdown();
  await server.connect(transport);
  console.error(
    `kadal-store mcp ${o.version ?? ""}: ${hostLabel(o.host)}, project ${resolve(o.root)}${session ? "" : " (not signed in: run kadal-store login)"}`,
  );
  // Stay up until the client disconnects.
  await new Promise<void>(() => {});
}

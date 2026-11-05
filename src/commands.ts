import { createInterface } from "node:readline";
import { relative, resolve, sep } from "node:path";

import { UsageError, bool, num, str, type Parsed } from "./args.ts";
import { clearSession, loadSession, saveSession } from "./config.ts";
import { editionFrom } from "./editions.ts";
import { type ProductReport, countOutcomes, fetchProduct } from "./fetch-product.ts";
import { AuthError, hostLabel, signedOut } from "./host.ts";
import { DEFAULT_SCOPE, login, revokeSession } from "./oauth.ts";
import * as render from "./render.ts";
import { Auth } from "./session.ts";
import { Store } from "./store.ts";
import { CONTEXT_LIMIT, clip, summariseProject } from "./summarise.ts";
import { planSync, transfer } from "./transfer.ts";
import {
  type BuyLink,
  type DownloadLinks,
  type Library,
  type MyNotes,
  NOTE_KINDS,
  NOTE_STATUSES,
  type NoteKind,
  type ProductDetail,
  type Recommendations,
  type ReportResult,
  type SearchResult,
  type Shelves,
  TIERS,
  type Tier,
  type WhoAmI,
} from "./types.ts";

/**
 * The commands. Each one is a tool call (or two) and a rendering: `--json` prints the tool's
 * structuredContent exactly, so an agent driving the CLI sees what an agent on the hosted MCP
 * server sees. Local work (downloads, sync, the project summary, login) has its own documented
 * shapes, listed in the README.
 */

export interface Runtime {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** stdout, one line or JSON document per call. */
  out: (text: string) => void;
  /** stderr. */
  err: (text: string) => void;
  open: (url: string) => void;
  fetch: typeof fetch;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  version: string;
}

export interface Io {
  json: boolean;
  /** People-facing lines: stdout, or stderr in --json mode (stdout is the one JSON document). */
  say: (line: string) => void;
  emit: (data: unknown) => void;
}

export interface Ctx {
  rt: Runtime;
  io: Io;
  host: string;
  flags: Parsed["flags"];
  args: string[];
}

export const EXIT = { ok: 0, failed: 1, usage: 2, auth: 3, checksum: 4 } as const;

const storeFor = (c: Ctx) =>
  new Store(c.host, new Auth(c.host, c.rt.env, c.rt.fetch), c.rt.version);

/** Run against the store, and always close the client (its socket would keep Node alive). */
async function withStore<T>(c: Ctx, fn: (s: Store) => Promise<T>): Promise<T> {
  const store = storeFor(c);
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

const say = (c: Ctx, lines: string[]) => lines.forEach((l) => c.io.say(l));

/** `--max 20` is twenty dollars; the tools take integer cents. */
function centsFrom(v: unknown, flag = "--max"): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  if (n < 0) throw new UsageError(`${flag} takes a price in dollars, like 20 or 4.99`);
  return Math.round(n * 100);
}

function intIn(v: unknown, flag: string, min: number, max: number): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < min || n > max)
    throw new UsageError(`${flag} takes a whole number from ${min} to ${max}`);
  return n;
}

function oneOf<T extends string>(v: unknown, flag: string, allowed: readonly T[]): T | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  if (!allowed.includes(s as T))
    throw new UsageError(`${flag} takes ${allowed.join(", ")} (got "${s}")`);
  return s as T;
}

const list = (v: unknown): string[] | undefined => {
  const all = (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return all.length ? all : undefined;
};

/** Drop undefined keys: tools validate their input, and `undefined` is not JSON. */
const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** A yes/no on the terminal. No terminal means no one to ask: that is a usage error, not a yes. */
async function confirm(c: Ctx, question: string, otherwise: string): Promise<boolean> {
  if (!c.rt.stdin.isTTY) throw new UsageError(otherwise);
  const rl = createInterface({ input: c.rt.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((done) => rl.question(`${question} [y/N] `, done));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ── account ────────────────────────────────────────────────────────────────────────────────

export async function loginCommand(c: Ctx): Promise<number> {
  // Lines typed into the terminal can finish a sign-in whose browser is on another machine.
  const rl = c.rt.stdin.isTTY ? createInterface({ input: c.rt.stdin, terminal: false }) : null;
  let session;
  try {
    session = await login({
      host: c.host,
      scope: str(c.flags.scope) ?? DEFAULT_SCOPE,
      fetch: c.rt.fetch,
      open: c.flags.open === false ? null : c.rt.open,
      log: c.io.say,
      lines: rl ?? undefined,
      version: c.rt.version,
    });
  } finally {
    rl?.close();
  }
  let path = await saveSession(session, c.rt.env);
  // Who it is for, so the sign-in says so (and whoami works offline from the file later).
  const me = await withStore(c, (s) => s.call<WhoAmI>("whoami")).catch(() => null);
  if (me) path = await saveSession({ ...session, user: me.user }, c.rt.env);
  if (c.io.json)
    c.io.emit({
      ok: true,
      host: c.host,
      user: me?.user ?? null,
      scopes: me?.scopes ?? session.scope.split(" "),
      operator: me?.operator ?? false,
      config: path,
    });
  else
    c.io.say(
      `Signed in${me ? ` as ${me.user.name ? `${me.user.name} <${me.user.email}>` : me.user.email}` : ""} on ${hostLabel(c.host)}. Saved to ${path}`,
    );
  return EXIT.ok;
}

export async function logoutCommand(c: Ctx): Promise<number> {
  const session = await loadSession(c.host, c.rt.env);
  const revoked = session ? await revokeSession(session, c.rt.fetch) : false;
  const signedOutNow = await clearSession(c.host, c.rt.env);
  if (c.io.json) c.io.emit({ ok: true, host: c.host, signedOut: signedOutNow, revoked });
  else if (!signedOutNow) c.io.say(`Not signed in to ${hostLabel(c.host)}.`);
  else
    c.io.say(
      revoked
        ? `Signed out of ${hostLabel(c.host)} and revoked this machine's access.`
        : `Signed out on this machine. The store could not be told, so remove "Kadal Store CLI" under Account → Settings → Connected apps.`,
    );
  return EXIT.ok;
}

export async function whoamiCommand(c: Ctx): Promise<number> {
  if (!(await loadSession(c.host, c.rt.env))) throw new AuthError(signedOut(c.host));
  const me = await withStore(c, (s) => s.call<WhoAmI>("whoami"));
  if (c.io.json) c.io.emit(me);
  else say(c, render.whoamiText(me, c.host));
  return EXIT.ok;
}

// ── the catalogue ──────────────────────────────────────────────────────────────────────────

export async function shelvesCommand(c: Ctx): Promise<number> {
  const r = await withStore(c, (s) => s.call<Shelves>("list_shelves"));
  if (c.io.json) c.io.emit(r);
  else say(c, render.shelvesText(r));
  return EXIT.ok;
}

export function searchArgs(c: Pick<Ctx, "flags" | "args">): Record<string, unknown> {
  const f = c.flags;
  return defined({
    query: c.args.join(" ").trim() || undefined,
    shelf: str(f.shelf),
    style: str(f.style),
    topic: str(f.topic),
    format: str(f.format),
    kind: oneOf(f.kind, "--kind", ["asset", "pack"] as const),
    maxCents: centsFrom(f.max),
    sort: oneOf(f.sort, "--sort", ["relevance", "newest", "price"] as const),
    limit: intIn(f.limit, "--limit", 1, 50),
    cursor: str(f.cursor),
  });
}

export async function searchCommand(c: Ctx): Promise<number> {
  const args = searchArgs(c);
  const r = await withStore(c, (s) => s.call<SearchResult>("search_products", args));
  if (c.io.json) c.io.emit(r);
  else say(c, render.searchText(r, `kadal-store search ${c.args.join(" ")}`.trim()));
  return EXIT.ok;
}

export async function showCommand(c: Ctx): Promise<number> {
  const slug = c.args[0];
  if (!slug) throw new UsageError("show needs a product slug: kadal-store show <slug>");
  const r = await withStore(c, (s) => s.call<{ product: ProductDetail }>("get_product", { slug }));
  if (c.io.json) c.io.emit(r);
  else say(c, render.productText(r.product));
  return EXIT.ok;
}

export async function recommendCommand(c: Ctx): Promise<number> {
  const words = c.args.join(" ").trim();
  const from = str(c.flags.from);
  if (!words && !from)
    throw new UsageError(
      'recommend needs a few words ("a cosy pixel-art farming game"), --from <dir>, or both',
    );
  let context = words;
  if (from) {
    const summary = await summariseProject(resolve(c.rt.cwd, from));
    // The person sees exactly what leaves the machine, before it does.
    c.rt.err(`This summary of ${summary.dir} will be sent to ${hostLabel(c.host)}:`);
    c.rt.err("");
    for (const line of summary.text.split("\n")) c.rt.err(`  ${line}`);
    c.rt.err("");
    const otherwise =
      "Nothing was sent. Add --yes to send this summary (there is no terminal to ask).";
    if (c.flags.yes !== true && !(await confirm(c, "Send it?", otherwise))) {
      c.io.say("Nothing was sent.");
      return EXIT.ok;
    }
    context = [words, summary.text].filter(Boolean).join("\n\n");
  }
  const args = defined({
    context: clip(context, CONTEXT_LIMIT),
    shelves: list(c.flags.shelf),
    formats: list(c.flags.format),
    maxCents: centsFrom(c.flags.max),
    includeOwned: bool(c.flags["include-owned"]),
    limit: intIn(c.flags.limit, "--limit", 1, 20),
  });
  const r = await withStore(c, (s) => s.call<Recommendations>("recommend", args));
  if (c.io.json) c.io.emit(r);
  else say(c, render.recommendText(r));
  return EXIT.ok;
}

// ── what you own ───────────────────────────────────────────────────────────────────────────

export async function libraryCommand(c: Ctx): Promise<number> {
  const r = await withStore(c, (s) => s.call<Library>("list_library"));
  if (c.io.json) c.io.emit(r);
  else say(c, render.libraryText(r.items));
  return EXIT.ok;
}

/** A path as the person would type it: relative to where they ran the command, when inside it. */
const shown = (c: Ctx, path: string): string => {
  const rel = relative(c.rt.cwd, path);
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? rel : path;
};
/** Per-file progress lines, with the working folder taken off the front of each path. */
const progress = (c: Ctx) => (line: string) => c.io.say(line.split(c.rt.cwd + sep).join(""));

const concurrencyOf = (c: Ctx) => intIn(c.flags.concurrency, "--concurrency", 1, 16) ?? 4;

/** 4 when a file failed its checksum (the store's bytes are wrong, or something in between), 1 for any other failure. */
const transferExit = (files: { status: string; checksum?: boolean }[]) =>
  files.some((f) => f.checksum)
    ? EXIT.checksum
    : files.some((f) => f.status === "failed")
      ? EXIT.failed
      : EXIT.ok;

export async function downloadCommand(c: Ctx): Promise<number> {
  const slug = c.args[0];
  if (!slug)
    throw new UsageError(
      "download needs a product slug: kadal-store download <slug>  (kadal-store library lists yours)",
    );
  if (c.args.length > 1)
    throw new UsageError(
      `download takes one product; got ${c.args.join(", ")}. For everything, use sync.`,
    );
  const dir = resolve(c.rt.cwd, str(c.flags.out) ?? slug);
  const edition = editionFrom(c.flags);
  const zip = c.flags.zip === true;
  const fileNames = list(c.flags.file);
  if (zip && (fileNames || edition))
    throw new UsageError("--zip is the whole product; leave out --file and the edition flags");
  c.io.say(`Downloading ${slug} into ${shown(c, dir)}`);
  const report: ProductReport = await withStore(c, (s) =>
    fetchProduct(
      s,
      {
        slug,
        dir,
        fileNames,
        edition,
        zip,
        force: c.flags.force === true,
        concurrency: concurrencyOf(c),
      },
      { fetch: c.rt.fetch, log: progress(c) },
    ),
  );
  if (c.io.json) c.io.emit(report);
  else
    c.io.say(
      report.zip
        ? `Done: ${shown(c, report.zip.path)}`
        : `Done: ${report.counts.downloaded} downloaded, ${report.counts.skipped} already here${report.counts.failed ? `, ${report.counts.failed} failed` : ""}.`,
    );
  return transferExit(report.files);
}

export async function syncCommand(c: Ctx): Promise<number> {
  if (c.args.length > 1) throw new UsageError("sync takes one folder");
  const dir = resolve(c.rt.cwd, c.args[0] ?? "kadal-store");
  const edition = editionFrom(c.flags);
  const only = list(c.flags.product);
  const dry = c.flags["dry-run"] === true;
  const result = await withStore(c, async (s) => {
    const library = await s.call<Library>("list_library");
    const plan = await planSync(library, dir, { edition, only });
    c.io.say(
      `${library.items.length} product${library.items.length === 1 ? "" : "s"} · ${plan.skip.length} file${plan.skip.length === 1 ? "" : "s"} already in ${shown(c, dir)} · ${plan.download.length} to download${dry ? " (dry run)" : ""}`,
    );
    const skipped = plan.skip.map((p) => ({ ...p, status: "skipped" as const }));
    if (dry)
      return [...skipped, ...plan.download.map((p) => ({ ...p, status: "planned" as const }))];
    const fetched = await transfer(
      plan.download,
      (slug, fileIds) => s.call<DownloadLinks>("get_download_links", { slug, fileIds }),
      { concurrency: concurrencyOf(c), fetch: c.rt.fetch, log: progress(c) },
    );
    return [...skipped, ...fetched];
  });
  const counts = countOutcomes(result);
  if (c.io.json) c.io.emit({ dir, dryRun: dry, files: result, counts });
  else if (!dry)
    c.io.say(
      `Done: ${counts.downloaded} downloaded, ${counts.skipped} already here${counts.failed ? `, ${counts.failed} failed` : ""}.`,
    );
  else for (const f of result) if (f.status === "planned") c.io.say(`  + ${shown(c, f.path)}`);
  return transferExit(result);
}

// ── buying, problems ───────────────────────────────────────────────────────────────────────

export function buyItems(words: string[]): { slug: string; tier?: Tier }[] {
  if (!words.length)
    throw new UsageError("buy needs at least one product: kadal-store buy <slug[:tier]>…");
  if (words.length > 20) throw new UsageError("buy takes at most 20 products at a time");
  return words.map((w) => {
    const [slug, tier, extra] = w.split(":");
    if (!slug || extra !== undefined) throw new UsageError(`"${w}" is not slug or slug:tier`);
    if (tier === undefined || tier === "") return { slug };
    if (!TIERS.includes(tier as Tier))
      throw new UsageError(`"${tier}" is not a tier; use ${TIERS.join(", ")}`);
    return { slug, tier: tier as Tier };
  });
}

export async function buyCommand(c: Ctx): Promise<number> {
  const items = buyItems(c.args);
  const r = await withStore(c, (s) =>
    s.call<BuyLink>("create_buy_link", { items, ref: str(c.flags.ref) ?? "cli" }),
  );
  if (c.io.json) c.io.emit(r);
  else say(c, render.buyText(r));
  if (c.flags.open === true) c.rt.open(r.url);
  return EXIT.ok;
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export async function reportArgs(c: Ctx): Promise<Record<string, unknown>> {
  const [slug, ...words] = c.args;
  if (!slug)
    throw new UsageError(
      'report needs a product: kadal-store report <slug> --kind mistake "what is wrong"',
    );
  const kind = oneOf(c.flags.kind, "--kind", NOTE_KINDS);
  if (!kind) throw new UsageError(`report needs --kind: ${NOTE_KINDS.join(", ")}`);
  let body = words.join(" ").trim();
  if (body === "-") body = (await readStdin(c.rt.stdin)).trim();
  if (!body)
    throw new UsageError(
      "report needs the words: what is wrong, where (or - to read them from stdin)",
    );
  if (body.length > 4000)
    throw new UsageError(`a report is at most 4000 characters (this one is ${body.length})`);
  const page = intIn(c.flags.page, "--page", 1, 100_000);
  const at = num(c.flags.at);
  if (page !== undefined && at !== undefined)
    throw new UsageError("--page is for a PDF, --at for audio or video: one or the other");
  if (at !== undefined && at < 0)
    throw new UsageError("--at takes seconds from the start, like 12.5");
  return defined({
    slug,
    fileName: str(c.flags.file),
    page,
    timeSeconds: at,
    kind: kind as NoteKind,
    body,
  });
}

export async function reportCommand(c: Ctx): Promise<number> {
  const args = await reportArgs(c);
  const r = await withStore(c, (s) => s.call<ReportResult>("report_problem", args));
  if (c.io.json) c.io.emit(r);
  else
    say(c, [
      `Thanks. Your note is ${r.note.status}: ${r.note.url}`,
      "Only you and Kadal can see it. Replies show up in `kadal-store notes`.",
    ]);
  return EXIT.ok;
}

export async function notesCommand(c: Ctx): Promise<number> {
  const status = oneOf(c.flags.status, "--status", NOTE_STATUSES);
  const r = await withStore(c, (s) => s.call<MyNotes>("list_my_notes", defined({ status })));
  if (c.io.json) c.io.emit(r);
  else say(c, render.notesText(r.notes));
  return EXIT.ok;
}

export async function mcpCommand(c: Ctx): Promise<number> {
  const { serveStdio } = await import("./mcp.ts");
  await serveStdio({
    host: c.host,
    root: resolve(c.rt.cwd, str(c.flags.dir) ?? "."),
    allowOutside: c.flags["allow-outside"] === true,
    env: c.rt.env,
    fetch: c.rt.fetch,
    version: c.rt.version,
  });
  return EXIT.ok;
}

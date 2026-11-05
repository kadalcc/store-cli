/**
 * kadal-store — the Kadal Store (store.kadal.cc) from a terminal or an AI agent (bin: ./bin.ts).
 *
 *   kadal-store login | logout | whoami      OAuth sign-in in the browser; the token stays here
 *   kadal-store shelves | search | show       the catalogue
 *   kadal-store recommend [words] [--from .]  products for the project in front of you
 *   kadal-store library | download | sync     what you own, into a folder, checked by sha256
 *   kadal-store buy <slug>…                   a link to review and pay (nothing is charged here)
 *   kadal-store report | notes                problems in files you own, and our replies
 *   kadal-store mcp                           the same tools as a stdio MCP server
 *
 * The contract with the store is apps/store-worker/docs/agents.md in the Kadal monorepo: every
 * command is a call to one of the hosted MCP server's tools, and `--json` prints its answer as
 * it is. Exit codes: 0 ok · 1 failed · 2 usage · 3 not signed in · 4 a download failed its
 * checksum. KADAL_STORE_HOST (or --host) points the CLI at another store, e.g. a local worker.
 */
import { readFileSync } from "node:fs";

import { type FlagSpecs, UsageError, parseArgs, str } from "./args.ts";
import * as cmd from "./commands.ts";
import { EXIT, type Ctx, type Io, type Runtime } from "./commands.ts";
import { AuthError, ChecksumError, HostError, ToolError, hostFrom } from "./host.ts";
import { openBrowser } from "./open.ts";

export { EXIT, type Runtime } from "./commands.ts";
export { configPath, loadSession, saveSession, type Session } from "./config.ts";
export { editionFrom, matchesEdition } from "./editions.ts";
export { DEFAULT_HOST, normaliseHost } from "./host.ts";
export { login, refreshSession, discover, pkcePair, clientIdFor } from "./oauth.ts";
export { summariseProject, type ProjectSummary } from "./summarise.ts";
export { planSync } from "./transfer.ts";
export type * from "./types.ts";

export const HELP = `kadal-store <command> [options]

  login       sign in to the store in your browser; the token is saved on this machine only
              --no-open  print the sign-in address instead of opening a browser
              --scope "<scopes>"  (default "store:read store:write"; the operator adds store:ops)
  logout      sign this machine out and revoke its access
  whoami      who this machine is signed in as, and what it may do
  shelves     the store's shelves, with how many products each holds
  search      search <words…>  find products   --shelf <slug> --style <s> --topic <t> --format <f>
              --kind asset|pack  --max <dollars>  --sort relevance|newest|price
              --limit <1-50> (20)  --cursor <c> (the next page)
  show        show <slug>  one product: prices, licence, files, editions, pack contents, updates
  recommend   recommend [words…]  products for what you are working on
              --from <dir>  summarise that project and send the summary, never its files: the
              README's headings, package.json's name, description and dependency names, a count of
              file types, the top-level names. You see it before it goes (--yes: don't ask)
              --shelf <slug>… --format <f>… --max <dollars> --include-owned --limit <1-20> (8)
  library     everything you own, with its files
  download    download <slug>  one product's files into a folder (default ./<slug>)
              --file <name>…  only those files   -o, --out <dir>  where they go
              --year 2027 --week sun|mon --lang en|ja|en-ja --size a4|a5|letter…  one edition
              --zip  the whole product as one zip   --force  download files that are already here
              --concurrency <n> (4). Every file is checked against its sha256 before it is kept;
              an interrupted download picks up where it stopped
  sync        sync [dir]  every file you own into dir (default ./kadal-store), one folder per
              product; files whose sha256 already matches are skipped, nothing is deleted
              --product <slug>…  only those   --year --week --lang --size  one edition
              --dry-run  say what would come down   --concurrency <n> (4)
  buy         buy <slug[:tier]>…  a link to a page where you review the items and pay; nothing is
              charged until you pay in the checkout there   --open  open it in your browser
              tiers: standard (default), personal, commercial (see the licence in show)
  report      report <slug> --kind mistake|question|idea "what is wrong"  tell Kadal about a
              problem in a product   --file <name>  --page <n> (PDF) | --at <seconds> (audio, video)
              Use - instead of the words to read them from stdin
  notes       your notes and Kadal's replies   --status open|accepted|declined|duplicate|fixed
  mcp         a Model Context Protocol server on stdio for AI agents: the store's tools with this
              machine's sign-in, plus project_summary and download_to_folder
              --dir <path>  the project downloads go into (default: where it starts)
              --allow-outside  let it read and write outside that folder

Global: --json prints one JSON object on stdout (a tool's answer, as the store sent it) ·
--host <url> another store (or KADAL_STORE_HOST), e.g. http://localhost:8861 · --help · --version
Exit codes: 0 ok, 1 failed, 2 usage, 3 not signed in, 4 a download failed its checksum.

Docs: https://github.com/kadalcc/store-cli#readme`;

const hasHelp = (command: string) => HELP.includes(`\n  ${command} `);

/** One command's part of HELP, with the global options: what `<command> --help` prints. */
export function commandHelp(command: string): string {
  const lines = HELP.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`  ${command} `));
  if (start < 0) return HELP;
  let end = start + 1;
  // A command's own lines are indented past the two spaces each command name starts at.
  while (end < lines.length && /^ {3,}\S/.test(lines[end]!)) end++;
  return `kadal-store ${command} [options]\n\n${lines.slice(start, end).join("\n")}\n\n${HELP.slice(HELP.indexOf("Global:"))}`;
}

const GLOBAL: FlagSpecs = {
  json: { kind: "boolean" },
  host: { kind: "string" },
  help: { kind: "boolean", short: "h" },
};

const EDITION_FLAGS: FlagSpecs = {
  year: { kind: "string" },
  week: { kind: "string" },
  lang: { kind: "string" },
  size: { kind: "string" },
};

export const COMMAND_FLAGS: Record<string, FlagSpecs> = {
  login: { scope: { kind: "string" }, open: { kind: "boolean" } },
  logout: {},
  whoami: {},
  shelves: {},
  search: {
    shelf: { kind: "string" },
    style: { kind: "string" },
    topic: { kind: "string" },
    format: { kind: "string" },
    kind: { kind: "string" },
    max: { kind: "number" },
    sort: { kind: "string" },
    limit: { kind: "number" },
    cursor: { kind: "string" },
  },
  show: {},
  recommend: {
    from: { kind: "string" },
    yes: { kind: "boolean", short: "y" },
    shelf: { kind: "string", multiple: true },
    format: { kind: "string", multiple: true },
    max: { kind: "number" },
    "include-owned": { kind: "boolean" },
    limit: { kind: "number" },
  },
  library: {},
  download: {
    file: { kind: "string", multiple: true },
    out: { kind: "string", short: "o" },
    zip: { kind: "boolean" },
    force: { kind: "boolean" },
    concurrency: { kind: "number" },
    ...EDITION_FLAGS,
  },
  sync: {
    product: { kind: "string", multiple: true },
    "dry-run": { kind: "boolean" },
    concurrency: { kind: "number" },
    ...EDITION_FLAGS,
  },
  buy: { open: { kind: "boolean" }, ref: { kind: "string" } },
  report: {
    kind: { kind: "string" },
    file: { kind: "string" },
    page: { kind: "number" },
    at: { kind: "number" },
  },
  notes: { status: { kind: "string" } },
  mcp: { dir: { kind: "string", short: "C" }, "allow-outside": { kind: "boolean" } },
};

const RUN: Record<string, (c: Ctx) => Promise<number>> = {
  login: cmd.loginCommand,
  logout: cmd.logoutCommand,
  whoami: cmd.whoamiCommand,
  shelves: cmd.shelvesCommand,
  search: cmd.searchCommand,
  show: cmd.showCommand,
  recommend: cmd.recommendCommand,
  library: cmd.libraryCommand,
  download: cmd.downloadCommand,
  sync: cmd.syncCommand,
  buy: cmd.buyCommand,
  report: cmd.reportCommand,
  notes: cmd.notesCommand,
  mcp: cmd.mcpCommand,
};

/** Global options may come before the command (`kadal-store --json library`); move them after it. */
function commandFirst(argv: string[]): string[] {
  const lead: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    const takesValue = a === "--host" && argv[i + 1] !== undefined;
    if (!takesValue && a !== "--json" && !a.startsWith("--host=") && !a.startsWith("--json="))
      break;
    const n = takesValue ? 2 : 1;
    lead.push(...argv.slice(i, i + n));
    i += n;
  }
  return lead.length && i < argv.length ? [argv[i]!, ...lead, ...argv.slice(i + 1)] : argv;
}

export function ownVersion(): string {
  try {
    // dist/index.js and src/index.ts both sit one folder below package.json.
    const url = new URL("../package.json", import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export function defaultRuntime(): Runtime {
  return {
    env: process.env,
    cwd: process.cwd(),
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
    open: openBrowser,
    fetch: globalThis.fetch,
    stdin: process.stdin,
    version: ownVersion(),
  };
}

export async function main(argv: string[], runtime: Partial<Runtime> = {}): Promise<number> {
  const rt: Runtime = { ...defaultRuntime(), ...runtime };
  const [command, ...rest] = commandFirst(argv);
  const json = rest.includes("--json") || rest.includes("--json=true");
  const io: Io = {
    json,
    say: (line) => (json ? rt.err(line) : rt.out(line)),
    emit: (data) => rt.out(JSON.stringify(data, null, 2)),
  };

  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        // `help <command>` is that command's part.
        io.say(rest[0] && !rest[0].startsWith("-") ? commandHelp(rest[0]) : HELP);
        return EXIT.ok;
      case "--version":
      case "-v":
      case "version":
        if (json) io.emit({ version: rt.version });
        else io.say(rt.version);
        return EXIT.ok;
    }
    const run = RUN[command];
    const specs = COMMAND_FLAGS[command];
    if (!run || !specs) throw new UsageError(`Unknown command: ${command}`);
    const { flags, positionals } = parseArgs(rest, { ...GLOBAL, ...specs });
    if (flags.help) {
      io.say(commandHelp(command));
      return EXIT.ok;
    }
    const host = hostFrom(rt.env, str(flags.host));
    return await run({ rt, io, host, flags, args: positionals });
  } catch (e) {
    const code =
      e instanceof UsageError
        ? EXIT.usage
        : e instanceof AuthError
          ? EXIT.auth
          : e instanceof ChecksumError
            ? EXIT.checksum
            : EXIT.failed;
    const message = e instanceof Error ? e.message : String(e);
    if (json)
      io.emit({
        ok: false,
        error: {
          code:
            e instanceof HostError
              ? e.code
              : e instanceof ToolError
                ? "tool_error"
                : code === EXIT.usage
                  ? "usage"
                  : code === EXIT.auth
                    ? "unauthorized"
                    : code === EXIT.checksum
                      ? "checksum"
                      : "failed",
          message,
          exitCode: code,
        },
      });
    else
      rt.err(
        `error: ${message}${code === EXIT.usage ? `\n\nRun \`kadal-store ${command && hasHelp(command) ? `${command} ` : ""}--help\` for usage.` : ""}`,
      );
    return code;
  }
}

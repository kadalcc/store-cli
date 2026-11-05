<h1 align="center">Kadal Store CLI</h1>

<h3 align="center">Your store library, in your terminal and your AI agent.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@kadal/store"><img alt="npm version" src="https://img.shields.io/npm/v/@kadal/store?color=0e7490&label=%40kadal%2Fstore"></a>
  <a href="https://github.com/kadalcc/store-cli/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kadalcc/store-cli/ci.yml?branch=main&label=CI"></a>
  <a href="LICENSE"><img alt="Licence: AGPL-3.0-or-later" src="https://img.shields.io/badge/licence-AGPL--3.0--or--later-0e7490"></a>
  <a href="https://github.com/sponsors/pmithunish"><img alt="Sponsor" src="https://img.shields.io/badge/sponsor-%E2%99%A5-db61a2?logo=githubsponsors&logoColor=white"></a>
</p>

[The Kadal Store](https://store.kadal.cc) sells digital downloads: planners and printables, sound
effects and music, shaders, 3D models, textures, icons and templates. `@kadal/store` brings it to
where you work. Search the store, get suggestions for the project you are in, download and sync
what you own, and get a link to buy the rest. It works the same for you in a terminal and for the
AI agent you already use (Claude, Cursor, Codex, any MCP client), on your own account and your own
model subscription.

An agent can find things, download what you own and hand you a link. It can never buy: payment
always happens on the store's checkout page, in front of you.

```sh
npx -y @kadal/store login                      # once: approve in your browser
npx -y @kadal/store recommend --from .         # what fits the project you are in
npx -y @kadal/store download retro-ui-sfx -o assets/sfx
```

Or install it: `npm i -g @kadal/store`, then `kadal-store <command>`. Node 20 or newer.

## Sign in

```text
$ kadal-store login
Opening your browser to sign in to store.kadal.cc. If it does not open, visit:
  https://store.kadal.cc/authorize?response_type=code&client_id=…
Signed in as Ana <ana@example.com> on store.kadal.cc. Saved to ~/.config/kadal/store.json
```

You sign in on the store's own page, so your password never passes through the CLI. The token is
saved in `~/.config/kadal/store.json` (`$XDG_CONFIG_HOME` is respected; `%APPDATA%\kadal\` on
Windows), readable only by you, and renews itself. On a machine without a browser, use
`--no-open`, open the address anywhere, and paste the address the browser lands on back into the
terminal. `kadal-store logout` signs this machine out and revokes its access; so does removing
"Kadal Store CLI" under **Account → Settings → Connected apps**.

## Commands

### Find

```text
$ kadal-store search planner --max 10
Techo weekly planner 2027  Planners  owned (personal)    techo-weekly-2027
A5 monthly undated         Planners  from $4.00          monthly-undated-a5

2 of 2. Details: kadal-store show <slug>
```

- `search <words…>` with `--shelf <slug>`, `--style`, `--topic`, `--format`, `--kind asset|pack`,
  `--max <dollars>`, `--sort relevance|newest|price`, `--limit <1-50>`, `--cursor <next page>`.
- `shelves` lists the store's shelves (use a slug with `--shelf`).
- `show <slug>`: prices per licence tier, the licence (what each tier allows and doesn't), the
  files with their sizes and editions, what a pack holds, and its updates.

### Suggestions for your project

```text
$ kadal-store recommend "ui sounds" --from .
This summary of /home/ana/cosy-farm will be sent to store.kadal.cc:

  Project: cosy-farm — A cosy farming game
  Built with: Phaser
  Dependencies: phaser
  README sections: Cosy Farm · Art style
  File types: .png 412, .ts 88, .wav 31
  Top level: assets/, src/, package.json, README.md

Send it? [y/N] y
Retro UI sound effects  Sound effects  from $9.00   retro-ui-sfx
    Matches "ui" and "sounds", and your .wav files.
```

`--from <dir>` reads only the README's headings, package.json's (or pyproject.toml's, Cargo.toml's)
name, description and dependency names, a count of file types, and the top-level names. It never
reads or sends what is inside your files, and you see the exact text before it goes. `--yes`
skips the question. Also `--shelf`, `--format` (both repeatable), `--max <dollars>`,
`--include-owned`, `--limit <1-20>`.

### What you own

```text
$ kadal-store library
Techo weekly planner 2027  (personal)  3 files, 39 KB  techo-weekly-2027
Retro UI sound effects  (standard)  2 files, 12 KB  retro-ui-sfx

$ kadal-store download techo-weekly-2027 --year 2027 --size a5 -o planner
Downloading techo-weekly-2027 into planner
  ✓ planner/techo-weekly_2027_mon_en_a5.pdf
  ✓ planner/READ ME.txt
Done: 2 downloaded, 0 already here.

$ kadal-store sync ~/Kadal
2 products · 5 files already in /home/ana/Kadal · 0 to download
Done: 0 downloaded, 5 already here.
```

- `download <slug>` puts one product's files in `./<slug>` (or `-o <dir>`). `--file <name>`
  (repeatable) picks files; `--year 2027 --week sun|mon --lang en|ja|en-ja --size a4|a5|letter…`
  picks one edition of a product sold in editions; `--zip` gets the whole product as one zip.
- `sync [dir]` mirrors everything you own into `dir` (default `./kadal-store`), one folder per
  product. Files already there with the same sha256 are skipped; nothing is ever deleted.
  `--product <slug>` (repeatable), the edition flags, and `--dry-run`.
- Every file is checked against the sha256 the store gives before it is kept. A download that is
  cut off leaves a `.kadal-part` file, and the next run picks up where it stopped. Downloads run
  four at a time (`--concurrency <n>`).

### Buy

```text
$ kadal-store buy fern-pack techo-weekly-2027:personal
Review and pay here:
  https://store.kadal.cc/buy?items=fern-pack:standard,techo-weekly-2027:personal&ref=cli

  Fern textures pack                        standard    $12.00
  Techo weekly planner 2027                 personal    $9.00  (you already own this)
  Total                                                 $12.00

Nothing is charged until you pay in the checkout on that page.
```

`buy <slug[:tier]>…` (tiers: `standard`, the default, `personal`, `commercial`) builds a page where
you see each item, its licence and price, and anything you already own. `--open` opens it.

### Tell us about a problem

```text
$ kadal-store report techo-weekly-2027 --kind mistake --file techo-weekly_2027_mon_en_a5.pdf --page 12 "March 31 is missing"
Thanks. Your note is open: https://store.kadal.cc/account/notes/note_…
Only you and Kadal can see it. Replies show up in `kadal-store notes`.

$ kadal-store notes
  Techo weekly planner 2027 · mistake · techo-weekly_2027_mon_en_a5.pdf  [Accepted for the 7 Nov update]  note_…
    March 31 is missing
    Kadal: Thanks, fixed in the next update.
```

`--kind mistake|question|idea`; `--page <n>` for a PDF, `--at <seconds>` for audio or video. Use
`-` in place of the words to read them from stdin. When a fix ships, the product's update shows in
your library and the next `download` or `sync` gets it.

### Everything else

`whoami`, `logout`, `--help` (and `<command> --help`), `--version`.

## For scripts and agents

- `--json` on any command prints one JSON document on stdout; everything meant for people goes to
  stderr. For the store's commands it is the store tool's answer exactly as the store sent it
  (shapes in [the contract](#the-contract)). `download` prints
  `{slug, dir, files: [{fileId, name, path, bytes, sha256, status, resumed?, error?}], zip, counts}`,
  `sync` prints `{dir, dryRun, files, counts}`, `login` prints `{ok, host, user, scopes, operator,
  config}`, `logout` prints `{ok, host, signedOut, revoked}`. Errors are
  `{ok: false, error: {code, message, exitCode}}`.
- Exit codes: `0` ok, `1` failed (the message says why), `2` usage, `3` not signed in (or the
  sign-in expired: run `kadal-store login`), `4` a download failed its checksum (nothing was kept).
- `--host <url>` or `KADAL_STORE_HOST` points at another store, such as a local worker
  (`--host http://localhost:8861`). Each host keeps its own sign-in.

## Connect your agent

**Claude Code, with the skill and the MCP server together:**

```text
/plugin marketplace add kadalcc/store-cli
/plugin install kadal-store@kadal-store
```

**The local MCP server alone** (it uses the sign-in from `kadal-store login`):

```sh
claude mcp add kadal-store -- npx -y @kadal/store mcp
```

For Claude Desktop, Cursor, VS Code and others, point the client at `npx -y @kadal/store mcp`:

```json
{ "mcpServers": { "kadal-store": { "command": "npx", "args": ["-y", "@kadal/store", "mcp"] } } }
```

**The hosted MCP server**, for clients that sign in themselves (OAuth) and need nothing installed:

```sh
claude mcp add --transport http kadal-store https://store.kadal.cc/mcp
```

**The skill alone**, for any agent that reads Agent Skills: `npx skills add kadalcc/store-cli`
([skills/kadal-store](skills/kadal-store/SKILL.md)). It teaches the agent to find assets for the
project in front of it, download into it, never buy on its own, and report problems it finds in
files you bought.

| MCP tools | |
| --- | --- |
| `search_products`, `get_product`, `list_shelves`, `recommend` | the catalogue, the licence of each product, suggestions from a description of the work |
| `list_library`, `get_download_links` | what you own, and ten-minute download links with each file's sha256 |
| `create_buy_link` | a review page to pay on yourself; it charges nothing |
| `report_problem`, `list_my_notes` | a note about a file you own, and Kadal's replies |
| `whoami` | who is signed in, with which scopes |
| `project_summary` (local) | what `recommend --from` sends: the folder described without its contents |
| `download_to_folder` (local) | files you own into the project, checked by sha256, skipping what is there; only inside the folder the server started in unless it was started with `--allow-outside` |

`kadal-store mcp --dir <path>` serves another folder as the project.

## The contract

Every command is one call to a tool of the store's hosted MCP server (`POST
https://store.kadal.cc/mcp`, Streamable HTTP, OAuth 2.1 with PKCE). The tools, their inputs and
their outputs are specified in the store's `apps/store-worker/docs/agents.md`; the types are in
[`src/types.ts`](src/types.ts). Money is always integer US cents; URLs are absolute.

## Development

```sh
bun install && bun run build && bun run test
bun test/fake-store.ts 8899 &                      # a fake store, no account needed
node dist/bin.js login --host http://127.0.0.1:8899
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Licence

[AGPL-3.0-or-later](LICENSE), like the [Kadal Deck](https://github.com/kadalcc/deck) engine.
Security reports: [SECURITY.md](SECURITY.md).

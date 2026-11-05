---
name: kadal-store
description: Find, download and report problems with digital assets from the Kadal Store (store.kadal.cc) — planners, printables, sound effects, music, shaders, 3D models, textures, icons and templates — with the person's own store account. Use when the user wants assets for the project they are in, mentions the Kadal Store, store.kadal.cc or kadal-store, asks what they own or to download or sync it, wants a link to buy something, or found a mistake in a file they bought.
license: AGPL-3.0-or-later
compatibility: Node 20+ (npx -y @kadal/store). The person signs in once with `kadal-store login`, which opens their browser.
metadata:
  homepage: https://store.kadal.cc
  repository: https://github.com/kadalcc/store-cli
---

# Kadal Store

The `kadal-store` CLI (`npx -y @kadal/store <command>`) and, when connected, the `kadal-store` MCP
server act as the person, with their own store sign-in. Add `--json` to any command for its data
on stdout (people-facing lines go to stderr). The MCP tools have the same names as the data:
`search_products`, `get_product`, `recommend`, `list_library`, `download_to_folder`,
`create_buy_link`, `report_problem`, `list_my_notes`, `project_summary`.

## Signed out

Exit code 3 (or a tool error saying "Not signed in") means the person has not signed in on this
machine. Ask them to run `npx -y @kadal/store login` themselves: it opens the store's page in their
browser to approve. Never try to sign in, enter credentials, or approve anything for them.

## Find assets for the current project

1. Understand what the project needs (art style, formats, engine, page size, licence) from the
   conversation and the code you have seen.
2. `kadal-store recommend "<what it needs>" --from . --json` scores the store against a summary
   of the folder: names, dependency names, README headings, a count of file types. It never sends
   file contents. The first time, run it without `--yes`: it prints the summary on stderr and
   stops (exit 2). Show the person what would be sent, and add `--yes` once they agree.
   MCP: `project_summary`, then `recommend` with its `text` (plus the need) as `context`.
3. Or search directly: `kadal-store search "retro ui sounds" --format wav --max 20 --json`
   (`--max` is dollars; prices in the data are US cents).
4. Read the best few with `kadal-store show <slug> --json` (MCP `get_product`): the files, the
   editions, and the licence. Check the licence tier fits the use (commercial work needs a tier
   that allows it) before you suggest anything.
5. Suggest a short list with your own reasons. `owned` on a product means they already have it.

## Use what they own

- `kadal-store library --json` (MCP `list_library`): every product they own, with its files.
- Put files into the project where they belong:
  `kadal-store download <slug> -o assets/sfx` (MCP `download_to_folder` with `dir`). Narrow with
  `--file <name>` or an edition: `--year 2027 --week mon --lang en --size a5`. `--zip` gets the
  whole product as one zip. Every file is checked against its sha256; files already there are
  skipped. Exit 4 means a file failed its checksum and was not kept: run it again once, and report
  it if it repeats.
- `kadal-store sync <dir>` mirrors everything they own, one folder per product. Use it only when
  asked; it can be large.
- Mind the licence when you move files into a project that will be published or sold.

## Buying: never on your own

- Never buy, never say something was bought, never open a checkout for the person.
- When they ask for something they do not own, or agree to it, make a review link:
  `kadal-store buy <slug>[:tier] … --json` (MCP `create_buy_link`), and give them the URL. It
  shows each item, its licence and price, and anything they already own. Nothing is charged until
  they pay in the checkout on that page themselves.
- Tiers: `standard` (default), `personal`, `commercial`. Pick the one the licence says the use
  needs, and say why.

## Report problems in files they bought

When a file they own has a mistake (a typo, a wrong date, a missing page, a broken file):

1. Check it yourself first (open the PDF page, play the clip, load the model).
2. `kadal-store report <slug> --kind mistake --file "<file name>" --page 12 "March 31 is missing"`
   (`--at 12.5` for seconds into audio or video; MCP `report_problem`). Kinds: `mistake`,
   `question`, `idea`. One report per problem, in plain words: what is wrong and where.
3. Tell the person you filed it, and give them the note's link. Only they and Kadal see it.
   `kadal-store notes` (MCP `list_my_notes`) shows its status and Kadal's replies; fixed files
   arrive as updates in their library, so a later `download` or `sync` picks them up.

## Reference

| exit | meaning |
| --- | --- |
| 0 | done |
| 1 | failed (the store's message says why: not owned, not found…) |
| 2 | usage: a flag or value is wrong; `kadal-store <command> --help` |
| 3 | not signed in, or the sign-in expired: ask the person to run `kadal-store login` |
| 4 | a download failed its checksum (nothing was kept) |

`--host <url>` (or `KADAL_STORE_HOST`) points at another store, such as a local one at
`http://localhost:8861`.

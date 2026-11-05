# Working on the Kadal Store CLI

This repository is `@kadal/store` (AGPL-3.0-or-later): the `kadal-store` CLI and its local MCP
server. Using the store from an agent rather than changing the CLI? Read
`skills/kadal-store/SKILL.md` instead.

## Commands (Bun 1.3+, Node 20+)

```sh
bun install
bun run build        # dist/ (tsdown, one file per source file)
bun run typecheck
bun run test         # bun test: unit tests and the end-to-end run against test/fake-store.ts
bun run lint         # oxlint
node tools/smoke.mjs # the built CLI under Node against the fake store: login → download → buy
bun test/fake-store.ts 8899   # a fake store to try commands against (--host http://127.0.0.1:8899)
```

## Map

| path | |
| --- | --- |
| `src/index.ts` | `main`, the help text, flags per command, exit codes, `--json` errors |
| `src/commands.ts` | one function per command: a tool call and its rendering |
| `src/oauth.ts` | discovery, PKCE, the loopback listener, the client ID document / registration, refresh, revoke |
| `src/session.ts`, `src/config.ts` | the saved sign-in per host (0600), refresh before expiry and on a 401 |
| `src/store.ts` | the MCP client (Streamable HTTP) over the authenticated fetch |
| `src/download.ts`, `src/transfer.ts`, `src/fetch-product.ts` | `.kadal-part` files, Range resume, sha256, the sync plan |
| `src/summarise.ts` | `recommend --from`: a contents-free summary of a project |
| `src/mcp.ts` | `kadal-store mcp`: the store's tools proxied, plus `project_summary` and `download_to_folder` |
| `skills/kadal-store` | the Agent Skill |
| `.claude-plugin/marketplace.json` | makes this repo a Claude Code plugin marketplace (the skill + the MCP server) |

## Rules

- The contract with the store is `apps/store-worker/docs/agents.md` in the Kadal monorepo. A tool's
  name, input or output changes there and here together, or not at all. `--json` prints a tool's
  `structuredContent` unchanged.
- The CLI must stay quick to start: the MCP SDK and zod load only in the commands that call the
  store (`store.ts` imports the client lazily; `mcp.ts` is imported by `kadal-store mcp` alone).
- In `--json` mode and in the MCP server, stdout carries only the protocol; people-facing lines go
  to stderr.
- Nothing from a project's files leaves the machine. `summarise.ts` reads manifests' names and
  descriptions, dependency names, README headings and file names, and nothing else.
- Never write outside the folder a download was pointed at: file names from the store go through
  `safeFileName`.
- `package.json` must survive `npm pkg fix` unchanged (CI checks it; npm 11 drops `bin` paths that
  start with `./`).
- Every user-facing change gets a changeset (`bun run changeset`).

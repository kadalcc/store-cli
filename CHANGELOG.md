# @kadal/store

## 0.1.2

### Patch Changes

- caba37e: `download` and `sync` take `--color <hex>` for recolourable illustrations, and the local MCP
  server's `download_to_folder` and `get_download_links` take `color`: the SVGs come in that colour
  as `<name>-<rrggbb>.svg`, each checked against the store's sha256 for the recoloured file, and a
  product that can't be recoloured is refused. The `More:` line under `search` now repeats your
  filters, so it pages through the same search. The help, the skill and the README say what `buy`
  does without a tier: each item comes with the cheapest licence on sale.
- 6ef0542: A new README, which is also the npm page: pictures of the store, an agent and the terminal, a grid
  of products from the store, a "Start in 30 seconds" section, setup for Claude, Claude Code, ChatGPT,
  Cursor, VS Code and Codex, what `recommend --from` sends, and why an agent can never pay. Every
  example uses real products from the store.

## 0.1.1

### Patch Changes

- 8acd6a1: The package names itself `cc.kadal/store` (`mcpName`), so the official MCP Registry lists this local
  server beside the hosted one at `https://store.kadal.cc/mcp`. The README links both, and the
  step-by-step setup for each app.

## 0.1.0

The first release: the Kadal Store from your terminal and your AI agent.

- **Sign in** with `kadal-store login`: the store's own sign-in page in your browser (OAuth with
  PKCE), and a token that stays on this machine and renews itself.
- **Find**: `search`, `show`, `shelves`, and `recommend`, which can read a short summary of the
  project you are in (`--from .`) and never its files.
- **Use what you own**: `library`, `download` (one product, one edition, or a zip) and `sync`
  (everything, one folder per product). Every file is checked against its sha256, and an
  interrupted download picks up where it stopped.
- **Buy** with `buy`, which gives you a page to review and pay on; nothing is charged until you
  pay there.
- **Tell us** about a problem with `report`, and read the replies with `notes`.
- **`kadal-store mcp`**, a local MCP server with the same tools for any agent, plus
  `project_summary` and `download_to_folder`; and the `kadal-store` Agent Skill and Claude Code
  plugin.

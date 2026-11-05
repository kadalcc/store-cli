# Licensing

Two kinds of licence meet when you use the Kadal Store CLI. They cover different things.

## The CLI: AGPL-3.0-or-later

The code in this repository (`@kadal/store`: the `kadal-store` CLI, its local MCP server and the
Agent Skill) is free software under the **GNU Affero General Public License, version 3 or later**.
The full text is in [`LICENSE`](./LICENSE). You may use it, change it and build on it, for
anything, including commercially.

Running it triggers nothing: in a terminal, in a script, or as the MCP server your agent talks to.
The one obligation that matters in practice is AGPL §13: if you run a **modified** version as a
network service for other people, they must be able to get your modified source.

The packages it installs beside it keep their own licences; they are listed in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## What you download: the store's licences

The files the CLI downloads are products from the [Kadal Store](https://store.kadal.cc). The AGPL
says nothing about them. Each comes under the licence you bought it with, on the store's terms:

- **Standard**, on printables, art and icons, and wallpapers: use it, print it, and sell work made
  with it.
- **Personal** or **Commercial**, on the other shelves: personal is for things you make for
  yourself, not for money; commercial covers client work, products you sell and anything
  monetised.

None of them lets you resell or share the files themselves. `kadal-store show <slug>` prints what
each tier allows and doesn't, and so does every product page. The full terms are at
[store.kadal.cc/licence](https://store.kadal.cc/licence/).

## Contributions

Contributions are accepted under the AGPL. A short Contributor Licence Agreement will be added
before the first outside pull request is merged (see [CONTRIBUTING.md](./CONTRIBUTING.md)).

Questions about any of this: **hello@kadal.cc**.

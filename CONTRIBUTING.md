# Contributing to the Kadal Store CLI

Thanks for helping. A bug report with the command you ran, its `--json` output and the exit code
is the most useful thing you can send; pull requests are welcome too.

## Setup

You need [Bun](https://bun.sh) 1.3+ (the package manager and test runner) and Node 20+ (what the
published CLI runs on).

```sh
git clone https://github.com/kadalcc/store-cli && cd store-cli
bun install
bun run build
bun run typecheck
bun run test
```

Try a command without an account, against the fake store the tests use:

```sh
bun test/fake-store.ts 8899 &
node dist/bin.js login --host http://127.0.0.1:8899   # approves at once
node dist/bin.js library --host http://127.0.0.1:8899
```

Against a local store worker (`wrangler dev` in the Kadal monorepo), pass its address instead:
`--host http://localhost:8861`, or set `KADAL_STORE_HOST`.

## Tests

- `bun run test`: the argument parsing, edition flags, the sync plan, token refresh and the
  project summary, then the CLI end to end against `test/fake-store.ts`: a real OAuth round trip
  through the loopback listener, real MCP calls, real downloads (resume, checksum failure, an
  expired link), and the stdio server's tools through the SDK's own client.
- `node tools/smoke.mjs`: the built `dist/bin.js` under Node, the way `npx` runs it.

## Changes and releases

- Keep pull requests focused, with a test where the behaviour can be tested.
- Add a changeset (`bun run changeset`) describing the change for users; releases are cut from
  `main` by the release workflow, which publishes to npm with provenance.
- Format and lint: `bun run format`, `bun run lint`.

## Licence of contributions

The CLI is AGPL-3.0-or-later. Before the first outside pull request is merged, a short
Contributor Licence Agreement will be added and linked from the pull request template. Until
then, please open an issue first for anything larger than a fix.

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

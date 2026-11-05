# Security

Please report vulnerabilities privately to **support@kadal.cc** with "Kadal Store CLI security" in
the subject, rather than in a public issue. Include what is affected (the CLI, the local MCP
server, or the store at store.kadal.cc), how to reproduce it, and its impact.

You'll get an acknowledgement within three working days and a plan within ten. Fixes ship as a
patch release with a changelog entry crediting you, unless you'd rather not be named.

Supported versions: the latest minor release of `@kadal/store`.

## What the CLI keeps, and where

- Your sign-in: an access token (one hour) and a refresh token, in `~/.config/kadal/store.json`
  (`$XDG_CONFIG_HOME/kadal/store.json`; `%APPDATA%\kadal\store.json` on Windows), readable only by
  you (mode 0600, in a 0700 folder). No password ever passes through the CLI: you sign in on the
  store's own page.
- `kadal-store logout` revokes the token at the store and deletes it here. You can also remove
  "Kadal Store CLI" under **Account → Settings → Connected apps** on store.kadal.cc at any time.
- The CLI talks to the store over https only; plain http is refused for anything but a store on
  this machine (`--host http://localhost:…`).
- `recommend --from` sends a short summary of a folder (names, dependency names, README headings,
  a count of file types), never the contents of a file, and shows it to you first.

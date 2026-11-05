---
"@kadal/store": patch
---

`download` and `sync` take `--color <hex>` for recolourable illustrations, and the local MCP
server's `download_to_folder` and `get_download_links` take `color`: the SVGs come in that colour
as `<name>-<rrggbb>.svg`, each checked against the store's sha256 for the recoloured file, and a
product that can't be recoloured is refused. The `More:` line under `search` now repeats your
filters, so it pages through the same search. The help, the skill and the README say what `buy`
does without a tier: each item comes with the cheapest licence on sale.

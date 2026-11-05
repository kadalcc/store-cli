import { defineConfig } from "tsdown";

/**
 * One file in dist/ per file in src/ (unbundled), so the commands that load the MCP SDK lazily
 * keep doing so and `kadal-store --help` starts without it. Every bare import stays external:
 * npm installs the SDK and zod next to us. Target Node 20, the oldest `npx -y @kadal/store` runs on.
 */
export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts" },
  format: "esm",
  platform: "node",
  target: "node20",
  unbundle: true,
  dts: true,
  clean: true,
  fixedExtension: false,
  deps: { neverBundle: [/^[^./]/] },
});

#!/usr/bin/env node
/**
 * Publishes @kadal/store when its current version isn't on npm yet (what `changeset publish`
 * does), in one of three modes, from NPM_PUBLISH_MODE (as in github.com/kadalcc/deck):
 *
 *   direct (default)  `npm publish` — in CI this authenticates through npm trusted publishing
 *   stage             `npm stage publish` — the version waits on npmjs.com (Staged Packages)
 *                     until a maintainer approves it with 2FA
 *   bootstrap         `npm stage publish` only while npm has never seen the package, with an
 *                     ordinary token. Staging creates the package (as a `0.0.0-stage` placeholder),
 *                     which is what a trusted publisher needs before it can be added; reject the
 *                     staged version, add the trusted publisher, then publish directly.
 *
 * Prints `New tag: @kadal/store@<version>`, which changesets/action turns into a git tag. Run
 * after `bun run build`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mode = process.env.NPM_PUBLISH_MODE || "direct";
if (!["direct", "stage", "bootstrap"].includes(mode))
  throw new Error(`NPM_PUBLISH_MODE must be direct, stage or bootstrap, not ${mode}`);

const onNpm = (name, version) => {
  try {
    return (
      execFileSync("npm", ["view", `${name}@${version}`, "version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === version
    );
  } catch {
    return false; // 404: the package or this version doesn't exist yet
  }
};

const exists = (name) => {
  try {
    execFileSync("npm", ["view", name, "name"], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (error) {
    // Only a 404 means "never published"; any other failure must not pass for it.
    if (/E404/.test(String(error.stderr))) return false;
    throw error;
  }
};

const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (onNpm(name, version)) {
  console.log(`${name}@${version} is already on npm`);
  process.exit(0);
}
if (mode === "bootstrap" && exists(name)) {
  console.log(`${name} already exists on npm; nothing to bootstrap`);
  process.exit(0);
}
// Trusted publishing can only publish to a package that already exists, so a package npm has
// never seen waits for a maintainer's first publish (bootstrap) instead of failing the release.
if (mode === "direct" && process.env.CI && !exists(name)) {
  console.warn(
    `::warning::${name} isn't on npm yet; skipped (publish its first version by hand, or bootstrap)`,
  );
  process.exit(0);
}
const argv = mode === "direct" ? ["publish"] : ["stage", "publish"];
console.log(`$ npm ${argv.join(" ")}   (${name}@${version})`);
execFileSync("npm", argv, { cwd: root, stdio: "inherit" });
if (mode !== "bootstrap") {
  const tag = `${name}@${version}`;
  try {
    execFileSync("git", ["tag", tag], { cwd: root, stdio: "ignore" });
  } catch {
    // already tagged (a re-run after a partial failure)
  }
  console.log(`New tag: ${tag}`);
}

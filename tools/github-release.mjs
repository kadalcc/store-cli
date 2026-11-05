#!/usr/bin/env node
/**
 * One GitHub release per version, after tools/publish.mjs has put it on npm: the tag
 * `v<version>`, titled "Kadal Store CLI <version>", with the changelog entry for that version.
 * The package tag (`@kadal/store@<version>`) stays too, because changesets reads it.
 *
 * The notes come from `## <version>` in CHANGELOG.md (written by `changeset version`). Running it
 * twice does nothing the second time.
 *
 *   GITHUB_SHA  the commit to tag; defaults to the commit of `@kadal/store@<version>`
 *   GH_TOKEN    for `gh` (the workflow's GITHUB_TOKEN, with contents: write)
 *
 * Locally: `git fetch --tags && node tools/github-release.mjs` (with `gh` signed in).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const run = (cmd, args, opts = {}) =>
  (execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts }) ?? "").trim();

const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = `v${version}`;
const packageTag = `${name}@${version}`;

// changesets/action does not push the package tag with createGithubReleases off, so it goes up here.
if (run("git", ["tag", "--list", packageTag]))
  run("git", ["push", "origin", `refs/tags/${packageTag}`], { stdio: "inherit" });

try {
  run("gh", ["release", "view", tag], { stdio: ["ignore", "pipe", "ignore"] });
  console.log(`${tag} is already released`);
  process.exit(0);
} catch {
  // not released yet
}

const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n");
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
const notes =
  start === -1
    ? "See the [changelog](https://github.com/kadalcc/store-cli/blob/main/CHANGELOG.md)."
    : lines
        .slice(start + 1, end === -1 ? undefined : end)
        .join("\n")
        .trim();

const body = `${notes}

[\`${packageTag}\`](https://www.npmjs.com/package/${name}/v/${version}), published from [release.yml](https://github.com/kadalcc/store-cli/actions/workflows/release.yml) through npm trusted publishing, with provenance.

\`\`\`sh
npx -y ${name}@${version} login
claude mcp add kadal-store -- npx -y ${name} mcp
\`\`\`
`;

// The tag goes up with git, not with `gh release create --target`: GitHub refuses to create a ref
// through the API on a commit that touches .github/workflows unless the token has the `workflow`
// scope, which a git push of the tag doesn't need.
if (!run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
  const target = process.env.GITHUB_SHA || run("git", ["rev-list", "-n", "1", packageTag]);
  run("git", ["tag", "--force", tag, target]);
  run("git", ["push", "origin", `refs/tags/${tag}`], { stdio: "inherit" });
}
const file = join(mkdtempSync(join(tmpdir(), "store-cli-release-")), "notes.md");
writeFileSync(file, body);
const args = ["release", "create", tag, "--verify-tag", "--title", `Kadal Store CLI ${version}`];
args.push("--notes-file", file, version.includes("-") ? "--prerelease" : "--latest");
run("gh", args, { stdio: "inherit" });
console.log(`Released ${tag}`);

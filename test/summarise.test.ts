import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readmeHeadings, summariseProject } from "../src/summarise.ts";
import { tempDir } from "./helpers.ts";

function project(): string {
  const dir = tempDir("kadal-store-project-");
  const put = (path: string, text = "") => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put(
    "package.json",
    JSON.stringify({
      name: "cosy-farm",
      description: "A cosy pixel-art farming game",
      keywords: ["farming", "pixel art"],
      scripts: { deploy: "SECRET_SCRIPT" },
      dependencies: { phaser: "^3.80.0", howler: "^2.2.4" },
      devDependencies: { vite: "^6.0.0" },
    }),
  );
  put(
    "README.md",
    [
      "# Cosy Farm",
      "The paragraph text is private: PARAGRAPH_SECRET.",
      "## Getting [started](docs/start.md)",
      "```sh",
      "# not a heading, a shell comment",
      "```",
      "### Art **style** ###",
    ].join("\n"),
  );
  put("src/main.ts", "const apiKey = 'FILE_SECRET';");
  put("src/scenes/farm.ts");
  put("assets/sprites/cow.png");
  put("assets/sprites/pig.png");
  put("assets/sfx/moo.wav");
  put("art/farm.blend");
  put(".obsidian/app.json");
  put(".env", "TOKEN=DOTENV_SECRET");
  put("node_modules/phaser/index.js");
  put("node_modules/phaser/huge.png");
  symlinkSync("/", join(dir, "root-link"));
  return dir;
}

describe("summariseProject", () => {
  test("names, dependencies, tools, headings, file types, top level", async () => {
    const dir = project();
    const s = await summariseProject(dir);
    expect(s).toMatchObject({
      dir,
      name: "cosy-farm",
      description: "A cosy pixel-art farming game",
      keywords: ["farming", "pixel art"],
      dependencies: ["howler", "phaser", "vite"],
      frameworks: ["Blender", "Obsidian vault", "Phaser", "Vite", "howler.js"],
      readmeHeadings: ["Cosy Farm", "Getting started", "Art style"],
    });
    expect(s.fileTypes).toEqual([
      { ext: ".png", count: 2 },
      { ext: ".ts", count: 2 },
      { ext: ".blend", count: 1 },
      { ext: ".json", count: 1 },
      { ext: ".md", count: 1 },
      { ext: ".wav", count: 1 },
    ]);
    expect(s.files).toEqual(["art/", "assets/", "src/", "package.json", "README.md", "root-link"]);
    expect(s.text).toContain("Project: cosy-farm — A cosy pixel-art farming game");
    expect(s.text).toContain("README sections: Cosy Farm · Getting started · Art style");
  });

  test("never sends contents, secrets, scripts or the absolute path", async () => {
    const dir = project();
    const s = await summariseProject(dir);
    for (const secret of [
      "SECRET_SCRIPT",
      "PARAGRAPH_SECRET",
      "FILE_SECRET",
      "DOTENV_SECRET",
      "shell comment",
      dir,
      ".env",
    ])
      expect(s.text).not.toContain(secret);
    // node_modules is not walked: its png is not in the census.
    expect(s.scanned).toBe(8);
  });

  test("a bare folder still says something, and the text stays under the tool's limit", async () => {
    const dir = tempDir("bare-");
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `${"x".repeat(150)}-${i}.txt`), "");
    const s = await summariseProject(dir);
    expect(s.name).toBeNull();
    expect(s.text.length).toBeLessThanOrEqual(6000);
    expect(s.text).toStartWith("Project: bare-");
    await expect(summariseProject(join(dir, "nope"))).rejects.toThrow(/not a folder/);
  });

  test("python and rust manifests", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\nname = "sfx-tool"\ndescription = "Batch-normalise sound effects"\ndependencies = ["pydub>=0.25", "numpy"]\n',
    );
    writeFileSync(join(dir, "requirements.txt"), "streamlit==1.40\n# comment\n");
    const s = await summariseProject(dir);
    expect(s.name).toBe("sfx-tool");
    expect(s.description).toBe("Batch-normalise sound effects");
    expect(s.dependencies).toEqual(["numpy", "pydub", "streamlit"]);
    expect(s.frameworks).toEqual(["Python", "Streamlit"]);
  });

  test("readmeHeadings caps and cleans", () => {
    expect(readmeHeadings("# <img src=x> Title\n## ![logo](x.png) Two\n#nope")).toEqual([
      "Title",
      "Two",
    ]);
    expect(
      readmeHeadings(Array.from({ length: 40 }, (_, i) => `## H${i}`).join("\n")),
    ).toHaveLength(25);
  });
});

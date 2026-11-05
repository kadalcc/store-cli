import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `recommend --from <dir>`: what the project is, in a few lines, without its contents
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The store's `recommend` scores products against words, so it needs words about the project:
 * its name and description, what it is built with, what its README is about, and what kind of
 * files it is made of. It never needs the files. So this reads only:
 *
 *   - package.json / pyproject.toml / Cargo.toml / go.mod: name, description, keywords, and the
 *     NAMES of dependencies (never versions, scripts, or anything else in them);
 *   - the README's headings (not its paragraphs);
 *   - file names, to count extensions and spot tools (project.godot, *.blend, .obsidian/), and
 *     the top-level entries as a hint of the layout.
 *
 * Folders that are build output, dependencies or private (node_modules, .git, dist, any dot
 * folder…) are not walked, symlinks are not followed, and the walk stops at 20 000 entries. The
 * person sees the exact text before it is sent, and it is capped at the tool's 6000 characters.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface ProjectSummary {
  /** Absolute; shown to the person, never sent. */
  dir: string;
  name: string | null;
  description: string | null;
  keywords: string[];
  dependencies: string[];
  frameworks: string[];
  readmeHeadings: string[];
  fileTypes: { ext: string; count: number }[];
  /** Top-level entries; folders end in "/". */
  files: string[];
  /** Files counted. */
  scanned: number;
  /** The walk hit its limit; the census is of the first part. */
  truncated: boolean;
  /** Exactly what `recommend` sends as context. */
  text: string;
}

export const CONTEXT_LIMIT = 6000;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 8;

const SKIP_DIRS = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "venv",
  "env",
  "__pycache__",
  "site-packages",
  "Pods",
  "DerivedData",
  // Unity's generated folders, the size of the project itself.
  "Library",
  "Temp",
  "Logs",
  "obj",
]);

/** Dependency name → what it says about the project. */
const DEP_HINTS: Record<string, string> = {
  next: "Next.js",
  react: "React",
  "react-native": "React Native",
  expo: "Expo",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  astro: "Astro",
  "solid-js": "Solid",
  "@angular/core": "Angular",
  "@builder.io/qwik": "Qwik",
  preact: "Preact",
  vite: "Vite",
  tailwindcss: "Tailwind CSS",
  "@mui/material": "Material UI",
  "lucide-react": "Lucide icons",
  three: "three.js",
  "@react-three/fiber": "React Three Fiber",
  "@babylonjs/core": "Babylon.js",
  phaser: "Phaser",
  "pixi.js": "PixiJS",
  p5: "p5.js",
  gsap: "GSAP",
  motion: "Motion",
  "framer-motion": "Motion",
  d3: "D3",
  tone: "Tone.js",
  howler: "howler.js",
  remotion: "Remotion",
  electron: "Electron",
  "@tauri-apps/api": "Tauri",
  gatsby: "Gatsby",
  "@docusaurus/core": "Docusaurus",
  vitepress: "VitePress",
  "@11ty/eleventy": "Eleventy",
  "@kadal/deck": "Kadal Deck",
  "@slidev/cli": "Slidev",
  "reveal.js": "reveal.js",
  hono: "Hono",
  express: "Express",
  wrangler: "Cloudflare Workers",
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  pygame: "Pygame",
  streamlit: "Streamlit",
  bevy: "Bevy",
  macroquad: "macroquad",
};

/** A file or folder name (exact, or by extension) → the tool it belongs to. */
const NAME_HINTS: Record<string, string> = {
  "project.godot": "Godot",
  "ProjectSettings/": "Unity",
  "Cargo.toml": "Rust",
  "go.mod": "Go",
  "pyproject.toml": "Python",
  "requirements.txt": "Python",
  Gemfile: "Ruby",
  "composer.json": "PHP",
  "pubspec.yaml": "Flutter",
  "build.gradle": "Gradle",
  "build.gradle.kts": "Gradle",
  "deck.mdx": "Kadal Deck",
  "components.json": "shadcn/ui",
  "wrangler.toml": "Cloudflare Workers",
  "wrangler.jsonc": "Cloudflare Workers",
  ".obsidian/": "Obsidian vault",
};

const EXT_HINTS: Record<string, string> = {
  ".uproject": "Unreal Engine",
  ".gd": "Godot",
  ".gdshader": "Godot shaders",
  ".unity": "Unity",
  ".blend": "Blender",
  ".glb": "glTF models",
  ".gltf": "glTF models",
  ".fbx": "FBX models",
  ".usdz": "USDZ models",
  ".glsl": "GLSL shaders",
  ".wgsl": "WGSL shaders",
  ".shader": "shaders",
  ".hlsl": "HLSL shaders",
  ".typ": "Typst",
  ".tex": "LaTeX",
  ".ipynb": "Jupyter",
  ".mdx": "MDX",
  ".xcodeproj": "Xcode",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".prproj": "Premiere Pro",
  ".aep": "After Effects",
  ".drp": "DaVinci Resolve",
  ".fcpbundle": "Final Cut Pro",
  ".als": "Ableton Live",
  ".logicx": "Logic Pro",
  ".flp": "FL Studio",
  ".psd": "Photoshop",
  ".ai": "Illustrator",
  ".fig": "Figma",
  ".sketch": "Sketch",
  ".kra": "Krita",
  ".procreate": "Procreate",
  ".afdesign": "Affinity Designer",
  ".indd": "InDesign",
  ".key": "Keynote",
  ".pptx": "PowerPoint",
  ".goodnotes": "GoodNotes",
};

const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as unknown;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const readText = async (path: string, max = 256 * 1024): Promise<string | null> => {
  try {
    const text = await readFile(path, "utf8");
    return text.slice(0, max);
  } catch {
    return null;
  }
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** `key = "value"` in a TOML table (`[project]`, `[package]`…): enough for a name and a description. */
function tomlValue(toml: string, table: string, key: string): string | null {
  const start = toml.search(new RegExp(`^\\[${table.replace(/\./g, "\\.")}\\]\\s*$`, "m"));
  if (start < 0) return null;
  const rest = toml.slice(start).split(/\n(?=\[)/)[0]!;
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(rest);
  return m ? m[1]! : null;
}

/** Dependency names from TOML: `[dependencies]` keys, or a `dependencies = ["name>=1", …]` array. */
function tomlDeps(toml: string): string[] {
  const out: string[] = [];
  for (const table of ["dependencies", "tool.poetry.dependencies"]) {
    const start = toml.search(new RegExp(`^\\[${table.replace(/\./g, "\\.")}\\]\\s*$`, "m"));
    if (start < 0) continue;
    const body = toml.slice(start).split("\n").slice(1);
    for (const line of body) {
      if (line.startsWith("[")) break;
      const m = /^([A-Za-z0-9_.-]+)\s*=/.exec(line);
      if (m && m[1] !== "python") out.push(m[1]!);
    }
  }
  const arr = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(toml);
  if (arr) for (const m of arr[1]!.matchAll(/"([A-Za-z0-9_.-]+)/g)) out.push(m[1]!);
  return out;
}

/** Markdown headings outside code fences, as plain words. */
export function readmeHeadings(markdown: string, max = 25): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[1]!
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (text) out.push(oneLine(text, 80));
    if (out.length >= max) break;
  }
  return out;
}

const READMES = ["README.md", "readme.md", "Readme.md", "README.markdown", "README.mdx", "README"];

export async function summariseProject(dirInput: string): Promise<ProjectSummary> {
  const dir = resolve(dirInput);
  let top: Dirent[];
  try {
    top = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`${dirInput} is not a folder this can read.`);
  }

  // ── manifests: names and descriptions, dependency names ─────────────────────────────────
  let name: string | null = null;
  let description: string | null = null;
  const keywords: string[] = [];
  const deps = new Set<string>();
  const pkg = await readJson(join(dir, "package.json"));
  if (pkg) {
    if (typeof pkg.name === "string") name = pkg.name;
    if (typeof pkg.description === "string") description = pkg.description;
    keywords.push(...strings(pkg.keywords));
    for (const field of ["dependencies", "devDependencies", "peerDependencies"])
      if (pkg[field] && typeof pkg[field] === "object")
        for (const d of Object.keys(pkg[field] as object)) deps.add(d);
  }
  for (const [file, table] of [
    ["pyproject.toml", "project"],
    ["pyproject.toml", "tool.poetry"],
    ["Cargo.toml", "package"],
  ] as const) {
    const toml = await readText(join(dir, file), 64 * 1024);
    if (!toml) continue;
    name ??= tomlValue(toml, table, "name");
    description ??= tomlValue(toml, table, "description");
    for (const d of tomlDeps(toml)) deps.add(d);
  }
  const gomod = await readText(join(dir, "go.mod"), 16 * 1024);
  if (gomod) name ??= /^module\s+(\S+)/m.exec(gomod)?.[1] ?? null;
  const reqs = await readText(join(dir, "requirements.txt"), 32 * 1024);
  if (reqs)
    for (const line of reqs.split("\n")) {
      const m = /^([A-Za-z0-9_.-]+)/.exec(line.trim());
      if (m) deps.add(m[1]!);
    }

  // ── README headings ──────────────────────────────────────────────────────────────────────
  let headings: string[] = [];
  for (const f of READMES) {
    const text = await readText(join(dir, f));
    if (text !== null) {
      headings = readmeHeadings(text);
      break;
    }
  }

  // ── file census (names only) ─────────────────────────────────────────────────────────────
  const counts = new Map<string, number>();
  const frameworks = new Set<string>();
  for (const d of deps) if (DEP_HINTS[d]) frameworks.add(DEP_HINTS[d]!);
  for (const d of deps) if (d.startsWith("@remotion/")) frameworks.add("Remotion");
  let scanned = 0;
  let entries = 0;
  let truncated = false;
  const queue: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];
  while (queue.length) {
    const { path, depth } = queue.shift()!;
    let list: Dirent[];
    try {
      list = path === dir ? top : await readdir(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      if (++entries > MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const hint = NAME_HINTS[e.isDirectory() ? `${e.name}/` : e.name];
      if (hint) frameworks.add(hint);
      const ext = extname(e.name).toLowerCase();
      // Bundles that are folders on disk (Final Cut libraries, Logic projects, Xcode projects).
      if (EXT_HINTS[ext]) frameworks.add(EXT_HINTS[ext]!);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name) || EXT_HINTS[ext]) continue;
        if (depth + 1 < MAX_DEPTH) queue.push({ path: join(path, e.name), depth: depth + 1 });
        continue;
      }
      if (!e.isFile() || e.name.startsWith(".")) continue;
      scanned++;
      const key = ext || e.name;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (truncated) break;
  }

  const fileTypes = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15)
    .map(([ext, count]) => ({ ext, count }));
  const files = top
    .filter((e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b))
    .slice(0, 20);

  const summary: Omit<ProjectSummary, "text"> = {
    dir,
    name,
    description: description ? oneLine(description, 300) : null,
    keywords: keywords.slice(0, 20).map((k) => oneLine(k, 40)),
    dependencies: [...deps].sort().slice(0, 60),
    frameworks: [...frameworks].sort(),
    readmeHeadings: headings,
    fileTypes,
    files,
    scanned,
    truncated,
  };
  return { ...summary, text: summaryText(summary) };
}

/** The lines `recommend` sends. Never the absolute path: it names the person's home folder. */
export function summaryText(s: Omit<ProjectSummary, "text">): string {
  const lines = [
    `Project: ${s.name ?? basename(s.dir)}${s.description ? ` — ${s.description}` : ""}`,
    s.keywords.length ? `Keywords: ${s.keywords.join(", ")}` : "",
    s.frameworks.length ? `Built with: ${s.frameworks.join(", ")}` : "",
    s.dependencies.length ? `Dependencies: ${s.dependencies.join(", ")}` : "",
    s.readmeHeadings.length ? `README sections: ${s.readmeHeadings.join(" · ")}` : "",
    s.fileTypes.length
      ? `File types: ${s.fileTypes.map((t) => `${t.ext} ${t.count}`).join(", ")}${s.truncated ? " (first 20 000 entries)" : ""}`
      : "",
    s.files.length ? `Top level: ${s.files.join(", ")}` : "",
  ].filter(Boolean);
  return clip(lines.join("\n"), CONTEXT_LIMIT);
}

export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

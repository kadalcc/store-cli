import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { main } from "../src/index.ts";
import { approveInBrowser } from "./fake-store.ts";

const made: string[] = [];

/** Called once after every test file (test/setup.ts, preloaded by bunfig.toml). */
export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A throwaway folder, removed when the run ends; tests never touch the real ~/.config. */
export function tempDir(prefix = "kadal-store-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export interface Run {
  code: number;
  out: string;
  err: string;
  /** stdout parsed, for --json runs. */
  json: <T = Record<string, unknown>>() => T;
}

/** `kadal-store …` in-process, with its own config folder and a browser that approves at once. */
export function cli(config: string, cwd: string) {
  return async (
    argv: string[],
    extra: { stdin?: string; open?: (url: string) => void } = {},
  ): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    const stdin = Readable.from(extra.stdin === undefined ? [] : [extra.stdin]) as Readable & {
      isTTY?: boolean;
    };
    const code = await main(argv, {
      env: { XDG_CONFIG_HOME: config, HOME: config },
      cwd,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      open: extra.open ?? ((url) => void approveInBrowser(url)),
      stdin,
    });
    const text = out.join("\n");
    return { code, out: text, err: err.join("\n"), json: <T>() => JSON.parse(text) as T };
  };
}

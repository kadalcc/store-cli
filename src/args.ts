/**
 * A small, strict argument parser: `--flag value`, `--flag=value`, boolean `--flag` and
 * `--no-flag`, short aliases, positionals, and `--` to stop. Unknown flags are usage errors
 * (exit 2) unless the command passes the rest through. A `forward` flag is checked like ours and
 * then handed on as written.
 *
 * The same parser as `kadal-deck`'s (github.com/kadalcc/deck, packages/deck/src/cli/args.ts), so
 * the two CLIs read flags the same way; no dependency for forty lines of loop.
 */

export class UsageError extends Error {}

export type FlagKind = "string" | "boolean" | "number" | "optional-string";

export interface FlagSpec {
  kind: FlagKind;
  /** One-letter alias, without the dash. */
  short?: string;
  /** May repeat; values collect into an array. */
  multiple?: boolean;
  /** Checked, then kept in `rest` as it was written (with its value), for another program. */
  forward?: boolean;
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface Parsed {
  flags: Record<string, string | number | boolean | string[] | undefined>;
  positionals: string[];
  /** `forward` flags as written, and tokens not understood when `passthrough` is on. */
  rest: string[];
}

export function parseArgs(
  argv: string[],
  specs: FlagSpecs,
  { passthrough = false }: { passthrough?: boolean } = {},
): Parsed {
  const flags: Parsed["flags"] = {};
  const positionals: string[] = [];
  const rest: string[] = [];
  const byShort = new Map(
    Object.entries(specs)
      .filter(([, s]) => s.short)
      .map(([n, s]) => [s.short!, n]),
  );
  const set = (name: string, value: string | number | boolean) => {
    const spec = specs[name]!;
    if (spec.multiple) {
      const list = (flags[name] as string[] | undefined) ?? [];
      list.push(String(value));
      flags[name] = list;
    } else flags[name] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--") {
      (passthrough ? rest : positionals).push(...argv.slice(i + 1));
      break;
    }
    let name: string | null = null;
    let inline: string | undefined;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      inline = eq >= 0 ? tok.slice(eq + 1) : undefined;
    } else if (/^-[a-zA-Z]$/.test(tok)) {
      name = byShort.get(tok.slice(1)) ?? null;
      if (!name) {
        if (passthrough) {
          rest.push(tok);
          continue;
        }
        throw new UsageError(`Unknown option ${tok}`);
      }
    } else {
      positionals.push(tok);
      continue;
    }

    let spec = specs[name];
    if (!spec && name.startsWith("no-") && specs[name.slice(3)]?.kind === "boolean") {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags[name.slice(3)] = false;
      if (specs[name.slice(3)]!.forward) rest.push(tok);
      continue;
    }
    if (!spec) {
      if (passthrough) {
        rest.push(tok);
        // A passthrough flag's value travels with it when it plainly is one.
        const next = argv[i + 1];
        if (inline === undefined && next !== undefined && !next.startsWith("-")) {
          rest.push(next);
          i++;
        }
        continue;
      }
      throw new UsageError(`Unknown option --${name}`);
    }
    if (spec.kind === "boolean") {
      if (inline === undefined) set(name, true);
      else if (/^(true|1|yes)$/i.test(inline)) set(name, true);
      else if (/^(false|0|no)$/i.test(inline)) set(name, false);
      else throw new UsageError(`--${name} is a switch; it takes no value (got "${inline}")`);
      if (spec.forward) rest.push(tok);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !(next.startsWith("-") && next.length > 1 && !/^-\d/.test(next))) {
        value = next;
        i++;
      }
    }
    if (value === undefined) {
      if (spec.kind === "optional-string") {
        set(name, true);
        if (spec.forward) rest.push(tok);
        continue;
      }
      throw new UsageError(`--${name} needs a value`);
    }
    if (spec.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new UsageError(`--${name} needs a number (got "${value}")`);
      set(name, n);
    } else set(name, value);
    if (spec.forward) rest.push(...(inline === undefined ? [tok, value] : [tok]));
  }
  return { flags, positionals, rest };
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
export const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

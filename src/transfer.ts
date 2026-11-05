import { join } from "node:path";

import {
  LinkExpiredError,
  alreadyHave,
  downloadTo,
  pool,
  safeFileName,
  sha256File,
} from "./download.ts";
import { matchesEdition } from "./editions.ts";
import { AuthError, ChecksumError } from "./host.ts";
import type { DownloadLink, DownloadLinks, Edition, Library } from "./types.ts";

/**
 * What `download`, `sync` and the MCP server's `download_to_folder` share: decide which files are
 * already here (same sha256), fetch the rest a few at a time, and report every file's fate.
 */

export interface Planned {
  slug: string;
  fileId: string;
  name: string;
  bytes: number;
  sha256: string;
  path: string;
}

export interface FileOutcome extends Planned {
  status: "downloaded" | "skipped" | "failed" | "planned";
  resumed?: boolean;
  error?: string;
  /** The checksum did not match: the bytes were thrown away (exit 4). */
  checksum?: boolean;
}

export interface SyncPlan {
  download: Planned[];
  skip: Planned[];
}

/**
 * Every owned file under `dir/<product slug>/<file name>`, split into what must come down and
 * what is already here byte for byte. Two files that clean to the same name keep both, the
 * second with its file id, so a sync never overwrites one product file with another.
 */
export async function planSync(
  library: Library,
  dir: string,
  {
    edition,
    only,
    links,
    hash = sha256File,
  }: {
    edition?: Edition;
    only?: string[];
    /** Links already asked for, per product slug: theirs are the names and sha256s that count. */
    links?: Map<string, DownloadLink[]>;
    hash?: (path: string) => Promise<string | null>;
  } = {},
): Promise<SyncPlan> {
  const plan: SyncPlan = { download: [], skip: [] };
  for (const item of library.items) {
    const slug = item.product.slug;
    if (only?.length && !only.includes(slug)) continue;
    const folder = join(dir, safeFileName(slug));
    const used = new Set<string>();
    const linked = new Map(links?.get(slug)?.map((l) => [l.fileId, l]));
    for (const f of item.files) {
      if (!matchesEdition(f.edition, edition)) continue;
      // A recoloured SVG arrives as hero-2f9e44.svg with the recoloured file's sha256.
      const got = linked.get(f.id) ?? f;
      let name = safeFileName(got.name);
      if (used.has(name.toLowerCase())) name = `${safeFileName(f.id)}-${name}`;
      used.add(name.toLowerCase());
      const planned: Planned = {
        slug,
        fileId: f.id,
        name: got.name,
        bytes: got.bytes,
        sha256: got.sha256,
        path: join(folder, name),
      };
      ((await alreadyHave(planned.path, got, hash)) ? plan.skip : plan.download).push(planned);
    }
  }
  return plan;
}

/** Where a product's links land: `dir/<name>`, names cleaned and kept apart as in planSync. */
export function placeLinks(links: DownloadLink[], slug: string, dir: string): Planned[] {
  const used = new Set<string>();
  return links.map((l) => {
    let name = safeFileName(l.name);
    if (used.has(name.toLowerCase())) name = `${safeFileName(l.fileId)}-${name}`;
    used.add(name.toLowerCase());
    return {
      slug,
      fileId: l.fileId,
      name: l.name,
      bytes: l.bytes,
      sha256: l.sha256,
      path: join(dir, name),
    };
  });
}

export type GetLinks = (slug: string, fileIds: string[]) => Promise<DownloadLinks>;

export interface TransferOptions {
  concurrency?: number;
  fetch?: typeof fetch;
  /** One line per finished file (people-facing; stderr in --json mode). */
  log?: (line: string) => void;
  /** Links already in hand (download asked for them up front); the rest are asked for per product. */
  links?: Map<string, DownloadLink>;
}

/**
 * Fetch every planned file. Links are asked for once per product, just before its files start,
 * and asked for again for any file whose link stopped working (they last ten minutes, and a big
 * sync can take longer than that to reach the last product).
 */
export async function transfer(
  files: Planned[],
  getLinks: GetLinks,
  o: TransferOptions = {},
): Promise<FileOutcome[]> {
  const known = new Map(o.links);
  const bySlug = new Map<string, Planned[]>();
  for (const f of files) bySlug.set(f.slug, [...(bySlug.get(f.slug) ?? []), f]);

  /** A new link for one file, after its old one stopped working. */
  const freshLink = async (f: Planned): Promise<DownloadLink> => {
    const { links } = await getLinks(f.slug, [f.fileId]);
    const link = links.find((l) => l.fileId === f.fileId);
    if (!link) throw new Error(`The store gave no download link for ${f.name}.`);
    known.set(f.fileId, link);
    return link;
  };
  const failed = (f: Planned, e: unknown): FileOutcome => ({
    ...f,
    status: "failed",
    error: e instanceof Error ? e.message : String(e),
    ...(e instanceof ChecksumError ? { checksum: true } : {}),
  });

  // Products one after another (each needs its links first), files within a product in parallel.
  const outcomes: FileOutcome[] = [];
  const report = (out: FileOutcome) => {
    o.log?.(
      out.status === "downloaded"
        ? `  ✓ ${out.path}${out.resumed ? " (resumed)" : ""}`
        : `  ✗ ${out.path}: ${out.error}`,
    );
    outcomes.push(out);
  };
  for (const [slug, group] of bySlug) {
    const missing = group.filter((f) => !known.has(f.fileId)).map((f) => f.fileId);
    if (missing.length) {
      try {
        for (const l of (await getLinks(slug, missing)).links) known.set(l.fileId, l);
      } catch (e) {
        // Signed out stops everything; anything else (not owned any more…) fails this product.
        if (e instanceof AuthError) throw e;
        group.forEach((f) => report(failed(f, e)));
        continue;
      }
    }
    const settled = await pool(group, o.concurrency ?? 4, async (f) => {
      const link = known.get(f.fileId) ?? (await freshLink(f));
      try {
        return await downloadTo(link.url, f.path, f, o.fetch);
      } catch (e) {
        if (!(e instanceof LinkExpiredError)) throw e;
        return downloadTo((await freshLink(f)).url, f.path, f, o.fetch);
      }
    });
    settled.forEach((r, i) => {
      const f = group[i]!;
      report(
        r.status === "fulfilled"
          ? {
              ...f,
              status: "downloaded",
              sha256: r.value.sha256,
              bytes: r.value.bytes,
              ...(r.value.resumed ? { resumed: true } : {}),
            }
          : failed(f, r.reason),
      );
    });
  }
  return outcomes;
}

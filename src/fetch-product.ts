import { join } from "node:path";

import { UsageError } from "./args.ts";
import { alreadyHave, downloadTo, safeFileName } from "./download.ts";
import type { Store } from "./store.ts";
import { type FileOutcome, placeLinks, transfer } from "./transfer.ts";
import type { DownloadLinks, Edition, Library } from "./types.ts";

/**
 * One product's files into one folder: what `kadal-store download` and the MCP server's
 * `download_to_folder` both do. The store picks the files (`fileIds`, `edition`, or all of them);
 * names narrow that list here, because the store's tool takes ids and people type names.
 */

export interface ProductRequest {
  slug: string;
  dir: string;
  fileIds?: string[];
  fileNames?: string[];
  edition?: Edition;
  zip?: boolean;
  /** Download even when a file with the same sha256 is already there. */
  force?: boolean;
  concurrency?: number;
  /** A recolourable product's colour, "#rrggbb" (hexColor): its SVGs come in it. */
  color?: string;
}

/**
 * A colour as the store's recolor.ts reads one: "#2F9E44", "2f9e44" or "#2f9" → "#2f9e44", and
 * anything else null. Checked here too, so a typo is a usage error before the store is asked.
 */
export function hexColor(raw: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  const h = m?.[1]?.toLowerCase();
  return h ? `#${h.length === 3 ? [...h].map((ch) => ch + ch).join("") : h}` : null;
}

/** Said by `download`, `sync` and download_to_folder alike, so it names no flag. */
export const notRecolourable = (name: string) =>
  `${name} comes in its own colours and can't be recoloured; leave the colour out. Only recolourable products (the Illustrations shelf) take one.`;

export interface ProductReport {
  slug: string;
  dir: string;
  files: FileOutcome[];
  zip: { path: string; bytes: number; sha256: string } | null;
  counts: { downloaded: number; skipped: number; failed: number };
}

export const countOutcomes = (files: FileOutcome[]) => ({
  downloaded: files.filter((f) => f.status === "downloaded").length,
  skipped: files.filter((f) => f.status === "skipped").length,
  failed: files.filter((f) => f.status === "failed").length,
});

export async function fetchProduct(
  store: Store,
  req: ProductRequest,
  o: { fetch?: typeof fetch; log?: (line: string) => void } = {},
): Promise<ProductReport> {
  // A colour needs a recolourable product, and its SVG links come back under coloured names
  // (hero-2f9e44.svg): the library says whether it is one, and what its files are called.
  const owned = req.color
    ? (await store.call<Library>("list_library")).items.find((i) => i.product.slug === req.slug)
    : undefined;
  if (owned && !owned.recolor) throw new UsageError(notRecolourable(owned.product.name));
  // Every ask for links carries the colour, or a renewed link would bring the file as drawn.
  const tint = req.color ? { color: req.color } : {};
  const args: Record<string, unknown> = { slug: req.slug, ...tint };
  if (req.fileIds?.length) args.fileIds = req.fileIds;
  if (req.edition) args.edition = req.edition;
  if (req.zip) args.zip = true;
  const got = await store.call<DownloadLinks>("get_download_links", args);

  if (req.zip) {
    if (!got.zip)
      throw new UsageError(`${req.slug} has no zip; download its files instead (leave out --zip).`);
    const name = `${safeFileName(req.slug)}${req.color ? `-${req.color.slice(1)}` : ""}.zip`;
    const path = join(req.dir, name);
    // The zip is built on request, so the store has no checksum for it; the bytes are the bytes.
    const z = await downloadTo(got.zip.url, path, {}, o.fetch);
    o.log?.(`  ✓ ${path}`);
    return {
      slug: req.slug,
      dir: req.dir,
      files: [],
      zip: { path, bytes: z.bytes, sha256: z.sha256 },
      counts: { downloaded: 1, skipped: 0, failed: 0 },
    };
  }

  let links = got.links;
  if (req.fileNames?.length) {
    const want = new Map(req.fileNames.map((n) => [n.toLowerCase(), n]));
    // People type a file's own name, which a recoloured SVG's link no longer carries.
    const own = new Map(owned?.files.map((f) => [f.id, f.name.toLowerCase()]));
    links = links.filter(
      (l) => want.delete(l.name.toLowerCase()) || want.delete(own.get(l.fileId) ?? ""),
    );
    if (want.size)
      throw new UsageError(
        `No file named ${[...want.values()].map((n) => `"${n}"`).join(", ")} in ${req.slug}${req.edition ? " (in that edition)" : ""}. Its files: ${got.links.map((l) => l.name).join(", ") || "none"}`,
      );
  }
  if (!links.length)
    throw new UsageError(
      `No files to download in ${req.slug}${req.edition ? " for that edition" : ""}.`,
    );

  const placed = placeLinks(links, req.slug, req.dir);
  const skipped: FileOutcome[] = [];
  const todo = [];
  for (const p of placed)
    if (!req.force && (await alreadyHave(p.path, p))) skipped.push({ ...p, status: "skipped" });
    else todo.push(p);
  for (const s of skipped) o.log?.(`  = ${s.path} (already here)`);

  const fetched = await transfer(
    todo,
    (slug, fileIds) => store.call<DownloadLinks>("get_download_links", { slug, fileIds, ...tint }),
    {
      concurrency: req.concurrency,
      fetch: o.fetch,
      log: o.log,
      links: new Map(links.map((l) => [l.fileId, l])),
    },
  );
  const files = [...skipped, ...fetched];
  return { slug: req.slug, dir: req.dir, files, zip: null, counts: countOutcomes(files) };
}

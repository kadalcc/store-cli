import { join } from "node:path";

import { UsageError } from "./args.ts";
import { alreadyHave, downloadTo, safeFileName } from "./download.ts";
import type { Store } from "./store.ts";
import { type FileOutcome, placeLinks, transfer } from "./transfer.ts";
import type { DownloadLinks, Edition } from "./types.ts";

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
}

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
  const args: Record<string, unknown> = { slug: req.slug };
  if (req.fileIds?.length) args.fileIds = req.fileIds;
  if (req.edition) args.edition = req.edition;
  if (req.zip) args.zip = true;
  const got = await store.call<DownloadLinks>("get_download_links", args);

  if (req.zip) {
    if (!got.zip)
      throw new UsageError(`${req.slug} has no zip; download its files instead (leave out --zip).`);
    const path = join(req.dir, `${safeFileName(req.slug)}.zip`);
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
    links = links.filter((l) => want.delete(l.name.toLowerCase()));
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
    (slug, fileIds) => store.call<DownloadLinks>("get_download_links", { slug, fileIds }),
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

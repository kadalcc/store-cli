import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ChecksumError, HostError } from "./host.ts";

/**
 * Getting the bytes: each file streams into `<name>.kadal-part` beside its final place, is
 * checked against the sha256 the store gave, and only then renamed into place. So a file at its
 * real name is always a whole, verified one; an interrupted run leaves a `.kadal-part` that the
 * next run continues from with a Range request (download links last ten minutes, so "resume"
 * means a fresh link and the bytes we already have).
 */

export const PART_SUFFIX = ".kadal-part";

/**
 * A file name from the store, made safe to join to a folder: no folders of its own (`../`,
 * `C:\`), no characters Windows refuses, no leading dot (a hidden or relative name), not empty.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is stripped
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[.\s]+/, "").trim();
  return cleaned.slice(0, 200) || "file";
}

/** The sha256 of a file, or null when there is no file there. */
export async function sha256File(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    return hash.digest("hex");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function sizeOf(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/** Whether the file at `path` is already the one the store has (size first: it is free). */
export async function alreadyHave(
  path: string,
  want: { bytes?: number; sha256?: string },
  hash: (path: string) => Promise<string | null> = sha256File,
): Promise<boolean> {
  if (!want.sha256) return false;
  const size = await sizeOf(path);
  if (size === null || (want.bytes !== undefined && size !== want.bytes)) return false;
  return (await hash(path)) === want.sha256.toLowerCase();
}

export interface Fetched {
  path: string;
  bytes: number;
  sha256: string;
  resumed: boolean;
}

/** A link that stopped working (expired after ten minutes, or used up): get a new one and retry. */
export class LinkExpiredError extends Error {
  constructor(readonly status: number) {
    super(`The download link answered ${status}`);
    this.name = "LinkExpiredError";
  }
}

export async function downloadTo(
  url: string,
  dest: string,
  want: { sha256?: string; bytes?: number },
  fetchFn: typeof fetch = fetch,
): Promise<Fetched> {
  await mkdir(dirname(dest), { recursive: true });
  const part = dest + PART_SUFFIX;
  const have = (await sizeOf(part)) ?? 0;
  // A part as long as the whole file (or longer) cannot be resumed; check it, then start over.
  const resumable = have > 0 && (want.bytes === undefined || have < want.bytes);
  if (have > 0 && !resumable) await rm(part, { force: true });

  let res = await fetchFn(url, {
    headers: resumable ? { range: `bytes=${have}-` } : {},
    redirect: "follow",
  });
  if (res.status === 416) {
    // The store thinks we have it all; the checksum below decides.
    await res.body?.cancel().catch(() => {});
    res = await fetchFn(url, { redirect: "follow" });
  }
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => {});
    throw new LinkExpiredError(res.status);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new HostError(res.status, `http_${res.status}`, `Downloading ${url} failed: the store answered ${res.status}.`);
  }

  // 206 continues the part; a 200 (the store ignored the Range) starts it over.
  const appending = res.status === 206 && resumable;
  const hash = createHash("sha256");
  if (appending) for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
  let bytes = appending ? have : 0;
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(part, { flags: appending ? "a" : "w", mode: 0o644 }),
  );
  const sha256 = hash.digest("hex");

  if (want.sha256 && sha256 !== want.sha256.toLowerCase()) {
    // A bad part must not be resumed from, or every retry inherits its wrong bytes.
    await rm(part, { force: true });
    throw new ChecksumError(
      `${dest} did not match the store's checksum (got ${sha256.slice(0, 12)}…, expected ${want.sha256.slice(0, 12)}…); nothing was kept. Run the command again; if it keeps happening, \`kadal-store report\` it.`,
    );
  }
  await rename(part, dest);
  return { path: dest, bytes, sha256, resumed: appending };
}

/** Run `fn` over `items`, at most `limit` at a time, keeping every outcome (never fail fast). */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!, i) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export const formatBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`;

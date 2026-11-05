import { UsageError } from "./args.ts";

/**
 * Which store we talk to, and the errors that come back from it. One CLI serves the live store
 * and a local `wrangler dev` worker (`--host http://localhost:8861`), so the host is part of
 * every saved sign-in rather than a constant.
 */

export const DEFAULT_HOST = "https://store.kadal.cc";

/** `--host` wins, then KADAL_STORE_HOST, then the live store. */
export function hostFrom(env: NodeJS.ProcessEnv, flag?: string): string {
  return normaliseHost(flag || env.KADAL_STORE_HOST || DEFAULT_HOST);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Scheme, host, port and any path, without the trailing slash. Plain http is refused anywhere but
 * this machine: the bearer token rides on every request, and on an open network that is the same
 * as publishing it.
 */
export function normaliseHost(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UsageError(`--host needs a URL like https://store.kadal.cc (got "${input}")`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new UsageError(`--host must be an http(s) URL (got "${input}")`);
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname))
    throw new UsageError(
      `--host ${url.origin} is plain http on another machine; use https (http is only for a local worker)`,
    );
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** The host without its scheme, for sentences: "store.kadal.cc", "localhost:8861". */
export const hostLabel = (host: string): string => host.replace(/^https?:\/\//, "");

/** No usable sign-in for this host: exit 3, and the one thing to do about it. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export const signedOut = (host: string): string =>
  host === DEFAULT_HOST
    ? "Not signed in to the Kadal Store. Run `kadal-store login`."
    : `Not signed in to ${hostLabel(host)}. Run \`kadal-store login --host ${host}\`.`;

/** The store answered, and the answer was no. `code` is its error code, or `http_<status>`. */
export class HostError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}

/** A tool ran and reported a failure (`isError`); the message is what the store said. */
export class ToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** A file came down but its bytes are not the ones the store promised: exit 4. */
export class ChecksumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksumError";
  }
}

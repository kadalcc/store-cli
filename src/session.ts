import { type Session, loadSession, saveSession } from "./config.ts";
import { AuthError, signedOut } from "./host.ts";
import { expiredMessage, refreshSession } from "./oauth.ts";

/**
 * A host's saved sign-in, kept fresh. Access tokens last an hour, so most runs a day apart start
 * with a refresh: one minute before expiry the token is swapped, and a 401 the store sends anyway
 * (revoked, clock skew) gets one refresh and one retry before it becomes "run kadal-store login".
 *
 * The MCP server and a command in another terminal can hold the same session. Before refreshing
 * we re-read the file: if the other one already rotated the tokens, theirs are used rather than
 * spending a refresh token the store may just have retired.
 */

const EARLY_MS = 60_000;

export class Auth {
  private refreshing: Promise<Session> | null = null;

  constructor(
    readonly host: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly baseFetch: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The saved session, or AuthError("Run kadal-store login"). */
  async session(): Promise<Session> {
    const s = await loadSession(this.host, this.env);
    if (!s) throw new AuthError(signedOut(this.host));
    return s;
  }

  /** A usable access token; `rejected` is one the store just turned down. */
  async accessToken(rejected?: string): Promise<string> {
    const s = await this.session();
    if (s.accessToken !== rejected && s.expiresAt - EARLY_MS > this.now()) return s.accessToken;
    return (await this.refresh(s, rejected)).accessToken;
  }

  private refresh(stale: Session, rejected?: string): Promise<Session> {
    // One refresh at a time per process: parallel downloads all hitting expiry share it.
    this.refreshing ??= (async () => {
      const fresh = (s: Session | null): s is Session =>
        !!s &&
        s.accessToken !== stale.accessToken &&
        s.accessToken !== rejected &&
        s.expiresAt - EARLY_MS > this.now();
      const latest = await loadSession(this.host, this.env);
      if (fresh(latest)) return latest;
      try {
        const next = await refreshSession(latest ?? stale, this.baseFetch);
        await saveSession(next, this.env);
        return next;
      } catch (e) {
        // Lost a race with another process that rotated first: its tokens are in the file.
        const after = await loadSession(this.host, this.env);
        if (fresh(after)) return after;
        throw e;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * `fetch` with the bearer token, for the MCP client's transport. A 401 is retried once with a
   * refreshed token; the request body is a string (JSON-RPC), so sending it twice is safe.
   */
  readonly fetch: typeof fetch = async (input, init) => {
    const send = (token: string) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return this.baseFetch(input, { ...init, headers });
    };
    const token = await this.accessToken();
    const res = await send(token);
    if (res.status !== 401) return res;
    await res.body?.cancel().catch(() => {});
    const retry = await send(await this.accessToken(token));
    if (retry.status === 401) {
      await retry.body?.cancel().catch(() => {});
      throw new AuthError(expiredMessage(this.host, "the store turned the token down"));
    }
    return retry;
  };
}

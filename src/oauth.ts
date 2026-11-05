import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Session } from "./config.ts";
import { AuthError, HostError, hostLabel } from "./host.ts";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Signing in: OAuth 2.1, authorization code + PKCE (S256), loopback redirect (RFC 8252)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   GET  /.well-known/oauth-protected-resource      → the resource (…/mcp) and its auth server
 *   GET  /.well-known/oauth-authorization-server    → endpoints, client_id_metadata_document_supported
 *   (browser) GET /authorize?…                      → the store's consent page → 127.0.0.1:<port>/callback
 *   POST /oauth/token                               → access token (1 h) + refresh token
 *
 * The client is public: no secret could stay secret inside an npm package. Its identity is the
 * client ID metadata document at <host>/cli/client.json (an https URL is the client_id, so there
 * is nothing to register). Where the store does not advertise metadata documents (a local
 * `wrangler dev` worker cannot fetch its own URLs, and http:// is never a document URL), or it
 * rejects ours, the CLI registers itself at /oauth/register (RFC 7591) instead.
 *
 * The redirect is http://127.0.0.1:<random port>/callback: loopback redirects may use any port
 * (RFC 8252 §7.3), so one registered `http://127.0.0.1/callback` covers every run. `state` ties
 * the answer to this run, PKCE ties the code to this process, and `resource` (RFC 8707) ties the
 * token to the MCP endpoint, so a token for the store is useless anywhere else.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DEFAULT_SCOPE = "store:read store:write";
const CLIENT_NAME = "Kadal Store CLI";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface ServerInfo {
  host: string;
  issuer?: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  metadataDocumentSupported: boolean;
}

/** The CLI's client ID metadata document. For the live store: https://store.kadal.cc/cli/client.json. */
export const clientIdFor = (host: string): string => `${host}/cli/client.json`;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function getJson(
  url: string,
  fetchFn: typeof fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export async function discover(host: string, fetchFn: typeof fetch = fetch): Promise<ServerInfo> {
  // The contract serves it at the root; RFC 9728 also allows the resource's path as a suffix.
  const prm =
    (await getJson(`${host}/.well-known/oauth-protected-resource`, fetchFn)) ??
    (await getJson(`${host}/.well-known/oauth-protected-resource/mcp`, fetchFn));
  const servers = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers : [];
  const asBase = (str(servers[0]) ?? host).replace(/\/+$/, "");
  const as = await getJson(`${asBase}/.well-known/oauth-authorization-server`, fetchFn);
  const authorizationEndpoint = str(as?.authorization_endpoint);
  const tokenEndpoint = str(as?.token_endpoint);
  if (!as || !authorizationEndpoint || !tokenEndpoint)
    throw new HostError(
      0,
      "no_oauth_metadata",
      `${hostLabel(host)} did not answer with its sign-in details (/.well-known/oauth-authorization-server). Check the address and that the store is up.`,
    );
  return {
    host,
    issuer: str(as.issuer),
    resource: str(prm?.resource) ?? `${host}/mcp`,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: str(as.registration_endpoint),
    revocationEndpoint: str(as.revocation_endpoint),
    metadataDocumentSupported: as.client_id_metadata_document_supported === true,
  };
}

/** An OAuth error answer (`{error, error_description}`) from the token or registration endpoint. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

async function tokenRequest(
  endpoint: string,
  params: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<TokenResponse> {
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON: reported by status below */
  }
  if (!res.ok || typeof data.access_token !== "string")
    throw new OAuthError(
      str(data.error) ?? `http_${res.status}`,
      str(data.error_description) ??
        str(data.error) ??
        `The token endpoint answered ${res.status}.`,
      res.status,
    );
  return data as unknown as TokenResponse;
}

function sessionFrom(
  info: Pick<ServerInfo, "host" | "resource" | "tokenEndpoint" | "revocationEndpoint">,
  client: { id: string; kind: Session["clientKind"] },
  t: TokenResponse,
  scope: string,
): Session {
  return {
    host: info.host,
    clientId: client.id,
    clientKind: client.kind,
    resource: info.resource,
    tokenEndpoint: info.tokenEndpoint,
    ...(info.revocationEndpoint ? { revocationEndpoint: info.revocationEndpoint } : {}),
    accessToken: t.access_token,
    ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
    expiresAt: Date.now() + (typeof t.expires_in === "number" ? t.expires_in : 3600) * 1000,
    scope: t.scope ?? scope,
    savedAt: new Date().toISOString(),
  };
}

/** RFC 7591 dynamic registration of a public client whose redirect is the loopback callback. */
export async function registerClient(
  info: ServerInfo,
  scope: string,
  fetchFn: typeof fetch,
  version = "0.0.0",
): Promise<string> {
  if (!info.registrationEndpoint)
    throw new HostError(
      0,
      "no_registration",
      `${hostLabel(info.host)} accepts neither the CLI's client ID document nor registration, so this CLI cannot sign in to it.`,
    );
  const res = await fetchFn(info.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      client_uri: "https://github.com/kadalcc/store-cli",
      software_id: "kadal-store-cli",
      software_version: version,
      // Any port on 127.0.0.1 matches this one (RFC 8252 §7.3).
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const id = str(data.client_id);
  if (!res.ok || !id)
    throw new OAuthError(
      str(data.error) ?? `http_${res.status}`,
      `Registering the CLI with ${hostLabel(info.host)} failed: ${str(data.error_description) ?? str(data.error) ?? res.status}`,
      res.status,
    );
  return id;
}

// ── the loopback listener ────────────────────────────────────────────────────────────────────

interface Answer {
  params: URLSearchParams;
  /** Finish the browser's page; a no-op for a pasted URL, which has no page waiting. */
  reply: (ok: boolean, title: string, line: string) => Promise<void>;
}

interface Loopback {
  port: number;
  wait: (state: string, timeoutMs: number) => Promise<Answer>;
  close: () => void;
}

async function startLoopback(lines?: AsyncIterable<string>): Promise<Loopback> {
  type Waiter = { state: string; resolve: (a: Answer) => void };
  let waiter = null as Waiter | null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    // Only the answer to this run's request: anything else could be a page elsewhere trying to
    // sign this terminal in to someone else's account.
    if (!waiter || url.searchParams.get("state") !== waiter.state) {
      res
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(
          page(
            false,
            "That sign-in link is not this one",
            "Go back to the terminal and run kadal-store login again.",
          ),
        );
      return;
    }
    const w = waiter;
    waiter = null;
    w.resolve({
      params: url.searchParams,
      // Resolves once the page has gone out, so closing the listener cannot cut it short.
      reply: (ok, title, line) =>
        new Promise<void>((done) => {
          res.on("close", done);
          res
            .writeHead(ok ? 200 : 400, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              connection: "close",
            })
            .end(page(ok, title, line), done);
        }),
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1, not localhost: the name can resolve to ::1 first, and the redirect says 127.0.0.1.
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  // A browser on another machine lands on a 127.0.0.1 page that cannot load; the address it
  // shows still carries the code, and pasting it into the terminal finishes the same way. One
  // reader for the whole login, matched against whichever request is waiting.
  if (lines)
    void (async () => {
      for await (const line of lines) {
        const params = pastedParams(line);
        if (!params || !waiter || params.get("state") !== waiter.state) continue;
        const w = waiter;
        waiter = null;
        w.resolve({ params, reply: async () => {} });
      }
    })().catch(() => {});
  return {
    port,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
    wait: (state, timeoutMs) =>
      new Promise<Answer>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(
            new AuthError(
              "The sign-in was not finished within 5 minutes; run `kadal-store login` again.",
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        waiter = {
          state,
          resolve: (a: Answer) => {
            clearTimeout(timer);
            resolve(a);
          },
        };
      }),
  };
}

/** The query of a pasted callback address (`http://127.0.0.1:1234/callback?code=…&state=…`). */
export function pastedParams(line: string): URLSearchParams | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.searchParams.has("state") ? url.searchParams : null;
  } catch {
    const query = new URLSearchParams(text.replace(/^[^?]*\?/, ""));
    return query.has("state") ? query : null;
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page the browser lands on: one line of what happened and what to do next. */
function page(ok: boolean, title: string, line: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Kadal Store</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --ink: #0f172a; --muted: #475569; --mark: ${ok ? "#0e7490" : "#b91c1c"}; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1220; --card: #111a2c; --ink: #e2e8f0; --muted: #94a3b8; --mark: ${ok ? "#22d3ee" : "#f87171"}; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { background: var(--card); border-radius: 16px; padding: 40px 36px; max-width: 420px; margin: 16px; box-shadow: 0 1px 3px rgb(0 0 0 / .08), 0 12px 32px rgb(0 0 0 / .06); text-align: center; }
  .mark { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; margin: 0 auto 20px; background: var(--mark); color: var(--card); font-size: 28px; font-weight: 700; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0; color: var(--muted); }
  small { display: block; margin-top: 24px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">${ok ? "&#10003;" : "!"}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(line)}</p>
  <small>Kadal Store CLI</small>
</main>
</body>
</html>`;
}

// ── login, refresh, revoke ───────────────────────────────────────────────────────────────────

export interface LoginOptions {
  host: string;
  scope?: string;
  fetch?: typeof fetch;
  /** Open the sign-in page; null prints it only (`--no-open`). */
  open?: ((url: string) => void) | null;
  log?: (line: string) => void;
  timeoutMs?: number;
  /** Lines typed into the terminal; a pasted callback address finishes the sign-in. */
  lines?: AsyncIterable<string>;
  /** Force one kind of client (tests, and stores that misreport their support). */
  client?: "auto" | Session["clientKind"];
  version?: string;
}

const CLIENT_PROBLEM = /^(invalid_client|unauthorized_client)$/;

export async function login(o: LoginOptions): Promise<Session> {
  const fetchFn = o.fetch ?? fetch;
  const log = o.log ?? (() => {});
  const scope = o.scope ?? DEFAULT_SCOPE;
  const info = await discover(o.host, fetchFn);
  // A metadata document must be an https URL the store can fetch.
  let kind: Session["clientKind"] =
    o.client && o.client !== "auto"
      ? o.client
      : info.metadataDocumentSupported && clientIdFor(info.host).startsWith("https://")
        ? "metadata-document"
        : "registered";

  const loop = await startLoopback(o.lines);
  try {
    const redirectUri = `http://127.0.0.1:${loop.port}/callback`;
    for (let attempt = 0; ; attempt++) {
      const clientId =
        kind === "metadata-document"
          ? clientIdFor(info.host)
          : await registerClient(info, scope, fetchFn, o.version);
      const { verifier, challenge } = pkcePair();
      const state = randomBytes(16).toString("base64url");
      const url = new URL(info.authorizationEndpoint);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: info.resource,
      }))
        url.searchParams.set(k, v);

      log(
        o.open === null
          ? `Open this address in a browser to sign in to ${hostLabel(info.host)}:`
          : `Opening your browser to sign in to ${hostLabel(info.host)}. If it does not open, visit:`,
      );
      log(`  ${url.href}`);
      if (o.lines)
        log("Browser on another machine? Approve there, then paste the address it lands on here.");
      o.open?.(url.href);

      const answer = await loop.wait(state, o.timeoutMs ?? LOGIN_TIMEOUT_MS);
      const p = answer.params;
      // Our metadata document refused (or unknown): register instead, once, and ask again.
      const retryAsRegistered = (code: string) =>
        kind === "metadata-document" &&
        attempt === 0 &&
        !!info.registrationEndpoint &&
        CLIENT_PROBLEM.test(code);

      const error = p.get("error");
      if (error) {
        if (retryAsRegistered(error)) {
          await answer.reply(
            false,
            "One more step",
            "The terminal is opening a new sign-in page; approve that one.",
          );
          log(
            "The store did not accept the CLI's client document; registering this CLI and asking again.",
          );
          kind = "registered";
          continue;
        }
        const why =
          error === "access_denied"
            ? "You declined in the browser, so nothing was saved."
            : `The store said: ${p.get("error_description") ?? error}`;
        await answer.reply(false, "Not signed in", why);
        throw new AuthError(`Sign-in did not finish. ${why}`);
      }
      // RFC 9207: an `iss` that is not our server's means the answer came from a different one.
      const iss = p.get("iss");
      if (iss && info.issuer && iss !== info.issuer) {
        await answer.reply(
          false,
          "Not signed in",
          "The answer came from a different server than the one asked.",
        );
        throw new AuthError(
          `Sign-in answer came from ${iss}, not ${info.issuer}; nothing was saved.`,
        );
      }
      const code = p.get("code");
      if (!code) {
        await answer.reply(false, "Not signed in", "The store sent no code back.");
        throw new AuthError(
          "The store sent no authorization code back; run `kadal-store login` again.",
        );
      }
      let tokens: TokenResponse;
      try {
        tokens = await tokenRequest(
          info.tokenEndpoint,
          {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
            resource: info.resource,
          },
          fetchFn,
        );
      } catch (e) {
        if (e instanceof OAuthError && retryAsRegistered(e.code)) {
          await answer.reply(
            false,
            "One more step",
            "The terminal is opening a new sign-in page; approve that one.",
          );
          log(
            "The store did not accept the CLI's client document; registering this CLI and asking again.",
          );
          kind = "registered";
          continue;
        }
        await answer.reply(false, "Not signed in", e instanceof Error ? e.message : String(e));
        throw e instanceof OAuthError ? new AuthError(`Sign-in failed: ${e.message}`) : e;
      }
      await answer.reply(
        true,
        "You're signed in",
        "You can close this tab and go back to the terminal.",
      );
      return sessionFrom(info, { id: clientId, kind }, tokens, scope);
    }
  } finally {
    loop.close();
  }
}

export const expiredMessage = (host: string, why?: string): string =>
  `Your sign-in to ${hostLabel(host)} has expired or was revoked${why ? ` (${why})` : ""}. Run \`kadal-store login${
    host === "https://store.kadal.cc" ? "" : ` --host ${host}`
  }\`.`;

/** A new access token (and, with rotation, a new refresh token) for a saved session. */
export async function refreshSession(s: Session, fetchFn: typeof fetch = fetch): Promise<Session> {
  if (!s.refreshToken) throw new AuthError(expiredMessage(s.host));
  try {
    const t = await tokenRequest(
      s.tokenEndpoint,
      {
        grant_type: "refresh_token",
        refresh_token: s.refreshToken,
        client_id: s.clientId,
        resource: s.resource,
      },
      fetchFn,
    );
    return {
      ...sessionFrom(s, { id: s.clientId, kind: s.clientKind }, t, s.scope),
      // Without rotation the old refresh token stays the one to use.
      refreshToken: t.refresh_token ?? s.refreshToken,
      ...(s.user ? { user: s.user } : {}),
    };
  } catch (e) {
    // invalid_grant: the 30-day idle window or 90-day cap passed, or the grant was revoked in
    // Account → Settings → Connected apps. Only signing in again fixes either.
    if (e instanceof OAuthError && (e.code === "invalid_grant" || e.code === "invalid_client"))
      throw new AuthError(expiredMessage(s.host, e.message));
    throw e;
  }
}

/** Best effort (RFC 7009): revoking the refresh token ends the grant on the store's side too. */
export async function revokeSession(s: Session, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const endpoint = s.revocationEndpoint;
  const token = s.refreshToken ?? s.accessToken;
  if (!endpoint) return false;
  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        token_type_hint: s.refreshToken ? "refresh_token" : "access_token",
        client_id: s.clientId,
      }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

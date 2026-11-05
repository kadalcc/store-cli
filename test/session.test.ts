import { afterAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

import { type Session, configPath, loadSession, saveSession } from "../src/config.ts";
import { AuthError } from "../src/host.ts";
import { clientIdFor, discover, login, pastedParams, pkcePair } from "../src/oauth.ts";
import { Auth } from "../src/session.ts";
import { approveInBrowser, startFakeStore } from "./fake-store.ts";
import { tempDir } from "./helpers.ts";

const store = startFakeStore({ accessTtl: 3600 });
afterAll(() => store.stop());

const envFor = () => {
  const config = tempDir();
  return { XDG_CONFIG_HOME: config, HOME: config } as NodeJS.ProcessEnv;
};

async function signIn(env: NodeJS.ProcessEnv): Promise<Session> {
  const s = await login({
    host: store.url,
    open: (url) => void approveInBrowser(url),
    client: "registered",
  });
  await saveSession(s, env);
  return s;
}

describe("config", () => {
  test("XDG_CONFIG_HOME, ~/.config, %APPDATA%", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe("/x/kadal/store.json");
    expect(configPath({ HOME: "/home/ana" }, "darwin")).toBe("/home/ana/.config/kadal/store.json");
    expect(configPath({ APPDATA: "C:\\Users\\ana\\AppData\\Roaming" }, "win32")).toContain("kadal");
  });

  test("saved 0600, one session per host", async () => {
    const env = envFor();
    const s = await signIn(env);
    const path = configPath(env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    await saveSession({ ...s, host: "http://localhost:8861" }, env);
    expect((await loadSession(store.url, env))?.accessToken).toBe(s.accessToken);
    expect((await loadSession("http://localhost:8861", env))?.host).toBe("http://localhost:8861");
  });
});

describe("oauth", () => {
  test("PKCE S256: a 43-character verifier and its SHA-256", async () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(digest);
  });

  test("discovery reads the resource and the endpoints", async () => {
    const info = await discover(store.url);
    expect(info).toMatchObject({
      resource: `${store.url}/mcp`,
      tokenEndpoint: `${store.url}/oauth/token`,
      registrationEndpoint: `${store.url}/oauth/register`,
      metadataDocumentSupported: true,
    });
    await expect(discover("http://127.0.0.1:9")).rejects.toThrow(/sign-in details/);
  });

  test("the metadata document is the client when the store accepts it", async () => {
    store.calls.length = 0;
    const s = await login({
      host: store.url,
      open: (url) => void approveInBrowser(url),
      client: "metadata-document",
    });
    expect(s.clientId).toBe(clientIdFor(store.url));
    expect(s.clientKind).toBe("metadata-document");
    expect(store.calls).not.toContain("register");
  });

  test("a store that refuses the document gets a registered client instead, in the same login", async () => {
    store.options.rejectCimd = true;
    store.calls.length = 0;
    const opened: string[] = [];
    try {
      const s = await login({
        host: store.url,
        open: (url) => {
          opened.push(url);
          void approveInBrowser(url);
        },
        client: "metadata-document",
      });
      expect(s.clientKind).toBe("registered");
      expect(opened).toHaveLength(2);
      expect(store.calls.filter((c) => c.startsWith("authorize") || c === "register")).toEqual([
        "authorize:cimd",
        "register",
        "authorize:registered",
      ]);
    } finally {
      store.options.rejectCimd = false;
    }
  });

  test("auto picks registration for an http store (a document URL must be https)", async () => {
    const s = await login({ host: store.url, open: (url) => void approveInBrowser(url) });
    expect(s.clientKind).toBe("registered");
  });

  test("the browser's page says it worked; a stranger's callback is refused", async () => {
    let browser: Promise<{ stranger: number; page: string }> | null = null;
    await login({
      host: store.url,
      client: "registered",
      open: (url) => {
        browser = (async () => {
          const redirect = new URL(url).searchParams.get("redirect_uri")!;
          const stranger = (await fetch(`${redirect}?code=evil&state=nope`)).status;
          return { stranger, page: (await approveInBrowser(url)).html };
        })();
      },
    });
    const { stranger, page } = await browser!;
    expect(stranger).toBe(400);
    expect(page).toContain("<h1>You&#39;re signed in</h1>");
  });

  test("a pasted callback address finishes a login whose browser is elsewhere", async () => {
    const lines = new (class {
      push!: (line: string) => void;
      async *[Symbol.asyncIterator]() {
        const queue: string[] = [];
        let wake: (() => void) | null = null;
        this.push = (l) => {
          queue.push(l);
          wake?.();
        };
        while (true) {
          if (!queue.length) await new Promise<void>((r) => (wake = r));
          yield queue.shift()!;
        }
      }
    })();
    const s = await login({
      host: store.url,
      client: "registered",
      lines,
      open: (url) =>
        void (async () => {
          // The browser on another machine follows /authorize but never reaches our 127.0.0.1.
          const res = await fetch(url, { redirect: "manual" });
          lines.push("not a url");
          lines.push(res.headers.get("location")!);
        })(),
    });
    expect(s.accessToken).toStartWith("at_");
    expect(pastedParams("?code=a&state=b")?.get("code")).toBe("a");
    expect(pastedParams("hello")).toBeNull();
  });

  test("declining in the browser saves nothing", async () => {
    await expect(
      login({
        host: store.url,
        client: "registered",
        open: (url) =>
          void (async () => {
            const back = new URL(new URL(url).searchParams.get("redirect_uri")!);
            back.searchParams.set("state", new URL(url).searchParams.get("state")!);
            back.searchParams.set("error", "access_denied");
            await fetch(back);
          })(),
      }),
    ).rejects.toThrow(/declined/);
  });
});

describe("refresh", () => {
  test("an expired access token is refreshed, rotated and saved", async () => {
    const env = envFor();
    const s = await signIn(env);
    await saveSession({ ...s, expiresAt: Date.now() - 1000 }, env);
    store.calls.length = 0;
    const auth = new Auth(store.url, env);
    const token = await auth.accessToken();
    expect(token).not.toBe(s.accessToken);
    expect(store.calls).toEqual(["token:refresh_token"]);
    const saved = (await loadSession(store.url, env))!;
    expect(saved.accessToken).toBe(token);
    expect(saved.refreshToken).not.toBe(s.refreshToken);
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
    // Still fresh: no second refresh.
    expect(await auth.accessToken()).toBe(token);
    expect(store.calls).toEqual(["token:refresh_token"]);
  });

  test("parallel callers share one refresh", async () => {
    const env = envFor();
    const s = await signIn(env);
    await saveSession({ ...s, expiresAt: 0 }, env);
    store.calls.length = 0;
    const auth = new Auth(store.url, env);
    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(store.calls.filter((c) => c === "token:refresh_token")).toHaveLength(1);
  });

  test("another process that rotated first: its tokens are used, not a dead refresh token", async () => {
    const env = envFor();
    const s = await signIn(env);
    const stale = { ...s, expiresAt: 0 };
    // Process B refreshed and saved; we still hold the stale copy in memory.
    const b = new Auth(store.url, env);
    await saveSession(stale, env);
    const bToken = await b.accessToken();
    store.calls.length = 0;
    const a = new Auth(store.url, env);
    expect(await a.accessToken(stale.accessToken)).toBe(bToken);
    expect(store.calls).toEqual([]);
  });

  test("a 401 from the store gets one refresh and a retry", async () => {
    const env = envFor();
    const s = await signIn(env);
    // The token looks fresh but the store no longer knows it.
    await saveSession({ ...s, accessToken: "at_revoked" }, env);
    const auth = new Auth(store.url, env);
    store.calls.length = 0;
    const res = await auth.fetch(`${store.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(200);
    expect(store.calls).toEqual(["token:refresh_token"]);
  });

  test("a revoked grant: 'run kadal-store login', exit 3", async () => {
    const env = envFor();
    const s = await signIn(env);
    await saveSession({ ...s, expiresAt: 0 }, env);
    store.revokeAll();
    const err = await new Auth(store.url, env).accessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain("Run `kadal-store login --host");
  });

  test("signed out: AuthError before any request", async () => {
    store.calls.length = 0;
    await expect(new Auth(store.url, envFor()).accessToken()).rejects.toThrow(/Not signed in/);
    expect(store.calls).toEqual([]);
  });
});

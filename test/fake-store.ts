import { createHash, randomBytes } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

/**
 * An in-memory Kadal Store for tests: the OAuth server, the hosted MCP endpoint and the /dl/
 * download route of apps/store-worker/docs/agents.md, with fixtures, and enough checks to fail a
 * client that gets the protocol wrong (PKCE, state, resource, bearer, loopback redirect).
 *
 *   GET  /.well-known/oauth-protected-resource      {resource, authorization_servers}
 *   GET  /.well-known/oauth-authorization-server    endpoints, client_id_metadata_document_supported
 *   GET  /cli/client.json                           the CLI's client ID metadata document
 *   POST /oauth/register                            RFC 7591, public clients
 *   GET  /authorize                                 approves at once (the person said yes) → 302
 *   POST /oauth/token                               code (PKCE S256) and refresh_token grants; revocation
 *   POST /mcp                                       Streamable HTTP, stateless, Bearer
 *   GET  /dl/<token>                                file bytes, Range-aware
 *
 * Not shipped: tests import it, and `bun test/fake-store.ts [port]` serves it for trying the
 * built CLI by hand (`node dist/bin.js login --host http://localhost:<port>`).
 */

export interface FakeOptions {
  /** Advertise client ID metadata documents (default true). */
  cimd?: boolean;
  /** /authorize answers a metadata-document client with error=invalid_client (test the fallback). */
  rejectCimd?: boolean;
  /** Seconds an access token lives (default 3600). */
  accessTtl?: number;
  /** Rotate refresh tokens on use (default true). */
  rotate?: boolean;
  port?: number;
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

interface FakeFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  edition: Record<string, string> | null;
}

interface FakeProduct {
  slug: string;
  name: string;
  kind: "asset" | "pack";
  shelf: { slug: string; name: string };
  cents: number;
  tags: { style: string[]; topic: string[]; format: string[] };
  owned: "standard" | "personal" | "commercial" | null;
  files: FakeFile[];
}

const bytesOf = (text: string, n = 1): Uint8Array => new TextEncoder().encode(text.repeat(n));

export function fixtures(): FakeProduct[] {
  return [
    {
      slug: "techo-weekly-2027",
      name: "Techo weekly planner 2027",
      kind: "asset",
      shelf: { slug: "planners", name: "Planners" },
      cents: 600,
      tags: { style: ["minimal"], topic: ["planning"], format: ["pdf"] },
      owned: "personal",
      files: [
        {
          id: "f_a5",
          name: "techo-weekly_2027_mon_en_a5.pdf",
          bytes: bytesOf("%PDF a5 ", 3000),
          edition: { year: "2027", week: "mon", lang: "en", size: "a5" },
        },
        {
          id: "f_a6",
          name: "techo-weekly_2027_mon_en_a6.pdf",
          bytes: bytesOf("%PDF a6 ", 2000),
          edition: { year: "2027", week: "mon", lang: "en", size: "a6" },
        },
        { id: "f_readme", name: "READ ME.txt", bytes: bytesOf("Print at 100%.\n"), edition: null },
      ],
    },
    {
      slug: "retro-ui-sfx",
      name: "Retro UI sound effects",
      kind: "asset",
      shelf: { slug: "sound", name: "Sound effects" },
      cents: 900,
      tags: { style: ["retro", "8-bit"], topic: ["ui", "games"], format: ["wav"] },
      owned: "standard",
      files: [
        { id: "f_click", name: "click.wav", bytes: bytesOf("RIFF click ", 500), edition: null },
        { id: "f_beep", name: "beep.wav", bytes: bytesOf("RIFF beep ", 700), edition: null },
      ],
    },
    {
      slug: "fern-pack",
      name: "Fern textures pack",
      kind: "pack",
      shelf: { slug: "textures", name: "Textures" },
      cents: 1200,
      tags: { style: ["natural"], topic: ["plants", "games"], format: ["png"] },
      owned: null,
      files: [],
    },
  ];
}

export interface FakeStore {
  url: string;
  stop: () => void;
  /** Tool calls and route hits, in order: "tool:list_library", "dl:f_a5", "token:refresh_token"… */
  calls: string[];
  products: FakeProduct[];
  /** Serve wrong bytes for these file ids. */
  corrupt: Set<string>;
  /** The next download of these file ids answers 403 (an expired link). */
  expireOnce: Set<string>;
  /** Close the connection halfway through these file ids, once (an interrupted download). */
  cutOnce: Set<string>;
  notes: {
    id: string;
    slug: string;
    kind: string;
    body: string;
    fileName?: string;
    page?: number;
    timeSeconds?: number;
  }[];
  /** Revoke every token (the person removed the app). */
  revokeAll: () => void;
  options: FakeOptions;
}

export function startFakeStore(opts: FakeOptions = {}): FakeStore {
  const options: FakeOptions = { cimd: true, accessTtl: 3600, rotate: true, ...opts };
  const products = fixtures();
  const calls: string[] = [];
  const corrupt = new Set<string>();
  const expireOnce = new Set<string>();
  const cutOnce = new Set<string>();
  const notes: FakeStore["notes"] = [];
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string }
  >();
  const access = new Map<string, { exp: number; scope: string }>();
  const refresh = new Map<string, { clientId: string; scope: string }>();
  const dl = new Map<string, { fileId?: string; slug?: string; exp: number }>();
  let origin = "";
  let n = 0;

  const user = { id: "u_ana", name: "Ana", email: "ana@example.com" };
  const card = (p: FakeProduct) => ({
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    shelf: p.shelf,
    blurb: `${p.name}, for tests.`,
    url: `${origin}/p/${p.slug}`,
    imageUrl: null,
    prices: [
      { tier: "standard", cents: p.cents },
      { tier: "personal", cents: p.cents + 300 },
      { tier: "commercial", cents: p.cents * 3 },
    ],
    fromCents: p.cents,
    tags: p.tags,
    owned: p.owned,
    ...(p.kind === "pack" ? { packOf: 3 } : {}),
  });
  const find = (slug: string) => products.find((p) => p.slug === slug);
  const json = (data: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  });
  const toolError = (text: string) => ({
    isError: true,
    content: [{ type: "text" as const, text }],
  });
  const issue = () => {
    const t = `at_${++n}_${b64url(randomBytes(6))}`;
    return t;
  };

  function mcpServer(scope: string): McpServer {
    const server = new McpServer({ name: "fake-store", version: "0.0.0" });
    const tool = (
      name: string,
      shape: z.ZodRawShape,
      fn: (a: Record<string, unknown>) => unknown,
    ) =>
      server.registerTool(name, { inputSchema: shape }, async (a: Record<string, unknown>) => {
        calls.push(`tool:${name}`);
        return fn(a) as ReturnType<typeof json>;
      });

    tool("whoami", {}, () => json({ user, scopes: scope.split(" "), operator: false }));
    tool("list_shelves", {}, () =>
      json({
        shelves: [...new Map(products.map((p) => [p.shelf.slug, p.shelf])).values()].map((s) => ({
          ...s,
          blurb: null,
          count: products.filter((p) => p.shelf.slug === s.slug).length,
          licenceModel: "tiers",
        })),
      }),
    );
    tool(
      "search_products",
      {
        query: z.string().optional(),
        shelf: z.string().optional(),
        maxCents: z.number().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
      },
      (a) => {
        const q = String(a.query ?? "").toLowerCase();
        const hits = products.filter(
          (p) =>
            (!q ||
              q
                .split(/\s+/)
                .some((w) =>
                  `${p.name} ${p.tags.topic.join(" ")} ${p.tags.format.join(" ")}`
                    .toLowerCase()
                    .includes(w),
                )) &&
            (!a.shelf || p.shelf.slug === a.shelf) &&
            (a.maxCents === undefined || p.cents <= Number(a.maxCents)),
        );
        return json({ items: hits.map(card), nextCursor: null, total: hits.length });
      },
    );
    tool("get_product", { slug: z.string() }, (a) => {
      const p = find(String(a.slug));
      if (!p) return toolError(`No product ${a.slug}.`);
      return json({
        product: {
          ...card(p),
          description: `All about ${p.name}.`,
          files: p.files.map((f) => ({
            name: f.name,
            bytes: f.bytes.length,
            minTier: "standard",
            edition: f.edition,
          })),
          editions: null,
          contents: [],
          inPacks: [],
          licence: {
            model: "tiers",
            tiers: [
              { tier: "standard", label: "Standard", yes: ["Personal projects"], no: ["Resale"] },
            ],
          },
          updates: [],
        },
      });
    });
    tool(
      "recommend",
      {
        context: z.string(),
        shelves: z.array(z.string()).optional(),
        formats: z.array(z.string()).optional(),
        includeOwned: z.boolean().optional(),
        limit: z.number().optional(),
      },
      (a) => {
        calls.push(`context:${a.context}`);
        const items = products
          .filter((p) => a.includeOwned || !p.owned)
          .map((p) => ({ ...card(p), why: `Mentions ${p.tags.topic[0]}.`, score: 0.5 }));
        return json({ items, packs: [] });
      },
    );
    tool("list_library", {}, () =>
      json({
        items: products
          .filter((p) => p.owned)
          .map((p) => ({
            product: card(p),
            tier: p.owned,
            files: p.files.map((f) => ({
              id: f.id,
              name: f.name,
              bytes: f.bytes.length,
              sha256: sha(f.bytes),
              edition: f.edition,
            })),
            zipAvailable: true,
            updatedAt: "2026-11-01T00:00:00.000Z",
            lastUpdate: null,
          })),
      }),
    );
    tool(
      "get_download_links",
      {
        slug: z.string(),
        fileIds: z.array(z.string()).optional(),
        edition: z
          .object({
            year: z.string().optional(),
            week: z.string().optional(),
            lang: z.string().optional(),
            size: z.string().optional(),
          })
          .optional(),
        zip: z.boolean().optional(),
      },
      (a) => {
        const p = find(String(a.slug));
        if (!p?.owned) return toolError(`You don't own ${a.slug}.`);
        calls.push(
          `links:${p.slug}:${(a.fileIds as string[] | undefined)?.join(",") ?? "*"}${a.edition ? `:${JSON.stringify(a.edition)}` : ""}`,
        );
        const ed = a.edition as Record<string, string> | undefined;
        const ids = a.fileIds as string[] | undefined;
        const files = p.files.filter(
          (f) =>
            (!ids || ids.includes(f.id)) &&
            (!ed ||
              Object.entries(ed).every(
                ([k, v]) => !f.edition || f.edition[k] === undefined || f.edition[k] === v,
              )),
        );
        const exp = Date.now() + 600_000;
        const links = files.map((f) => {
          const t = b64url(randomBytes(9));
          dl.set(t, { fileId: f.id, exp });
          return {
            fileId: f.id,
            name: f.name,
            bytes: f.bytes.length,
            sha256: sha(f.bytes),
            url: `${origin}/dl/${t}`,
            expiresAt: new Date(exp).toISOString(),
          };
        });
        let zip = null;
        if (a.zip) {
          const t = b64url(randomBytes(9));
          dl.set(t, { slug: p.slug, exp });
          zip = { url: `${origin}/dl/${t}`, expiresAt: new Date(exp).toISOString() };
        }
        return json({ links, zip });
      },
    );
    tool(
      "create_buy_link",
      {
        items: z.array(z.object({ slug: z.string(), tier: z.string().optional() })),
        ref: z.string().optional(),
      },
      (a) => {
        const items = (a.items as { slug: string; tier?: string }[]).map((i) => {
          const p = find(i.slug);
          if (!p) throw new Error(`No product ${i.slug}`);
          const tier = i.tier ?? "standard";
          return {
            slug: p.slug,
            name: p.name,
            tier,
            cents: tier === "standard" ? p.cents : p.cents + 300,
            owned: !!p.owned,
          };
        });
        const q = items.map((i) => `${i.slug}:${i.tier}`).join(",");
        return json({
          url: `${origin}/buy?items=${q}&ref=${a.ref ?? "agent"}`,
          items,
          totalCents: items.filter((i) => !i.owned).reduce((s, i) => s + i.cents, 0),
          note: "Owned items are left out of the total.",
        });
      },
    );
    tool(
      "report_problem",
      {
        slug: z.string(),
        fileName: z.string().optional(),
        page: z.number().optional(),
        timeSeconds: z.number().optional(),
        kind: z.enum(["mistake", "question", "idea"]),
        body: z.string(),
      },
      (a) => {
        if (!scope.split(" ").includes("store:write"))
          return toolError("This needs the store:write scope.");
        const id = `note_${notes.length + 1}`;
        notes.push({
          id,
          slug: String(a.slug),
          kind: String(a.kind),
          body: String(a.body),
          fileName: a.fileName as string | undefined,
          page: a.page as number | undefined,
          timeSeconds: a.timeSeconds as number | undefined,
        });
        return json({ note: { id, status: "open", url: `${origin}/account/notes/${id}` } });
      },
    );
    tool("list_my_notes", { status: z.string().optional() }, () =>
      json({
        notes: notes.map((x) => ({
          id: x.id,
          product: {
            slug: x.slug,
            name: find(x.slug)?.name ?? x.slug,
            url: `${origin}/p/${x.slug}`,
          },
          target: x.fileName ? "file" : "product",
          mediaId: null,
          fileId: null,
          targetName: x.fileName ?? null,
          targetType: null,
          targetUrl: null,
          current: true,
          anchor: x.page ? { page: x.page } : null,
          kind: x.kind,
          body: x.body,
          status: "open",
          statusLine: "Open",
          via: "agent",
          files: [],
          messages: [],
          unread: false,
          createdAt: "2026-11-05T00:00:00.000Z",
          updatedAt: "2026-11-05T00:00:00.000Z",
        })),
      }),
    );
    return server;
  }

  const form = async (req: Request) => new URLSearchParams(await req.text());
  const oauthError = (error: string, status = 400, description?: string) =>
    Response.json(
      { error, ...(description ? { error_description: description } : {}) },
      { status },
    );
  const loopback = (uri: string) => {
    try {
      const u = new URL(uri);
      return u.protocol === "http:" && u.hostname === "127.0.0.1" && u.pathname === "/callback";
    } catch {
      return false;
    }
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/.well-known/oauth-protected-resource")
      return Response.json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["store:read", "store:write"],
      });
    if (path === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/token`,
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        client_id_metadata_document_supported: options.cimd === true,
      });
    if (path === "/cli/client.json")
      return Response.json({
        client_id: `${origin}/cli/client.json`,
        client_name: "Kadal Store CLI",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    if (path === "/oauth/register" && req.method === "POST") {
      const body = (await req.json()) as {
        redirect_uris?: string[];
        token_endpoint_auth_method?: string;
      };
      calls.push("register");
      if (body.token_endpoint_auth_method !== "none") return oauthError("invalid_client_metadata");
      if (!body.redirect_uris?.every(loopback)) return oauthError("invalid_redirect_uri");
      const id = `client_${clients.size + 1}`;
      clients.set(id, { redirect_uris: body.redirect_uris });
      return Response.json({ client_id: id, ...body }, { status: 201 });
    }
    if (path === "/authorize") {
      const q = url.searchParams;
      const clientId = q.get("client_id") ?? "";
      const redirectUri = q.get("redirect_uri") ?? "";
      calls.push(`authorize:${clientId.startsWith("http") ? "cimd" : "registered"}`);
      // Like the real provider: never redirect to an address the client did not register.
      if (!loopback(redirectUri)) return new Response("bad redirect", { status: 400 });
      const cimd = clientId === `${origin}/cli/client.json`;
      if (!cimd && !clients.has(clientId)) return new Response("unknown client", { status: 400 });
      const back = new URL(redirectUri);
      back.searchParams.set("state", q.get("state") ?? "");
      back.searchParams.set("iss", origin);
      if (cimd && (options.rejectCimd || !options.cimd)) {
        back.searchParams.set("error", "invalid_client");
        return Response.redirect(back.href, 302);
      }
      if (
        q.get("response_type") !== "code" ||
        q.get("code_challenge_method") !== "S256" ||
        !q.get("code_challenge")
      )
        return new Response("PKCE S256 required", { status: 400 });
      if (q.get("resource") !== `${origin}/mcp`)
        return new Response("bad resource", { status: 400 });
      const code = `code_${b64url(randomBytes(8))}`;
      codes.set(code, {
        clientId,
        redirectUri,
        challenge: q.get("code_challenge")!,
        resource: q.get("resource")!,
        scope: q.get("scope") ?? "store:read",
      });
      back.searchParams.set("code", code);
      return Response.redirect(back.href, 302);
    }
    if (path === "/oauth/token" && req.method === "POST") {
      const f = await form(req);
      // RFC 7009 revocation on the token endpoint, as workers-oauth-provider does it.
      if (f.has("token") && !f.has("grant_type")) {
        calls.push("revoke");
        refresh.delete(f.get("token")!);
        access.delete(f.get("token")!);
        return new Response(null, { status: 200 });
      }
      const grant = f.get("grant_type");
      calls.push(`token:${grant}`);
      let scope = "";
      let clientId = "";
      if (grant === "authorization_code") {
        const c = codes.get(f.get("code") ?? "");
        if (!c) return oauthError("invalid_grant");
        codes.delete(f.get("code")!);
        if (c.clientId !== f.get("client_id") || c.redirectUri !== f.get("redirect_uri"))
          return oauthError("invalid_grant", 400, "client or redirect differs");
        if (
          b64url(
            createHash("sha256")
              .update(f.get("code_verifier") ?? "")
              .digest(),
          ) !== c.challenge
        )
          return oauthError("invalid_grant", 400, "PKCE verifier does not match");
        if (f.get("resource") !== c.resource) return oauthError("invalid_target");
        scope = c.scope;
        clientId = c.clientId;
      } else if (grant === "refresh_token") {
        const r = refresh.get(f.get("refresh_token") ?? "");
        if (!r || r.clientId !== f.get("client_id"))
          return oauthError("invalid_grant", 400, "refresh token is not valid");
        if (options.rotate) refresh.delete(f.get("refresh_token")!);
        scope = r.scope;
        clientId = r.clientId;
      } else return oauthError("unsupported_grant_type");
      const at = issue();
      access.set(at, { exp: Date.now() + (options.accessTtl ?? 3600) * 1000, scope });
      const rt =
        options.rotate || grant === "authorization_code"
          ? `rt_${++n}_${b64url(randomBytes(6))}`
          : f.get("refresh_token")!;
      refresh.set(rt, { clientId, scope });
      return Response.json({
        access_token: at,
        token_type: "bearer",
        expires_in: options.accessTtl,
        refresh_token: rt,
        scope,
      });
    }
    if (path === "/mcp") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const a = access.get(token);
      if (!a || a.exp < Date.now())
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            "content-type": "application/json",
          },
        });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const server = mcpServer(a.scope);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(req);
    }
    if (path.startsWith("/dl/")) {
      const t = dl.get(path.slice(4));
      if (!t || t.exp < Date.now()) return new Response("expired", { status: 403 });
      if (t.slug) {
        calls.push(`dl:zip:${t.slug}`);
        return new Response(bytesOf(`PK zip of ${t.slug} `, 100));
      }
      const file = products.flatMap((p) => p.files).find((f) => f.id === t.fileId)!;
      if (expireOnce.delete(file.id)) return new Response("expired", { status: 403 });
      let body = corrupt.has(file.id) ? bytesOf("x", file.bytes.length) : file.bytes;
      const range = /^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "");
      calls.push(`dl:${file.id}${range ? `@${range[1]}` : ""}`);
      if (cutOnce.delete(file.id)) {
        // Half the file, then the response ends: a connection that dropped part way.
        return new Response(body.slice(0, Math.floor(body.length / 2)));
      }
      if (range) {
        const from = Number(range[1]);
        if (from >= body.length) return new Response(null, { status: 416 });
        body = body.slice(from);
        return new Response(body, {
          status: 206,
          headers: {
            "content-range": `bytes ${from}-${file.bytes.length - 1}/${file.bytes.length}`,
          },
        });
      }
      return new Response(body);
    }
    return new Response("not found", { status: 404 });
  }

  const server = Bun.serve({ port: options.port ?? 0, hostname: "127.0.0.1", fetch: handle });
  origin = `http://127.0.0.1:${server.port}`;
  return {
    url: origin,
    stop: () => server.stop(true),
    calls,
    products,
    corrupt,
    expireOnce,
    cutOnce,
    notes,
    revokeAll: () => {
      access.clear();
      refresh.clear();
    },
    options,
  };
}

/** Stand in for the person's browser: follow /authorize's redirect to the CLI's loopback. */
export async function approveInBrowser(url: string): Promise<{ status: number; html: string }> {
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) return { status: res.status, html: await res.text() };
  const back = await fetch(location);
  return { status: back.status, html: await back.text() };
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 8899);
  const store = startFakeStore({ port });
  console.log(`fake Kadal Store on ${store.url} (Ctrl-C to stop)`);
}

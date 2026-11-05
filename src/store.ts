import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AuthError, HostError, ToolError, hostLabel } from "./host.ts";
import { expiredMessage } from "./oauth.ts";
import type { Auth } from "./session.ts";

/**
 * The store's hosted MCP server (`POST <host>/mcp`, Streamable HTTP, stateless) as a client.
 * Every command is one tool call: the CLI holds no catalogue logic of its own, so what an agent
 * sees through the hosted server, the CLI and `kadal-store mcp` is the same data. The SDK is
 * imported on first use, so `--help` and `logout` never load it.
 */
export class Store {
  private client: Promise<Client> | null = null;

  constructor(
    readonly host: string,
    readonly auth: Auth,
    private readonly version: string,
  ) {}

  private async connect(): Promise<Client> {
    // Signed out fails here, before the SDK loads or anything goes over the network.
    await this.auth.session();
    this.client ??= (async () => {
      const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      ]);
      const client = new Client({ name: "kadal-store", version: this.version });
      const transport = new StreamableHTTPClientTransport(new URL(`${this.host}/mcp`), {
        fetch: this.auth.fetch,
      });
      await client.connect(transport);
      return client;
    })();
    try {
      return await this.client;
    } catch (e) {
      this.client = null;
      throw explain(e, this.host);
    }
  }

  /** The tool's whole answer, error or not (what the stdio proxy hands on as it is). */
  async raw(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const client = await this.connect();
    try {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    } catch (e) {
      throw explain(e, this.host);
    }
  }

  /** The tool's `structuredContent`; an `isError` answer becomes a ToolError with its text. */
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.raw(name, args);
    const text = textOf(result);
    if (result.isError) throw new ToolError(name, text || `${name} failed.`);
    if (result.structuredContent) return result.structuredContent as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HostError(0, "no_data", `The store's ${name} answered without data.`);
    }
  }

  async close(): Promise<void> {
    const pending = this.client;
    this.client = null;
    const client = await pending?.catch(() => null);
    await client?.close().catch(() => {});
  }
}

export const textOf = (r: CallToolResult): string =>
  r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

/** The SDK's transport and protocol errors, as sentences that say what to do. */
export function explain(e: unknown, host: string): Error {
  for (let cur: unknown = e, i = 0; cur && i < 6; cur = (cur as { cause?: unknown }).cause, i++)
    if (cur instanceof AuthError || cur instanceof HostError) return cur;
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (e as { code?: unknown }).code;
  // StreamableHTTPError carries the HTTP status as `code`.
  if (err.name === "StreamableHTTPError" || /Streamable HTTP/i.test(err.message)) {
    if (code === 401) return new AuthError(expiredMessage(host));
    if (code === 403)
      return new HostError(
        403,
        "forbidden",
        "The store refused that with this sign-in (403). Run `kadal-store login` again to grant it.",
      );
    if (code === 404)
      return new HostError(
        404,
        "no_mcp",
        `${hostLabel(host)} has no MCP endpoint at /mcp; check --host.`,
      );
    if (typeof code === "number" && code >= 500)
      return new HostError(
        code,
        `http_${code}`,
        `The store is having trouble (${code}); try again in a minute.`,
      );
  }
  const cause = (e as { cause?: { code?: string } }).cause;
  if (err instanceof TypeError && /fetch failed/i.test(err.message))
    return new HostError(
      0,
      "unreachable",
      `Could not reach ${hostLabel(host)}${cause?.code ? ` (${cause.code})` : ""}. Check your connection and --host.`,
    );
  return err;
}

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where this machine's sign-ins live: `~/.config/kadal/store.json` (XDG_CONFIG_HOME respected;
 * %APPDATA%\kadal\store.json on Windows), mode 0600 in a 0700 folder. One file holds a session
 * per host, so signing in to a local worker never signs you out of the live store.
 */

export interface Session {
  host: string;
  /** The OAuth client this token was issued to; refresh must name the same one. */
  clientId: string;
  /** `metadata-document`: clientId is the https URL of our client document. `registered`: from /oauth/register. */
  clientKind: "metadata-document" | "registered";
  /** The protected resource the token is for (RFC 8707), sent again on refresh. */
  resource: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  user?: { id: string; name: string | null; email: string };
  savedAt: string;
}

interface StoreFile {
  version: 1;
  sessions: Record<string, Session>;
}

export function configPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const base = env.APPDATA || join(env.USERPROFILE || homedir(), "AppData", "Roaming");
    return join(base, "kadal", "store.json");
  }
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "kadal", "store.json");
}

async function readAll(env: NodeJS.ProcessEnv): Promise<StoreFile> {
  try {
    const data = JSON.parse(await readFile(configPath(env), "utf8")) as Partial<StoreFile>;
    if (data && typeof data.sessions === "object" && data.sessions)
      return { version: 1, sessions: data.sessions };
  } catch {
    /* none saved, or unreadable: start empty rather than refuse to sign in */
  }
  return { version: 1, sessions: {} };
}

/**
 * Written to a temporary file and renamed over the old one, so a crash mid-write (or the MCP
 * server refreshing while a command does) never leaves half a JSON file and no sign-in at all.
 */
async function writeAll(file: StoreFile, env: NodeJS.ProcessEnv): Promise<string> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode is masked by the umask; chmod is not.
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
  return path;
}

export async function loadSession(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Session | null> {
  return (await readAll(env)).sessions[host] ?? null;
}

export async function saveSession(
  session: Session,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const file = await readAll(env);
  file.sessions[session.host] = session;
  return writeAll(file, env);
}

/** True when there was a session to forget. The file goes once it holds none. */
export async function clearSession(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const file = await readAll(env);
  if (!file.sessions[host]) return false;
  delete file.sessions[host];
  if (Object.keys(file.sessions).length) await writeAll(file, env);
  else await rm(configPath(env), { force: true });
  return true;
}

#!/usr/bin/env node
/**
 * The built CLI the way `npx -y @kadal/store` runs it: `node dist/bin.js` under whatever Node is
 * on PATH (CI runs this on Node 20), against test/fake-store.ts (served by Bun). Signs in by
 * playing the browser (following the printed /authorize address to the loopback), then library,
 * a download checked by sha256, a sync that skips it all the second time, and a buy link.
 *
 *   node tools/smoke.mjs        (after `bun run build`; needs bun on PATH for the fake store)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bin = join(root, "dist", "bin.js");
const work = mkdtempSync(join(tmpdir(), "kadal-store-smoke-"));
const port = 18000 + Math.floor(Math.random() * 1000);
const host = `http://127.0.0.1:${port}`;
const env = { ...process.env, XDG_CONFIG_HOME: join(work, "config"), KADAL_STORE_HOST: host };

const fake = spawn("bun", [join(root, "test", "fake-store.ts"), String(port)], {
  stdio: ["ignore", "pipe", "inherit"],
});
let failed = false;
const done = (code) => {
  fake.kill();
  rmSync(work, { recursive: true, force: true });
  process.exit(code);
};
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed = true;
};

const cli = (...args) => {
  const r = spawnSync("node", [bin, ...args, "--json"], { cwd: work, env, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* reported below */
  }
  return { code: r.status, json, stderr: r.stderr };
};

await new Promise((ready) =>
  fake.stdout.on("data", (d) => String(d).includes("fake Kadal Store") && ready()),
);

// login: the CLI prints the address; we are the browser.
const login = spawn("node", [bin, "login", "--no-open", "--json"], {
  cwd: work,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let said = "";
let out = "";
login.stdout.on("data", (d) => (out += d));
login.stderr.on("data", async (d) => {
  said += d;
  const m = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/.exec(said);
  if (m && !login.approved) {
    login.approved = true;
    const res = await fetch(m[1], { redirect: "manual" });
    await fetch(res.headers.get("location"));
  }
});
const loginCode = await new Promise((r) => login.on("exit", r));
check(
  "login",
  loginCode === 0 && JSON.parse(out).user?.email === "ana@example.com",
  `exit ${loginCode}`,
);

const lib = cli("library");
check("library", lib.code === 0 && lib.json?.items?.length === 2);

const dl = cli("download", "techo-weekly-2027", "--size", "a5", "-o", "planner");
check(
  "download one edition",
  dl.code === 0 && dl.json?.counts?.downloaded === 2,
  JSON.stringify(dl.json?.counts),
);

const sync1 = cli("sync", "mirror");
const sync2 = cli("sync", "mirror");
check(
  "sync, then sync again",
  sync1.json?.counts?.downloaded === 5 &&
    sync2.json?.counts?.skipped === 5 &&
    sync2.json?.counts?.downloaded === 0,
);

const buy = cli("buy", "fern-pack");
check(
  "buy link",
  buy.code === 0 && /\/buy\?items=fern-pack/.test(buy.json?.url ?? ""),
  buy.json?.url,
);

const out2 = cli("logout");
const after = cli("library");
check("logout, then signed out (exit 3)", out2.json?.revoked === true && after.code === 3);

done(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * Remakes the README's pictures in headless Chromium:
 *
 *   ../hero.webp     hero.html at 2x: the store, an agent using it, the terminal
 *   ../store.webp    a product page on store.kadal.cc, on a phone
 *   ../review.webp   the review page a buy link opens, on a phone
 *   ../agents.webp   store.kadal.cc/agents/, on a phone
 *   ../social.jpg    social.html at 2x, scaled to 1280×640 (GitHub's social preview)
 *
 * The phone pictures are the live pages, so they change when the store does. The hero's agent
 * and terminal lines come from running this CLI and `kadal-store mcp` against a stand-in store
 * that serves store.kadal.cc's own catalogue (its public /api/products), with a demo account
 * that owns Soft UI Sounds; they are copied into hero.html by hand.
 *
 *   bun add --no-save playwright && bunx playwright install chromium
 *   node .github/assets/src/render.mjs           # needs cwebp and magick (brew install webp imagemagick)
 *
 * Every text in these pictures is at least 44 px at 1080 px wide (60 for headlines), so it reads
 * on a 360-pt phone. Check each one at 100% and at phone size after a change.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

const src = dirname(fileURLToPath(import.meta.url));
const assets = join(src, "..");
const tmp = mkdtempSync(join(tmpdir(), "kadal-store-assets-"));
const only = process.argv.slice(2);
const wanted = (name) => only.length === 0 || only.includes(name);

/** PNG → WebP, sized for a README: `width` px wide, lossy at `q`. */
function webp(png, out, width, q = 80) {
  execFileSync("cwebp", [
    "-quiet",
    "-q",
    String(q),
    "-m",
    "6",
    "-resize",
    String(width),
    "0",
    png,
    "-o",
    out,
  ]);
  console.log(
    `${out.slice(assets.length + 1)}  ${(readFileSync(out).length / 1024).toFixed(0)} KB`,
  );
}

const browser = await chromium.launch();
try {
  // ── compositions ────────────────────────────────────────────────────────────────────────
  for (const [name, file, width] of [["hero", "hero.html", 1620]]) {
    if (!wanted(name)) continue;
    const page = await browser.newPage({
      viewport: { width: 1080, height: 800 },
      deviceScaleFactor: 2,
    });
    await page.goto(pathToFileURL(join(src, file)).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const png = join(tmp, `${name}.png`);
    await page.screenshot({ path: png, fullPage: true });
    webp(png, join(assets, `${name}.webp`), width);
    await page.close();
  }

  if (wanted("social")) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 640 },
      deviceScaleFactor: 2,
    });
    await page.goto(pathToFileURL(join(src, "social.html")).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const png = join(tmp, "social.png");
    await page.screenshot({ path: png });
    const out = join(assets, "social.jpg");
    execFileSync("magick", [png, "-resize", "1280x640", "-strip", "-quality", "86", out]);
    console.log(`social.jpg  ${(readFileSync(out).length / 1024).toFixed(0)} KB`);
    await page.close();
  }

  // ── the live store, on a phone ──────────────────────────────────────────────────────────
  const phones = [
    // name, page, how far down to start (CSS px), how tall a slice
    ["store", "https://store.kadal.cc/p/one-name-ui-sounds", 560, 900],
    ["review", "https://store.kadal.cc/buy?items=one-name-ui-sounds:personal&ref=cli", 0, 900],
    ["agents", "https://store.kadal.cc/agents/", 0, 900],
  ];
  for (const [name, url, top, height] of phones) {
    if (!wanted(name)) continue;
    const context = await browser.newContext({
      viewport: { width: 390, height: top + height },
      deviceScaleFactor: 2,
      colorScheme: "light",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    // The Kadal Deck strip across the top is the network's, not the store's: hide it, as its
    // close button does.
    await page.evaluate(() => document.documentElement.classList.add("strip-off"));
    await page.waitForTimeout(500);
    const shot = join(tmp, `${name}-page.png`);
    await page.screenshot({ path: shot, clip: { x: 0, y: top, width: 390, height } });
    await context.close();

    // In a plain phone frame, on a transparent page so it sits on GitHub's light or dark.
    const frame = await browser.newPage({
      viewport: { width: 430, height: height + 40 },
      deviceScaleFactor: 2,
    });
    const data = `data:image/png;base64,${readFileSync(shot).toString("base64")}`;
    await frame.setContent(
      `<body style="margin:0;background:transparent"><div id="f" style="display:inline-block;padding:9px;border-radius:44px;background:#0b1724">` +
        `<img src="${data}" style="display:block;width:390px;border-radius:35px"></div></body>`,
    );
    const framed = join(tmp, `${name}.png`);
    await frame.locator("#f").screenshot({ path: framed, omitBackground: true });
    webp(framed, join(assets, `${name}.webp`), 560, 82);
    await frame.close();
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}

import { formatBytes } from "./download.ts";
import { editionLabel } from "./editions.ts";
import type {
  BuyLink,
  LibraryItem,
  Note,
  ProductCard,
  ProductDetail,
  Recommendations,
  SearchResult,
  Shelves,
  WhoAmI,
} from "./types.ts";

/**
 * The people-facing text of each command. `--json` skips all of this and prints the tool's data,
 * so nothing here is a contract: it is tuned for a terminal 80 columns wide and a quick read.
 */

export const money = (cents: number | null | undefined): string =>
  cents === null || cents === undefined
    ? "—"
    : cents === 0
      ? "free"
      : `$${(cents / 100).toFixed(2)}`;

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const priceLine = (p: ProductCard): string =>
  p.owned
    ? `owned (${p.owned})`
    : p.prices.length > 1
      ? `from ${money(p.fromCents)}`
      : money(p.fromCents ?? p.prices[0]?.cents);

/** One product per line: name, shelf, price or owned, then its slug for the next command. */
export function cardLines(items: ProductCard[]): string[] {
  const nameW = Math.min(38, Math.max(10, ...items.map((p) => p.name.length)));
  const shelfW = Math.min(18, Math.max(5, ...items.map((p) => p.shelf.name.length)));
  return items.map(
    (p) =>
      `${pad(cut(p.name, nameW), nameW)}  ${pad(cut(p.shelf.name, shelfW), shelfW)}  ${pad(priceLine(p), 18)}  ${p.slug}${p.kind === "pack" && p.packOf ? `  (pack of ${p.packOf})` : ""}`,
  );
}

export function searchText(r: SearchResult, again?: string): string[] {
  if (!r.items.length)
    return ["Nothing matched. Try fewer words, or `kadal-store shelves` to browse."];
  const lines = cardLines(r.items);
  lines.push("", `${r.items.length} of ${r.total}. Details: kadal-store show <slug>`);
  if (r.nextCursor) lines.push(`More: ${again ?? "kadal-store search …"} --cursor ${r.nextCursor}`);
  return lines;
}

export function shelvesText(r: Shelves): string[] {
  const w = Math.max(...r.shelves.map((s) => s.slug.length), 4);
  return r.shelves.map(
    (s) =>
      `${pad(s.slug, w)}  ${pad(s.name, 24)}  ${String(s.count).padStart(4)} products${s.blurb ? `  ${cut(s.blurb, 50)}` : ""}`,
  );
}

export function productText(p: ProductDetail): string[] {
  const out = [
    `${p.name}  (${p.kind === "pack" ? `pack${p.packOf ? ` of ${p.packOf}` : ""}` : "asset"} · ${p.shelf.name})`,
    p.url,
  ];
  if (p.owned) out.push(`You own this (${p.owned}).`);
  if (p.blurb) out.push("", p.blurb);
  if (p.description && p.description !== p.blurb) out.push("", cut(p.description.trim(), 1200));
  if (p.prices.length)
    out.push("", "Prices:", ...p.prices.map((x) => `  ${pad(x.tier, 11)} ${money(x.cents)}`));
  const tags = [...p.tags.style, ...p.tags.topic, ...p.tags.format];
  if (tags.length) out.push("", `Tags: ${tags.join(", ")}`);
  if (p.files.length) {
    out.push("", `Files (${p.files.length}):`);
    for (const f of p.files.slice(0, 40)) {
      const ed = editionLabel(f.edition);
      out.push(
        `  ${f.name}  ${formatBytes(f.bytes)}${f.minTier !== "standard" ? `  ${f.minTier}+` : ""}${ed ? `  [${ed}]` : ""}`,
      );
    }
    if (p.files.length > 40) out.push(`  … and ${p.files.length - 40} more`);
  }
  if (p.contents.length)
    out.push("", "In this pack:", ...cardLines(p.contents).map((l) => `  ${l}`));
  if (p.inPacks.length) out.push("", "Also in:", ...cardLines(p.inPacks).map((l) => `  ${l}`));
  if (p.licence.tiers.length) {
    out.push("", `Licence (${p.licence.model}):`);
    for (const t of p.licence.tiers) {
      out.push(`  ${t.label}`);
      for (const y of t.yes) out.push(`    + ${y}`);
      for (const n of t.no) out.push(`    − ${n}`);
    }
  }
  if (p.updates.length) {
    out.push("", "Updates:");
    for (const u of p.updates.slice(0, 5))
      out.push(
        `  ${u.at.slice(0, 10)}  ${u.summary}${u.reports ? ` · answered ${u.reports} report${u.reports === 1 ? "" : "s"}` : ""}`,
      );
  }
  out.push(
    "",
    p.owned ? `Download: kadal-store download ${p.slug}` : `Buy: kadal-store buy ${p.slug}`,
  );
  return out;
}

export function recommendText(r: Recommendations): string[] {
  if (!r.items.length && !r.packs.length)
    return ["Nothing fits well yet. Try a few words about what you need."];
  const out: string[] = [];
  for (const p of r.items) out.push(...cardLines([p]), `    ${p.why}`);
  if (r.packs.length) {
    out.push("", "Packs that complete what you have:");
    for (const p of r.packs) out.push(...cardLines([p]), `    ${p.why} (you own ${p.ownedOf})`);
  }
  out.push("", "Details: kadal-store show <slug> · a link to buy: kadal-store buy <slug>…");
  return out;
}

export function libraryText(items: LibraryItem[]): string[] {
  if (!items.length) return ["Nothing in your library yet. Browse: kadal-store search <words>"];
  const out: string[] = [];
  for (const it of items) {
    const total = it.files.reduce((n, f) => n + f.bytes, 0);
    out.push(
      `${it.product.name}  (${it.tier})  ${it.files.length} file${it.files.length === 1 ? "" : "s"}, ${formatBytes(total)}  ${it.product.slug}`,
    );
    if (it.lastUpdate)
      out.push(`    updated ${it.lastUpdate.at.slice(0, 10)}: ${it.lastUpdate.summary}`);
  }
  out.push("", "Download one: kadal-store download <slug> · everything: kadal-store sync <dir>");
  return out;
}

export function buyText(r: BuyLink): string[] {
  const out = ["Review and pay here:", `  ${r.url}`, ""];
  for (const i of r.items)
    out.push(
      `  ${pad(cut(i.name, 40), 40)}  ${pad(i.tier, 10)}  ${money(i.cents)}${i.owned ? "  (you already own this)" : ""}`,
    );
  out.push(`  ${pad("Total", 52)}  ${money(r.totalCents)}`, "");
  if (r.note) out.push(r.note);
  out.push("Nothing is charged until you pay in the checkout on that page.");
  return out;
}

export function notesText(notes: Note[]): string[] {
  if (!notes.length)
    return [
      'You have no notes. Found a problem in a file? kadal-store report <slug> --kind mistake "…"',
    ];
  const out: string[] = [];
  for (const n of notes) {
    out.push(
      `${n.unread ? "● " : "  "}${n.product.name} · ${n.kind}${n.targetName ? ` · ${n.targetName}` : ""}  [${n.statusLine || n.status}]  ${n.id}`,
      `    ${cut(n.body.replace(/\s+/g, " "), 100)}`,
    );
    const reply = [...n.messages].reverse().find((m) => m.author === "kadal" && m.body);
    if (reply?.body) out.push(`    Kadal: ${cut(reply.body.replace(/\s+/g, " "), 100)}`);
  }
  return out;
}

export function whoamiText(w: WhoAmI, host: string): string[] {
  return [
    `${w.user.name ? `${w.user.name} ` : ""}<${w.user.email}> on ${host.replace(/^https?:\/\//, "")}`,
    `scopes: ${w.scopes.join(" ")}${w.operator ? " · operator" : ""}`,
  ];
}

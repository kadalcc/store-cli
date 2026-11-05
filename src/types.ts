/**
 * The shapes the store's MCP tools return, as written in the contract
 * (store.kadal.cc's apps/store-worker/docs/agents.md and docs/notes.md). `--json` prints these
 * exactly, so they are this CLI's output contract too. Money is integer US cents, URLs are
 * absolute, times are ISO strings.
 */

export type Tier = "standard" | "personal" | "commercial";
export const TIERS: readonly Tier[] = ["standard", "personal", "commercial"];

export interface ProductCard {
  slug: string;
  name: string;
  kind: "asset" | "pack";
  shelf: { slug: string; name: string };
  blurb: string | null;
  url: string;
  imageUrl: string | null;
  prices: { tier: Tier; cents: number }[];
  fromCents: number | null;
  tags: { style: string[]; topic: string[]; format: string[] };
  /** The caller's best tier, if they own it. */
  owned: Tier | null;
  /** Packs: how many items. */
  packOf?: number;
}

/** One value per axis (year, week, lang, size); an axis left out narrows nothing. */
export interface Edition {
  year?: string;
  week?: string;
  lang?: string;
  size?: string;
}

export interface WhoAmI {
  user: { id: string; name: string | null; email: string };
  scopes: string[];
  operator: boolean;
}

export interface Shelves {
  shelves: { slug: string; name: string; blurb: string | null; count: number; licenceModel: string }[];
}

export interface SearchResult {
  items: ProductCard[];
  nextCursor: string | null;
  total: number;
}

export interface ProductFile {
  name: string;
  bytes: number;
  minTier: Tier;
  edition: Edition | null;
}

export interface LicenceTier {
  tier: Tier;
  label: string;
  yes: string[];
  no: string[];
}

export interface ProductDetail extends ProductCard {
  description: string | null;
  files: ProductFile[];
  editions: unknown;
  contents: ProductCard[];
  inPacks: ProductCard[];
  licence: { model: string; tiers: LicenceTier[] };
  updates: { summary: string; at: string; reports: number }[];
}

export interface Recommendations {
  items: (ProductCard & { why: string; score: number })[];
  packs: (ProductCard & { why: string; ownedOf: number })[];
}

export interface LibraryFile {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  edition: Edition | null;
}

export interface LibraryItem {
  product: ProductCard;
  tier: Tier;
  files: LibraryFile[];
  zipAvailable: boolean;
  updatedAt: string;
  lastUpdate: { summary: string; at: string } | null;
}

export interface Library {
  items: LibraryItem[];
}

export interface DownloadLink {
  fileId: string;
  name: string;
  bytes: number;
  sha256: string;
  url: string;
  expiresAt: string;
}

export interface DownloadLinks {
  links: DownloadLink[];
  zip: { url: string; expiresAt: string } | null;
}

export interface BuyLink {
  url: string;
  items: { slug: string; name: string; tier: Tier; cents: number; owned: boolean }[];
  totalCents: number;
  note: string;
}

export type NoteKind = "mistake" | "question" | "idea";
export const NOTE_KINDS: readonly NoteKind[] = ["mistake", "question", "idea"];
export type NoteStatus = "open" | "accepted" | "declined" | "duplicate" | "fixed";
export const NOTE_STATUSES: readonly NoteStatus[] = [
  "open",
  "accepted",
  "declined",
  "duplicate",
  "fixed",
];

export interface Note {
  id: string;
  product: { slug: string; name: string; url: string };
  target: "media" | "file" | "product";
  mediaId: string | null;
  fileId: string | null;
  targetName: string | null;
  targetType: string | null;
  targetUrl: string | null;
  current: boolean;
  anchor: Record<string, unknown> | null;
  kind: NoteKind;
  body: string;
  status: NoteStatus;
  statusLine: string;
  via: "web" | "agent";
  files: { id: string; url: string }[];
  messages: { author: "person" | "kadal"; body: string | null; status: string | null; at: string }[];
  unread: boolean;
  createdAt: string;
  updatedAt: string;
  author?: { name: string | null; email: string };
}

export interface ReportResult {
  note: { id: string; status: NoteStatus; url: string };
}

export interface MyNotes {
  notes: Note[];
}

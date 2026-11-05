/**
 * The README's "How it works" drawing, in Kadal Deck's sketch DSL (`@kadal/deck/sketch`, what a
 * slide's `<Sketch>` draws). The Kadal monorepo's deck-site renders it in Chromium with
 * Excalidraw (`bun run diagrams <name>` with this file in apps/deck-site/diagrams/) into
 * ../how-it-works.svg, which carries its own font and both colour schemes, and
 * ../how-it-works.excalidraw, which opens on excalidraw.com. Drawn 760 wide (808 with its margin) with
 * text at 33 px or more, so it reads on a phone.
 */
import { sketch } from "@kadal/deck/sketch";

export const alt =
  "Your AI agent reaches the store two ways: the hosted MCP server at store.kadal.cc/mcp, signed in with OAuth and nothing to install, or kadal-store mcp on your computer over stdio. You run the same kadal-store in a terminal. Both act on store.kadal.cc with your own sign-in: the shop and your library. A buy link opens a review page, where only you can pay.";

const s = sketch({ width: 760, height: 930, size: 34 });

s.node("agent", { x: 0, y: 60, w: 340, h: 120, label: "your AI agent", tone: "info" });
s.region("local", {
  x: 390,
  y: 0,
  w: 370,
  h: 420,
  title: "on your computer",
  tone: "neutral",
  size: 33,
});
s.node("you", { x: 410, y: 60, w: 330, h: 110, label: "you, in a\nterminal", tone: "neutral" });
s.node("cli", {
  x: 410,
  y: 270,
  w: 330,
  h: 120,
  label: "kadal-store\nCLI · local MCP",
  tone: "accent",
  font: "code",
  size: 33,
});
s.node("hosted", {
  x: 0,
  y: 270,
  w: 340,
  h: 140,
  label: "hosted MCP\nstore.kadal.cc/mcp",
  tone: "purple",
});

s.node("store", {
  x: 110,
  y: 530,
  w: 540,
  h: 150,
  label: "store.kadal.cc\nthe shop · your library",
  shape: "cylinder",
  tone: "teal",
});
s.node("review", {
  x: 110,
  y: 800,
  w: 540,
  h: 130,
  label: "review page\nonly you pay",
  shape: "note",
  tone: "amber",
});

s.arrow("agent", "hosted", { label: "OAuth", size: 33 });
s.arrow("agent", "cli", { from: "right", to: "left", label: "stdio", size: 33 });
s.arrow("you", "cli", { label: "commands", size: 33 });
s.arrow("hosted", "store", {});
s.arrow("cli", "store", { label: "your sign-in", size: 33 });
s.arrow("store", "review", { label: "buy link", size: 33, tone: "amber", dashed: true });

export default s.build();

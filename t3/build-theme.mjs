#!/usr/bin/env node
// Builds t3/teqneo.json — the Teqneo look for T3 Code (docs/teqneo-code.md).
//
//   node t3/build-theme.mjs           write t3/teqneo.json
//   node t3/build-theme.mjs --check   fail if t3/teqneo.json is out of date or invalid
//
// The palette is written here, as data next to the rules it must obey, and the
// JSON is generated so the two cannot drift. Every colour comes from the
// Teqneo Design System tokens the hub itself uses (apps/web/src/app/globals.css):
// paper and black grounds, black for the person's actions with the red hover
// swap, AI blue for focus and what the agent did, red for errors. Square
// corners and Helvetica come from the custom CSS.
//
// What T3 Code accepts is checked here against its published format
// (packages/contracts/src/server.ts and packages/shared/src/themePalettes.ts
// in pingdotgg/t3code): every colour role present in both variants as #rrggbb,
// a name of 48 characters or fewer, CSS under 50,000 characters that loads no
// files. A theme that fails is not written.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "teqneo.json");

/** T3 Code's colour roles, in its own order (themePalettes.ts THEME_COLOR_ROLES). */
export const ROLES = [
  "canvas", "chrome", "toolbar", "toolbarForeground", "toolbarBorder", "toolbarControl",
  "toolbarControlForeground", "toolbarControlHover", "surface", "surfaceRaised", "surfaceOverlay",
  "text", "textMuted", "border", "input", "focus", "accent", "accentForeground", "secondary",
  "secondaryForeground", "muted", "mutedForeground", "placeholder", "secondaryLabel", "iconMuted",
  "error", "errorForeground", "errorSurface", "warning", "warningForeground", "warningSurface",
  "update", "updateForeground", "updateSurface", "accentSurface", "accentSurfaceForeground",
  "messageSurface", "messageForeground", "messageAction", "messageActionForeground",
  "messageActionHover", "codeBackground", "codeForeground", "searchMatchBackground",
  "searchMatchForeground", "searchMatchActiveBackground", "searchMatchActiveForeground", "sidebar",
  "sidebarForeground", "sidebarMutedForeground", "sidebarControlSurface", "sidebarRowHover",
  "sidebarRowActive", "sidebarRowSelected", "sidebarBorder", "terminalBackground",
  "terminalForeground", "terminalCursor", "terminalSelection", "terminalScrollbar",
  "terminalScrollbarHover",
];

// The design system's tokens (globals.css :root), named as there.
const tk = {
  red: "#e21b16", redTint: "#f6c9c2", redDeep: "#b8130f",
  blue: "#2e7ebb", blueTint: "#cfdfeb", blueDeep: "#22629a",
  black: "#0b0b0b", ink2: "#34312c", ink3: "#6b655b", ink4: "#a39c8e",
  paper: "#f1ebdd", paper2: "#e7dfcd", paper3: "#d9cfb9", white: "#ffffff",
};

// Light: the hub's own product UI — paper ground, white work surfaces,
// hairlines that are paper a step darker, black type.
const light = {
  canvas: tk.paper, chrome: tk.paper, toolbar: tk.paper,
  toolbarForeground: tk.black, toolbarBorder: "#e0d7c4",
  toolbarControl: tk.white, toolbarControlForeground: tk.black, toolbarControlHover: tk.paper2,
  surface: tk.white, surfaceRaised: "#fbf8f2", surfaceOverlay: tk.white,
  text: tk.black, textMuted: tk.ink3, border: "#e0d7c4", input: tk.paper3,
  // Focus is the AI blue, as on the hub; the primary action is black, as on the hub.
  focus: tk.blue, accent: tk.black, accentForeground: tk.paper,
  secondary: tk.paper2, secondaryForeground: tk.black,
  muted: "#ece5d5", mutedForeground: tk.ink3,
  placeholder: tk.ink4, secondaryLabel: tk.ink3, iconMuted: "#8a8376",
  // The palette has no green or amber: red is what needs action.
  error: tk.red, errorForeground: tk.redDeep, errorSurface: "#f8e0dc",
  warning: tk.redDeep, warningForeground: tk.redDeep, warningSurface: "#f5e6d8",
  update: tk.blue, updateForeground: tk.blueDeep, updateSurface: tk.blueTint,
  accentSurface: tk.paper2, accentSurfaceForeground: tk.black,
  messageSurface: tk.paper2, messageForeground: tk.black,
  // Send: black, swapping to red on hover — the system's one hover.
  messageAction: tk.black, messageActionForeground: tk.paper, messageActionHover: tk.red,
  codeBackground: "#fbf8f2", codeForeground: tk.ink2,
  searchMatchBackground: tk.redTint, searchMatchForeground: tk.black,
  searchMatchActiveBackground: tk.red, searchMatchActiveForeground: tk.white,
  sidebar: tk.paper2, sidebarForeground: tk.black, sidebarMutedForeground: tk.ink3,
  sidebarControlSurface: tk.paper, sidebarRowHover: "#efe8da", sidebarRowActive: tk.paper,
  sidebarRowSelected: tk.white, sidebarBorder: tk.paper3,
  terminalBackground: "#fbf8f2", terminalForeground: tk.black, terminalCursor: tk.red,
  terminalSelection: tk.redTint, terminalScrollbar: tk.paper3, terminalScrollbarHover: tk.ink4,
};

// Dark: the hub's inverse — black ground, paper type. Red and blue stay
// themselves, lifted a step so they read on black, as in globals.css .dark.
const dark = {
  canvas: tk.black, chrome: tk.black, toolbar: tk.black,
  toolbarForeground: tk.paper, toolbarBorder: "#2a2723",
  toolbarControl: "#171614", toolbarControlForeground: tk.paper, toolbarControlHover: "#1d1b18",
  surface: "#171614", surfaceRaised: "#1d1b18", surfaceOverlay: "#1d1b18",
  text: tk.paper, textMuted: tk.ink4, border: "#2a2723", input: "#3a3631",
  focus: "#5f9fd3", accent: tk.paper, accentForeground: tk.black,
  secondary: "#1d1b18", secondaryForeground: tk.paper,
  muted: "#171614", mutedForeground: tk.ink4,
  placeholder: "#7a7367", secondaryLabel: tk.ink4, iconMuted: "#7a7367",
  error: "#f0574f", errorForeground: "#f0574f", errorSurface: "#3a1412",
  warning: "#f0574f", warningForeground: "#f0574f", warningSurface: "#33180f",
  update: "#5f9fd3", updateForeground: "#5f9fd3", updateSurface: "#12283a",
  accentSurface: "#1d1b18", accentSurfaceForeground: tk.paper,
  messageSurface: "#1d1b18", messageForeground: tk.paper,
  messageAction: tk.paper, messageActionForeground: tk.black, messageActionHover: tk.red,
  codeBackground: "#121110", codeForeground: tk.paper2,
  searchMatchBackground: "#5a1a16", searchMatchForeground: tk.paper,
  searchMatchActiveBackground: tk.red, searchMatchActiveForeground: tk.white,
  sidebar: "#121110", sidebarForeground: tk.paper, sidebarMutedForeground: tk.ink4,
  sidebarControlSurface: "#1d1b18", sidebarRowHover: "#171614", sidebarRowActive: "#1d1b18",
  sidebarRowSelected: "#23211d", sidebarBorder: "#2a2723",
  terminalBackground: tk.black, terminalForeground: tk.paper2, terminalCursor: tk.red,
  terminalSelection: "#4a1a17", terminalScrollbar: "#2a2723", terminalScrollbarHover: "#3a3631",
};

// The shape: square by default (2px on inputs, as on the hub), Helvetica
// from the system as the one face. Targets variables and data- attributes,
// which T3 Code keeps stable across releases; class names it does not.
const css = `/* Teqneo — square corners and the system's one face (docs/teqneo-code.md). */
:root {
  --radius: 0px;
  --control-radius: 2px;
  --font-sans: "Helvetica Neue", Helvetica, Arial, ui-sans-serif, system-ui, sans-serif;
}
`;

// The base is light, so the variants carry only dark: T3 Code refuses a theme
// whose variants repeat its base appearance (themePalette.ts, parseThemeFile).
export const theme = {
  version: 1,
  name: "Teqneo",
  appearance: "light",
  colors: light,
  variants: { dark },
  css,
};

/** What T3 Code would refuse, in words. Empty when the theme is valid. */
export function problems(t) {
  const out = [];
  const hex = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  if (!t.name || t.name.length > 48) out.push("name must be 1–48 characters");
  if (!["light", "dark"].includes(t.appearance)) out.push("appearance must be light or dark");
  if (t.variants && t.appearance in t.variants) out.push(`variants must not repeat the base appearance "${t.appearance}"`);
  const other = t.appearance === "light" ? "dark" : "light";
  for (const [label, palette] of [["colors", t.colors], [`variants.${other}`, t.variants?.[other]]]) {
    if (!palette) {
      out.push(`${label} is missing`);
      continue;
    }
    const missing = ROLES.filter((r) => !(r in palette));
    if (missing.length) out.push(`${label} lacks ${missing.join(", ")}`);
    const extra = Object.keys(palette).filter((k) => !ROLES.includes(k));
    if (extra.length) out.push(`${label} has roles T3 Code does not know: ${extra.join(", ")}`);
    for (const [role, value] of Object.entries(palette)) if (!hex.test(value)) out.push(`${label}.${role} is not a hex colour: ${value}`);
  }
  if (t.css.length > 50_000) out.push("css is over 50,000 characters");
  // T3 Code refuses CSS that loads files: @import, image-set(), url() other than data: or #id.
  if (/@import|image-set\(|url\(\s*["']?(?!data:|#)/i.test(t.css)) out.push("css loads files");
  return out;
}

const json = JSON.stringify(theme, null, 2) + "\n";
const found = problems(theme);
if (found.length) {
  console.error(`Not written — T3 Code would refuse it:\n- ${found.join("\n- ")}`);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing counts as stale */
  }
  if (current !== json) {
    console.error("t3/teqneo.json is out of date: run node t3/build-theme.mjs");
    process.exit(1);
  }
  console.log(`t3/teqneo.json is current and valid (${ROLES.length} roles × light and dark).`);
} else if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` || process.argv[1]?.endsWith("build-theme.mjs")) {
  // Written to a temporary file and renamed, as T3 Code asks of anything in its themes folder.
  writeFileSync(`${OUT}.tmp`, json);
  renameSync(`${OUT}.tmp`, OUT);
  console.log(`Wrote ${OUT} (${ROLES.length} roles × light and dark).`);
}

#!/usr/bin/env node
// Build a BB plugin's README logo: the plugin's own BB icon, in white, on a
// rounded gradient tile. The 120×120 layout matches bb-plugin-rewind's
// docs/logo.svg.
//
//   node make-logo.mjs [--plugin <dir>] [--out <file>] [--from <hex>] [--to <hex>]
//                      [--icon <name|path.svg>] [--stroke <width>] [--hugeicons <dir>]
//
// --icon defaults to bb.branding.icon in the plugin's package.json:
//   - A path (./assets/icon.svg) is read as SVG and recoloured white.
//   - A name (GridView) is resolved the way the plugin's vendored icon
//     component resolves it: a `Name: SomethingIcon` entry in
//     components/ui/*.ts(x). Failing that, the script falls back to
//     `<Name>Icon` from @hugeicons/core-free-icons and warns that it guessed.
// --hugeicons names a directory whose node_modules has
// @hugeicons/core-free-icons, for plugins that do not depend on it.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TILE = 120;
const GLYPH = 72; // the glyph's box, centred, leaving Rewind's 24px margin
const RADIUS = 28;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).join("\n"));
  process.exit(0);
}

const plugin = resolve(args.plugin ?? ".");
const out = resolve(plugin, args.out ?? "docs/logo.svg");
const from = args.from ?? "#0969da";
const to = args.to ?? "#0550ae";
for (const colour of [from, to]) if (!HEX.test(colour)) fail(`"${colour}" is not a #hex colour`);

const manifestPath = join(plugin, "package.json");
if (!existsSync(manifestPath)) fail(`no package.json in ${plugin}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const icon = args.icon ?? manifest.bb?.branding?.icon;
if (!icon) fail("package.json has no bb.branding.icon; pass --icon <name|path.svg>");

const glyph = /\.svg$/i.test(icon) || /^[./~]/.test(icon)
  ? glyphFromSvg(resolve(plugin, icon))
  : await glyphFromHugeicons(icon);

if (args.stroke !== undefined) glyph.strokeWidth = args.stroke;
if (glyph.strokeWidth !== undefined) {
  glyph.body = glyph.body.replace(/stroke-width="[^"]*"/g, `stroke-width="${glyph.strokeWidth}"`);
  if (glyph.group["stroke-width"] !== undefined) glyph.group["stroke-width"] = glyph.strokeWidth;
}

const [minX, minY, width, height] = glyph.box;
const scale = GLYPH / Math.max(width, height);
const tx = (TILE - width * scale) / 2 - minX * scale;
const ty = (TILE - height * scale) / 2 - minY * scale;
const groupAttrs = Object.entries(glyph.group).map(([k, v]) => ` ${k}="${v}"`).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}">
  <!-- Glyph: ${glyph.source}, the icon BB shows for ${manifest.bb?.name ?? manifest.name}. -->
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="${TILE}" height="${TILE}" rx="${RADIUS}" fill="url(#bg)"/>
  <g transform="translate(${round(tx)} ${round(ty)}) scale(${round(scale)})"${groupAttrs}>
${indent(glyph.body, "    ")}
  </g>
</svg>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg);
console.log(`wrote ${relative(process.cwd(), out) || out} (${glyph.source}, ${from} → ${to})`);

// ---------------------------------------------------------------------------

function glyphFromSvg(file) {
  if (!existsSync(file)) fail(`icon file ${file} does not exist`);
  const text = readFileSync(file, "utf8");
  const root = text.match(/<svg\b([^>]*)>/i);
  const end = text.lastIndexOf("</svg>");
  if (!root || end === -1) fail(`${file} is not an SVG`);
  const attrs = Object.fromEntries(
    [...root[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
  const box = (attrs.viewBox ?? `0 0 ${parseFloat(attrs.width) || 24} ${parseFloat(attrs.height) || 24}`)
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const group = {};
  for (const key of ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]) {
    if (attrs[key] !== undefined) group[key] = key === "fill" || key === "stroke" ? recolour(attrs[key]) : attrs[key];
  }
  group.fill ??= "#fff"; // SVG's default fill is black, which would vanish on the tile
  const body = text
    .slice(root.index + root[0].length, end)
    .trim()
    .replace(/\b(fill|stroke)="(?!none"|url\()[^"]*"/g, '$1="#fff"')
    .replace(/\b(fill|stroke)\s*:\s*(?!none|url\()[^;"]+/g, "$1:#fff");
  return { box, group, body, source: relative(plugin, file) };
}

async function glyphFromHugeicons(name) {
  let exportName = mappedExport(name);
  const guessed = exportName === undefined;
  exportName ??= `${name}Icon`;
  const icons = await loadHugeicons();
  const data = icons[exportName];
  if (!Array.isArray(data)) {
    fail(
      `@hugeicons/core-free-icons has no ${exportName}` +
        (guessed ? ` (guessed from "${name}"; no mapping in components/ui). Pass --icon <path.svg>` : ""),
    );
  }
  if (guessed) console.warn(`make-logo: guessed ${exportName} for "${name}"; check the preview against BB`);
  const body = data
    .map(([tag, attrs]) => {
      const rendered = Object.entries(attrs)
        .filter(([key]) => key !== "key")
        .map(([key, value]) => ` ${kebab(key)}="${key === "fill" || key === "stroke" ? recolour(String(value)) : value}"`)
        .join("");
      return `<${tag}${rendered}/>`;
    })
    .join("\n");
  // Hugeicons draw at 1.5 in a 24px box; 2 keeps the glyph legible at 96px.
  return {
    box: [0, 0, 24, 24],
    group: { fill: "none" },
    body,
    strokeWidth: "2",
    source: `Hugeicons ${exportName.replace(/Icon$/, "")} (MIT)`,
  };
}

function mappedExport(name) {
  const dir = join(plugin, "components", "ui");
  if (!existsSync(dir)) return undefined;
  const pattern = new RegExp(`["']?\\b${name}["']?\\s*:\\s*([A-Za-z0-9_]+Icon)\\b`);
  for (const file of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const match = readFileSync(join(dir, file), "utf8").match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

async function loadHugeicons() {
  const bases = [args.hugeicons, plugin].filter(Boolean).map((base) => resolve(base));
  for (const base of bases) {
    const dir = findPackage(base, "@hugeicons/core-free-icons");
    if (dir === undefined) continue;
    // The package is "type": "module", so only its ESM entry loads.
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const esm = pkg.exports?.["."]?.import;
    const entry = (typeof esm === "string" ? esm : esm?.default) ?? pkg.module ?? pkg.main;
    return import(pathToFileURL(join(dir, entry)).href);
  }
  fail(
    "cannot find @hugeicons/core-free-icons. Install it somewhere disposable and point at it:\n" +
      '  npm i --prefix "$TMPDIR/hugeicons" @hugeicons/core-free-icons\n' +
      '  node make-logo.mjs … --hugeicons "$TMPDIR/hugeicons"',
  );
}

/** Node's lookup, by hand: the nearest node_modules/<name> at or above start. */
function findPackage(start, name) {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** Any paint except "none" and gradient references becomes white. */
function recolour(value) {
  return value === "none" || value.startsWith("url(") ? value : "#fff";
}

function kebab(key) {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function round(value) {
  return Number(value.toFixed(4)).toString();
}

function indent(text, pad) {
  return text
    .split("\n")
    .map((line) => pad + line.trim())
    .join("\n");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith("--")) fail(`unexpected argument "${arg}"`);
    const value = argv[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    parsed[arg.slice(2)] = value;
  }
  return parsed;
}

function fail(message) {
  console.error(`make-logo: ${message}`);
  process.exit(1);
}

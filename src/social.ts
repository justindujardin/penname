/** Social preview cards.
 *
 * A link pasted into Slack, X, LinkedIn, or Discord shows whatever the page's
 * og/twitter meta names, and the scrapers want one image: 1200×630, PNG or
 * JPEG, at an absolute URL. SVG is not accepted, so this is the one place the
 * engine rasterizes. The card is composed as an SVG string the way figures
 * are (the masthead in miniature beside one figure of the site's own
 * vocabulary) and rendered by resvg, a Rust renderer that needs neither a
 * browser nor system libraries. Fonts are files to it, so the Plex faces the
 * web theme uses ship in assets/fonts. See docs/social.md.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import type { SocialSpec, Vocabulary } from "./types.js";

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONT_FILES = ["IBMPlexSans-Regular.ttf", "IBMPlexSans-SemiBold.ttf", "IBMPlexMono-Regular.ttf"].map((f) =>
  join(engineRoot, "assets", "fonts", f),
);

export const CARD_W = 1200;
export const CARD_H = 630;

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── the head tags ────────────────────────────────────────────────────────

export interface SocialImage {
  /** Absolute URL. */
  url: string;
  width?: number;
  height?: number;
}

export interface SocialMeta {
  /** Absolute page URL. */
  url: string;
  title: string;
  description?: string;
  image?: SocialImage;
}

/** A plain description, the Open Graph set, and the Twitter card. */
export function socialMetaHtml(m: SocialMeta): string {
  const tag = (attr: string, name: string, content: string | number | undefined) =>
    content === undefined || content === "" ? "" : `\n<meta ${attr}="${name}" content="${escAttr(String(content))}">`;
  return (
    tag("name", "description", m.description) +
    tag("property", "og:type", "article") +
    tag("property", "og:url", m.url) +
    tag("property", "og:title", m.title) +
    tag("property", "og:description", m.description) +
    tag("property", "og:image", m.image?.url) +
    tag("property", "og:image:width", m.image?.width) +
    tag("property", "og:image:height", m.image?.height) +
    tag("name", "twitter:card", m.image ? "summary_large_image" : "summary") +
    tag("name", "twitter:title", m.title) +
    tag("name", "twitter:description", m.description) +
    tag("name", "twitter:image", m.image?.url)
  );
}

export interface SocialPage {
  /** The site's address. Without it only the plain description is emitted:
   * nothing else in the set can be absolute. */
  site?: string;
  /** Page path from the site root: "" for the index, "tutorial.html", "chapter/". */
  page: string;
  title: string;
  description?: string;
  /** The card, as buildCard returned it; pages that share one pass it along. */
  image?: BuiltCard;
}

/** The head fragment for one page. */
export function socialHead(p: SocialPage): string {
  if (!p.site) return p.description ? `\n<meta name="description" content="${escAttr(p.description)}">` : "";
  const base = p.site.replace(/\/$/, "");
  return socialMetaHtml({
    url: `${base}/${p.page}`,
    title: p.title,
    description: p.description,
    image: p.image ? { url: `${base}/${p.image.path}`, width: p.image.width, height: p.image.height } : undefined,
  });
}

/** The opening of a text, cut at a sentence boundary under `max` characters;
 * a first sentence longer than that is cut at a word with an ellipsis. */
export function descriptionFrom(text: string | undefined, max = 200): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // sentence ends: punctuation followed by a space or the end ("et al.," is
  // not one); the longest run of whole sentences under the limit wins
  let out = "";
  for (const m of flat.matchAll(/[.!?]+(?=\s|$)/g)) {
    const upTo = flat.slice(0, m.index! + m[0].length);
    if (upTo.length > max) break;
    out = upTo;
  }
  if (out) return out;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

// ── composing the card ───────────────────────────────────────────────────

/** `--name: value` pairs from every :root block of a stylesheet, later blocks
 * winning. The build concatenates the engine base with the project theme,
 * so a theme that re-points tokens is read second. */
export function rootTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of css.matchAll(/:root\s*\{([^}]*)\}/g))
    for (const m of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** HTML named entities that are not XML's own five; figures may emit them
 * and the rasterizer parses XML. Unknown names are dropped. */
const ENTITIES: Record<string, string> = {
  nbsp: " ", thinsp: " ", ensp: " ", emsp: " ", middot: "·", times: "×",
  minus: "−", plusmn: "±", deg: "°", hellip: "…", ndash: "–", mdash: "—", rarr: "→", larr: "←",
  uarr: "↑", darr: "↓", le: "≤", ge: "≥", ne: "≠", approx: "≈", infin: "∞", pi: "π", theta: "θ",
  sigma: "σ", copy: "©",
};
const xmlEntities = (s: string) =>
  s.replace(/&([a-zA-Z]+);/g, (all, name: string) =>
    name in ENTITIES ? ENTITIES[name] : ["amp", "lt", "gt", "quot", "apos"].includes(name) ? all : "",
  );

export interface FigureSvg {
  /** Markup between the figure's <svg> tags. */
  inner: string;
  viewBox: string;
}

/** The first <svg>…</svg> of a rendered figure, with its viewBox. Renderers
 * wrap the chart in HTML chrome (a title line, readouts, preset chips) that
 * the card leaves behind; nested <svg> elements are kept whole. Null when
 * the render holds no SVG at all. */
export function extractSvg(html: string): FigureSvg | null {
  const open = html.search(/<svg\b/);
  if (open < 0) return null;
  const tagEnd = html.indexOf(">", open);
  if (tagEnd < 0) return null;
  const attrs = html.slice(open + 4, tagEnd);
  const re = /<svg\b|<\/svg\s*>/g;
  re.lastIndex = tagEnd + 1;
  let depth = 1;
  let close = -1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      close = m.index;
      break;
    }
  }
  if (close < 0) return null;
  const vb = /viewBox="([^"]+)"/.exec(attrs)?.[1];
  const w = /\bwidth="([\d.]+)"/.exec(attrs)?.[1];
  const h = /\bheight="([\d.]+)"/.exec(attrs)?.[1];
  const viewBox = vb ?? (w && h ? `0 0 ${w} ${h}` : null);
  if (!viewBox) return null;
  return { inner: xmlEntities(html.slice(tagEnd + 1, close)), viewBox };
}

/** Average glyph advance of Plex Sans SemiBold in em, with a little slack:
 * the rasterizer measures nothing until it draws. */
const ADVANCE = 0.58;

/** Greedy word wrap by average advance, stepping the size down until the
 * title fits `maxLines`; at the last size the last line is cut with an
 * ellipsis and `truncated` says so. */
export function wrapTitle(
  title: string,
  maxWidth: number,
  sizes: number[] = [64, 56, 48],
  maxLines = 3,
): { lines: string[]; size: number; truncated: boolean } {
  const words = title.split(/\s+/).filter(Boolean);
  let last = { lines: [title], size: sizes[0], truncated: false };
  for (const size of sizes) {
    const cap = Math.max(1, Math.floor(maxWidth / (size * ADVANCE)));
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (next.length <= cap || !cur) cur = next;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines) return { lines, size, truncated: false };
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(1, cap - 1)).replace(/\s+\S*$/, "")}…`;
    last = { lines: kept, size, truncated: true };
  }
  return last;
}

export interface CardInput {
  kicker: string;
  title: string;
  /** Tried in the title's place when the title would be truncated. */
  shortTitle?: string;
  byline?: string;
  /** The site's host name, printed at the foot of the card. */
  host: string;
  /** Theme tokens (--bg, --text, …) as rootTokens reads them; a missing one
   * falls back to the engine's web base. */
  tokens: Record<string, string>;
  figure?: FigureSvg | null;
}

const FALLBACK: Record<string, string> = {
  bg: "#f6f1e6",
  text: "#453425",
  "text-dim": "#6b5a45",
  "text-faint": "#8d7c64",
  link: "#45788c",
  border: "#d5c9af",
};

/** The card as SVG: the masthead in miniature on the left (kicker, title,
 * byline, host), the figure's chart on the right in a 488×540 box. Without
 * a figure the text column takes the full width. Everything is inline
 * attributes; nothing here needs a stylesheet. */
export function cardSvg(c: CardInput): string {
  const t = (k: string) => c.tokens[k] ?? FALLBACK[k];
  const pad = 72;
  const colW = c.figure ? 528 : CARD_W - 2 * pad;
  let wrap = wrapTitle(c.title, colW);
  if (wrap.truncated && c.shortTitle) {
    const alt = wrapTitle(c.shortTitle, colW);
    if (!alt.truncated) wrap = alt;
  }
  const lineH = wrap.size * 1.15;
  const firstBase = 158 + wrap.size * 0.8;
  const titleLines = wrap.lines
    .map((l, i) => `<tspan x="${pad}" y="${(firstBase + i * lineH).toFixed(1)}">${escText(l)}</tspan>`)
    .join("");
  const bylineY = firstBase + (wrap.lines.length - 1) * lineH + 54;
  const fig = c.figure
    ? `<svg x="640" y="45" width="488" height="540" viewBox="${escAttr(c.figure.viewBox)}" preserveAspectRatio="xMidYMid meet">${c.figure.inner}</svg>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
<rect width="${CARD_W}" height="${CARD_H}" fill="${t("bg")}"/>
<text x="${pad}" y="118" font-family="IBM Plex Mono" font-size="22" letter-spacing="4" fill="${t("link")}">${escText(c.kicker.toUpperCase())}</text>
<text font-family="IBM Plex Sans" font-weight="600" font-size="${wrap.size}" letter-spacing="-0.5" fill="${t("text")}">${titleLines}</text>
${c.byline ? `<text x="${pad}" y="${bylineY.toFixed(1)}" font-family="IBM Plex Sans" font-size="26" fill="${t("text-dim")}">${escText(c.byline)}</text>` : ""}
<line x1="${pad}" y1="536" x2="${pad + 56}" y2="536" stroke="${t("border")}" stroke-width="2"/>
<text x="${pad}" y="574" font-family="IBM Plex Mono" font-size="22" fill="${t("text-faint")}">${escText(c.host)}</text>
${fig}
</svg>`;
}

/** SVG string to PNG bytes through resvg, with the bundled Plex faces only,
 * so every machine renders the same bytes. Generic families in a figure's
 * own text map onto the same faces. */
export function renderCardPng(svg: string): Buffer {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_W },
    font: {
      fontFiles: FONT_FILES,
      loadSystemFonts: false,
      defaultFontFamily: "IBM Plex Sans",
      sansSerifFamily: "IBM Plex Sans",
      serifFamily: "IBM Plex Sans",
      monospaceFamily: "IBM Plex Mono",
    },
  });
  return Buffer.from(r.render().asPng());
}

// ── one document's card ──────────────────────────────────────────────────

export interface BuiltCard {
  /** dist-relative path. */
  path: string;
  width?: number;
  height?: number;
}

export interface CardJob {
  root: string;
  dist: string;
  /** Output path relative to dist, e.g. "social.png" or "chapter/social.png";
   * a shipped image keeps its own extension. */
  out: string;
  social?: SocialSpec;
  vocabulary?: Vocabulary;
  kicker: string;
  title: string;
  shortTitle?: string;
  byline?: string;
  host: string;
  /** The page's stylesheet text, for the theme tokens. */
  webCss: string;
  /** Names the document in errors. */
  source: string;
}

/** Writes one document's card into dist. `social.image` is copied as it is;
 * `social.figure` goes through the vocabulary's parse and resolve like a
 * fence and its chart is placed beside the text; neither gives a text-only
 * card. Every failure is the build's, not the reader's. */
export function buildCard(job: CardJob): BuiltCard {
  const social = job.social;
  if (social?.image) {
    const src = join(job.root, social.image);
    if (!existsSync(src)) throw new Error(`${job.source}: social.image "${social.image}" does not exist`);
    const path = job.out.replace(/\.png$/, extname(src).toLowerCase());
    mkdirSync(dirname(join(job.dist, path)), { recursive: true });
    copyFileSync(src, join(job.dist, path));
    return { path };
  }
  let figure: FigureSvg | null = null;
  if (social?.figure !== undefined) {
    if (!job.vocabulary) throw new Error(`${job.source}: social.figure needs a vocabulary in the build config`);
    const json = typeof social.figure === "string" ? social.figure : JSON.stringify(social.figure);
    let spec = job.vocabulary.parse(json);
    if (job.vocabulary.resolve) spec = job.vocabulary.resolve(spec as never, { root: job.root }) as typeof spec;
    figure = extractSvg(job.vocabulary.render(spec));
    if (!figure)
      throw new Error(
        `${job.source}: social.figure kind "${spec.kind}" renders no <svg>; the card needs an SVG chart (an HTML figure can ship a ready picture with social.image instead)`,
      );
  }
  const svg = cardSvg({
    kicker: job.kicker,
    title: social?.title ?? job.title,
    shortTitle: social?.title ? undefined : job.shortTitle,
    byline: job.byline,
    host: job.host,
    tokens: rootTokens(job.webCss),
    figure,
  });
  mkdirSync(dirname(join(job.dist, job.out)), { recursive: true });
  writeFileSync(join(job.dist, job.out), renderCardPng(svg));
  return { path: job.out, width: CARD_W, height: CARD_H };
}

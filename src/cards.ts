/** ```cards fences: the works a YAML file lists, as a grid of cards on the
 * web and a compact list in print.
 *
 *   ```cards
 *   { "src": "works.yaml", "group": "research" }
 *   ```
 *
 * The file holds every entry for the page; a fence shows one group of
 * it. A card has a title that links somewhere, a one-line blurb, and a
 * meta line of whatever the entry carries: a date or a span of years, a
 * star count, more links. Whether a thing is alive is what the years
 * say ("2020 to now", "2015 to 2018"); a status chip is only for a state
 * the reader has to act on, from a closed word list. Like
 * embeds, the pass runs on the raw markdown before the pipeline and
 * throws on any problem, so a broken entry fails the BUILD, not the
 * reader: a missing href, a status off the list, a group no fence asks
 * for, a local image that is not there. A remote image is taken on faith
 * and warned about, since the build should not depend on another site
 * being up. An entry marked `draft` is checked but not shown.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { displayHref } from "./shell.js";

export const CARD_STATUSES = ["deprecated", "archived", "experiment"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export interface CardLink {
  label: string;
  href: string;
}

/** One entry of the works file. Every text field is shown as written. */
export interface CardEntry {
  /** Which fence shows it. */
  group: string;
  title: string;
  /** Where the title (and the whole card, on the web) goes. A draft may
   * have nowhere to go yet. */
  href?: string;
  blurb?: string;
  /** Repo-relative path, copied into dist, or an absolute URL. */
  image?: string;
  /** A state the reader acts on: don't build on this (`deprecated`,
   * `archived`), or it never shipped (`experiment`). Most entries have
   * none. */
  status?: CardStatus;
  /** Shown as written: "September 2026", "2020 to now", "2015 to 2018". */
  date?: string;
  years?: string;
  /** Kept current by a refresh script, not by hand. Zero is not shown. */
  stars?: number;
  /** More links in the meta line: a PDF, the code. */
  links?: CardLink[];
  /** Checked like the others and left off the page. */
  draft?: boolean;
}

interface CardsSpec {
  src: string;
  group: string;
}

export interface CardsResult {
  /** The markdown with every fence replaced by its HTML. */
  md: string;
  /** Repo-relative image paths the cards reference, for the build to copy. */
  images: string[];
  /** Cards shown. */
  count: number;
}

const FENCE = /^```cards\n([\s\S]*?)\n```$/gm;

// a dollar sign is escaped too: the pipeline's math pass runs over the
// prose around a fence after this pass has replaced it
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\$/g, "&#36;");

const isRemote = (path: string) => /^https?:\/\//.test(path);

export function cardsPass(body: string, root: string): CardsResult {
  const specs: CardsSpec[] = [];
  for (const m of body.matchAll(FENCE)) specs.push(parseSpec(m[1]));
  if (specs.length === 0) return { md: body, images: [], count: 0 };

  // one load and one validation per file, however many fences read it
  const files = new Map<string, CardEntry[]>();
  for (const src of new Set(specs.map((s) => s.src))) {
    const entries = loadEntries(root, src);
    const asked = new Set(specs.filter((s) => s.src === src).map((s) => s.group));
    for (const e of entries) {
      if (!e.draft && !asked.has(e.group))
        throw new Error(
          `${src}: "${e.title}" is in group "${e.group}", which no cards fence asks for (asked: ${[...asked].join(", ")})`,
        );
    }
    files.set(src, entries);
  }

  const images = new Set<string>();
  let count = 0;
  const md = body.replace(FENCE, (_, json: string) => {
    const spec = parseSpec(json);
    const shown = files.get(spec.src)!.filter((e) => e.group === spec.group && !e.draft);
    if (shown.length === 0) throw new Error(`${spec.src}: no entries in group "${spec.group}"`);
    count += shown.length;
    for (const e of shown) if (e.image && !isRemote(e.image)) images.add(e.image);
    return cardsHtml(spec.group, shown);
  });
  return { md, images: [...images], count };
}

/** The markup, one line per element: markdown-it treats a raw block as
 * HTML only until the first blank line. */
export function cardsHtml(group: string, entries: CardEntry[]): string {
  const cards = entries.map((e) => {
    const status = e.status ? `<span class="card-status card-status-${e.status}">${e.status}</span>` : "";
    const image = e.image ? `<img class="card-image" src="${esc(e.image)}" alt="" loading="lazy">` : "";
    const meta: string[] = [];
    if (e.date) meta.push(`<span>${esc(e.date)}</span>`);
    if (e.years) meta.push(`<span>${esc(e.years)}</span>`);
    if (e.stars) meta.push(`<span>${e.stars.toLocaleString("en-US")} stars</span>`);
    // the address rides along for print, where the stylesheet shows it
    for (const l of e.links ?? [])
      meta.push(`<a href="${esc(l.href)}">${esc(l.label)}<span class="link-url"> ${esc(displayHref(l.href))}</span></a>`);
    return (
      `<article class="card">` +
      image +
      `<div class="card-body">` +
      `<div class="card-head"><h3 class="card-title"><a href="${esc(e.href!)}">${esc(e.title)}</a></h3>${status}</div>` +
      (e.blurb ? `<p class="card-blurb">${esc(e.blurb)}</p>` : "") +
      (meta.length ? `<div class="card-meta">${meta.join("")}</div>` : "") +
      `</div></article>`
    );
  });
  return `<section class="cards" data-group="${esc(group)}">\n${cards.join("\n")}\n</section>`;
}

function parseSpec(json: string): CardsSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`cards fence is not valid JSON: ${json.trim().slice(0, 80)}`);
  }
  const { src, group } = raw as Partial<CardsSpec>;
  if (typeof src !== "string" || !src) throw new Error(`cards fence needs a "src" path`);
  if (typeof group !== "string" || !group) throw new Error(`cards fence ${src}: needs a "group" name`);
  return { src, group };
}

function loadEntries(root: string, src: string): CardEntry[] {
  const path = join(root, src);
  if (!existsSync(path)) throw new Error(`cards: ${src} not found under ${root}`);
  const raw = parseYaml(readFileSync(path, "utf-8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${src}: expected a YAML list of entries`);
  return raw.map((e, i) => checkEntry(e, `${src} entry ${i + 1}`, root));
}

function checkEntry(raw: unknown, where: string, root: string): CardEntry {
  if (typeof raw !== "object" || raw === null) throw new Error(`${where}: not a mapping`);
  const e = raw as Record<string, unknown>;
  const name = typeof e.title === "string" ? `${where} ("${e.title}")` : where;
  const str = (key: string, required = false): string | undefined => {
    const v = e[key];
    if (v === undefined || v === null) {
      if (required) throw new Error(`${name}: needs a "${key}"`);
      return undefined;
    }
    if (typeof v !== "string" || !v.trim()) throw new Error(`${name}: "${key}" must be a non-empty string`);
    return v.trim();
  };
  const title = str("title", true)!;
  const group = str("group", true)!;
  if (e.draft !== undefined && typeof e.draft !== "boolean") throw new Error(`${name}: "draft" must be true or false`);
  const href = str("href", e.draft !== true);
  const status = str("status");
  if (status !== undefined && !(CARD_STATUSES as readonly string[]).includes(status))
    throw new Error(`${name}: status "${status}" is not one of ${CARD_STATUSES.join(", ")}`);
  const image = str("image");
  if (image !== undefined) {
    if (isRemote(image)) console.warn(`[cards] ${name}: image ${image} is remote; taken on faith`);
    else if (!existsSync(join(root, image))) throw new Error(`${name}: image "${image}" does not exist`);
  }
  if (e.stars !== undefined && (typeof e.stars !== "number" || !Number.isInteger(e.stars) || e.stars < 0))
    throw new Error(`${name}: "stars" must be a whole number`);
  const links = e.links === undefined ? undefined : checkLinks(e.links, name);
  // a bare year in YAML is a number; a card shows it as written
  const asText = (key: string) => (typeof e[key] === "number" ? String(e[key]) : str(key));
  return {
    group,
    title,
    href,
    blurb: str("blurb"),
    image,
    status: status as CardStatus | undefined,
    date: asText("date"),
    years: asText("years"),
    stars: e.stars as number | undefined,
    links,
    draft: e.draft as boolean | undefined,
  };
}

function checkLinks(raw: unknown, where: string): CardLink[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: "links" must be a list`);
  return raw.map((l, i) => {
    const link = l as Partial<CardLink> | null;
    if (!link || typeof link.label !== "string" || typeof link.href !== "string" || !link.label || !link.href)
      throw new Error(`${where}: link ${i + 1} needs a label and an href`);
    return { label: link.label, href: link.href };
  });
}

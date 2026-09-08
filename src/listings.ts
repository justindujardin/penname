/** Code listings with a marked region: the part the reader should see
 * before choosing to see all of it.
 *
 * A source file (or a hand-written fence) marks the region with the
 * editor folding convention, so the author's editor and the build agree
 * on what the fold is:
 *
 *   # region                      // #region core
 *   ...the lines that matter...   ...
 *   # endregion                   // #endregion
 *
 * Any comment leader works (#, //, --, ;, %, or a slash-star block); the
 * markers themselves never print. A file may hold several named regions;
 * the embed spec's "region" picks one, and an unnamed pick with more than
 * one region fails the build. No markers means no region: the fence
 * renders as an ordinary code block and the runtime's line-count fold
 * applies.
 *
 * With a region the build emits one structure that both outputs use:
 *
 *   <div class="listing" data-lines="48" data-path="…">
 *     <pre class="listing-region"><code>…</code></pre>
 *     <details class="listing-more"><summary>show all 48 lines</summary>
 *       <pre class="listing-full"><code>…</code></pre></details>
 *   </div>
 *
 * Web: the region shows; the details holds the whole file and, once open,
 * CSS hides the region so nothing is shown twice. No JavaScript involved,
 * so the no-JS reader has the same page. Print (`listingsForPdf`): the
 * region prints inline with a page-numbered link to a listings appendix
 * that holds every full file.
 */

const MARKER = /^\s*(?:#|\/\/|--|;+|%|\/\*)\s*#?\s*(region|endregion)\b[ \t]*(.*?)\s*(?:\*\/)?\s*$/i;

export interface Region {
  name: string;
  /** Line indexes into the marker-stripped source, end exclusive. */
  start: number;
  end: number;
}

export interface SplitListing {
  /** The source with every marker line removed. */
  source: string;
  regions: Region[];
}

/** Strip region markers out of a listing and record where each region
 * stood. Nesting and unbalanced markers fail the build. */
export function splitRegions(source: string, where: string): SplitListing {
  const kept: string[] = [];
  const regions: Region[] = [];
  let open: { name: string; start: number } | null = null;
  for (const line of source.split("\n")) {
    const m = MARKER.exec(line);
    if (!m) {
      kept.push(line);
      continue;
    }
    const [, kind, name] = m;
    if (kind.toLowerCase() === "region") {
      if (open) throw new Error(`${where}: region "${name || open.name}" opens inside region "${open.name}" (regions do not nest)`);
      open = { name: name.trim(), start: kept.length };
    } else {
      if (!open) throw new Error(`${where}: endregion without an open region`);
      regions.push({ name: open.name, start: open.start, end: kept.length });
      open = null;
    }
  }
  if (open) throw new Error(`${where}: region "${open.name}" is never closed`);
  const names = regions.map((r) => r.name).filter(Boolean);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`${where}: region "${dup}" is defined twice`);
  return { source: kept.join("\n"), regions };
}

/** Pick the region a listing shows: the named one, or the only one. */
export function pickRegion(split: SplitListing, name: string | undefined, where: string): Region | null {
  if (name !== undefined) {
    const r = split.regions.find((r) => r.name === name);
    if (!r) {
      const have = split.regions.map((r) => r.name || "(unnamed)").join(", ") || "none";
      throw new Error(`${where}: no region named "${name}" (regions: ${have})`);
    }
    return r;
  }
  if (split.regions.length === 0) return null;
  if (split.regions.length > 1) {
    const have = split.regions.map((r) => r.name || "(unnamed)").join(", ");
    throw new Error(`${where}: ${split.regions.length} regions (${have}) — say which with "region"`);
  }
  return split.regions[0];
}

export interface ListingInfo {
  lang: string;
  /** Source path when the fence came from an embed; drives the label. */
  path?: string;
  region?: string;
}

/** Parse a fence info string: the language, then `key=value` tokens. */
export function parseListingInfo(info: string): ListingInfo {
  const [lang = "", ...rest] = info.trim().split(/\s+/);
  const out: ListingInfo = { lang };
  for (const tok of rest) {
    const eq = tok.indexOf("=");
    if (eq === -1) continue;
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1);
    if (key === "embed") out.path = val;
    else if (key === "region") out.region = val;
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render a code fence that carries a region. Returns null when it holds
 * none, so the caller can fall back to the ordinary fence renderer. */
export function listingHtml(
  content: string,
  info: ListingInfo,
  highlight: (str: string, lang: string) => string,
): string | null {
  const where = info.path ?? "code fence";
  const split = splitRegions(content.replace(/\n$/, ""), where);
  const region = pickRegion(split, info.region, where);
  if (!region) return null;
  const lines = split.source.split("\n");
  const total = lines.length;
  const regionSrc = lines.slice(region.start, region.end).join("\n");
  const code = (src: string) => {
    const hl = highlight(src, info.lang);
    const cls = info.lang ? ` class="language-${esc(info.lang)}"` : "";
    return `<code${cls}>${hl || esc(src)}</code>`;
  };
  const name = info.path ? info.path.split("/").pop() ?? info.path : "";
  const pathAttr = info.path ? ` data-path="${esc(info.path)}"` : "";
  return (
    `<div class="listing" data-lines="${total}"${pathAttr}>` +
    `<pre class="listing-region">${code(regionSrc)}</pre>` +
    `<details class="listing-more"><summary class="btn">` +
    `<span class="listing-when-closed">show all ${total} lines${name ? ` of ${esc(name)}` : ""} ▾</span>` +
    `<span class="listing-when-open">collapse listing ▴</span>` +
    `</summary><pre class="listing-full">${code(split.source)}</pre></details>` +
    `</div>\n`
  );
}

export interface ListingAppendix {
  html: string;
  /** The appendix section, or "" when the article holds no listings. */
  appendix: string;
  count: number;
}

/** The print divergence: each listing keeps its region inline, followed by
 * a page-numbered link to the appendix entry holding the full file. `label`
 * names entry i (0-based), e.g. "B.1"; `title` and `id` head the section. */
export function listingsForPdf(
  html: string,
  opts: { label: (i: number) => string; title: string; id: string },
): ListingAppendix {
  const entries: string[] = [];
  const out = html.replace(
    /<div class="listing" data-lines="(\d+)"(?: data-path="([^"]*)")?>([\s\S]*?)<\/div>\n?/g,
    (_, _lines: string, path: string | undefined, inner: string) => {
      const region = /<pre class="listing-region">[\s\S]*?<\/pre>/.exec(inner)?.[0] ?? "";
      const full = /<pre class="listing-full">[\s\S]*?<\/pre>/.exec(inner)?.[0] ?? "";
      const i = entries.length;
      const label = opts.label(i);
      const name = path ? esc(path) : `Listing ${i + 1}`;
      entries.push(`<h2 id="listing-app-${i + 1}">${label} ${name}</h2>${full}`);
      return (
        `<div class="listing listing-print">${region}` +
        `<p class="listing-ref">Full listing — <a href="#listing-app-${i + 1}">${label}: ${name}</a></p></div>\n`
      );
    },
  );
  const appendix = entries.length
    ? `<section class="appendix listings-appendix"><h1 id="${opts.id}">${esc(opts.title)}</h1>${entries.join("")}</section>`
    : "";
  return { html: out, appendix, count: entries.length };
}

/** Page shells: <head> and the masthead header shared by web and PDF. */

import { parse as parseYaml } from "yaml";

import { DEFAULT_FONTS_HREF, type Frontmatter } from "./types.js";

export function headHtml(
  title: string,
  cssHref: string,
  opts: { fonts?: string; assetPrefix?: string; meta?: string } = {},
): string {
  const prefix = opts.assetPrefix ?? "";
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${opts.meta ?? ""}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="${opts.fonts ?? DEFAULT_FONTS_HREF}" rel="stylesheet">
<link rel="stylesheet" href="${prefix}assets/katex/katex.min.css">
<link rel="stylesheet" href="${prefix}${cssHref}">`;
}

export function authorsHtml(fm: Frontmatter): string {
  return (
    fm.authors
      .map((a) => {
        const affil = a.affiliation ? `<span class="affil"> · ${a.affiliation}</span>` : "";
        const email = a.email ? `<span class="affil"> · <a href="mailto:${a.email}">${a.email}</a></span>` : "";
        return `<span class="author">${a.name}${affil}${email}</span>`;
      })
      .join("") + (fm.credit ? `<div class="credit">${fm.credit}</div>` : "")
  );
}

export function mastheadHtml(fm: Frontmatter, opts: { kicker: string; pdfName?: string }): string {
  // The dateline shows only what the frontmatter declares: a date if there
  // is one; a DOI link if `doi` is set, "DOI pending" if it is declared but
  // empty, nothing at all if the key is absent; the PDF link if a PDF is
  // built. A book with no date and no doi key gets no dateline.
  const parts: string[] = [];
  if (fm.date) parts.push(String(fm.date));
  if (fm.doi) parts.push(`<a class="doi" target="_blank" rel="noopener" href="https://doi.org/${fm.doi}">doi:${fm.doi}</a>`);
  else if (fm.doi === "") parts.push(`<span class="doi pending">DOI pending</span>`);
  if (opts.pdfName) parts.push(`<a target="_blank" rel="noopener" href="${opts.pdfName}">PDF</a>`);
  return `<header class="masthead" id="top">
<div class="kicker">${fm.kicker ?? opts.kicker}</div>
<h1 class="doc-title">${fm.title}</h1>
<div class="byline">${authorsHtml(fm)}</div>
${parts.length ? `<div class="dateline">${parts.join(" · ")}</div>` : ""}
${fm.abstract ? `<div class="abstract"><span class="abs-label">Abstract</span> ${fm.abstract.trim()}</div>` : ""}
</header>`;
}

/** Frontmatter split shared by notes and book chapters. */
export function splitFrontmatter<T>(raw: string, sourceName: string): { fm: T; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`${sourceName} must start with YAML frontmatter`);
  return { fm: parseYaml(match[1]) as T, body: raw.slice(match[0].length) };
}

// ── panel layout: a control-panel shell with a left nav ─────────────────

export interface PanelGroup {
  label: string;
  items: { href: string; label: string; num?: string; current?: boolean }[];
  /** Render as a collapsed <details> group (open when it holds the current page). */
  collapsed?: boolean;
}

export interface PanelNav {
  brand: string;
  kicker?: string;
  /** Path from the current page to the site root ("", "../", "../../"). */
  prefix: string;
  groups: PanelGroup[];
  /** Relative path of the search index, from the site root. */
  searchIndex?: string;
  /** Show the nicknames switch (needs a glossary and the runtime). */
  plainToggle?: boolean;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The left nav of a panel-layout page: brand, search, the chapter groups,
 * and the appendix links. The consumer's hydrate entry calls
 * `enablePanel()` to switch on search and the narrow-screen toggle;
 * without JavaScript the lists are simply there. */
export function panelNavHtml(nav: PanelNav): string {
  const groups = nav.groups
    .map((g) => {
      const items = g.items
        .map(
          (it) =>
            `<li><a href="${nav.prefix}${it.href}"${it.current ? ' aria-current="page"' : ""}>` +
            `${it.num ? `<span class="num">${escText(it.num)}</span>` : ""}<span>${escText(it.label)}</span></a></li>`,
        )
        .join("");
      if (g.collapsed) {
        const open = g.items.some((it) => it.current) ? " open" : "";
        return `<details class="side-group side-details"${open}><summary class="side-label">${escText(g.label)}</summary><ul>${items}</ul></details>`;
      }
      return `<div class="side-group"><div class="side-label">${escText(g.label)}</div><ol>${items}</ol></div>`;
    })
    .join("");
  const search = nav.searchIndex
    ? `<div class="side-search"><input type="search" class="side-search-input" placeholder="search" aria-label="search" ` +
      `data-index="${nav.prefix}${nav.searchIndex}" data-prefix="${nav.prefix}"><div class="side-results" hidden></div></div>`
    : "";
  return (
    `<nav class="side" aria-label="site">` +
    `<div class="side-head"><a class="side-brand" href="${nav.prefix || "./"}">${escText(nav.brand)}</a>` +
    `${nav.kicker ? `<div class="side-kicker">${escText(nav.kicker)}</div>` : ""}` +
    `<button class="side-toggle" type="button" aria-expanded="false">menu</button></div>` +
    search +
    `<div class="side-lists">${groups}` +
    (nav.plainToggle
      ? `<label class="side-plain"><input type="checkbox" class="side-plain-toggle"> nicknames <span class="side-plain-note">call the field's words by the book's names for them</span></label>`
      : "") +
    `</div></nav>`
  );
}

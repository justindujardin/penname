/** Table-of-contents generation from collected headings. */

import type { TocEntry } from "./types.js";

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A flat list styled by level — WeasyPrint fills in the page numbers via
 * target-counter; on the web the same markup is plain anchor links. `hrefs`
 * prefixes every anchor (book chapters link into their own pages). */
export function tocHtml(
  entries: TocEntry[],
  depth: number,
  opts: { title?: string; hrefPrefix?: (e: TocEntry) => string } = {},
): string {
  const rows = entries
    .filter((e) => e.level <= depth)
    .map((e) => {
      const href = `${opts.hrefPrefix?.(e) ?? ""}#${e.id}`;
      return `<li class="toc-${e.level}"><a href="${href}">${escHtml(e.text)}</a></li>`;
    })
    .join("\n");
  if (!rows) return "";
  return `<nav class="toc"><div class="toc-title">${opts.title ?? "Contents"}</div><ol>\n${rows}\n</ol></nav>`;
}

// ── the floating panel (toc.web: "float") ───────────────────────────────

interface TocNode extends TocEntry {
  children: TocNode[];
}

/** Headings as a tree. A heading nests under the nearest shallower one
 * before it; a document that opens on an h2 gets that h2 at the top. */
function nest(entries: TocEntry[], depth: number): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  for (const e of entries) {
    if (e.level > depth) continue;
    const node: TocNode = { ...e, children: [] };
    while (stack.length && stack[stack.length - 1].level >= e.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

/** "2.1 Method" → ["2.1", "Method"]; "1. Introduction" → ["1",
 * "Introduction"]; an unnumbered heading keeps its text whole. */
function splitNumber(text: string): [string | null, string] {
  const m = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/.exec(text);
  return m ? [m[1], m[2]] : [null, text];
}

function nodesHtml(nodes: TocNode[]): string {
  return (
    "<ol>" +
    nodes
      .map((n) => {
        const [num, text] = splitNumber(n.text);
        const label =
          (num ? `<span class="toc-num">${num}</span>` : "") + `<span class="toc-text">${escHtml(text)}</span>`;
        const attrs = num ? ` data-num="${num}"` : "";
        return (
          `<li class="toc-${n.level}"><a href="#${n.id}"${attrs}>${label}</a>` +
          (n.children.length ? nodesHtml(n.children) : "") +
          `</li>`
        );
      })
      .join("") +
    "</ol>"
  );
}

/** Opens the panel on wide screens (the docked geometry, which the CSS
 * names through --toc-mode) unless the reader closed it last time, and
 * remembers a close. Inline beside the panel so the page never paints
 * closed and then jumps open; the hydrate bundle, when there is one,
 * adds the rest. */
const FLOAT_SCRIPT =
  `(function(d){if(!d)return;var m=function(){return getComputedStyle(d).getPropertyValue("--toc-mode").trim()};` +
  `try{if(m()==="dock"&&localStorage.getItem("penname:toc")!=="closed")d.open=true}catch(e){}` +
  `d.addEventListener("toggle",function(){try{if(m()==="dock")localStorage.setItem("penname:toc",d.open?"open":"closed")}catch(e){}})` +
  `})(document.currentScript.previousElementSibling)`;

/** The floating contents panel: one <details> whose summary is the tab
 * and whose body is the nested section list, opening with a row for the
 * top of the page (`top`: the document's short title, linking to the
 * masthead). It ships closed, so a reader without JavaScript gets a tab
 * that opens a plain list, and the script beside it opens it on wide
 * screens. */
export function tocFloatHtml(
  entries: TocEntry[],
  depth: number,
  opts: { title?: string; top?: { text: string; id: string } } = {},
): string {
  const nodes = nest(entries, depth);
  if (!nodes.length) return "";
  const top = opts.top
    ? `<li class="toc-top"><a href="#${opts.top.id}"><span class="toc-text">${escHtml(opts.top.text)}</span></a></li>`
    : "";
  return (
    `<details class="toc-float">` +
    `<summary class="toc-tab"><span class="toc-tab-label">${opts.title ?? "Contents"}</span>` +
    `<span class="toc-tab-here"></span><span class="toc-tab-mark" aria-hidden="true"></span></summary>` +
    `<nav class="toc-panel" aria-label="contents"><div class="toc-progress"><div class="toc-progress-bar"></div></div>` +
    `<div class="toc-list">${top ? nodesHtml(nodes).replace("<ol>", `<ol>${top}`) : nodesHtml(nodes)}</div></nav>` +
    `</details><script>${FLOAT_SCRIPT}</script>`
  );
}

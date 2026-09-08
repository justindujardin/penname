/** Glossary: the field's words, annotated where they are used.
 *
 * Jargon is damned either way — the technical word gates the newcomer,
 * the plain word misleads the expert. So the page keeps the field's word
 * and marks it: a build-time pass finds every use of a glossary term in
 * prose (never in code, links, headings, or figures) and wraps it with a
 * faint highlight, so a click shows a short plain description of what it
 * means. By default only the first use in each section is marked: a page
 * that marked every use would be mostly marks. A book prints a glossary
 * appendix; a note's glossary is web-only. A book may also give a term
 * its own word (`nickname`) and offer a site-wide swap from its nav; a
 * paper leaves that out.
 *
 * An entry defines the field's word and nothing about the site that
 * wrote it: no "this book", no "in this paper". The page supplies the
 * context, so a glossary file can sit under any site that uses the
 * words. `glossary` therefore takes a list of files, merged in order, and
 * the same term in two files fails the build rather than shadowing.
 *
 *   # glossary.yaml
 *   - term: gradient
 *     forms: [gradient, gradients]          # surface forms to match; default: term, term + "s"
 *     nickname: slope                       # optional: the book's own word for it; the site-wide swap uses it
 *     explain: Every knob's derivative …    # one short paragraph, plain words
 *     concept: gradient                     # optional: a concept slug to link
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

export interface GlossaryEntry {
  slug: string;
  term: string;
  forms: string[];
  /** The site's own word for the term; an entry without one keeps the
   * field's word under the nicknames swap. */
  nickname?: string;
  explain: string;
  concept?: string;
}

/** Where a term's links go: its concept page, when the site has one for
 * the slug (null otherwise), and its own glossary entry. */
export interface GlossaryLinks {
  concept(slug: string): string | null;
  entry(slug: string): string;
}

interface RawEntry {
  term: string;
  forms?: string[];
  nickname?: string;
  /** Older name for `nickname`. */
  plain?: string;
  explain: string;
  concept?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function loadGlossary(root: string, files: string | string[]): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const seen = new Map<string, string>(); // slug -> file that defined it
  for (const file of Array.isArray(files) ? files : [files]) {
    const raw = parseYaml(readFileSync(join(root, file), "utf-8")) as RawEntry[];
    if (!Array.isArray(raw)) throw new Error(`${file}: expected a list of glossary entries`);
    raw.forEach((e, i) => {
      if (!e.term || !e.explain) throw new Error(`${file}: entry ${i + 1} needs term and explain`);
      const slug = slugify(e.term);
      const prior = seen.get(slug);
      if (prior) throw new Error(`term "${e.term}" is listed twice: ${prior} and ${file}`);
      seen.set(slug, file);
      entries.push({
        slug,
        term: e.term,
        forms: e.forms?.length ? e.forms : [e.term, `${e.term}s`],
        nickname: e.nickname ?? e.plain,
        explain: e.explain.trim(),
        concept: e.concept,
      });
    });
  }
  return entries;
}

/** Elements whose text is never annotated. */
const SKIP_TAGS = new Set([
  "a", "script", "style", "code", "pre", "kbd", "samp", "svg", "math", "figure", "summary", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "button", "input", "textarea", "select", "label", "nav", "title",
]);
const SKIP_CLASSES = ["katex", "term", "fig-", "status", "concept-kicker", "crumbs", "kicker"];
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr", "source", "col", "embed", "area", "base", "param", "track"]);

/** Which uses of a term get a mark: the first on the page, the first in
 * each section (an h1 or h2 starts one; the default), or every use. */
export type GlossaryMarks = "first" | "section" | "every";

/** Wrap uses of glossary terms in the prose of `html`. Returns the
 * annotated markup and the slugs of the terms marked, so a page can carry
 * only the entries it needs. */
export function annotateTerms(
  html: string,
  entries: GlossaryEntry[],
  opts: { marks?: GlossaryMarks } = {},
): { html: string; used: Set<string> } {
  const marks = opts.marks ?? "section";
  const byForm = new Map<string, GlossaryEntry>();
  for (const e of entries) for (const f of e.forms) byForm.set(f.toLowerCase(), e);
  const forms = [...byForm.keys()].sort((a, b) => b.length - a.length).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (forms.length === 0) return { html, used: new Set() };
  const rx = new RegExp(`(?<![\\w-])(${forms.join("|")})(?![\\w-])`, "gi");
  const used = new Set<string>();
  const seen = new Set<string>(); // marked already, within the current scope
  const skip: string[] = [];
  const out: string[] = [];
  const tokens = html.split(/(<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>)/);
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok.startsWith("<!--")) {
      out.push(tok);
      continue;
    }
    if (tok.startsWith("<")) {
      out.push(tok);
      const close = tok.startsWith("</");
      const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tok)?.[1].toLowerCase() ?? "";
      if (!close && marks === "section" && (name === "h1" || name === "h2")) seen.clear();
      if (close) {
        if (skip.length && skip[skip.length - 1] === name) skip.pop();
        continue;
      }
      if (VOID.has(name) || tok.endsWith("/>")) continue;
      const cls = /\sclass="([^"]*)"/.exec(tok)?.[1] ?? "";
      const skipped = SKIP_TAGS.has(name) || SKIP_CLASSES.some((c) => cls.includes(c));
      if (skipped || skip.length) skip.push(name); // inside a skipped element, everything nested is skipped too
      continue;
    }
    if (skip.length) {
      out.push(tok);
      continue;
    }
    out.push(
      tok.replace(rx, (m) => {
        const e = byForm.get(m.toLowerCase())!;
        if (marks !== "every" && seen.has(e.slug)) return m;
        seen.add(e.slug);
        used.add(e.slug);
        return `<span class="term" data-term="${e.slug}" title="${esc(e.explain)}">${m}</span>`;
      }),
    );
  }
  return { html: out.join(""), used };
}

/** The per-page map the runtime reads: only the terms this page uses. */
export function glossaryScript(entries: GlossaryEntry[], used: Set<string>, links: GlossaryLinks): string {
  const rows = entries
    .filter((e) => used.has(e.slug))
    .map((e) => {
      const concept = e.concept ? links.concept(e.concept) : null;
      return {
        slug: e.slug,
        term: e.term,
        nickname: e.nickname ?? "",
        explain: e.explain,
        href: concept ?? links.entry(e.slug),
        link: concept ? "the concept" : "in the glossary",
      };
    });
  return rows.length ? `<script type="application/json" class="glossary">${JSON.stringify(rows).replace(/</g, "\\u003c")}</script>` : "";
}

/** The glossary as a definition list, for its web page and the print
 * appendix. `conceptHref` turns a concept slug into the link to use, or
 * null for none; `idPrefix` keeps a note's entry ids clear of its
 * heading ids. */
export function glossaryListHtml(
  entries: GlossaryEntry[],
  conceptHref: (slug: string) => string | null,
  opts: { idPrefix?: string } = {},
): string {
  const rows = [...entries]
    .sort((a, b) => a.term.localeCompare(b.term))
    .map((e) => {
      const concept = e.concept ? conceptHref(e.concept) : null;
      return (
        `<dt id="${opts.idPrefix ?? ""}${e.slug}">${esc(e.term)}${e.nickname ? `<span class="nick">nickname: ${esc(e.nickname)}</span>` : ""}</dt>` +
        `<dd>${esc(e.explain)}${concept ? ` <a class="concept-link" href="${concept}">the concept →</a>` : ""}</dd>`
      );
    })
    .join("\n");
  return `<dl class="glossary">\n${rows}\n</dl>`;
}

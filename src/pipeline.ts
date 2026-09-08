/** The markdown → article transform: citations, KaTeX, figure fences,
 * heading anchors. One `Pipeline` instance holds citation state, so a book
 * can render many chapters and still number its references continuously.
 */

import hljs from "highlight.js/lib/core";
import katex from "katex";
import MarkdownIt from "markdown-it";

import { listingHtml, parseListingInfo } from "./listings.js";
import { slugify } from "./toc.js";
import type { Ref, TocEntry, Vocabulary } from "./types.js";

/** Register highlight.js languages by name. Returns a markdown-it
 * `highlight` function; unknown languages fall back to plain escaping. */
export async function makeHighlighter(languages: string[]): Promise<(str: string, lang: string) => string> {
  for (const lang of languages) {
    if (!hljs.getLanguage(lang)) {
      const mod = await import(`highlight.js/lib/languages/${lang}`);
      hljs.registerLanguage(lang, mod.default);
    }
  }
  return (str, lang) => (lang && hljs.getLanguage(lang) ? hljs.highlight(str, { language: lang }).value : "");
}

export interface PipelineOptions {
  root: string;
  refs?: Record<string, Ref>;
  vocabulary?: Vocabulary;
  highlight?: (str: string, lang: string) => string;
}

export interface RenderResult {
  html: string;
  headings: TocEntry[];
}

export class Pipeline {
  readonly citeOrder: string[] = [];
  mathCount = 0;

  private readonly opts: PipelineOptions;
  private readonly md: MarkdownIt;
  private readonly mathBank: string[] = [];
  // per-render state, reset in render()
  private headings: TocEntry[] = [];
  private slugCounts = new Map<string, number>();
  private idPrefix = "";

  constructor(opts: PipelineOptions) {
    this.opts = opts;
    this.md = new MarkdownIt({ html: true, typographer: true, highlight: opts.highlight });

    const defaultFence = this.md.renderer.rules.fence!;
    this.md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (token.info.trim() !== "figure" || !this.opts.vocabulary) {
        // a code fence: a marked region becomes a listing fold; otherwise
        // markdown-it's own renderer, with the info reduced to the language
        // so embed=/region= tokens never leak into the class attribute
        const info = parseListingInfo(token.info);
        const listing = listingHtml(token.content, info, this.opts.highlight ?? (() => ""));
        if (listing) return listing;
        token.info = info.lang;
        return defaultFence(tokens, idx, options, env, self);
      }
      const vocab = this.opts.vocabulary;
      let spec = vocab.parse(token.content) as { kind: string; caption?: string };
      if (vocab.resolve) spec = vocab.resolve(spec as never, { root: this.opts.root }) as typeof spec;
      const caption = spec.caption ? `<figcaption>${this.md.utils.escapeHtml(spec.caption)}</figcaption>` : "";
      return (
        `<figure class="fig" data-kind="${spec.kind}">` +
        `<div class="fig-body">${vocab.render(spec)}</div>${caption}` +
        `<script type="application/json" class="fig-spec">${JSON.stringify(spec)}</script>` +
        `</figure>\n`
      );
    };

    this.md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
      const token = tokens[idx];
      const level = Number(token.tag.slice(1));
      if (level <= 3) {
        const text = plainHeadingText(tokens[idx + 1]?.content ?? "");
        const id = this.uniqueSlug(this.idPrefix + slugify(text));
        token.attrSet("id", id);
        this.headings.push({ level, text, id });
      }
      return self.renderToken(tokens, idx, options);
    };
  }

  /** Render one markdown body (frontmatter already stripped). `idPrefix`
   * namespaces heading anchors — book chapters pass their slug so the
   * concatenated PDF cannot collide two chapters' headings. */
  render(body: string, opts: { idPrefix?: string } = {}): RenderResult {
    this.headings = [];
    this.slugCounts = new Map();
    this.idPrefix = opts.idPrefix ? `${opts.idPrefix}-` : "";
    this.mathBank.length = 0;

    // transform order matters: fences are protected by markdown-it itself;
    // the cite and math passes run on the source but never touch fenced
    // blocks because we split around them first.
    const segments = body.split(/(```[\s\S]*?```)/g);
    const prepared = segments
      .map((seg, i) => (i % 2 === 1 ? seg : this.mathPass(this.citePass(seg))))
      .join("");
    const html = this.mathRestore(this.md.render(prepared));
    return { html, headings: this.headings };
  }

  /** The numbered reference list for every citation seen so far, or ""
   * when the document cites nothing. */
  refsSection(): string {
    if (!this.opts.refs || this.citeOrder.length === 0) return "";
    const refs = this.opts.refs;
    const items = this.citeOrder
      .map((key, i) => {
        const r = refs[key];
        const link = r.url ? ` <a href="${r.url}">${r.url}</a>` : "";
        return `<li id="ref-${i + 1}">${r.authors.join(", ")}. ${r.title}. <em>${r.venue}</em>, ${r.year}.${link}</li>`;
      })
      .join("\n");
    return `<section class="refs"><h1 id="references">References</h1><ol>\n${items}\n</ol></section>`;
  }

  // ── citations: [@a; @b] -> [n, m]; bare @key -> Surname et al. (year) ──

  private citeNum(key: string): number {
    if (!this.opts.refs?.[key]) throw new Error(`unknown citation key @${key} (add it to the refs file)`);
    if (!this.citeOrder.includes(key)) this.citeOrder.push(key);
    return this.citeOrder.indexOf(key) + 1;
  }

  private narrative(key: string): string {
    const r = this.opts.refs![key];
    const surname = (author: string) => author.split(" ").pop() ?? author;
    const who =
      r.authors.length === 1
        ? surname(r.authors[0])
        : r.authors.length === 2
          ? `${surname(r.authors[0])} and ${surname(r.authors[1])}`
          : `${surname(r.authors[0])} et al.`;
    return `${who} (${r.year})`;
  }

  private citePass(md: string): string {
    if (!this.opts.refs) return md;
    md = md.replace(/\[(@[a-zA-Z0-9_-]+(?:;\s*@[a-zA-Z0-9_-]+)*)\]/g, (_, group: string) => {
      const nums = group
        .split(";")
        .map((s) => s.trim().slice(1))
        .map((key) => `<a class="cite" href="#ref-${this.citeNum(key)}">${this.citeNum(key)}</a>`);
      return `[${nums.join(", ")}]`;
    });
    md = md.replace(/(^|[\s(])@([a-zA-Z0-9_-]+)/g, (m, pre: string, key: string) => {
      if (!this.opts.refs![key]) return m;
      return `${pre}<a class="cite narrative" href="#ref-${this.citeNum(key)}">${this.narrative(key)}</a>`;
    });
    return md;
  }

  // ── math: extract before markdown, render with KaTeX, reinsert after ──

  private mathPass(md: string): string {
    md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => {
      this.mathBank.push(katex.renderToString(tex.trim(), { displayMode: true, throwOnError: true }));
      this.mathCount++;
      return `MATHBLOCK${this.mathBank.length - 1}X`;
    });
    // inline spans may wrap across ONE source newline (prose is hard-wrapped);
    // a blank line still terminates the search so stray $ can't pair far apart
    md = md.replace(/\$((?:(?!\n\n)[^$])+?)\$/g, (_, tex: string) => {
      this.mathBank.push(
        katex.renderToString(tex.replace(/\s+/g, " ").trim(), { displayMode: false, throwOnError: true }),
      );
      this.mathCount++;
      return `MATHSPAN${this.mathBank.length - 1}X`;
    });
    return md;
  }

  private mathRestore(html: string): string {
    html = html.replace(/<p>MATHBLOCK(\d+)X<\/p>/g, (_, i) => this.mathBank[Number(i)]);
    return html.replace(/MATH(?:BLOCK|SPAN)(\d+)X/g, (_, i) => this.mathBank[Number(i)]);
  }

  private uniqueSlug(slug: string): string {
    const n = this.slugCounts.get(slug) ?? 0;
    this.slugCounts.set(slug, n + 1);
    return n === 0 ? slug : `${slug}-${n + 1}`;
  }
}

/** Heading text as it should appear in a ToC: math placeholders dropped,
 * cite anchors and other markup stripped to their text. */
function plainHeadingText(inlineContent: string): string {
  return inlineContent
    .replace(/MATH(?:BLOCK|SPAN)\d+X/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strict cross-references: every prose mention of "Section 3.2" must match
 * a numbered heading ("3.2 Method…", "2. Background…") or the build
 * fails; matches become in-document links. The pattern is deliberately
 * narrow — capital S, one space, digits and dots only — so ordinary prose
 * cannot false-positive. Text inside <pre>, <code>, and existing <a> tags
 * is left alone. */
export function sectionRefPass(html: string, headings: TocEntry[]): string {
  const targets = new Map<string, string>();
  for (const h of headings) {
    const m = /^(\d+(?:\.\d+)*)[.\s]/.exec(h.text);
    if (m) targets.set(m[1], h.id);
  }
  const guarded = /(<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>)/g;
  return html
    .split(guarded)
    .map((seg, i) => {
      if (i % 2 === 1) return seg;
      return seg.replace(/\bSection (\d+(?:\.\d+)*)\b/g, (mention, num: string) => {
        const id = targets.get(num);
        if (!id)
          throw new Error(
            `"${mention}" does not match any numbered heading` +
              (targets.size > 0
                ? ` (known: ${[...targets.keys()].sort().join(", ")})`
                : " (this document has no numbered headings)"),
          );
        return `<a class="sec-ref" href="#${id}">${mention}</a>`;
      });
    })
    .join("");
}

/** Web only: a "#" link after every heading that has an anchor, so a
 * reader can put a section's address in the URL bar (and, with the
 * runtime's enableHeadingLinks, on the clipboard). Print has page numbers
 * for that. */
export function headingAnchorPass(html: string): string {
  return html.replace(
    /<(h[1-3]) id="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g,
    (_, tag: string, id: string, attrs: string, inner: string) =>
      `<${tag} id="${id}"${attrs}>${inner}<a class="h-anchor" href="#${id}" aria-label="Link to this section">#</a></${tag}>`,
  );
}

/** Post-render passes shared by every output. External links leave the
 * document — open them in a new tab so the reader keeps their place
 * (WeasyPrint ignores the attributes, so the shared markup is print-safe).
 * Prose tables get a scroll container so wide data scrolls inside the
 * wrapper instead of breaking the page. */
export function articlePasses(html: string): string {
  html = html.replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http');
  return html
    // only the bare <table> markdown emits; a figure's own table keeps its markup
    .replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table-wrap"><table>$1</table></div>');
}

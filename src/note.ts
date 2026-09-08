/** One markdown file in, two artifacts out.
 *
 *   source.md ──┬──> dist/index.html   (dark, interactive — hydrate.js upgrades figures)
 *               └──> dist/pdf.html ──> dist/<name>.pdf   (WeasyPrint, print theme)
 *
 * The whole transform is TypeScript: markdown-it for prose, KaTeX rendered
 * at build time (both outputs get static math — no client JS required),
 * figure fences validated against the project's closed vocabulary and
 * rendered to inline SVG through the same code the browser hydrators use,
 * and a numeric citation pass over the refs file. WeasyPrint is the single
 * non-TS tool.
 *
 * Background folds: a `:::background Title` … `:::` block renders as a
 * collapsed <details> on the web and moves to a lettered appendix in the
 * PDF, leaving a page-numbered link at the original spot. Figures and
 * citations work inside blocks; citation numbering stays continuous with
 * the main text. Code listings with a marked region print the region and
 * move the full file to a second lettered appendix (listings.ts). Section
 * mentions ("Section 3.2") are strict links — see sectionRefPass.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as esbuild from "esbuild";

import { copyImages, copyKatexAssets, writeStyles } from "./assets.js";
import {
  answerKeyHtml,
  conceptPass,
  ConceptState,
  courseHtmlForPdf,
  loadConcepts,
  unpackPass,
} from "./course.js";
import { embedPass } from "./embeds.js";
import { annotateTerms, type GlossaryMarks, glossaryListHtml, glossaryScript, loadGlossary } from "./glossary.js";
import { listingsForPdf } from "./listings.js";
import type { PracticeConfig } from "./practice.js";
import { renderPdf } from "./pdf.js";
import { articlePasses, headingAnchorPass, makeHighlighter, Pipeline, sectionRefPass } from "./pipeline.js";
import { headHtml, mastheadHtml, splitFrontmatter } from "./shell.js";
import { tocFloatHtml, tocHtml } from "./toc.js";
import {
  DEFAULT_PDF_CHAR_SUBS,
  type Frontmatter,
  type Ref,
  type TocEntry,
  type TocOptions,
  type Vocabulary,
} from "./types.js";

export interface NoteConfig {
  /** Project root; every other path is relative to it. */
  root: string;
  /** The markdown source, e.g. "note.md" or "paper/report.md". */
  source: string;
  /** JSON file of citation keys, e.g. "refs.json". */
  refs?: string;
  /** The project's figure vocabulary (omit for figure-less documents). */
  vocabulary?: Vocabulary;
  /** Project theme stylesheets, appended to the engine base. */
  styles: { web: string; pdf: string };
  /** Browser entry bundled to dist/assets/hydrate.js. */
  hydrate?: string;
  /** Transitional images dir; copied into dist with PDF png fallbacks. */
  imagesDir?: string;
  /** highlight.js languages to register for fenced code. */
  codeLanguages?: string[];
  /** Directories of reusable concept units, searched in order; enables
   * `:::concept slug` transclusion (see course.ts). */
  concepts?: string[];
  /** Problem generators keyed by concept slug (see course.ts): worksheets
   * in the cards, an answer-key section in the PDF, graded sessions on
   * the web via enableCourse. */
  practice?: PracticeConfig;
  /** YAML lists of the field's words with plain explanations (see
   * glossary.ts), merged in order: a shared base, then the paper's own
   * additions. Marked uses in the web article get a popover, and the
   * terms the page uses follow the references as a Glossary section.
   * Web only; the PDF is unchanged. */
  glossary?: string | string[];
  /** Which uses of a term get a mark: "first" on the page, the first in
   * each "section" (default), or "every" use. */
  glossaryMarks?: GlossaryMarks;
  /** A site whose concept pages the glossary's `concept` slugs link to,
   * e.g. "https://website.com". Without it a popover links to
   * the entry in the page's own Glossary section. */
  conceptSite?: string;
  /** Masthead eyebrow when the frontmatter has no kicker. */
  kicker?: string;
  /** Footer line on the web page. */
  colophon?: string;
  /** Fallback PDF filename when the frontmatter has no pdf_name. */
  pdfName?: string;
  /** Emoji → text substitutions for the print output. */
  pdfCharSubs?: [string, string][];
  toc?: TocOptions | false;
  /** Skip the WeasyPrint step (dev / --no-pdf). */
  noPdf?: boolean;
  /** Web output filename (default "index.html"). Lets one repo build several
   * documents into the same dist/; the PDF staging file follows the name
   * ("tutorial.html" stages through "tutorial.pdf.html"). */
  htmlName?: string;
}

export interface BuildResult {
  refCount: number;
  mathCount: number;
  headings: TocEntry[];
  pdfName: string;
}

interface Background {
  title: string;
  body: string;
}

/** Pull `:::background Title` … `:::` blocks out of the markdown source,
 * leaving a placeholder token where each one stood. Line-based on purpose:
 * blocks may contain figure fences, embeds, math, citations, and unpack
 * folds, all of which render through the normal pipeline afterwards.
 * Backgrounds themselves don't nest, but an `:::unpack` inside one does —
 * so a bare ::: only closes the background when no fold is open. */
function extractBackgrounds(body: string): { main: string; blocks: Background[] } {
  const out: string[] = [];
  const blocks: Background[] = [];
  let cur: Background | null = null;
  let inFence = false;
  let unpackDepth = 0;
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) inFence = !inFence;
    else if (!inFence && /^:::unpack\s/.test(line)) unpackDepth++;
    else if (!inFence && unpackDepth > 0 && /^:::\s*$/.test(line)) unpackDepth--;
    else if (!inFence) {
      const open = /^:::background\s+(.+)$/.exec(line);
      if (!cur && open) {
        cur = { title: open[1].trim(), body: "" };
        continue;
      }
      if (cur && /^:::\s*$/.test(line)) {
        blocks.push(cur);
        out.push("", `BGBLOCK${blocks.length - 1}X`, "");
        cur = null;
        continue;
      }
    }
    if (cur) cur.body += line + "\n";
    else out.push(line);
  }
  if (cur) throw new Error(`:::background "${cur.title}" is never closed (add a ::: line)`);
  if (unpackDepth > 0) throw new Error(`an :::unpack fold is never closed (add a ::: line)`);
  return { main: out.join("\n"), blocks };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const replaceBgTokens = (html: string, fn: (i: number) => string): string =>
  html.replace(/(?:<p>)?BGBLOCK(\d+)X(?:<\/p>)?/g, (_, i) => fn(Number(i)));

export async function buildNote(cfg: NoteConfig): Promise<BuildResult> {
  const dist = join(cfg.root, "dist");
  const raw = readFileSync(join(cfg.root, cfg.source), "utf-8");
  const { fm, body } = splitFrontmatter<Frontmatter>(raw, cfg.source);
  const refs = cfg.refs
    ? (JSON.parse(readFileSync(join(cfg.root, cfg.refs), "utf-8")) as Record<string, Ref>)
    : undefined;

  const pipeline = new Pipeline({
    root: cfg.root,
    refs,
    vocabulary: cfg.vocabulary,
    highlight: await makeHighlighter(cfg.codeLanguages ?? []),
  });

  const conceptState = new ConceptState();
  let expanded = embedPass(body, cfg.root);
  if (cfg.concepts?.length)
    expanded = conceptPass(expanded, loadConcepts(cfg.root, cfg.concepts), conceptState, {
      practice: cfg.practice,
    });
  const { main, blocks } = extractBackgrounds(expanded);
  const mainUnpacked = unpackPass(main);
  const bgUnpacked = blocks.map((b) => unpackPass(b.body));
  const unpackCount = mainUnpacked.count + bgUnpacked.reduce((n, b) => n + b.count, 0);
  const { html, headings } = pipeline.render(mainUnpacked.md);
  const bgHtml = bgUnpacked.map((b, i) => pipeline.render(b.md, { idPrefix: `bg-${i + 1}` }).html);

  const linkedMain = sectionRefPass(html, headings);
  const linkedBg = bgHtml.map((h) => sectionRefPass(h, headings));

  const refsHtml = pipeline.refsSection();
  if (pipeline.citeOrder.length > 0) headings.push({ level: 1, text: "References", id: "references" });

  // web: backgrounds fold in place, headings carry their # links, and the
  // glossary's words get their popovers, with the list as a section after
  // the references; pdf: a page-numbered link to an appendix
  const glossary = cfg.glossary ? loadGlossary(cfg.root, cfg.glossary) : [];
  const site = cfg.conceptSite?.replace(/\/$/, "");
  const conceptHref = (slug: string) => (site ? `${site}/concepts/${slug}/` : null);
  let webArticle = headingAnchorPass(
    articlePasses(
      replaceBgTokens(
        linkedMain,
        (i) =>
          `<details class="bg"><summary>${esc(blocks[i].title)}</summary>` +
          `<div class="bg-body">${linkedBg[i]}</div></details>`,
      ) + refsHtml,
    ),
  );
  const pdfHeadings = [...headings];
  if (glossary.length) {
    const { html, used } = annotateTerms(webArticle, glossary, { marks: cfg.glossaryMarks });
    webArticle =
      html +
      headingAnchorPass(
        `<section class="glossary-section"><h1 id="glossary">Glossary</h1>` +
          `${glossaryListHtml(glossary.filter((e) => used.has(e.slug)), conceptHref, { idPrefix: "gl-" })}</section>`,
      ) +
      glossaryScript(glossary, used, { concept: conceptHref, entry: (slug) => `#gl-${slug}` });
    headings.push({ level: 1, text: "Glossary", id: "glossary" });
  }

  // pdf order: body, references, then the appendices (backgrounds,
  // listings, answer key) — the reference list follows the last numbered
  // section, as in a published paper, and the Contents lists them in the
  // same order. Citation numbering stays continuous either way: an
  // appendix citing a new source still takes the next number.
  let appendix = "";
  if (blocks.length > 0) {
    appendix =
      `<section class="appendix"><h1 id="appendix-background">Appendix: background &amp; further reading</h1>` +
      blocks
        .map((b, i) => `<h2 id="bg-app-${i + 1}">A.${i + 1} ${esc(b.title)}</h2>${linkedBg[i]}`)
        .join("") +
      `</section>`;
    pdfHeadings.push({ level: 1, text: "Appendix: background & further reading", id: "appendix-background" });
  }
  // listings: regions stay inline, full files go to the next lettered
  // appendix (after the backgrounds' A, when there are any)
  const listingLetter = blocks.length > 0 ? "B" : "A";
  const listings = listingsForPdf(
    replaceBgTokens(
      linkedMain,
      (i) => `<p class="bg-ref">Background — <a href="#bg-app-${i + 1}">A.${i + 1}: ${esc(blocks[i].title)}</a></p>`,
    ) +
      refsHtml +
      appendix,
    { label: (i) => `${listingLetter}.${i + 1}`, title: "Appendix: code listings", id: "appendix-listings" },
  );
  if (listings.count > 0) pdfHeadings.push({ level: 1, text: "Appendix: code listings", id: "appendix-listings" });
  const keySection = answerKeyHtml(conceptState, () => "");
  if (keySection) pdfHeadings.push({ level: 1, text: "Answer key", id: "answer-key" });
  let pdfArticle = courseHtmlForPdf(articlePasses(listings.html + listings.appendix + keySection));

  // ── images + the PDF variant of the article ──────────────────────────
  mkdirSync(dist, { recursive: true });
  const snapshotStems = cfg.imagesDir ? copyImages(join(cfg.root, cfg.imagesDir), webArticle, dist) : [];
  for (const [from, to] of cfg.pdfCharSubs ?? DEFAULT_PDF_CHAR_SUBS) pdfArticle = pdfArticle.replaceAll(from, to);
  for (const stem of snapshotStems) pdfArticle = pdfArticle.replaceAll(`images/${stem}.svg`, `images/${stem}.png`);

  // ── shells ───────────────────────────────────────────────────────────
  const toc: TocOptions =
    cfg.toc === false ? { pdf: false, web: false } : { pdf: true, web: false, depth: 2, ...cfg.toc };
  const pdfName = fm.pdf_name ?? cfg.pdfName ?? "document.pdf";
  const kicker = cfg.kicker ?? "a technical report";
  const titleBlock = mastheadHtml(fm, { kicker, pdfName });
  const webMode = toc.web === true ? "inline" : toc.web || "none";
  const webToc = webMode === "inline" ? tocHtml(headings, toc.depth ?? 2) : "";
  const floatToc =
    webMode === "float" ? tocFloatHtml(headings, toc.depth ?? 2, { top: { text: fm.short_title, id: "top" } }) : "";
  const pdfToc = toc.pdf ? tocHtml(pdfHeadings, toc.depth ?? 2) : "";

  copyKatexAssets(dist);
  writeStyles(dist, cfg.root, cfg.styles);

  const htmlName = cfg.htmlName ?? "index.html";
  const pdfHtmlName = htmlName === "index.html" ? "pdf.html" : htmlName.replace(/\.html$/, ".pdf.html");
  const colophon = cfg.colophon ? `\n<footer class="colophon">${cfg.colophon}</footer>` : "";
  const hydrateTag = cfg.hydrate ? `<script type="module" src="assets/hydrate.js"></script>` : "";
  writeFileSync(
    join(dist, htmlName),
    `<!doctype html><html lang="en"><head>${headHtml(fm.short_title, "assets/web.css")}</head>
<body>${floatToc}<main class="wrap">${titleBlock}${webToc}<article>${webArticle}</article>${colophon}
</main>${hydrateTag}</body></html>`,
  );

  writeFileSync(
    join(dist, pdfHtmlName),
    `<!doctype html><html lang="en"><head>${headHtml(fm.short_title, "assets/pdf.css")}</head>
<body><main>${titleBlock}${pdfToc}<article>${pdfArticle}</article></main></body></html>`,
  );

  if (cfg.hydrate) {
    await esbuild.build({
      entryPoints: [join(cfg.root, cfg.hydrate)],
      bundle: true,
      format: "esm",
      target: "es2022",
      outfile: join(dist, "assets/hydrate.js"),
    });
  }

  console.log(
    `web   : dist/${htmlName}  (${pipeline.citeOrder.length} refs, ${pipeline.mathCount} math spans` +
      (blocks.length ? `, ${blocks.length} background folds` : "") +
      (listings.count ? `, ${listings.count} listings` : "") +
      (glossary.length ? `, ${glossary.length} glossary terms` : "") +
      (conceptState.first.size ? `, ${conceptState.first.size} concepts (${conceptState.repeats.length} recaps)` : "") +
      (unpackCount ? `, ${unpackCount} unpack folds` : "") +
      `)`,
  );

  if (!cfg.noPdf) {
    renderPdf(dist, pdfHtmlName, pdfName);
    console.log(`pdf   : dist/${pdfName}`);
  }

  return {
    refCount: pipeline.citeOrder.length,
    mathCount: pipeline.mathCount,
    headings,
    pdfName,
  };
}

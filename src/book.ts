/** Book mode: a manifest of chapter markdown files in, a paged website and
 * one combined PDF out.
 *
 *   book.md + chapters/*.md ──┬──> dist/index.html            (landing: masthead + acts)
 *                             ├──> dist/<slug>/index.html     (one page per chapter)
 *                             └──> dist/pdf.html ──> dist/<name>.pdf
 *
 * The landing page's abstract, byline, and DOI come from book.md's
 * frontmatter — same shape as a note. Chapters carry their own small
 * frontmatter (title, blurb) and are ordered by the manifest, which also
 * groups them into acts. One Pipeline instance renders everything, so
 * citations number continuously across chapters and heading anchors are
 * namespaced by chapter slug (the combined PDF cannot collide).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import * as esbuild from "esbuild";

import { copyKatexAssets, writeStyles } from "./assets.js";
import {
  answerKeyHtml,
  appendixIndexHtml,
  calloutPass,
  calloutsForPdf,
  conceptBacklinkPass,
  conceptEntryHtml,
  conceptIndexHtml,
  conceptLinkPass,
  conceptPass,
  ConceptState,
  courseHtmlForPdf,
  loadConcepts,
  unpackPass,
  worksheetFor,
  type ConceptUsage,
} from "./course.js";
import { embedPass } from "./embeds.js";
import { listingsForPdf } from "./listings.js";
import { annotateTerms, type GlossaryMarks, glossaryListHtml, glossaryScript, loadGlossary } from "./glossary.js";
import type { PracticeConfig } from "./practice.js";
import { renderPdf } from "./pdf.js";
import { articlePasses, makeHighlighter, Pipeline } from "./pipeline.js";
import { buildCard, descriptionFrom, socialHead } from "./social.js";
import { headHtml, mastheadHtml, panelNavHtml, splitFrontmatter, type PanelGroup } from "./shell.js";
import { tocHtml } from "./toc.js";
import {
  DEFAULT_PDF_CHAR_SUBS,
  type Frontmatter,
  type HomeLink,
  type Ref,
  type SocialSpec,
  type TocEntry,
  type TocOptions,
  type Vocabulary,
} from "./types.js";

export interface ChapterEntry {
  /** Markdown source relative to root, e.g. "chapters/01-introduction.md". */
  file: string;
  /** URL slug; defaults to the file stem. */
  slug?: string;
  /** Display number ("01", "0a", "±0"). */
  num?: string;
  /** Act label grouping chapters on the landing page ("Act I · Foundations"). */
  act?: string;
}

export interface ChapterFrontmatter {
  title: string;
  blurb?: string;
  /** A card of the chapter's own; otherwise the chapter shares the book's. */
  social?: SocialSpec;
}

export interface BookConfig {
  root: string;
  /** The book's own markdown: note-style frontmatter + landing-page prose. */
  book: string;
  chapters: ChapterEntry[];
  refs?: string;
  vocabulary?: Vocabulary;
  styles: { web: string; pdf: string };
  hydrate?: string;
  codeLanguages?: string[];
  /** Directories of reusable concept units, searched in order; enables
   * `:::concept slug` transclusion and the landing-page concept index
   * (see course.ts). */
  concepts?: string[];
  /** Problem generators keyed by concept slug. A concept with a generator
   * gets a worksheet in its card: printed with an answer-key appendix in
   * the PDF, run as a graded practice session on the web (the consumer's
   * hydrate entry passes the same generators to enableCourse). */
  practice?: PracticeConfig;
  /** How concept units appear. "first-use" (default): the first mention in
   * build order embeds the full card and later mentions are recap stubs
   * linking back. "callout": every mention is the same collapsed inline
   * card, consecutive mentions group into a strip, each concept gets its
   * own page under concepts/ and an entry in a print appendix, and a
   * callout prints as one line with the appendix page number. */
  conceptMode?: "first-use" | "callout";
  /** Web shell. "article" (default): one centered column. "panel": a
   * control-panel layout with a left nav — brand, search, the chapter
   * groups, the appendix — on every page; print is unaffected. */
  layout?: "article" | "panel";
  /** YAML lists of the field's words with plain explanations (see
   * glossary.ts), merged in order. Uses in prose are marked on the web
   * pages; the site gets a glossary page and the PDF a glossary appendix. */
  glossary?: string | string[];
  /** Which uses of a term get a mark: "first" on the page, the first in
   * each "section" (default; a chapter page has one), or "every" use. */
  glossaryMarks?: GlossaryMarks;
  /** The site's address. Turns on the social preview: og/twitter meta on
   * every page and a card at dist/social.png from book.md's `social` block,
   * shared by the chapters unless one carries its own (see social.ts). */
  site?: string;
  kicker?: string;
  /** The site this book belongs to: a small link above the masthead and
   * in the panel's brand line. */
  home?: HomeLink;
  colophon?: string;
  pdfName?: string;
  pdfCharSubs?: [string, string][];
  /** depth 2 puts chapters AND their h2 sections in the PDF contents. */
  toc?: TocOptions;
  noPdf?: boolean;
}

interface LoadedChapter extends ChapterEntry {
  slug: string;
  fm: ChapterFrontmatter;
  html: string;
  headings: TocEntry[];
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export async function buildBook(cfg: BookConfig): Promise<{ chapters: number; pdfName: string }> {
  const dist = join(cfg.root, "dist");
  const { fm, body: introMd } = splitFrontmatter<Frontmatter>(
    readFileSync(join(cfg.root, cfg.book), "utf-8"),
    cfg.book,
  );
  const refs = cfg.refs
    ? (JSON.parse(readFileSync(join(cfg.root, cfg.refs), "utf-8")) as Record<string, Ref>)
    : undefined;

  const pipeline = new Pipeline({
    root: cfg.root,
    refs,
    vocabulary: cfg.vocabulary,
    highlight: await makeHighlighter(cfg.codeLanguages ?? []),
  });

  const conceptStore = cfg.concepts?.length ? loadConcepts(cfg.root, cfg.concepts) : null;
  const conceptState = new ConceptState();
  const callouts = cfg.conceptMode === "callout";
  const uses: ConceptUsage[] = [];
  let unpackCount = 0;
  // recap stubs name the chapter that introduced a concept; chapters are
  // processed in manifest order, so every label a stub needs exists by the
  // time it's asked for (the landing page is "the introduction").
  const chapterLabels = new Map<string, string>([["", "the introduction"], ["appendix", ""]]);
  const labelFor = (where: string) => chapterLabels.get(where) ?? where;
  const coursePasses = (md: string, where: string, idPrefix: string): string => {
    let expanded = embedPass(md, cfg.root);
    if (conceptStore)
      expanded = callouts
        ? calloutPass(expanded, conceptStore, conceptState, { where, idPrefix, practice: cfg.practice, uses })
        : conceptPass(expanded, conceptStore, conceptState, { where, idPrefix, labelFor, practice: cfg.practice });
    // a transcluded concept body may carry ```embed fences of its own
    expanded = embedPass(expanded, cfg.root);
    const unpacked = unpackPass(expanded);
    unpackCount += unpacked.count;
    return unpacked.md;
  };

  const glossary = cfg.glossary ? loadGlossary(cfg.root, cfg.glossary) : [];
  /** Annotate a page's prose with glossary terms and return the markup plus
   * the per-page term map (empty when there is no glossary). */
  const withTerms = (html: string, prefix: string): { html: string; script: string } => {
    if (!glossary.length) return { html, script: "" };
    const { html: annotated, used } = annotateTerms(html, glossary, { marks: cfg.glossaryMarks });
    const links = { concept: (slug: string) => `${prefix}concepts/${slug}/`, entry: (slug: string) => `${prefix}glossary/#${slug}` };
    return { html: annotated, script: glossaryScript(glossary, used, links) };
  };
  const chapterLabel = (ch: LoadedChapter) => (ch.num ? `${ch.num} · ${ch.fm.title}` : ch.fm.title);
  const intro = articlePasses(pipeline.render(coursePasses(introMd, "", "")).html);
  const chapters: LoadedChapter[] = cfg.chapters.map((entry) => {
    const slug = entry.slug ?? basename(entry.file).replace(/\.md$/, "");
    const raw = readFileSync(join(cfg.root, entry.file), "utf-8");
    const { fm: chFm, body } = splitFrontmatter<ChapterFrontmatter>(raw, entry.file);
    chapterLabels.set(slug, entry.num ? `chapter ${entry.num}` : chFm.title);
    const { html, headings } = pipeline.render(coursePasses(body, slug, `${slug}-`), { idPrefix: slug });
    return { ...entry, slug, fm: chFm, html: articlePasses(html), headings };
  });

  // ── callout mode: every concept rendered once on its own, for the web
  // page and the print appendix. Anchors are namespaced per concept. ──
  interface ConceptEntry { slug: string; title: string; web: string; pdf: string }
  const conceptEntries: ConceptEntry[] = [];
  if (conceptStore && callouts) {
    const usedIn = (slug: string) =>
      [...new Set(uses.filter((u) => u.slug === slug && u.where && chapterLabels.has(u.where)).map((u) => u.where))];
    for (const concept of [...conceptStore.values()].sort((a, b) => a.title.localeCompare(b.title))) {
      const bodyMd = coursePasses(concept.body, `concept:${concept.slug}`, `concept-${concept.slug}-`);
      const body = articlePasses(pipeline.render(bodyMd, { idPrefix: `concept-${concept.slug}` }).html);
      const worksheet = worksheetFor(concept, conceptState, cfg.practice);
      const used = usedIn(concept.slug).map((w) => {
        const ch = chapters.find((c) => c.slug === w)!;
        return { href: `../../${w}/`, label: chapterLabel(ch) };
      });
      conceptEntries.push({
        slug: concept.slug,
        title: concept.title,
        web: conceptEntryHtml(concept, conceptStore, body, worksheet, used),
        pdf: conceptEntryHtml(concept, conceptStore, body, worksheet, [], { heading: "h2" }),
      });
    }
  }

  mkdirSync(dist, { recursive: true });
  copyKatexAssets(dist);
  writeStyles(dist, cfg.root, cfg.styles);

  const kicker = cfg.kicker ?? "a course";
  const pdfName = fm.pdf_name ?? cfg.pdfName ?? "book.pdf";

  // ── social preview: the book's card, a chapter's own, the meta per page ──
  const siteUrl = cfg.site?.replace(/\/$/, "");
  for (const [social, where] of [[fm.social, cfg.book], ...chapters.map((c) => [c.fm.social, c.file])] as const)
    if (social && !siteUrl) throw new Error(`${where}: frontmatter has a social block but the build config sets no site`);
  const cardJob = {
    root: cfg.root,
    dist,
    vocabulary: cfg.vocabulary,
    byline: (fm.authors ?? []).map((a) => a.name).join(" · "),
    host: siteUrl ? new URL(siteUrl).host : "",
    webCss: siteUrl ? readFileSync(join(dist, "assets", "web.css"), "utf-8") : "",
  };
  const bookCard = siteUrl
    ? buildCard({ ...cardJob, out: "social.png", social: fm.social, kicker: fm.kicker ?? kicker, title: fm.title, shortTitle: fm.short_title, source: cfg.book })
    : undefined;
  const bookDescription = fm.social?.description ?? descriptionFrom(fm.abstract);
  const pageHead = (page: string, title: string, description: string | undefined, image = bookCard) =>
    socialHead({ site: siteUrl, page, title, description, image });
  const acts = [...new Set(chapters.map((c) => c.act ?? ""))];

  // ── landing page: masthead + intro prose + act-grouped chapter list ──
  const actsHtml = acts
    .map((act) => {
      const items = chapters
        .filter((c) => (c.act ?? "") === act)
        .map(
          (c) =>
            `<li><a href="${c.slug}/">` +
            `<span class="ch-num">${c.num ?? ""}</span>` +
            `<span class="ch-entry"><span class="ch-title">${escAttr(c.fm.title)}</span>` +
            `${c.fm.blurb ? `<span class="ch-blurb">${escAttr(c.fm.blurb)}</span>` : ""}</span>` +
            `</a></li>`,
        )
        .join("\n");
      return `<section class="act">${act ? `<div class="act-label">${escAttr(act)}</div>` : ""}<ol class="chapter-list">\n${items}\n</ol></section>`;
    })
    .join("\n");

  const colophon = cfg.colophon ? `\n<footer class="colophon">${cfg.colophon}</footer>` : "";
  const hydrateTag = (prefix: string) =>
    cfg.hydrate ? `<script type="module" src="${prefix}assets/hydrate.js"></script>` : "";

  // ── the web shell: a plain column, or the panel with a left nav ──
  const panel = cfg.layout === "panel";
  const navGroups = (current: string): PanelGroup[] => {
    const groups: PanelGroup[] = acts.map((act) => ({
      label: act || "Chapters",
      items: chapters
        .filter((c) => (c.act ?? "") === act)
        .map((c) => ({ href: `${c.slug}/`, label: c.fm.title, num: c.num, current: current === c.slug })),
    }));
    if (conceptEntries.length)
      groups.push({
        label: "Concepts",
        collapsed: true,
        items: conceptEntries.map((e) => ({ href: `concepts/${e.slug}/`, label: e.title, current: current === `concept:${e.slug}` })),
      });
    const extra: PanelGroup["items"] = [];
    if (conceptEntries.length) extra.push({ href: "concepts/", label: "All concepts", current: current === "concepts" });
    if (glossary.length) extra.push({ href: "glossary/", label: "Glossary", current: current === "glossary" });
    if (!cfg.noPdf) extra.push({ href: pdfName, label: "PDF" });
    if (extra.length) groups.push({ label: "Appendix", items: extra });
    return groups;
  };
  const shell = (prefix: string, current: string, main: string): string => {
    if (!panel) return `<body><main class="wrap">${main}</main>${hydrateTag(prefix)}</body>`;
    const nav = panelNavHtml({
      brand: fm.short_title,
      kicker: fm.kicker ?? kicker,
      prefix,
      groups: navGroups(current),
      searchIndex: "assets/search.json",
      plainToggle: glossary.some((e) => e.nickname),
      home: cfg.home,
    });
    return `<body class="panel">${nav}<div class="content"><main class="wrap">${main}</main></div>${hydrateTag(prefix)}</body>`;
  };
  /** `{{chapter:slug}}` in prose renders as "chapter NN" with the number
   * taken from the chapter list at build time — a link on the web, a
   * page-numbered link in print — so reordering chapters never touches
   * prose. An unknown slug fails the build. */
  const chapterRefPass = (html: string, prefix: string | null): string =>
    html.replace(/\{\{(chapter|Chapter):([a-z0-9-]+)\}\}/g, (_, word: string, slug: string) => {
      const ch = chapters.find((c) => c.slug === slug);
      if (!ch) throw new Error(`{{chapter:${slug}}}: no chapter with that slug (known: ${chapters.map((c) => c.slug).join(", ")})`);
      const label = ch.num ? `${word} ${ch.num}` : ch.fm.title;
      return prefix === null
        ? `<a class="chapter-ref" href="#${slug}">${label}</a>`
        : `<a class="chapter-ref" href="${prefix}${slug}/">${label}</a>`;
    });
  const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

  writeFileSync(
    join(dist, "index.html"),
    `<!doctype html><html lang="en"><head>${headHtml(fm.short_title, "assets/web.css", { meta: pageHead("", fm.social?.title ?? fm.title, bookDescription) })}</head>
${shell("", "", `${mastheadHtml(fm, { kicker, pdfName, home: cfg.home })}
<article class="book-intro">${(() => { const t = withTerms(chapterRefPass(conceptLinkPass(conceptBacklinkPass(intro, "", ""), "concepts/"), ""), ""); return t.html + t.script; })()}</article>
${actsHtml}
${conceptStore ? (callouts ? appendixIndexHtml(conceptStore, uses, labelFor, "concepts/") : conceptIndexHtml(conceptStore, conceptState, labelFor)) : ""}${colophon}`)}</html>`,
  );

  // ── chapter pages: crumbs + chapter head + prose + prev/next ─────────
  chapters.forEach((ch, i) => {
    const prev = chapters[i - 1];
    const next = chapters[i + 1];
    const nav =
      `<nav class="chapter-nav">` +
      (prev
        ? `<a class="prev" href="../${prev.slug}/"><span class="dir">← previous</span><span class="ttl">${escAttr(chapterLabel(prev))}</span></a>`
        : `<span></span>`) +
      (next
        ? `<a class="next" href="../${next.slug}/"><span class="dir">next →</span><span class="ttl">${escAttr(chapterLabel(next))}</span></a>`
        : "") +
      `</nav>`;
    const title = `${ch.num ? `${ch.num} · ` : ""}${ch.fm.title} — ${fm.short_title}`;
    mkdirSync(join(dist, ch.slug), { recursive: true });
    const card =
      siteUrl && ch.fm.social
        ? buildCard({ ...cardJob, out: `${ch.slug}/social.png`, social: ch.fm.social, kicker: ch.num ? `Chapter ${ch.num}` : (fm.kicker ?? kicker), title: ch.fm.title, source: ch.file })
        : bookCard;
    const meta = pageHead(`${ch.slug}/`, ch.fm.social?.title ?? title, ch.fm.social?.description ?? ch.fm.blurb ?? bookDescription, card);
    writeFileSync(
      join(dist, ch.slug, "index.html"),
      `<!doctype html><html lang="en"><head>${headHtml(title, "assets/web.css", { assetPrefix: "../", meta })}</head>
${shell("../", ch.slug, `<div class="crumbs"><a href="../">${escAttr(fm.short_title)}</a>${ch.act ? `<span>${escAttr(ch.act)}</span>` : ""}</div>
<header class="chapter-head">${ch.num ? `<div class="kicker">Chapter ${ch.num}</div>` : ""}<h1 class="doc-title">${escAttr(ch.fm.title)}</h1>${ch.fm.blurb ? `<p class="chapter-lede">${escAttr(ch.fm.blurb)}</p>` : ""}</header>
<article>${(() => { const t = withTerms(chapterRefPass(conceptLinkPass(conceptBacklinkPass(ch.html, ch.slug), "../concepts/"), "../"), "../"); return t.html + t.script; })()}</article>
${nav}`)}</html>`,
    );
  });

  // ── concept pages + the appendix index (callout mode) ────────────────
  if (conceptEntries.length) {
    mkdirSync(join(dist, "concepts"), { recursive: true });
    writeFileSync(
      join(dist, "concepts", "index.html"),
      `<!doctype html><html lang="en"><head>${headHtml(`Concepts — ${fm.short_title}`, "assets/web.css", { assetPrefix: "../", meta: pageHead("concepts/", `Concepts — ${fm.short_title}`, bookDescription) })}</head>
${shell("../", "concepts", `<div class="crumbs"><a href="../">${escAttr(fm.short_title)}</a><span>appendix</span></div>
<header class="chapter-head"><div class="kicker">Appendix</div><h1 class="doc-title">Concepts</h1></header>
${appendixIndexHtml(conceptStore!, uses, labelFor, "", { label: "every concept the book leans on" })}`)}</html>`,
    );
    for (const entry of conceptEntries) {
      mkdirSync(join(dist, "concepts", entry.slug), { recursive: true });
      writeFileSync(
        join(dist, "concepts", entry.slug, "index.html"),
        `<!doctype html><html lang="en"><head>${headHtml(`${entry.title} — ${fm.short_title}`, "assets/web.css", { assetPrefix: "../../", meta: pageHead(`concepts/${entry.slug}/`, `${entry.title} — ${fm.short_title}`, conceptStore!.get(entry.slug)?.gist ?? bookDescription) })}</head>
${shell("../../", `concept:${entry.slug}`, `<div class="crumbs"><a href="../../">${escAttr(fm.short_title)}</a><a href="../">concepts</a></div>
<article class="concept-page">${(() => { const t = withTerms(chapterRefPass(conceptLinkPass(entry.web, "../"), "../../"), "../../"); return t.html + t.script; })()}</article>`)}</html>`,
      );
    }
  }

  // ── glossary page ────────────────────────────────────────────────────
  if (glossary.length) {
    mkdirSync(join(dist, "glossary"), { recursive: true });
    writeFileSync(
      join(dist, "glossary", "index.html"),
      `<!doctype html><html lang="en"><head>${headHtml(`Glossary — ${fm.short_title}`, "assets/web.css", { assetPrefix: "../", meta: pageHead("glossary/", `Glossary — ${fm.short_title}`, bookDescription) })}</head>
${shell("../", "glossary", `<div class="crumbs"><a href="../">${escAttr(fm.short_title)}</a><span>appendix</span></div>
<header class="chapter-head"><div class="kicker">Appendix</div><h1 class="doc-title">Glossary</h1><p class="chapter-lede">The field's words, and the nickname this book uses for each. On any page, click an underlined word for its entry, or switch the whole site to nicknames from the menu.</p></header>
${glossaryListHtml(glossary, (slug) => `../concepts/${slug}/`)}`)}</html>`,
    );
  }

  // ── search index: one entry per chapter and concept, plain text ──────
  if (panel) {
    const index = [
      ...glossary.map((e) => ({ t: e.term, n: "", u: `glossary/#${e.slug}`, k: "term", g: e.nickname ?? "", x: e.explain })),
      ...chapters.map((ch) => ({ t: ch.fm.title, n: ch.num ?? "", u: `${ch.slug}/`, k: "chapter", g: ch.fm.blurb ?? "", x: plain(ch.html).slice(0, 8000) })),
      ...conceptEntries.map((e) => ({
        t: e.title, n: "", u: `concepts/${e.slug}/`, k: "concept", g: conceptStore!.get(e.slug)!.gist ?? "", x: plain(e.web).slice(0, 8000),
      })),
    ];
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "assets", "search.json"), JSON.stringify(index));
  }

  // ── combined PDF: masthead + contents + every chapter ────────────────
  const toc: TocOptions = { pdf: true, depth: 2, ...cfg.toc };
  const tocEntries: TocEntry[] = chapters.flatMap((ch) => [
    { level: 1, text: chapterLabel(ch), id: ch.slug },
    ...(toc.depth && toc.depth >= 2 ? ch.headings.filter((h) => h.level === 2) : []),
  ]);
  // pdf order: chapters, references, then the appendices
  const refsSection = pipeline.refsSection();
  if (refsSection) tocEntries.push({ level: 1, text: "References", id: "references" });
  const conceptsAppendix = conceptEntries.length
    ? `<section class="appendix concepts-appendix"><h1 id="appendix-concepts">Concepts</h1>` +
      conceptEntries.map((e) => calloutsForPdf(e.pdf, conceptStore!)).join("\n") +
      `</section>`
    : "";
  if (conceptsAppendix) tocEntries.push({ level: 1, text: "Concepts", id: "appendix-concepts" });
  const glossaryAppendix = glossary.length
    ? `<section class="appendix glossary-appendix"><h1 id="appendix-glossary">Glossary</h1>${glossaryListHtml(glossary, (slug) => `#concept-${slug}`)}</section>`
    : "";
  if (glossaryAppendix) tocEntries.push({ level: 1, text: "Glossary", id: "appendix-glossary" });
  const keySection = answerKeyHtml(conceptState, labelFor);
  if (keySection) tocEntries.push({ level: 1, text: "Answer key", id: "answer-key" });

  let pdfArticle = chapters
    .map(
      (ch) =>
        `<section class="chapter" id="${ch.slug}">` +
        `<header class="ch-head">${ch.act || ch.num ? `<div class="kicker">${escAttr([ch.act, ch.num ? `Chapter ${ch.num}` : ""].filter(Boolean).join(" · "))}</div>` : ""}` +
        `<h1 class="ch-title">${escAttr(ch.fm.title)}</h1>` +
        `${ch.fm.blurb ? `<p class="chapter-lede">${escAttr(ch.fm.blurb)}</p>` : ""}</header>` +
        `${ch.html}</section>`,
    )
    .join("\n");
  if (callouts && conceptStore) pdfArticle = calloutsForPdf(pdfArticle, conceptStore);
  pdfArticle += refsSection + conceptsAppendix + glossaryAppendix;
  // listing regions print inline; full files collect in a listings appendix
  const listings = listingsForPdf(pdfArticle, {
    label: (i) => `Listing ${i + 1}`,
    title: "Code listings",
    id: "appendix-listings",
  });
  if (listings.count) tocEntries.push({ level: 1, text: "Code listings", id: "appendix-listings" });
  pdfArticle = listings.html + listings.appendix + keySection;
  pdfArticle = chapterRefPass(courseHtmlForPdf(pdfArticle), null);
  for (const [from, to] of cfg.pdfCharSubs ?? DEFAULT_PDF_CHAR_SUBS) pdfArticle = pdfArticle.replaceAll(from, to);

  const pdfIntro = intro
    ? `<article class="book-intro">${chapterRefPass(courseHtmlForPdf(callouts && conceptStore ? calloutsForPdf(intro, conceptStore) : intro), null)}</article>`
    : "";
  writeFileSync(
    join(dist, "pdf.html"),
    `<!doctype html><html lang="en"><head>${headHtml(fm.short_title, "assets/pdf.css")}</head>
<body><main>${mastheadHtml(fm, { kicker, print: true })}
${pdfIntro}
${toc.pdf ? tocHtml(tocEntries, toc.depth ?? 2) : ""}
<article>${pdfArticle}</article></main></body></html>`,
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
    `web   : dist/index.html + ${chapters.length} chapter pages  (${pipeline.citeOrder.length} refs, ${pipeline.mathCount} math spans` +
      (conceptState.first.size ? `, ${conceptState.first.size} concepts (${conceptState.repeats.length} recaps)` : "") +
      (conceptEntries.length ? `, ${conceptEntries.length} concept pages (${uses.length} callouts)` : "") +
      (glossary.length ? `, ${glossary.length} glossary terms` : "") +
      (unpackCount ? `, ${unpackCount} unpack folds` : "") +
      (conceptState.worksheets.length ? `, ${conceptState.worksheets.length} worksheets` : "") +
      `)`,
  );

  if (!cfg.noPdf) {
    renderPdf(dist, "pdf.html", pdfName);
    console.log(`pdf   : dist/${pdfName}`);
  }

  return { chapters: chapters.length, pdfName };
}

/** Course machinery: reusable concept units and mipmap disclosure.
 *
 * Two directives, both expanded on the raw markdown before the pipeline
 * (like embeds), so figures, math, embeds, and citations inside them render
 * through the one normal path:
 *
 *   :::concept backprop            — transclude concepts/backprop.md here
 *   :::concept backprop {"open":0} — …collapsed by default
 *
 *   :::unpack The chain rule, from the ground up
 *   …more foundational explanation, may nest further :::unpack blocks…
 *   :::
 *
 * A concept is one markdown file holding one reusable unit (frontmatter:
 * title, gist, requires). The FIRST time a build meets a concept it embeds
 * the full unit in a fold; every LATER mention anywhere in the same build
 * becomes a one-line recap stub linking back to the introduction — reuse
 * without repetition. Unknown slugs, unknown requires, duplicate
 * definitions, and cyclic transclusion all fail the BUILD, not the reader.
 *
 * An unpack is one step down the explanation mipmap: prose states the dense
 * version, the fold underneath explains it one level more foundationally,
 * and folds nest until a concept's origin is reached. Everything ships
 * `open` — the no-JS and print reader sees the whole ladder; the browser
 * runtime (enableCourse in hydrate.ts) collapses to the reader's chosen
 * level and remembers concepts they marked as known.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  answerText,
  genProblems,
  worksheetSeed,
  type PracticeConfig,
  type PracticeProblem,
} from "./practice.js";
import { splitFrontmatter } from "./shell.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── concept store ──────────────────────────────────────────────────────

interface ConceptFrontmatter {
  title: string;
  /** One-line dense definition; shown in recap stubs and the index. */
  gist?: string;
  /** Slugs of concepts this one builds on. Must exist in the store. */
  requires?: string[];
}

export interface Concept {
  slug: string;
  title: string;
  gist?: string;
  requires: string[];
  body: string;
  file: string;
}

/** Load every concepts directory into one store. Directories are searched
 * in order, so a course can layer a local `concepts/` over a shared
 * commons — but the same slug twice is an error, not a shadow: a unit that
 * silently means two things is worse than a failed build. */
export function loadConcepts(root: string, dirs: string[]): Map<string, Concept> {
  const store = new Map<string, Concept>();
  for (const dir of dirs) {
    for (const f of readdirSync(join(root, dir)).sort()) {
      if (!f.endsWith(".md")) continue;
      const slug = f.replace(/\.md$/, "");
      const file = join(dir, f);
      const prior = store.get(slug);
      if (prior) throw new Error(`concept "${slug}" is defined twice: ${prior.file} and ${file}`);
      const { fm, body } = splitFrontmatter<ConceptFrontmatter>(readFileSync(join(root, file), "utf-8"), file);
      if (!fm.title) throw new Error(`concept ${file} has no "title" in its frontmatter`);
      store.set(slug, {
        slug,
        title: fm.title,
        gist: fm.gist,
        requires: fm.requires ?? [],
        body: body.trim(),
        file,
      });
    }
  }
  for (const c of store.values())
    for (const r of c.requires)
      if (!store.has(r)) throw new Error(`concept "${c.slug}" requires unknown concept "${r}"`);
  return store;
}

// ── concept usage state (one per build, shared across chapters) ────────

export interface ConceptUse {
  slug: string;
  /** Anchor id of the full embed ("<chapter>-concept-<slug>"). */
  anchor: string;
  /** Chapter slug that introduced it ("" for a note / the landing page). */
  where: string;
}

export interface WorksheetRecord {
  slug: string;
  title: string;
  where: string;
  problems: PracticeProblem[];
}

/** Where each concept was introduced and revisited, across one whole build
 * (a book shares one instance over every chapter, like the citation
 * order). */
export class ConceptState {
  readonly first = new Map<string, ConceptUse>();
  readonly repeats: ConceptUse[] = [];
  readonly worksheets: WorksheetRecord[] = [];
}

export interface ConceptPassOptions {
  /** Anchor namespace, e.g. "<chapter-slug>-" (mirrors Pipeline idPrefix). */
  idPrefix?: string;
  /** Chapter slug for backlinks; "" for notes and the book landing page. */
  where?: string;
  /** Human label for a chapter slug, used in recap-stub link text. */
  labelFor?: (where: string) => string;
  /** Problem generators; a concept whose slug has one gets a worksheet in
   * its card (printable in the PDF, a graded session on the web). */
  practice?: PracticeConfig;
}

interface ConceptOptionsJson {
  /** 0 collapses the fold by default (still expandable, prints in full). */
  open?: number;
}

const backlink = (use: ConceptUse, label: string): string =>
  `<a class="concept-back" data-where="${use.where}" href="#${use.anchor}">${esc(label)}</a>`;

/** Static worksheet markup, rendered into a concept card at build time.
 * The PDF prints it as-is (prompts plus ruled answer space); the web
 * runtime replaces the list with a practice entry that opens the graded
 * session. The embedded spec carries only {slug, seed, count} — the
 * browser regenerates identical problems from the same generator. One
 * HTML block, so internal blank lines are stripped. */
function worksheetHtml(slug: string, seed: number, problems: PracticeProblem[]): string {
  const items = problems
    .map((p) => {
      const choices =
        p.answer.kind === "choice"
          ? `<ol class="ws-choices">${p.answer.options.map((o) => `<li>${o}</li>`).join("")}</ol>`
          : `<div class="ws-space"></div>`;
      return `<li class="ws-problem"><div class="ws-prompt">${p.prompt}</div>${choices}</li>`;
    })
    .join("");
  return (
    `<section class="worksheet" data-concept="${slug}">` +
    `<div class="ws-head">practice · ${problems.length} problems <span class="ws-key-note">(answers in the key at the back)</span></div>` +
    `<ol class="ws-list">${items}</ol>` +
    `<script type="application/json" class="ws-spec">${JSON.stringify({ slug, seed, count: problems.length })}</script>` +
    `</section>`
  ).replace(/\n{2,}/g, "\n");
}

/** The PDF's answer-key appendix: every worksheet the build produced, in
 * order, with the concept and chapter it belongs to. Generated from the
 * same problems the sheets printed, so key and sheet cannot drift. */
export function answerKeyHtml(state: ConceptState, labelFor: (where: string) => string): string {
  if (state.worksheets.length === 0) return "";
  const blocks = state.worksheets
    .map(
      (ws) => {
        const label = labelFor(ws.where);
        return (
          `<div class="key-block"><div class="key-title">${esc(ws.title)}` +
          `${label ? ` <span class="key-where">· ${esc(label)}</span>` : ""}</div>` +
          `<ol class="key-list">` +
          ws.problems.map((p) => `<li>${esc(answerText(p.answer))}</li>`).join("") +
          `</ol></div>`
        );
      },
    )
    .join("");
  return `<section class="answer-key"><h1 id="answer-key">Answer key</h1>${blocks}</section>`;
}

/** Expand every `:::concept slug` line. Runs before background extraction
 * and before unpackPass, so a concept body's own unpack folds flow into
 * the same scanner as the chapter's. Fence-aware; recursion is allowed
 * (a concept may transclude another) but cycles fail the build, and a
 * nested transclusion counts as a use like any other. */
export function conceptPass(
  md: string,
  store: Map<string, Concept>,
  state: ConceptState,
  opts: ConceptPassOptions = {},
): string {
  const where = opts.where ?? "";
  const idPrefix = opts.idPrefix ?? "";
  const expanding: string[] = [];

  const expand = (body: string): string => {
    const out: string[] = [];
    let inFence = false;
    for (const line of body.split("\n")) {
      if (/^```/.test(line)) {
        inFence = !inFence;
        out.push(line);
        continue;
      }
      const m = inFence ? null : /^:::concept\s+([a-z0-9-]+)\s*(\{.*\})?\s*$/.exec(line);
      if (!m) {
        out.push(line);
        continue;
      }
      const [, slug, json] = m;
      const concept = store.get(slug);
      if (!concept) throw new Error(`:::concept ${slug}: no such concept (known: ${[...store.keys()].sort().join(", ")})`);
      if (expanding.includes(slug))
        throw new Error(`concept transclusion cycle: ${[...expanding, slug].join(" -> ")}`);
      let conceptOpts: ConceptOptionsJson = {};
      if (json) {
        try {
          conceptOpts = JSON.parse(json) as ConceptOptionsJson;
        } catch {
          throw new Error(`:::concept ${slug}: options are not valid JSON: ${json}`);
        }
      }

      const first = state.first.get(slug);
      if (first) {
        // revisit: a recap stub pointing back at the introduction
        state.repeats.push({ slug, anchor: first.anchor, where });
        const label =
          first.where === where
            ? "introduced above"
            : `introduced ${opts.labelFor && first.where ? `in ${opts.labelFor(first.where)}` : "earlier"}`;
        out.push(
          "",
          `<p class="concept-stub" data-concept="${slug}"><span class="concept-kicker">concept recap</span> ` +
            `<strong>${esc(concept.title)}</strong>${concept.gist ? ` — ${esc(concept.gist)}` : ""} · ` +
            backlink(first, label) +
            `</p>`,
          "",
        );
        continue;
      }

      const anchor = `${idPrefix}concept-${slug}`;
      state.first.set(slug, { slug, anchor, where });
      const requires = concept.requires
        .map((r) => {
          const req = store.get(r)!;
          const reqFirst = state.first.get(r);
          return reqFirst ? backlink(reqFirst, req.title) : `<span class="req">${esc(req.title)}</span>`;
        })
        .join(" · ");
      const openAttr = conceptOpts.open === 0 ? "" : " open";
      expanding.push(slug);
      const bodyMd = expand(concept.body);
      expanding.pop();
      const generator = opts.practice?.generators[slug];
      let worksheet = "";
      if (generator) {
        const seed = worksheetSeed(slug, opts.practice?.seed ?? 1);
        const problems = genProblems(generator, seed, opts.practice?.count ?? 4);
        state.worksheets.push({ slug, title: concept.title, where, problems });
        worksheet = worksheetHtml(slug, seed, problems);
      }
      out.push(
        "",
        `<section class="concept" data-concept="${slug}" id="${anchor}">` +
          `<details class="concept-fold"${openAttr}>` +
          `<summary class="concept-head"><span class="concept-kicker">concept</span> ` +
          `<span class="concept-title">${esc(concept.title)}</span>` +
          `${concept.gist ? ` <span class="concept-gist">${esc(concept.gist)}</span>` : ""}</summary>` +
          `<div class="concept-body">`,
        "",
        ...(requires ? [`<p class="concept-requires">builds on ${requires}</p>`, ""] : []),
        bodyMd,
        "",
        ...(worksheet ? [worksheet, ""] : []),
        `</div></details></section>`,
        "",
      );
    }
    if (inFence) throw new Error(`unclosed \`\`\` fence while expanding concepts`);
    return out.join("\n");
  };

  return expand(md);
}

/** Chapter pages link to concepts introduced elsewhere; the canonical HTML
 * carries same-document anchors (right for the combined PDF) plus the
 * introducing chapter in data-where. The web assembly rewrites hrefs that
 * leave the current page. */
export function conceptBacklinkPass(html: string, currentWhere: string, hrefPrefix = "../"): string {
  return html.replace(
    /(<a class="concept-back" data-where=")([^"]*)(" href=")#([^"]+)(")/g,
    (whole, pre, where, mid, anchor, post) =>
      where === currentWhere ? whole : `${pre}${where}${mid}${hrefPrefix}${where ? `${where}/` : ""}#${anchor}${post}`,
  );
}

// ── unpack folds ───────────────────────────────────────────────────────

/** Expand `:::unpack Title` … `:::` into <details> markup. Stack-based:
 * folds nest arbitrarily; a bare ::: closes the innermost open fold.
 * Fence-aware, and everything ships `open` — the print and no-JS reader
 * always sees the full ladder, while the browser runtime closes every
 * fold so the dense prose reads clean and one small chevron per fold
 * offers the way down. */
export function unpackPass(md: string): { md: string; count: number } {
  const out: string[] = [];
  const stack: string[] = [];
  let inFence = false;
  let count = 0;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence) {
      const open = /^:::unpack\s+(.+)$/.exec(line);
      if (open) {
        const title = open[1].trim();
        stack.push(title);
        count++;
        out.push(
          "",
          `<details class="unpack" data-depth="${stack.length}" open>` +
            `<summary class="unpack-summary"><span class="unpack-mark"></span>${esc(title)}</summary>` +
            `<div class="unpack-body">`,
          "",
        );
        continue;
      }
      if (stack.length > 0 && /^:::\s*$/.test(line)) {
        stack.pop();
        out.push("", `</div></details>`, "");
        continue;
      }
    }
    out.push(line);
  }
  if (stack.length > 0) throw new Error(`:::unpack "${stack[stack.length - 1]}" is never closed (add a ::: line)`);
  return { md: out.join("\n"), count };
}

// ── PDF divergence ─────────────────────────────────────────────────────

/** The print reader can't click a fold open, so unpack and concept
 * <details> become plain nested blocks (a rule down the left margin marks
 * the depth). Runs on the assembled PDF article only; the markup being
 * replaced is exactly what the passes above emitted. */
export function courseHtmlForPdf(html: string): string {
  return html
    .replace(/<details class="unpack" data-depth="(\d+)" open>/g, '<div class="unpack-print">')
    .replace(/<summary class="unpack-summary">/g, '<div class="unpack-label">')
    .replace(/<details class="concept-fold"( open)?>/g, '<div class="concept-print">')
    .replace(/<details class="concept callout"[^>]*>/g, '<div class="concept-print">')
    .replace(/<summary class="concept-head">/g, '<div class="concept-head">')
    .replace(/<\/summary>/g, "</div>")
    .replace(/<\/details>/g, "</div>");
}

// ── landing-page concept index (book mode, web only) ───────────────────

/** "Concepts" block for the book landing page: every unit the course
 * introduces, its gist, where it enters, where it comes back. The index is
 * generated from actual usage, so it cannot drift from the chapters. */
export function conceptIndexHtml(
  store: Map<string, Concept>,
  state: ConceptState,
  labelFor: (where: string) => string,
): string {
  if (state.first.size === 0) return "";
  const items = [...state.first.values()]
    .map((use) => {
      const c = store.get(use.slug)!;
      const revisits = [...new Set(state.repeats.filter((r) => r.slug === use.slug).map((r) => r.where))];
      const whereText =
        labelFor(use.where) + (revisits.length ? ` · revisited in ${revisits.map(labelFor).join(", ")}` : "");
      return (
        `<li><a href="${use.where ? `${use.where}/` : ""}#${use.anchor}">` +
        `<span class="concept-title">${esc(c.title)}</span>` +
        `${c.gist ? `<span class="concept-gist">${esc(c.gist)}</span>` : ""}` +
        `<span class="concept-where">${esc(whereText)}</span></a></li>`
      );
    })
    .join("\n");
  return `<section class="act concept-index"><div class="act-label">Concepts</div><ul class="concept-list">\n${items}\n</ul></section>`;
}

// ── callout mode: concepts as a knowledge base ─────────────────────────
//
// The second concept model. Nothing is introduced "first": every
// `:::concept slug` renders the same collapsed callout — title and gist on
// the summary, the full unit inside — so a page never sends the reader
// elsewhere and chapters can be read in any order. Consecutive callouts
// group into a strip of chips. Each concept also gets its own page
// (web) and an appendix entry (print); in print a callout becomes a
// one-line reference with the appendix page number.

export interface ConceptUsage {
  slug: string;
  where: string;
}

/** A worksheet generated once per concept, for the callouts, the concept
 * page, and the appendix alike; the answer key records it once. */
export function worksheetFor(
  concept: Concept,
  state: ConceptState,
  practice?: PracticeConfig,
): string {
  const generator = practice?.generators[concept.slug];
  if (!generator) return "";
  const seed = worksheetSeed(concept.slug, practice?.seed ?? 1);
  const problems = genProblems(generator, seed, practice?.count ?? 4);
  if (!state.worksheets.some((w) => w.slug === concept.slug))
    state.worksheets.push({ slug: concept.slug, title: concept.title, where: "appendix", problems });
  return worksheetHtml(concept.slug, seed, problems);
}

export interface CalloutPassOptions extends ConceptPassOptions {
  /** Usage records (which page used which concept), for "used in" lists. */
  uses?: ConceptUsage[];
}

const requiresHtml = (concept: Concept, store: Map<string, Concept>): string =>
  concept.requires.length
    ? `<p class="concept-requires">builds on ${concept.requires
        .map((r) => `<a class="concept-link" href="#concept-${r}">${esc(store.get(r)!.title)}</a>`)
        .join(" · ")}</p>`
    : "";

/** Expand every `:::concept slug` line into a collapsed inline callout.
 * Fence-aware; a concept may transclude another (cycles fail the build).
 * Consecutive callouts, blank lines between them allowed, are wrapped in
 * one `.concepts` strip and share a `name` so opening one closes the
 * others. */
export function calloutPass(
  md: string,
  store: Map<string, Concept>,
  state: ConceptState,
  opts: CalloutPassOptions = {},
): string {
  const where = opts.where ?? "";
  const idPrefix = opts.idPrefix ?? "";
  const expanding: string[] = [];
  let runs = 0;
  let seq = 0;

  const expand = (body: string): string => {
    const out: string[] = [];
    let inFence = false;
    let runOpen = false;
    // the accordion group of the run being emitted at THIS level; nested
    // expansions open runs of their own, so the id is captured per level
    let runId = 0;
    let pendingBlanks: string[] = [];
    const closeRun = () => {
      if (runOpen) {
        out.push("", "</div>", "");
        runOpen = false;
      }
    };
    for (const line of body.split("\n")) {
      if (/^```/.test(line)) {
        inFence = !inFence;
        closeRun();
        out.push(...pendingBlanks, line);
        pendingBlanks = [];
        continue;
      }
      const m = inFence ? null : /^:::concept\s+([a-z0-9-]+)\s*(\{.*\})?\s*$/.exec(line);
      if (!m) {
        if (runOpen && /^\s*$/.test(line)) {
          pendingBlanks.push(line);
          continue;
        }
        closeRun();
        out.push(...pendingBlanks, line);
        pendingBlanks = [];
        continue;
      }
      const slug = m[1];
      const concept = store.get(slug);
      if (!concept) throw new Error(`:::concept ${slug}: no such concept (known: ${[...store.keys()].sort().join(", ")})`);
      if (expanding.includes(slug)) throw new Error(`concept transclusion cycle: ${[...expanding, slug].join(" -> ")}`);
      pendingBlanks = [];
      if (!runOpen) {
        runs++;
        runId = runs;
        out.push("", `<div class="concepts">`, "");
        runOpen = true;
      }
      seq++;
      opts.uses?.push({ slug, where });
      expanding.push(slug);
      const bodyMd = expand(concept.body);
      expanding.pop();
      const worksheet = worksheetFor(concept, state, opts.practice);
      const anchor = `${idPrefix}concept-${slug}-${seq}`;
      out.push(
        `<!--callout:${slug}-->`,
        `<details class="concept callout" data-concept="${slug}" id="${anchor}" name="cg-${idPrefix}${runId}">` +
          `<summary class="concept-head"><span class="concept-kicker">concept</span> ` +
          `<span class="concept-title">${esc(concept.title)}</span>` +
          `${concept.gist ? ` <span class="concept-gist">${esc(concept.gist)}</span>` : ""}</summary>` +
          `<div class="concept-body">`,
        "",
        ...(concept.requires.length ? [requiresHtml(concept, store), ""] : []),
        bodyMd,
        "",
        ...(worksheet ? [worksheet, ""] : []),
        `<p class="concept-page-link"><a class="concept-link" href="#concept-${slug}">this concept on its own page →</a></p>`,
        `</div></details>`,
        `<!--/callout:${slug}-->`,
        "",
      );
    }
    closeRun();
    if (inFence) throw new Error(`unclosed \`\`\` fence while expanding concepts`);
    return out.join("\n");
  };

  return expand(md);
}

/** Web pages link to concept pages; the canonical markup carries
 * same-document anchors (right for the combined PDF). `prefix` is the
 * path from the current page to the concepts directory. */
export function conceptLinkPass(html: string, prefix: string): string {
  return html.replace(
    /(<a class="concept-link" href=")#concept-([a-z0-9-]+)(")/g,
    (_, pre, slug, post) => `${pre}${prefix}${slug}/${post}`,
  );
}

/** In print a callout is one line with the appendix page number. */
export function calloutsForPdf(html: string, store: Map<string, Concept>): string {
  return html.replace(/<!--callout:([a-z0-9-]+)-->[\s\S]*?<!--\/callout:\1-->/g, (_, slug) => {
    const c = store.get(slug)!;
    return (
      `<p class="concept-ref"><span class="concept-kicker">concept</span> <strong>${esc(c.title)}</strong>` +
      `${c.gist ? ` — ${esc(c.gist)}` : ""} · <a class="concept-back" href="#concept-${slug}">appendix</a></p>`
    );
  });
}

/** One concept as a standalone entry: the head, the rendered body, its
 * worksheet, and where the book uses it. Shared by the web page and the
 * print appendix. */
export function conceptEntryHtml(
  concept: Concept,
  store: Map<string, Concept>,
  bodyHtml: string,
  worksheet: string,
  usedIn: { href: string; label: string }[],
  opts: { heading?: "h1" | "h2" } = {},
): string {
  const H = opts.heading ?? "h1";
  const used = usedIn.length
    ? `<p class="concept-used">used in ${usedIn.map((u) => `<a href="${u.href}">${esc(u.label)}</a>`).join(", ")}</p>`
    : "";
  return (
    `<section class="concept-entry" id="concept-${concept.slug}" data-concept="${concept.slug}">` +
    `<header class="concept-entry-head"><div class="concept-kicker">concept</div>` +
    `<${H} class="concept-entry-title">${esc(concept.title)}</${H}>` +
    `${concept.gist ? `<p class="concept-gist">${esc(concept.gist)}</p>` : ""}` +
    `${requiresHtml(concept, store)}${used}</header>` +
    `<div class="concept-body">${bodyHtml}${worksheet}</div></section>`
  );
}

/** The appendix index: every concept, its gist, where it is used. */
export function appendixIndexHtml(
  store: Map<string, Concept>,
  uses: ConceptUsage[],
  labelFor: (where: string) => string,
  prefix: string,
  opts: { title?: string; label?: string } = {},
): string {
  const concepts = [...store.values()].sort((a, b) => a.title.localeCompare(b.title));
  const items = concepts
    .map((c) => {
      const wheres = [...new Set(uses.filter((u) => u.slug === c.slug && u.where).map((u) => u.where))];
      const whereText = wheres.length ? `used in ${wheres.map(labelFor).join(", ")}` : "";
      return (
        `<li><a href="${prefix}${c.slug}/">` +
        `<span class="concept-title">${esc(c.title)}</span>` +
        `${c.gist ? `<span class="concept-gist">${esc(c.gist)}</span>` : ""}` +
        `${whereText ? `<span class="concept-where">${esc(whereText)}</span>` : ""}</a></li>`
      );
    })
    .join("\n");
  return `<section class="act concept-index"><div class="act-label">${esc(opts.label ?? "Appendix · concepts")}</div><ul class="concept-list">\n${items}\n</ul></section>`;
}

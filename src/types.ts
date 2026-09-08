/** Shared types for the press. */

export interface Ref {
  authors: string[];
  title: string;
  venue: string;
  year: number;
  url?: string;
}

export interface Author {
  name: string;
  affiliation?: string;
  email?: string;
}

/** YAML frontmatter of a document (a note's markdown file, or a book's
 * book.md). */
export interface Frontmatter {
  title: string;
  short_title: string;
  /** Masthead eyebrow line; falls back to the project config, then to
   * "a technical report". */
  kicker?: string;
  authors: Author[];
  /** Non-author collaboration credit, rendered in the byline. */
  credit?: string;
  date: string;
  doi?: string;
  pdf_name?: string;
  abstract: string;
}

/** A project's closed figure vocabulary, injected into the pipeline.
 * `parse` must throw on unknown kinds and malformed params — figure fences
 * fail the BUILD, not the reader. `resolve` runs at build time only (the
 * renderer itself never reads files, so it can run in the browser too);
 * use it to load experiment output referenced by a spec. */
export interface Vocabulary {
  parse(json: string): { kind: string; caption?: string };
  render(spec: unknown): string;
  resolve?(spec: never, ctx: { root: string }): unknown;
}

export interface TocEntry {
  /** Heading level: 1 for h1, 2 for h2, 3 for h3. */
  level: number;
  /** Plain text of the heading (markup and math stripped). */
  text: string;
  /** Anchor id assigned to the heading element. */
  id: string;
}

export interface TocOptions {
  /** Render a Contents block in the PDF (with page numbers). Default true. */
  pdf?: boolean;
  /** The web page's contents. `false` (default): none. `"inline"` (or
   * `true`): the print list, without page numbers, between the masthead
   * and the article. `"float"`: a floating, collapsible panel. On wide
   * screens it docks beside the article and the page makes room; on
   * narrower ones it is a corner tab that opens a card over the page; on
   * phones the tab sits at the bottom and opens a sheet. The consumer's
   * hydrate entry calls `enableToc()` for the reading-position marks,
   * smooth scrolling, and the panel closing itself after a jump. */
  web?: boolean | "inline" | "float";
  /** Deepest heading level included. Default 2. */
  depth?: 1 | 2 | 3;
}

/** Emoji in code listings have no glyphs in the print fonts. */
export const DEFAULT_PDF_CHAR_SUBS: [string, string][] = [
  ["✅", "[OK]"],
  ["❌", "[FAIL]"],
  ["🧠", ""],
  ["🤖", ""],
];

export const DEFAULT_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap";

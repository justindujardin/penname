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
  /** The author's own page. The name becomes the link and keeps looking
   * like a name; a quieter way home than a `home` link above the masthead. */
  link?: string;
}

/** One entry of a masthead's link row (`links` in the frontmatter). */
export interface MastheadLink {
  label: string;
  href: string;
}

/** The site a page belongs to (`home` in the build config): a small link
 * above the masthead, and in a panel book's brand line. A site that is
 * the home itself sets none. */
export interface HomeLink {
  label: string;
  href: string;
}

/** YAML frontmatter of a document (a note's markdown file, or a book's
 * book.md). */
export interface Frontmatter {
  title: string;
  short_title: string;
  /** Masthead eyebrow line; falls back to the project config, then to
   * "a technical report". */
  kicker?: string;
  authors?: Author[];
  /** Non-author collaboration credit, rendered in the byline. */
  credit?: string;
  date?: string;
  doi?: string;
  pdf_name?: string;
  abstract?: string;
  /** One line under the title in sentence style (a person's page says who
   * they are here). Also the social card's text when there is no byline,
   * and the meta description when there is no abstract. */
  tagline?: string;
  /** A picture beside the masthead text, repo-relative. Setting it makes
   * the masthead a person's: portrait, name, tagline, links; no byline,
   * dateline, or abstract, and no eyebrow unless `kicker` is set. */
  portrait?: string;
  /** A row of links under the masthead text: GitHub, Bluesky, email. */
  links?: MastheadLink[];
  /** The social preview card (see social.ts). Needs `site` in the build config. */
  social?: SocialSpec;
}

/** The `social` block of a document's frontmatter. With `site` set and no
 * block at all, every page still gets the full meta set and a text-only card. */
export interface SocialSpec {
  /** A figure spec, as a ```figure fence holds it, written in YAML (or as a
   * JSON string); parsed and resolved by the vocabulary, so a bad one fails
   * the build. Its chart is placed beside the text. */
  figure?: unknown;
  /** Card and og:title; defaults to the document title (the card falls back
   * to short_title when the title would be cut). */
  title?: string;
  /** Meta description; defaults to the abstract's opening under 200 characters. */
  description?: string;
  /** A ready picture, repo-relative, shipped instead of a composed card. */
  image?: string;
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

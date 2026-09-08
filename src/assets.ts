/** Static asset handling: KaTeX css/fonts, theme stylesheets, and the
 * transitional image directory with its PDF fallbacks. */

import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const engineRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** KaTeX ships with the engine; copy its css + fonts into dist/assets. */
export function copyKatexAssets(dist: string): void {
  const katexDist = dirname(require.resolve("katex/package.json"));
  mkdirSync(join(dist, "assets"), { recursive: true });
  cpSync(join(katexDist, "dist/katex.min.css"), join(dist, "assets/katex/katex.min.css"));
  cpSync(join(katexDist, "dist/fonts"), join(dist, "assets/katex/fonts"), { recursive: true });
}

/** dist/assets/web.css and pdf.css are the engine base concatenated with the
 * project theme — the theme comes second, so its rules win cascade ties. */
export function writeStyles(dist: string, root: string, styles: { web: string; pdf: string }): void {
  mkdirSync(join(dist, "assets"), { recursive: true });
  for (const kind of ["web", "pdf"] as const) {
    const base = readFileSync(join(engineRoot, "styles", `base-${kind}.css`), "utf-8");
    const theme = readFileSync(join(root, styles[kind]), "utf-8");
    writeFileSync(join(dist, "assets", `${kind}.css`), `${base}\n/* ── project theme ── */\n\n${theme}`);
  }
}

/** Matplotlib exports carry an opaque white background; the web theme is
 * dark, so make it transparent. foreignObject snapshots are left alone. */
const prepareSvg = (text: string) =>
  text.includes("<foreignObject") ? text : text.replace(/fill:\s*#ffffff/g, "fill: none");

/** Copy every image the article references into dist/images. Returns the
 * stems of foreignObject SVGs (browser-only — blank in WeasyPrint) that have
 * a .png fallback; the PDF article swaps those in. */
export function copyImages(imagesDir: string, article: string, dist: string): string[] {
  mkdirSync(join(dist, "images"), { recursive: true });
  const names = readdirSync(imagesDir);
  const snapshotStems: string[] = [];
  for (const name of names) {
    if (!article.includes(`images/${name}`)) continue;
    const src = join(imagesDir, name);
    if (name.endsWith(".svg")) {
      const svg = readFileSync(src, "utf-8");
      writeFileSync(join(dist, "images", name), prepareSvg(svg));
      if (svg.includes("<foreignObject")) {
        const stem = name.slice(0, -4);
        if (names.includes(`${stem}.png`)) snapshotStems.push(stem);
        else console.warn(`[pdf] WARNING: ${name} uses foreignObject (blank in PDF) and has no .png fallback`);
      }
    } else if (/\.(png|jpe?g|webp)$/i.test(name)) {
      cpSync(src, join(dist, "images", name));
    }
  }
  return snapshotStems;
}

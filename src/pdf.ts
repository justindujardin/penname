/** WeasyPrint is the single non-TS tool in the pipeline, invoked via
 * `uv run --with weasyprint`. `--no-project` keeps uv from discovering the
 * consumer's own pyproject.toml above dist/ and syncing that whole
 * environment (a paper repo's torch, say) just to print a page. */

import { execFileSync } from "node:child_process";

export function renderPdf(dist: string, htmlName: string, pdfName: string): void {
  try {
    execFileSync("uv", ["run", "--no-project", "--with", "weasyprint", "weasyprint", htmlName, pdfName], {
      cwd: dist,
      stdio: "inherit",
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "the PDF step needs `uv` on PATH (https://docs.astral.sh/uv/) on a system with WeasyPrint's libraries (Pango, Cairo, gdk-pixbuf); build the page alone with --no-pdf",
      );
    throw e;
  }
}

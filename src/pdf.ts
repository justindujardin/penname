/** WeasyPrint is the single non-TS tool in the pipeline, invoked via
 * `uv run --with weasyprint`. */

import { execFileSync } from "node:child_process";

export function renderPdf(dist: string, htmlName: string, pdfName: string): void {
  execFileSync("uv", ["run", "--with", "weasyprint", "weasyprint", htmlName, pdfName], {
    cwd: dist,
    stdio: "inherit",
  });
}

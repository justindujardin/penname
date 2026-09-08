/** Build-time expansion of ```embed fences into ordinary code fences.
 *
 * An embed fence names a source file; the build inlines its contents, so a
 * listing can never drift from the file it claims to show — the same
 * philosophy as `vocabulary.resolve` for figure data, applied to code.
 * Runs on the raw markdown before the pipeline (the renderer itself never
 * reads files), and throws on any problem — embeds fail the BUILD, not the
 * reader.
 *
 *   ```embed
 *   { "path": "experiments/train.py" }
 *   ```
 *
 * The emitted fence carries `embed=<path>` (and `region=<name>`) in its
 * info string so the pipeline can label the listing and, when the file
 * marks a region, build the fold — see listings.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface EmbedSpec {
  /** File to inline, relative to the project root. */
  path: string;
  /** highlight.js language; inferred from the extension when omitted. */
  lang?: string;
  /** Which `# region` of the file is the teaser (see listings.ts). Only
   * needed when the file marks more than one. */
  region?: string;
}

const LANG_BY_EXT: Record<string, string> = {
  py: "python",
  ts: "typescript",
  js: "javascript",
  json: "json",
  sh: "bash",
  md: "markdown",
};

export function embedPass(body: string, root: string): string {
  return body.replace(/^```embed\n([\s\S]*?)\n```$/gm, (_, json: string) => {
    const spec = parseSpec(json);
    const ext = spec.path.split(".").pop() ?? "";
    const lang = spec.lang ?? LANG_BY_EXT[ext];
    if (!lang) throw new Error(`embed ${spec.path}: no language for extension ".${ext}" — pass "lang" explicitly`);
    let source: string;
    try {
      source = readFileSync(join(root, spec.path), "utf-8");
    } catch {
      throw new Error(`embed ${spec.path}: file not found under ${root}`);
    }
    if (source.includes("```")) throw new Error(`embed ${spec.path}: file contains a \`\`\` fence of its own`);
    if (/\s/.test(spec.path)) throw new Error(`embed ${spec.path}: path must not contain whitespace`);
    const info = [lang, `embed=${spec.path}`, spec.region !== undefined ? `region=${spec.region}` : ""].filter(Boolean).join(" ");
    return "```" + info + "\n" + source.trimEnd() + "\n```";
  });
}

function parseSpec(json: string): EmbedSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`embed fence is not valid JSON: ${json.trim().slice(0, 80)}`);
  }
  const { path, lang, region } = raw as Partial<EmbedSpec>;
  if (typeof path !== "string" || path.length === 0) throw new Error(`embed fence needs a "path" string`);
  if (lang !== undefined && typeof lang !== "string") throw new Error(`embed ${path}: "lang" must be a string`);
  if (region !== undefined && (typeof region !== "string" || /\s/.test(region)))
    throw new Error(`embed ${path}: "region" must be a single-word string`);
  return { path, lang, region };
}

/** Build-time half of the modelmap pipeline: keep the extracted JSON in
 * step with the Python it describes, by measurement rather than by a
 * version number. Every modelmap records a content hash of each project
 * source file its import touched, plus a hash of the extractor itself;
 * this helper rehashes those files and re-runs `py/limned.py` only when
 * something actually changed — so a dev-loop rebuild costs a few stat
 * calls, never a torch import. Node-only: keep it out of hydrate code.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Limned } from "./modelmap.js";

const LIMNED_PKG = join(dirname(fileURLToPath(import.meta.url)), "../py/limned");

/** Mirror of limned's own generator_hash(): one digest over the sorted
 * package sources, so an extractor or annotation-layer edit re-extracts
 * every cached map. */
function generatorHash(): string {
  const digest = createHash("sha256");
  for (const file of readdirSync(LIMNED_PKG).filter((f) => f.endsWith(".py")).sort()) {
    digest.update(readFileSync(join(LIMNED_PKG, file)));
  }
  return digest.digest("hex");
}

export interface ModelmapEntry {
  /** `module:attr` — a factory or a `__modelmap__`-annotated class. */
  symbol: string;
  /** Repo-relative path the JSON lands at (and `resolve` reads from). */
  out: string;
}

export interface ModelmapOptions {
  /** The Python launcher, run from `root`. Default `["uv", "run", "python"]`;
   * a project that does not list limned as a dependency can reach the
   * sibling checkout with `["uv", "run", "--with-editable", "../penname/py", "python"]`. */
  python?: string[];
}

const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Why `entry` must re-extract, or null if the cache is fresh. */
function staleReason(root: string, entry: ModelmapEntry): string | null {
  const path = join(root, entry.out);
  if (!existsSync(path)) return "no cached modelmap";
  let graph: Limned;
  try {
    graph = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return "cached modelmap is not valid JSON";
  }
  if (graph.symbol !== entry.symbol)
    return `cache holds ${graph.symbol}, manifest says ${entry.symbol}`;
  if (graph.generator !== generatorHash()) return "limned changed";
  for (const [file, hash] of Object.entries(graph.sources)) {
    const source = join(root, file);
    if (!existsSync(source)) return `${file} is gone`;
    if (sha256(source) !== hash) return `${file} changed`;
  }
  return null;
}

/** Extract every stale entry, printing its reason first — a rebuild that
 * says why is the difference between a cache and a mystery. Python runs
 * through `uv run` from `root`, the same way the models train. */
export function ensureModelmaps(
  root: string,
  entries: ModelmapEntry[],
  opts: ModelmapOptions = {},
): void {
  const [cmd, ...args] = opts.python ?? ["uv", "run", "python"];
  for (const entry of entries) {
    const reason = staleReason(root, entry);
    if (reason === null) continue;
    console.log(`modelmap ${entry.symbol}: ${reason} — extracting`);
    execFileSync(
      cmd,
      [...args, "-m", "limned", entry.symbol, "--out", entry.out],
      { cwd: root, stdio: "inherit" },
    );
  }
}

/** The vocabulary's `resolve` for the modelmap kind: reads the cached
 * graph named by `spec.src` into `spec.graph`, so the renderer — which
 * also runs in the browser — never opens a file. Other kinds pass
 * through untouched. */
export function resolveModelmap<S extends { kind: string }>(spec: S, ctx: { root: string }): S {
  if (spec.kind !== "model-map") return spec;
  const src = (spec as S & { src: string }).src;
  return { ...spec, graph: JSON.parse(readFileSync(join(ctx.root, src), "utf-8")) as Limned };
}

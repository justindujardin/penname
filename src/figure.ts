/** One figure kind, defined in one place.
 *
 * A consumer keeps each figure kind in its own module — the spec shape, the
 * fields a fence must supply, the string renderer, and the hydrator — and
 * lists the modules in one registry. The registry derives what the build
 * and the browser need: a parser that checks the kind and its required
 * fields, one render dispatch, and the hydrator map for `runHydrators`.
 * The spec union is derived from the list too, so the type and the table
 * cannot drift apart.
 *
 *   // src/figures/loss-bowl.ts
 *   export interface LossBowl { kind: "loss-bowl"; w0: number; lr: number; steps: number }
 *   export const lossBowl = defineFigure<LossBowl>({ kind: "loss-bowl", required: ["w0", "lr", "steps"], render, hydrate });
 *
 *   // src/figures.ts
 *   export const figures = figureRegistry([lossBowl, ...]);
 *   export type FigureSpec = SpecOf<typeof figures>;
 */

import type { Hydrator } from "./hydrate.js";

export interface FigureKind<S extends { kind: string }> {
  kind: S["kind"];
  /** Params a fence must carry; a missing one fails the build. */
  required: readonly (keyof S & string)[];
  /** Static markup for the web page and the PDF. Strings only. */
  render(spec: S): string;
  /** Web only: add controls and re-render through `render`. */
  hydrate?(body: HTMLElement, spec: S): void;
}

export const defineFigure = <S extends { kind: string }>(def: FigureKind<S>): FigureKind<S> => def;

/** The spec type behind a kind, or the union behind a registry. */
export type SpecOf<T> =
  T extends FigureRegistry<infer S> ? S : T extends FigureKind<infer S> ? S : never;

export interface FigureRegistry<S extends { kind: string }> {
  /** The `vocabulary.parse` of a buildBook / buildNote config. */
  parse(json: string): S;
  /** The `vocabulary.render` of a buildBook / buildNote config. */
  render(spec: unknown): string;
  /** The map `runHydrators` takes. */
  hydrators: Partial<Record<string, Hydrator<S>>>;
  kinds: readonly string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the list mixes every kind's spec; the union is recovered below
export function figureRegistry<const K extends readonly FigureKind<any>[]>(kinds: K): FigureRegistry<SpecOf<K[number]>> {
  type S = SpecOf<K[number]>;
  const byKind = new Map<string, FigureKind<S>>();
  for (const k of kinds) {
    if (byKind.has(k.kind)) throw new Error(`figure kind "${k.kind}" is registered twice`);
    byKind.set(k.kind, k as FigureKind<S>);
  }
  const known = () => [...byKind.keys()].join(", ");
  const parse = (json: string): S => {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new Error(`figure fence is not valid JSON: ${json.trim().slice(0, 80)}`);
    }
    const spec = raw as S;
    const def = byKind.get(spec.kind);
    if (!def) throw new Error(`unknown figure kind "${(spec as { kind?: string }).kind}" (known: ${known()})`);
    for (const field of def.required)
      if (!(field in spec)) throw new Error(`figure ${spec.kind}: missing required param "${field}"`);
    return spec;
  };
  const render = (spec: unknown): string => {
    const s = spec as S;
    const def = byKind.get(s.kind);
    if (!def) throw new Error(`unhandled figure kind "${s.kind}" (known: ${known()})`);
    return def.render(s);
  };
  const hydrators: Partial<Record<string, Hydrator<S>>> = {};
  for (const def of byKind.values()) if (def.hydrate) hydrators[def.kind] = (body, spec) => def.hydrate!(body, spec);
  return { parse, render, hydrators, kinds: [...byKind.keys()] };
}

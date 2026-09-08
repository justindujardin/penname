/** String-based SVG/HTML builder.
 *
 * Renderers produce markup as strings so the identical code runs in Node at
 * build time (static figures inlined into both the web page and the PDF) and
 * in the browser (hydrated widgets re-render by swapping innerHTML).
 *
 * WeasyPrint does not apply CSS stroke/fill rules to inline SVG, so every
 * SVG element carries presentation ATTRIBUTES in print colors — that table
 * is the project's ink vocabulary, passed to `makeStyled`. Presentation
 * attributes lose to any stylesheet rule, so the web theme (dark) overrides
 * them in the browser; the PDF renders them as-is. One markup string serves
 * both outputs.
 */

export type Attrs = Record<string, string | number | undefined>;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function h(tag: string, attrs: Attrs = {}, ...children: (string | string[])[]): string {
  const parts = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${esc(String(v))}"`);
  const open = parts.length ? `<${tag} ${parts.join(" ")}>` : `<${tag}>`;
  const body = children.flat().join("");
  return `${open}${body}</${tag}>`;
}

export const text = esc;

export const MONO = "DejaVu Sans Mono, Menlo, monospace";

/** A wall-clock face. Angles are TURNS measured clockwise from twelve.
 * Hands are drawn as rotated groups, so a web theme can put a CSS
 * transition on `.hand-rot` and a patched re-render sweeps the hand. Turns
 * are not reduced mod 1: pass 1.3 for a hand that went once around and on
 * to three-tenths, and the sweep runs forward through twelve. */
export interface ClockOpts {
  /** Where the hand points; omit for a bare face. */
  turns?: number | null;
  /** A faded second hand — where the hand was, or a reference position. */
  ghost?: number | null;
  /** Tick marks, in turns (ten tenths for a digit wheel). */
  ticks?: number[];
  /** Hand length, 0…1 — pooled energy on a chord, or emphasis. */
  mag?: number;
  /** Hand role: a `hand-*` class from the ink table; its tip takes the
   * matching `tip-*` class. */
  cls?: string;
  size?: number;
  /** A caption under the face; wraps the svg in a `.clock-cell`. */
  label?: string;
  labelCls?: string;
}

export interface Styled {
  /** h() for classed SVG elements: class for the web theme, ink attributes
   * for print. Explicit attrs still win over the class defaults. */
  s(tag: string, cls: string, attrs?: Attrs, ...children: (string | string[])[]): string;
  axisLabel(x: number, y: number, label: string, anchor?: string): string;
  polyline(points: [number, number][], cls: string): string;
  /** A clock face drawn in the project's ink. The consumer's table supplies
   * `clock-rim`, `clock-tick`, `clock-pin`, `clock-hand hand-ghost`, and one
   * `clock-hand hand-<role>` / `tip tip-<role>` pair per hand role it uses. */
  clockFace(opts: ClockOpts): string;
}

export function makeStyled(classAttrs: Record<string, Attrs>): Styled {
  const s: Styled["s"] = (tag, cls, attrs = {}, ...children) =>
    h(tag, { class: cls, ...(classAttrs[cls] ?? {}), ...attrs }, ...children);
  const clockFace: Styled["clockFace"] = (opts) => {
    const {
      turns = null, ghost = null, ticks, mag = 1,
      cls = "hand-plain", size = 84, label, labelCls = "",
    } = opts;
    const r = size * 0.42;
    const c = size / 2;
    const at = (t: number) => t * 2 * Math.PI - Math.PI / 2; // clockwise from twelve
    const kids: string[] = [s("circle", "clock-rim", { cx: c, cy: c, r, fill: "none" })];
    for (const t of ticks ?? []) {
      const a = at(t);
      kids.push(
        s("line", "clock-tick", {
          x1: (c + Math.cos(a) * r * 0.88).toFixed(2), y1: (c + Math.sin(a) * r * 0.88).toFixed(2),
          x2: (c + Math.cos(a) * r).toFixed(2), y2: (c + Math.sin(a) * r).toFixed(2),
        }),
      );
    }
    // a hand points up from the pin and is rotated into place: translate to
    // the center, then rotate — two groups, so the rotation alone can animate
    const hand = (t: number, len: number, lineCls: string, tip: string | null): string =>
      h(
        "g",
        { class: "hand-g", "data-key": tip ? "hand" : "ghost", transform: `translate(${c} ${c})` },
        h(
          "g",
          { class: "hand-rot", transform: `rotate(${(t * 360).toFixed(2)})` },
          s("line", lineCls, { x1: 0, y1: 0, x2: 0, y2: (-len).toFixed(2) }),
          tip ? s("circle", tip, { cx: 0, cy: (-len).toFixed(2), r: 2.6 }) : "",
        ),
      );
    if (ghost != null) kids.push(hand(ghost, r * 0.86, "clock-hand hand-ghost", null));
    if (turns != null) {
      const len = r * 0.86 * Math.max(0.06, Math.min(1, mag));
      kids.push(hand(turns, len, `clock-hand ${cls}`, `tip ${cls.replace(/^hand-/, "tip-")}`));
    }
    kids.push(s("circle", "clock-pin", { cx: c, cy: c, r: 1.8 }));
    const svg = h("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: "clock" }, kids);
    if (label == null) return svg;
    return `<div class="clock-cell">${svg}<div class="clock-cap ${labelCls}">${esc(label)}</div></div>`;
  };
  return {
    s,
    axisLabel: (x, y, label, anchor = "middle") =>
      s("text", "ax-label", { x, y, "text-anchor": anchor }, text(label)),
    polyline: (points, cls) =>
      s("polyline", cls, {
        points: points.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" "),
        fill: "none",
      }),
    clockFace,
  };
}

/** Chart scaffold: panel-relative coordinates with margins. */
export interface Frame {
  w: number;
  h: number;
  l: number;
  r: number;
  t: number;
  b: number;
  x(v: number): number;
  y(v: number): number;
}

export function frame(
  w: number,
  h: number,
  xd: [number, number],
  yd: [number, number],
  m = { l: 46, r: 14, t: 14, b: 30 },
): Frame {
  return {
    w,
    h,
    l: m.l,
    r: m.r,
    t: m.t,
    b: m.b,
    x: (v) => m.l + ((v - xd[0]) / (xd[1] - xd[0])) * (w - m.l - m.r),
    y: (v) => h - m.b - ((v - yd[0]) / (yd[1] - yd[0])) * (h - m.t - m.b),
  };
}

/** The modelmap figure: a limned graph drawn as cards and edges, with the
 * reading controls a large model needs.
 *
 * One renderer serves the static page, the PDF, and every re-render in
 * the browser. The hydrator adds what a static picture cannot: click a
 * stacked card to open the subtree it folds, click a group's label to
 * fold it back, step the whole map a level deeper or shallower, search
 * for a module by name, read a card's shapes and docs in a detail panel,
 * and take the map full screen, where it pans and zooms. Every card is
 * keyed, so a re-render slides cards to their new places instead of
 * redrawing the picture.
 *
 * A consumer wires it in as one figure kind:
 *
 *   export const modelMap = defineFigure<ModelmapSpec>({
 *     kind: "model-map", required: ["src", "depth"],
 *     render: renderModelmapFigure, hydrate: hydrateModelmapFigure,
 *   });
 *
 * with `resolveModelmap` (from `penname/modelmap-build`) as the
 * vocabulary's `resolve`, so the graph JSON is read at build time and
 * the renderer never touches the filesystem. The ink is the base theme's
 * unless the site's stylesheet restyles the `mm-` classes.
 */

import { ctlRow, patch } from "./hydrate.js";
import {
  layoutModelmap,
  openAtDepth,
  type Limned,
  type MapOptions,
  type ModelLayout,
  type PlacedNode,
} from "./modelmap.js";
import { h, makeStyled, MONO, text } from "./svg.js";

export interface ModelmapSpec {
  kind: "model-map";
  /** Modelmap JSON under the repo root, extracted by `limned`. */
  src: string;
  /** Qualified-name segments shown before a subtree folds into one card. */
  depth: number;
  /** Containers opened beyond the depth — the authored starting point. */
  open?: string[];
  /** Subtrees kept as single cards at any depth. */
  close?: string[];
  /** Input ports left out of the picture. */
  hide?: string[];
  /** Identical numbered siblings drawn once with a ×N badge. Default true. */
  templates?: boolean;
  /** Frame width a narrower graph is centered in. */
  width?: number;
  /** Title line; the model's name and parameter count by default. */
  title?: string;
  /** Note under the figure; the legend by default. */
  note?: string;
  /** The parsed graph, injected at build time by `resolveModelmap`. */
  graph?: unknown;
  caption?: string;
}

// ── ink: print-safe presentation attributes ─────────────────────────────
// The web theme restyles every class from its tokens (base-web.css); the
// PDF renders these as they are.
const INK = {
  card: "#ffffff",
  line: "#5c6270",
  faint: "#8a919e",
  ghost: "#b5bbc6",
  rim: "#d5d9e0",
  port: "#f3f4f6",
  frozen: "#e8f2f5",
  frozenLine: "#0b7285",
  tie: "#b06f10",
};
const font = { "font-family": MONO };
const { s } = makeStyled({
  "mm-node": { fill: INK.card, stroke: INK.line, "stroke-width": 1.2 },
  "mm-node port": { fill: INK.port, stroke: INK.rim, "stroke-width": 1.1 },
  "mm-node frozen": { fill: INK.frozen, stroke: INK.frozenLine, "stroke-width": 1.3 },
  "mm-node dormant": {
    fill: INK.card, stroke: INK.ghost, "stroke-width": 1.1, "stroke-dasharray": "3 3", opacity: 0.6,
  },
  "mm-node shadow": { fill: INK.card, stroke: INK.line, "stroke-width": 1.2, opacity: 0.5 },
  "mm-hull": { fill: INK.ghost, "fill-opacity": 0.14, stroke: INK.rim, "stroke-width": 1, rx: 8 },
  "mm-hull template": {
    fill: INK.card, "fill-opacity": 0.5, stroke: INK.faint, "stroke-width": 1.1, "stroke-dasharray": "6 4", rx: 8,
  },
  "mm-edge": { fill: "none", stroke: INK.ghost, "stroke-width": 1.3 },
  "mm-edge port": { fill: "none", stroke: INK.rim, "stroke-width": 1.2 },
  "mm-edge frozen": { fill: "none", stroke: INK.frozenLine, "stroke-width": 1.4 },
  "mm-edge tie": { fill: "none", stroke: INK.tie, "stroke-width": 1.4, "stroke-dasharray": "5 4" },
  "mm-tip": { fill: INK.ghost },
  "mm-tip port": { fill: INK.rim },
  "mm-tip frozen": { fill: INK.frozenLine },
  "mm-name": { fill: INK.line, "font-size": 11, "font-weight": 600, "text-anchor": "middle", ...font },
  "mm-sub": { fill: INK.faint, "font-size": 9, "font-weight": 400, "text-anchor": "middle", ...font },
  "mm-hull-label": { fill: INK.faint, "font-size": 10, "font-weight": 600, ...font },
});

const fixed = (v: number) => v.toFixed(1);

const options = (spec: ModelmapSpec): MapOptions => ({
  depth: spec.depth,
  open: spec.open,
  close: spec.close,
  hide: spec.hide,
  templates: spec.templates,
  width: spec.width,
});

/** The picture alone: one `<svg>` of hulls, edges, arrows, ties, cards. */
export function renderModelmapScene(map: ModelLayout): string {
  const kids: string[] = [];
  for (const hull of map.hulls) {
    kids.push(
      h(
        "g",
        { class: "mm-group", "data-collapse": hull.id, "data-key": `hull:${hull.id}` },
        s("rect", hull.kind === "template" ? "mm-hull template" : "mm-hull", {
          x: fixed(hull.x), y: fixed(hull.y), width: fixed(hull.w), height: fixed(hull.h),
        }),
        s("text", "mm-hull-label", {
          x: fixed(hull.x + 8), y: fixed(hull.y + 13), "font-size": fixed(10 * hull.scale),
        }, text(`▾ ${hull.label}`)),
      ),
    );
  }
  const kindOf = new Map(map.nodes.map((n) => [n.id, n.kind]));
  for (const edge of map.edges) {
    const src = kindOf.get(edge.src);
    const variant = src === "buffer" ? " frozen" : src === "input" ? " port" : "";
    kids.push(
      h(
        "g",
        { "data-key": `edge:${edge.src}→${edge.dst}`, "data-edge": `${edge.src}→${edge.dst}` },
        h("title", {}, text(`${edge.src} → ${edge.dst}  [${edge.shape.join("×")}]`)),
        s("path", `mm-edge${variant}`, { d: edge.d }),
      ),
    );
  }
  for (const a of map.arrows) {
    const variant = a.variant ? ` ${a.variant}` : "";
    kids.push(
      h(
        "g",
        { "data-key": `arrow:${fixed(a.x)}:${fixed(a.y)}` },
        s("path", `mm-edge${variant}`, { d: `M ${fixed(a.x)} ${fixed(a.y - 12)} L ${fixed(a.x)} ${fixed(a.y - 5)}` }),
        s("polygon", `mm-tip${variant}`, {
          points: `${fixed(a.x)},${fixed(a.y)} ${fixed(a.x - 3.4)},${fixed(a.y - 7)} ${fixed(a.x + 3.4)},${fixed(a.y - 7)}`,
        }),
      ),
    );
  }
  for (const tie of map.ties) {
    kids.push(
      h(
        "g",
        { "data-key": `tie:${tie.a}:${tie.b}` },
        h("title", {}, text(`${tie.a} and ${tie.b} share one weight`)),
        s("path", "mm-edge tie", { d: tie.d }),
      ),
    );
  }
  for (const node of map.nodes) kids.push(renderCard(node));
  return h(
    "svg",
    {
      viewBox: `0 0 ${fixed(map.w)} ${fixed(map.h)}`,
      width: fixed(map.w),
      height: fixed(map.h),
      class: "mm-svg",
    },
    h("g", { class: "mm-scene", "data-key": "scene" }, kids),
  );
}

function renderCard(node: PlacedNode): string {
  const cls =
    node.kind === "buffer" ? "mm-node frozen"
    : node.kind === "input" ? "mm-node port"
    : node.dormant ? "mm-node dormant"
    : "mm-node";
  const cx = node.w / 2;
  const line1 = 14 * node.scale;
  const line2 = 26 * node.scale;
  const twoLine = node.h >= 30 && node.sub;
  const rx = node.kind === "module" ? 5 : node.h / 2;
  return h(
    "g",
    {
      class: `mm-card${node.expandable ? " expandable" : ""} ${node.kind}`,
      "data-node": node.id,
      "data-key": `card:${node.id}`,
      ...(node.expandable ? { "data-expand": node.id } : {}),
      transform: `translate(${fixed(node.x)} ${fixed(node.y)})`,
    },
    h("title", {}, text(node.detail.join("\n"))),
    // A card that folds a subtree sits on a visible stack — the paper
    // tell for "there is more underneath".
    node.expandable
      ? s("rect", "mm-node shadow", { x: 4, y: 4, width: fixed(node.w), height: fixed(node.h), rx: 5 })
      : "",
    s("rect", cls, { x: 0, y: 0, width: fixed(node.w), height: fixed(node.h), rx: fixed(rx) }),
    s("text", "mm-name", {
      x: fixed(cx), y: fixed(twoLine ? line1 : node.h / 2 - 1), "font-size": fixed(11 * node.scale),
    }, text(node.expandable ? `${node.label} ▸` : node.label)),
    node.sub
      ? s("text", "mm-sub", {
          x: fixed(cx), y: fixed(twoLine ? line2 : node.h / 2 + 9), "font-size": fixed(9 * node.scale),
        }, text(node.sub))
      : "",
  );
}

const LEGEND =
  "cards are modules and a stacked card folds a subtree · capsules are the " +
  "inputs · a dashed capsule is a frozen buffer · a dashed arc is a shared weight";

/** The figure: title, the picture in a scrolling stage, and a note. */
export function renderModelmapFigure(spec: ModelmapSpec): string {
  const graph = spec.graph as Limned | undefined;
  if (!graph) {
    return `<div class="fig-note">modelmap unresolved — pass resolveModelmap as the vocabulary's resolve</div>`;
  }
  const map = layoutModelmap(graph, options(spec));
  const title = spec.title ?? `${map.name} — ${map.params} parameters`;
  return (
    `<div class="fig-title">${text(title)}</div>` +
    `<div class="mm-body"><div class="mm-stage">${renderModelmapScene(map)}</div></div>` +
    `<div class="fig-note">${text(spec.note ?? LEGEND)}</div>`
  );
}

// ── the browser side ────────────────────────────────────────────────────

const btn = (label: string, title: string, onclick: () => void): HTMLButtonElement => {
  const b = document.createElement("button");
  b.className = "btn mm-btn";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onclick);
  return b;
};

/** Every container id in the graph, deepest first, for the depth stepper's ceiling. */
function maxDepth(graph: Limned): number {
  let deepest = 1;
  for (const n of graph.nodes) deepest = Math.max(deepest, n.id.split(".").length);
  return deepest;
}

export function hydrateModelmapFigure(body: HTMLElement, spec0: ModelmapSpec): void {
  const spec = { ...spec0 };
  const graph = spec.graph as Limned | undefined;
  if (!graph) return;
  const fig = body.closest<HTMLElement>("figure.fig");
  const stage = body.querySelector<HTMLElement>(".mm-stage");
  const wrap = body.querySelector<HTMLElement>(".mm-body");
  if (!stage || !wrap) return;

  // ── state ──
  let depth = spec.depth;
  const open = new Set(openAtDepth(graph, depth, { close: spec.close, templates: spec.templates }));
  for (const id of spec.open ?? []) open.add(id);
  let map: ModelLayout = layoutModelmap(graph, { ...options(spec), depth: 1, open: [...open] });
  let full = false;
  let selected: string | null = null;
  let query = "";
  // Full-screen view: scale and the scene point under the viewport's origin.
  const view = { k: 1, x: 0, y: 0 };

  // ── chrome ──
  const depthOut = document.createElement("span");
  depthOut.className = "ctl-value";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "ctl-text mm-search";
  search.placeholder = "find a module";
  search.setAttribute("aria-label", "find a module");
  const zoomOut = document.createElement("span");
  zoomOut.className = "ctl-value mm-zoom";
  const fullBtn = btn("⤢ full screen", "Open the map full screen (Esc closes)", () => setFull(!full));
  const bar = ctlRow(
    btn("−", "Fold one level", () => stepDepth(-1)),
    depthOut,
    btn("+", "Open one level", () => stepDepth(1)),
    btn("⟲", "Back to the authored view", () => reset()),
    search,
    fullBtn,
    btn("fit", "Fit the whole map in view", () => fit()),
    zoomOut,
  );
  bar.classList.add("mm-bar");
  const detail = document.createElement("div");
  detail.className = "mm-detail";
  wrap.append(detail);
  body.prepend(bar);

  // ── rendering ──
  const render = () => {
    map = layoutModelmap(graph, { ...options(spec), depth: 1, open: [...open] });
    patch(stage, renderModelmapScene(map));
    applyView();
    applyQuery();
    applySelection();
    depthOut.textContent = `depth ${depth}`;
  };
  const svg = () => stage.querySelector<SVGSVGElement>("svg.mm-svg");
  const applyView = () => {
    const el = svg();
    if (!el) return;
    if (!full) {
      el.setAttribute("viewBox", `0 0 ${map.w.toFixed(1)} ${map.h.toFixed(1)}`);
      el.setAttribute("width", map.w.toFixed(1));
      el.setAttribute("height", map.h.toFixed(1));
      return;
    }
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    el.setAttribute("width", "100%");
    el.setAttribute("height", "100%");
    el.setAttribute("viewBox", `${view.x.toFixed(2)} ${view.y.toFixed(2)} ${(W / view.k).toFixed(2)} ${(H / view.k).toFixed(2)}`);
    zoomOut.textContent = `${Math.round(view.k * 100)}%`;
  };
  const applyQuery = () => {
    const q = query.trim().toLowerCase();
    for (const card of stage.querySelectorAll<SVGGElement>(".mm-card")) {
      const id = card.getAttribute("data-node") ?? "";
      const hit = q !== "" && id.toLowerCase().includes(q);
      card.classList.toggle("hit", hit);
      card.classList.toggle("dim", q !== "" && !hit);
    }
  };
  const applySelection = () => {
    for (const card of stage.querySelectorAll<SVGGElement>(".mm-card")) {
      card.classList.toggle("selected", card.getAttribute("data-node") === selected);
    }
    const node = map.nodes.find((n) => n.id === selected);
    showDetail(node ?? null);
  };
  const showDetail = (node: PlacedNode | null) => {
    if (!node) {
      detail.innerHTML =
        `<span class="mm-detail-hint">hover a card for its shapes and sizes · click a stacked card to open it · click a group's label to fold it</span>`;
      return;
    }
    const [head, ...rest] = node.detail;
    detail.innerHTML =
      `<b>${text(node.label)}</b>${node.sub ? ` <span class="mm-detail-sub">${text(node.sub)}</span>` : ""}` +
      `<div class="mm-detail-path">${text(head)}</div>` +
      rest.map((line) => `<div>${text(line)}</div>`).join("");
  };

  // ── navigation ──
  const stepDepth = (by: number) => {
    depth = Math.max(1, Math.min(maxDepth(graph), depth + by));
    open.clear();
    for (const id of openAtDepth(graph, depth, { close: spec.close, templates: spec.templates })) open.add(id);
    render();
  };
  const reset = () => {
    depth = spec.depth;
    open.clear();
    for (const id of openAtDepth(graph, depth, { close: spec.close, templates: spec.templates })) open.add(id);
    for (const id of spec.open ?? []) open.add(id);
    selected = null;
    query = "";
    search.value = "";
    render();
    if (full) fit();
  };
  const collapse = (id: string) => {
    for (const at of [...open]) if (at === id || at.startsWith(`${id}.`)) open.delete(at);
    if (selected && (selected === id || selected.startsWith(`${id}.`))) selected = id;
    render();
  };
  const reveal = (q: string) => {
    // Open every container on the way to each matching module.
    const needle = q.trim().toLowerCase();
    if (!needle) return;
    let changed = false;
    for (const n of graph.nodes) {
      if (!n.id.toLowerCase().includes(needle)) continue;
      const parts = n.id.split(".");
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join(".");
        const projected = map.nodes.find((v) => v.id === prefix || prefix.startsWith(v.id + "."));
        void projected;
        if (!open.has(prefix)) {
          open.add(prefix);
          changed = true;
        }
      }
    }
    if (changed) render();
  };

  // ── full screen: pan and zoom ──
  const clampZoom = (k: number) => Math.max(0.15, Math.min(4, k));
  const fit = () => {
    if (!full) return;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    view.k = clampZoom(Math.min(W / map.w, H / map.h) * 0.94);
    view.x = (map.w - W / view.k) / 2;
    view.y = (map.h - H / view.k) / 2;
    applyView();
  };
  const zoomAt = (factor: number, px: number, py: number) => {
    // Keep the scene point under (px, py) fixed while scaling.
    const k0 = view.k;
    const k1 = clampZoom(k0 * factor);
    const sx = view.x + px / k0;
    const sy = view.y + py / k0;
    view.k = k1;
    view.x = sx - px / k1;
    view.y = sy - py / k1;
    applyView();
  };
  const setFull = (on: boolean) => {
    full = on;
    fig?.classList.toggle("mm-full", on);
    document.documentElement.classList.toggle("mm-lock", on);
    fullBtn.textContent = on ? "✕ close" : "⤢ full screen";
    if (on) fit();
    else applyView();
  };
  stage.addEventListener(
    "wheel",
    (ev) => {
      if (!full) return;
      ev.preventDefault();
      const box = stage.getBoundingClientRect();
      zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - box.left, ev.clientY - box.top);
    },
    { passive: false },
  );
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  stage.addEventListener("pointerdown", (ev) => {
    if (!full || ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false };
    stage.setPointerCapture(ev.pointerId);
  });
  stage.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    stage.classList.add("panning");
    view.x = drag.vx - dx / view.k;
    view.y = drag.vy - dy / view.k;
    applyView();
  });
  const endDrag = () => {
    stage.classList.remove("panning");
    drag = null;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", () => full && applyView());
  document.addEventListener("keydown", (ev) => {
    if (!full || ev.target === search) return;
    if (ev.key === "Escape") setFull(false);
    else if (ev.key === "0") fit();
    else if (ev.key === "+" || ev.key === "=") zoomAt(1.25, stage.clientWidth / 2, stage.clientHeight / 2);
    else if (ev.key === "-") zoomAt(0.8, stage.clientWidth / 2, stage.clientHeight / 2);
  });

  // ── clicks: open, fold, select ──
  stage.addEventListener("click", (ev) => {
    if (drag?.moved) return;
    const target = ev.target as Element;
    const card = target.closest<SVGGElement>("[data-node]");
    if (card) {
      const id = card.getAttribute("data-node")!;
      selected = id;
      if (card.hasAttribute("data-expand")) open.add(id);
      render();
      return;
    }
    const fold = target.closest("[data-collapse]");
    if (fold) {
      collapse(fold.getAttribute("data-collapse")!);
      return;
    }
    // Empty hull area: fold the smallest box under the pointer.
    const el = svg();
    const box = el?.getBoundingClientRect();
    if (el && box && box.width) {
      const vb = el.viewBox.baseVal;
      const px = vb.x + ((ev.clientX - box.left) / box.width) * vb.width;
      const py = vb.y + ((ev.clientY - box.top) / box.height) * vb.height;
      let best: { id: string; area: number } | null = null;
      for (const hull of map.hulls) {
        if (px >= hull.x && px <= hull.x + hull.w && py >= hull.y && py <= hull.y + hull.h) {
          const area = hull.w * hull.h;
          if (!best || area < best.area) best = { id: hull.id, area };
        }
      }
      if (best) {
        collapse(best.id);
        return;
      }
    }
    selected = null;
    applySelection();
  });
  stage.addEventListener("pointerover", (ev) => {
    const card = (ev.target as Element).closest<SVGGElement>("[data-node]");
    if (!card || selected) return;
    showDetail(map.nodes.find((n) => n.id === card.getAttribute("data-node")) ?? null);
  });
  stage.addEventListener("pointerout", (ev) => {
    if (selected) return;
    const card = (ev.target as Element).closest("[data-node]");
    if (card) showDetail(null);
  });
  search.addEventListener("input", () => {
    query = search.value;
    applyQuery();
  });
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") reveal(search.value);
    if (ev.key === "Escape") {
      search.value = "";
      query = "";
      applyQuery();
      search.blur();
    }
  });

  render();
}

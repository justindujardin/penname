/** Layout for limned modelmaps — the JSON `py/limned.py` extracts from a
 * PyTorch model becomes positioned boxes, hulls and edges here, and a
 * consumer's renderer turns those into SVG in its own ink.
 *
 * Pure and synchronous on purpose: this file is bundled into the hydrate
 * script, so a browser control (a depth stepper) can re-lay the same graph
 * without a server round trip, and the PDF gets the identical geometry.
 *
 * The semantic passes are local — depth projection, template folding
 * (`blocks.0..7` → one ×8 card or one opened interior), transitive
 * reduction of pseudo-source edges only (a residual skip is a finding,
 * not clutter) — and the geometry is dagre's compound layered layout,
 * which owns ranking, ordering, coordinates and cluster boxes.
 */

import dagre from "@dagrejs/dagre";

// ── the JSON contract (mirrors py/limned.py) ────────────────────────────

export interface LimnedNode {
  id: string;
  cls: string;
  params: number;
  buffers: number;
  calls: number;
  order?: number;
  in?: number[][];
  out?: number[][];
  /** The attribute's `#:` doc, or the class docstring's first paragraph. */
  doc?: string;
  /** Banner-comment section or explicit annotation group. */
  group?: string;
  /** Explicit display label from `limn(..., label=…)`. */
  label?: string;
  /** torch's own `extra_repr()` — what the built-ins registry formats. */
  extra?: string;
}

export interface LimnedEdge {
  src: string;
  dst: string;
  shape: number[];
  n: number;
}

export interface LimnedPort {
  name: string;
  shape: number[];
  dtype: string;
  consumed?: boolean;
}

export interface LimnedGroup {
  label: string;
  members: string[];
}

export interface Limned {
  limned: number;
  name: string;
  doc?: string;
  symbol: string;
  torch: string;
  params_total: number;
  buffers_total: number;
  inputs: LimnedPort[];
  buffers: LimnedPort[];
  groups?: LimnedGroup[];
  nodes: LimnedNode[];
  edges: LimnedEdge[];
  ties: string[][];
  sinks: { name: string; srcs: string[] }[];
  sources: Record<string, string>;
  generator: string;
}

// ── layout output ───────────────────────────────────────────────────────

export type NodeKind = "module" | "group" | "input" | "buffer";

export interface PlacedNode {
  id: string;
  label: string;
  sub: string;
  kind: NodeKind;
  dormant: boolean;
  repeat: number;
  /** Banner-comment section the module was declared under, if any. */
  group: string;
  /** True when the card folds hidden structure a click can open. */
  expandable: boolean;
  /** Visual weight, 1..~1.3 — a card holding a subtree reads larger
   * than a leaf, in proportion (bounded) to how much it holds. */
  scale: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Tooltip lines: full path, shapes, docs, parameter counts. */
  detail: string[];
}

export interface PlacedEdge {
  src: string;
  dst: string;
  /** Ready-to-use SVG path data. Ends at the destination's shared entry
   * stem — the arrowhead belongs to the stem, not the edge. */
  d: string;
  shape: number[];
}

/** One entry per destination card: however many edges feed it, one stem
 * and one arrowhead point into it. */
export interface PlacedArrow {
  x: number;
  y: number;
  /** Ink variant: "" plain, "frozen" when every feed is a buffer,
   * "port" when every feed is an input. */
  variant: string;
}

export interface PlacedTie {
  a: string;
  b: string;
  d: string;
}

export interface Hull {
  id: string;
  label: string;
  /** "family" for an opened container's box, "template" for a repeated
   * instance's interior drawn once with its ×N badge. */
  kind: "family" | "template";
  /** Label size multiplier, 1..~1.5 — a group holding more reads
   * louder, within reason. */
  scale: number;
  /** True when the box would collide with foreign cards and only the
   * label is drawn — collapse stays clickable either way. */
  bare?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ModelLayout {
  w: number;
  h: number;
  name: string;
  params: string;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  arrows: PlacedArrow[];
  ties: PlacedTie[];
  hulls: Hull[];
}

export interface MapOptions {
  /** Qualified-name segments rendered before a subtree folds into one
   * card. 1 is the top-level attributes. Containers shallower than this
   * start open; `open` reaches deeper. */
  depth: number;
  /** Containers rendered expanded regardless of depth — the working
   * state of click-to-unfold navigation, and an author's way to open
   * one subtree in a static figure. */
  open?: string[];
  /** Subtrees never opened past their root, whatever the depth —
   * presentational focus, e.g. keep entry MLPs as single cards. */
  close?: string[];
  /** Input ports left out of the picture (a loss denominator like
   * `cost` earns its keep in a caption, not a box). */
  hide?: string[];
  /** Treat identical numbered siblings as one template: `blocks.0…7`
   * renders as one card — or, when opened, one interior — with a ×8
   * badge. The structure is what a diagram conveys; drawing it eight
   * times adds ink, not information. Default true. */
  templates?: boolean;
  /** Deprecated alias for `templates`. */
  collapse?: boolean;
  /** Frame width the ranks wrap to. Default 960. */
  width?: number;
}

export function human(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

const shapeText = (shapes: number[][] | undefined) =>
  (shapes ?? []).map((s) => `[${s.join("×")}]`).join(" ");

/** How the torch built-ins print on a card — the registry that turns
 * `extra_repr()` into the compact form a diagram wants. Anything not
 * listed falls back to its class name. */
const BUILTIN: Record<string, (extra: string) => string> = {
  Linear: (e) => {
    const m = /in_features=(\d+), out_features=(\d+)/.exec(e);
    return m ? `${m[1]}→${m[2]}` : "Linear";
  },
  Embedding: (e) => {
    const m = /^(\d+), (\d+)/.exec(e);
    return m ? `${m[1]}×${m[2]}` : "Embedding";
  },
  LayerNorm: (e) => {
    const m = /\((\d+),?\)/.exec(e);
    return m ? `norm ${m[1]}` : "LayerNorm";
  },
  Dropout: () => "dropout",
  GELU: () => "gelu",
  ReLU: () => "relu",
  Sequential: () => "mlp",
  ModuleList: () => "list",
};

const clsLabel = (cls: string, extra: string | undefined): string =>
  BUILTIN[cls] ? BUILTIN[cls](extra ?? "") : cls;

// ── internal working node ───────────────────────────────────────────────

interface VNode {
  id: string;
  label: string;
  sub: string;
  kind: NodeKind;
  dormant: boolean;
  repeat: number;
  order: number;
  group: string;
  expandable: boolean;
  scale: number;
  detail: string[];
  rank: number;
  pos: number;
  x: number;
  y: number;
  w: number;
  h: number;
  members: string[];
}

const NODE_H = 34;
const CHAR_W = 6.4;
const PAD_X = 12;

/** Numbered sibling runs with identical structure become one template:
 * every `parent.N.rest` maps to `parent.*.rest`, provided the indices
 * are contiguous and every instance has the same class and the same
 * subtree parameter count — the guards that keep `mlp.0`/`mlp.2` (same
 * class, different layers) out. `count` gives the instance multiplier
 * for a template id, for per-instance parameter display. */
function templateMapper(nodes: LimnedNode[]): {
  map: (id: string) => string;
  count: (id: string) => number;
} {
  const subtree = new Map<string, number>();
  for (const n of nodes) {
    const parts = n.id.split(".");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join(".");
      subtree.set(p, (subtree.get(p) ?? 0) + n.params);
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, number[]>();
  for (const n of nodes) {
    const m = n.id.match(/^(.*)\.(\d+)$/);
    if (m) (kids.get(m[1]) ?? kids.set(m[1], []).get(m[1])!).push(Number(m[2]));
  }
  const counts = new Map<string, number>();
  for (const [parent, indices] of kids) {
    indices.sort((a, b) => a - b);
    if (indices.length < 2) continue;
    const contiguous = indices.every((v, i) => i === 0 || v === indices[i - 1] + 1);
    const sizes = new Set(indices.map((i) => subtree.get(`${parent}.${i}`) ?? 0));
    const classes = new Set(indices.map((i) => byId.get(`${parent}.${i}`)?.cls));
    if (contiguous && sizes.size === 1 && classes.size === 1) {
      counts.set(parent, indices.length);
    }
  }
  const map = (id: string): string => {
    const out: string[] = [];
    for (const part of id.split(".")) {
      out.push(/^\d+$/.test(part) && counts.has(out.join(".")) ? "*" : part);
    }
    return out.join(".");
  };
  const count = (id: string): number => {
    let n = 1;
    const out: string[] = [];
    for (const part of id.split(".")) {
      if (part === "*") n *= counts.get(out.join(".")) ?? 1;
      out.push(part === "*" ? "0" : part);
    }
    return n;
  };
  return { map, count };
}

/** Annotated groups become virtual containers: each member id gains a
 * `§slug` segment before its final attribute, so `word_in` becomes
 * `§entries.word_in` and the whole navigation machinery — cut, open,
 * fold, cluster — treats the pathway like a module subtree the code
 * never had to declare. A member's own subtree rides along. */
function groupMapper(
  groups: LimnedGroup[] | undefined,
  tmMap: (id: string) => string,
): { map: (id: string) => string; label: (seg: string) => string | undefined } {
  const bySlug = new Map<string, string>();
  const rewrite = new Map<string, string>();
  for (const group of groups ?? []) {
    const slug =
      "§" +
      group.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    bySlug.set(slug, group.label);
    for (const raw of group.members) {
      const mid = tmMap(raw);
      const cut = mid.lastIndexOf(".");
      const parent = cut === -1 ? "" : mid.slice(0, cut);
      const attr = cut === -1 ? mid : mid.slice(cut + 1);
      rewrite.set(mid, parent ? `${parent}.${slug}.${attr}` : `${slug}.${attr}`);
    }
  }
  const map = (id: string): string => {
    let best: string | null = null;
    for (const m of rewrite.keys()) {
      if ((id === m || id.startsWith(`${m}.`)) && (!best || m.length > best.length)) {
        best = m;
      }
    }
    return best ? rewrite.get(best)! + id.slice(best.length) : id;
  };
  return { map, label: (seg) => bySlug.get(seg) };
}

/** Strip the virtual `§` segments back off — the raw id the extractor
 * actually knows about. */
const real = (id: string): string =>
  id.split(".").filter((s) => !s.startsWith("§")).join(".");

/** The container ids a given depth would render expanded, in template-
 * mapped space — how a client turns an authored `depth` into the `open`
 * set that click-to-unfold navigation then edits. */
export function openAtDepth(
  graph: Limned,
  depth: number,
  opts?: { templates?: boolean; close?: string[] },
): string[] {
  const tm =
    (opts?.templates ?? true)
      ? templateMapper(graph.nodes)
      : { map: (id: string) => id, count: () => 1 };
  const gm = groupMapper(graph.groups, tm.map);
  const close = new Set(opts?.close ?? []);
  const containers = new Set<string>();
  for (const n of graph.nodes) {
    const parts = gm.map(tm.map(n.id)).split(".");
    for (let i = 1; i < parts.length; i++) {
      containers.add(parts.slice(0, i).join("."));
    }
  }
  return [...containers].filter(
    (id) => id.split(".").length < depth && !close.has(real(id)),
  );
}

export function layoutModelmap(graph: Limned, opts: MapOptions): ModelLayout {
  const depth = Math.max(1, opts.depth);
  const close = opts.close ?? [];
  const hide = new Set(opts.hide ?? []);
  const templates = opts.templates ?? opts.collapse ?? true;
  const tm = templates
    ? templateMapper(graph.nodes)
    : { map: (id: string) => id, count: () => 1 };
  const gm = groupMapper(graph.groups, tm.map);
  const project = (id: string): string => gm.map(tm.map(id));
  const pretty = (seg: string): string =>
    seg.startsWith("§") ? gm.label(seg) ?? seg.slice(1) : seg;

  // ── project every extracted module to its visible ancestor ────────────
  // A container renders expanded when it sits shallower than `depth` or
  // in the `open` set; the projection cuts at the first closed one.
  // This is the whole navigation model: opening a card is adding its id
  // to `open` and laying out again.
  const closeSet = new Set(close);
  const openSet = new Set(opts.open ?? []);
  const kidsOf = new Map<string, number>();
  for (const n of graph.nodes) {
    const parts = project(n.id).split(".");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join(".");
      kidsOf.set(prefix, (kidsOf.get(prefix) ?? 0) + 1);
    }
  }
  const isOpen = (id: string): boolean =>
    !closeSet.has(real(id)) &&
    (id.split(".").length < depth || openSet.has(id));
  const visible = (id: string): string => {
    const parts = id.split(".");
    let at = "";
    for (let i = 0; i < parts.length; i++) {
      at = at ? `${at}.${parts[i]}` : parts[i];
      if (i < parts.length - 1 && !isOpen(at)) return at;
    }
    return at;
  };
  const place = (id: string): string => visible(project(id));

  // A card is live when it or anything under it fired: a ModuleList
  // never runs a forward of its own, and flagging it dormant while its
  // blocks carry the whole model would be the diagram lying.
  const executed = new Map<string, boolean>();
  for (const n of graph.nodes) {
    if (n.calls === 0) continue;
    const parts = project(n.id).split(".");
    for (let i = 1; i <= parts.length; i++) {
      executed.set(parts.slice(0, i).join("."), true);
    }
  }
  for (const n of graph.nodes) {
    const v = place(n.id);
    if (!executed.has(v)) executed.set(v, false);
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // A template id's representative raw node is its first instance;
  // virtual group segments strip back off before the lookup.
  const rep = (id: string): LimnedNode | undefined =>
    byId.get(real(id)) ?? byId.get(real(id).replaceAll("*", "0"));
  const vnodes = new Map<string, VNode>();
  for (const n of graph.nodes) {
    const v = place(n.id);
    let vn = vnodes.get(v);
    if (!vn) {
      const own = rep(v);
      const instances = tm.count(real(v));
      const container = v.endsWith(".*");
      const hidden = kidsOf.get(v) ?? 0;
      const expandable = hidden > 0 && !closeSet.has(real(v));
      const last = v.split(".").pop() ?? v;
      vn = {
        id: v,
        label: container
          ? `${own?.cls ?? "?"} ×${instances}`
          : last.startsWith("§")
            ? pretty(last)
            : own?.label ?? last,
        sub: own && !container ? clsLabel(own.cls, own.extra) : "",
        kind: "module",
        dormant: !(executed.get(v) ?? false),
        repeat: container ? instances : 1,
        order: own?.order ?? Number.MAX_SAFE_INTEGER,
        group: own?.group ?? "",
        expandable,
        // A card standing for a subtree earns size from what it holds —
        // log-ish and clamped, so trunk is prominent without being a
        // billboard.
        scale: expandable ? Math.min(1.3, 1 + hidden / 90) : 1,
        detail: [
          container ? `${v} — ${instances} identical instances` : v,
          ...(expandable ? [`folds ${hidden} modules — click to open`] : []),
        ],
        rank: 0,
        pos: 0,
        x: 0,
        y: 0,
        w: 0,
        h: NODE_H,
        members: [],
      };
      vnodes.set(v, vn);
    }
    vn.members.push(n.id);
    if (n.order !== undefined) vn.order = Math.min(vn.order, n.order);
  }

  // Aggregate parameter and buffer counts over each card's members —
  // shown per instance when the card stands for a template, because
  // "one Block is 9.6M" is the fact a reader uses; the total rides in
  // the tooltip.
  for (const vn of vnodes.values()) {
    let params = 0;
    let buffers = 0;
    for (const m of vn.members) {
      const n = byId.get(m)!;
      params += n.params;
      buffers += n.buffers;
    }
    const instances = tm.count(real(vn.id));
    const per = params / instances;
    const perBuf = buffers / instances;
    const own = rep(vn.id);
    if (own?.in?.length) vn.detail.push(`in ${shapeText(own.in)}`);
    if (own?.out?.length) vn.detail.push(`out ${shapeText(own.out)}`);
    if (params) {
      vn.detail.push(
        instances > 1
          ? `${human(per)} params × ${instances} = ${human(params)}`
          : `${human(params)} params`,
      );
    }
    if (buffers) vn.detail.push(`${human(perBuf)} frozen floats`);
    if (vn.group) vn.detail.push(`§ ${vn.group}`);
    if (vn.dormant) vn.detail.push("never fired on the example batch");
    if (own?.doc) vn.detail.push(own.doc);
    vn.sub = [vn.sub, per ? human(per) : perBuf ? `${human(perBuf)}◦` : ""]
      .filter(Boolean)
      .join(" · ");
  }

  // ── pseudo-nodes for inputs and consumed buffers ──────────────────────
  const ports: { id: string; port: LimnedPort; kind: NodeKind }[] = [
    ...graph.inputs
      .filter((p) => !hide.has(p.name))
      .map((p) => ({ id: `input:${p.name}`, port: p, kind: "input" as const })),
    ...graph.buffers
      .filter((p) => p.consumed && !hide.has(p.name))
      .map((p) => ({ id: `buffer:${p.name}`, port: p, kind: "buffer" as const })),
  ];
  const seenPorts = new Set<string>();
  for (const { id, port, kind } of ports) {
    if (seenPorts.has(id)) continue;
    seenPorts.add(id);
    vnodes.set(id, {
      id,
      label: port.name,
      sub: `[${port.shape.join("×")}]`,
      kind,
      dormant: false,
      repeat: 1,
      order: -1,
      group: "",
      expandable: false,
      scale: 1,
      detail: [
        kind === "buffer" ? `frozen buffer ${port.name}` : `input ${port.name}`,
        `[${port.shape.join("×")}] ${port.dtype}`,
      ],
      rank: 0,
      pos: 0,
      x: 0,
      y: 0,
      w: 0,
      // Tall enough for two clear lines: an 11px name with a descending
      // underscore over a 9px shape row needs the same pitch a card gets.
      h: 30,
      members: [],
    });
  }

  // ── visible edges ─────────────────────────────────────────────────────
  const edgeMap = new Map<string, { src: string; dst: string; shape: number[] }>();
  for (const e of graph.edges) {
    const src = e.src.includes(":") ? e.src : place(e.src);
    const dst = place(e.dst);
    if (src === dst || !vnodes.has(src) || !vnodes.has(dst)) continue;
    const key = `${src}→${dst}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { src, dst, shape: e.shape });
  }
  let edges = [...edgeMap.values()];

  // ── opened templates become hulls ─────────────────────────────────────
  // When a template's interior is on screen, the container card
  // dissolves: its exits reattach to the latest-firing interior card and
  // its entries to the earliest, so the flow line runs through the
  // instance the way execution does, and the recurrence between
  // instances folds into the ×N badge instead of a cycle.
  const templateHulls: { id: string; label: string }[] = [];
  for (const vn of [...vnodes.values()]) {
    if (!vn.id.endsWith(".*")) continue;
    const interior = [...vnodes.values()].filter((k) =>
      k.id.startsWith(vn.id + "."),
    );
    if (!interior.length) continue;
    const last = interior.reduce((a, b) => (a.order > b.order ? a : b));
    const first = interior.reduce((a, b) => (a.order < b.order ? a : b));
    edges = edges.flatMap((e) => {
      if (e.src === vn.id) {
        return e.dst.startsWith(vn.id + ".") ? [] : [{ ...e, src: last.id }];
      }
      if (e.dst === vn.id) {
        return e.src.startsWith(vn.id + ".") ? [] : [{ ...e, dst: first.id }];
      }
      return [e];
    });
    templateHulls.push({ id: vn.id, label: vn.label });
    vnodes.delete(vn.id);
  }
  const dedup = new Set<string>();
  edges = edges.filter((e) => {
    const key = `${e.src}→${e.dst}`;
    if (e.src === e.dst || dedup.has(key)) return false;
    dedup.add(key);
    return true;
  });

  // Drop cards nothing touches (containers like a bare ModuleList whose
  // children all folded elsewhere never carry an edge).
  const touched = new Set(edges.flatMap((e) => [e.src, e.dst]));
  for (const vn of [...vnodes.values()]) {
    if (!touched.has(vn.id) && !vn.dormant) vnodes.delete(vn.id);
  }

  // Transitive reduction for pseudo-source edges only: an input that
  // reaches a deep head through the trunk keeps the entry edge and loses
  // the long echo. Module edges stay as extracted — a residual skip is a
  // finding, not clutter.
  const out = new Map<string, string[]>();
  for (const e of edges) (out.get(e.src) ?? out.set(e.src, []).get(e.src)!).push(e.dst);
  const reaches = (from: string, to: string, skip: string): boolean => {
    const stack = (out.get(from) ?? []).filter((d) => !(from === skip.split("→")[0] && d === to));
    const seen = new Set(stack);
    while (stack.length) {
      const at = stack.pop()!;
      if (at === to) return true;
      for (const next of out.get(at) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  };
  edges = edges.filter(
    (e) => !e.src.includes(":") || !reaches(e.src, e.dst, `${e.src}→${e.dst}`),
  );

  // A port whose consumers all sit in one section belongs to it too, so
  // the ordering pass keeps an auxiliary input beside the heads that
  // read it.
  for (const vn of vnodes.values()) {
    if (vn.kind !== "input" && vn.kind !== "buffer") continue;
    const groups = new Set(
      edges.filter((e) => e.src === vn.id).map((e) => vnodes.get(e.dst)?.group ?? ""),
    );
    if (groups.size === 1) vn.group = [...groups][0];
  }

  // ── geometry: dagre's compound layered layout ─────────────────────────
  // Ranking, ordering, coordinates and cluster boxes all come from
  // dagre. Clusters are exclusive regions with their own margins, which
  // is the property the hand-rolled hulls kept violating: a card can
  // sit inside a family box or beside it, never under its border line.
  const nodes = [...vnodes.values()];
  for (const vn of nodes) {
    const chars = Math.max(vn.label.length, vn.sub.length * 0.92);
    vn.w = Math.max(64, chars * CHAR_W + 2 * PAD_X) * vn.scale;
    vn.h = vn.h * vn.scale;
  }

  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({ rankdir: "TB", nodesep: 16, ranksep: 46, marginx: 12, marginy: 10 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const vn of nodes) g.setNode(vn.id, { width: vn.w, height: vn.h });

  // Only templates are real dagre clusters. A family cluster buys a
  // grey wash at the cost of an exclusive column — dagre strands its
  // few members in an empty box and shoves everything else sideways.
  // Templates are tight (contiguous ranks, exclusive members), so the
  // cluster machinery earns its keep exactly there.
  const clusters: { id: string; label: string; kind: "family" | "template" }[] = [];
  for (const t of templateHulls) {
    const kids = nodes.filter((vn) => vn.id.startsWith(t.id + "."));
    if (kids.length < 2) continue;
    const id = `cluster:${t.id}`;
    g.setNode(id, {});
    clusters.push({ id, label: t.label, kind: "template" });
    for (const vn of kids) g.setParent(vn.id, id);
  }
  // Open virtual groups cluster too — that is the routed-together look:
  // dagre keeps a pathway's cards adjacent and boxes them tightly.
  const virtualOpen = new Set<string>();
  for (const vn of nodes) {
    const parts = vn.id.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i].startsWith("§")) {
        virtualOpen.add(parts.slice(0, i + 1).join("."));
      }
    }
  }
  for (const id of virtualOpen) {
    const kids = nodes.filter((vn) => vn.id.startsWith(`${id}.`));
    if (kids.length < 2) continue;
    const cid = `cluster:${id}`;
    g.setNode(cid, {});
    clusters.push({
      id: cid,
      label: pretty(id.split(".").pop() ?? id),
      kind: "family",
    });
    for (const vn of kids) {
      if (!g.parent(vn.id)) g.setParent(vn.id, cid);
    }
  }
  for (const e of edges) g.setEdge(e.src, e.dst);
  dagre.layout(g);

  for (const vn of nodes) {
    const at = g.node(vn.id);
    vn.x = at.x - at.width / 2;
    vn.y = at.y - at.height / 2;
  }
  const graphW = (g.graph().width ?? 0) + 12;
  const graphH = (g.graph().height ?? 0) + 10;
  // A requested width wider than the graph centers it; narrower is
  // ignored — the figure scales in flow and pans in the lightbox.
  const shift = Math.max(0, ((opts.width ?? 0) - graphW) / 2);
  for (const vn of nodes) vn.x += shift;
  const maxW = Math.max(graphW, opts.width ?? 0);
  const height = graphH;

  // A group's label speaks at a volume bounded by its population.
  const hullScale = (members: number) => Math.min(1.5, 1 + members / 14);

  const hulls: Hull[] = [];
  for (const c of clusters) {
    const at = g.node(c.id);
    if (!at) continue;
    const members = nodes.filter((vn) =>
      vn.id.startsWith(c.id.slice("cluster:".length) + "."),
    ).length;
    hulls.push({
      id: c.id.slice("cluster:".length),
      label: c.label,
      kind: c.kind,
      scale: hullScale(members),
      x: at.x - at.width / 2 - 4 + shift,
      y: at.y - at.height / 2 - 4,
      w: at.width + 8,
      h: at.height + 8,
    });
  }
  // Every other opened container gets a post-hoc box — drawn in full
  // when it would touch nobody else's card, label-only when it would;
  // either way the label is there to collapse by.
  const opened = new Set(
    nodes
      .filter((vn) => vn.kind === "module" && vn.id.includes("."))
      .map((vn) => vn.id.split(".").slice(0, -1).join("."))
      .filter((id) => id && !id.endsWith(".*")),
  );
  for (const id of opened) {
    // A container whose interior is a template already has the template
    // hull speaking for it, and an open virtual group has its cluster;
    // a second box would just echo the border.
    if (vnodes.has(`${id}.*`) || hulls.some((h) => h.id === `${id}.*`)) continue;
    if (virtualOpen.has(id)) continue;
    const kids = nodes.filter(
      (vn) => vn.kind === "module" && vn.id.startsWith(id + "."),
    );
    if (kids.length < 2) continue;
    const x0 = Math.min(...kids.map((k) => k.x)) - 8;
    const y0 = Math.min(...kids.map((k) => k.y)) - 20;
    const x1 = Math.max(...kids.map((k) => k.x + k.w)) + 8;
    const y1 = Math.max(...kids.map((k) => k.y + k.h)) + 8;
    const bumped = nodes.some(
      (vn) =>
        !kids.includes(vn) &&
        vn.x < x1 && vn.x + vn.w > x0 &&
        vn.y < y1 && vn.y + vn.h > y0,
    );
    hulls.unshift({
      id, label: pretty(id.split(".").pop() ?? id), kind: "family",
      scale: hullScale(kids.length), bare: bumped,
      x: x0, y: y0, w: x1 - x0, h: y1 - y0,
    });
  }

  // Nested hulls: an outer box grows up and left until its label keeps
  // a band of its own above the inner box's — headings never stack.
  // Innermost first, so a three-deep nest staircases outward.
  for (const outer of [...hulls].sort((a, b) => a.w * a.h - b.w * b.h)) {
    if (outer.bare) continue;
    for (const inner of hulls) {
      if (inner === outer) continue;
      const contained =
        inner.x >= outer.x - 1 && inner.x + inner.w <= outer.x + outer.w + 1 &&
        inner.y >= outer.y - 1 && inner.y + inner.h <= outer.y + outer.h + 1;
      if (!contained) continue;
      if (inner.y - outer.y < 20) {
        const lift = 20 - (inner.y - outer.y);
        outer.y -= lift;
        outer.h += lift;
      }
      if (inner.x - outer.x < 8) {
        const push = 8 - (inner.x - outer.x);
        outer.x -= push;
        outer.w += push;
      }
    }
  }

  // ── edge paths: bundle at both ends ───────────────────────────────────
  // Every edge leaves its source's bottom center and lands on its
  // destination's entry stem, a short vertical just above the card that
  // carries the single arrowhead. Ten feeds into one LayerNorm read as
  // one merging stream and one arrow, not ten arrowheads elbowing along
  // the card's top edge.
  const STEM = 12;
  const placedEdges: PlacedEdge[] = [];
  const arrows: PlacedArrow[] = [];
  const feeds = new Map<string, string[]>();
  for (const e of edges) {
    (feeds.get(e.dst) ?? feeds.set(e.dst, []).get(e.dst)!).push(e.src);
  }
  for (const e of edges) {
    const s = vnodes.get(e.src)!;
    const t = vnodes.get(e.dst)!;
    const x1 = s.x + s.w / 2;
    const x2 = t.x + t.w / 2;
    const y1 = s.y + s.h;
    const y2 = t.y - STEM;
    if (y2 <= y1) {
      // A skip landing beside or above its source bows around the cards
      // and keeps its own arrow; bundling is for the common downward flow.
      const bow = Math.max(s.w, t.w) / 2 + 26;
      placedEdges.push({
        src: e.src, dst: e.dst, shape: e.shape,
        d: `M ${x1} ${y1} C ${x1 + bow} ${y1 + 24}, ${t.x + t.w / 2 + bow} ${t.y - 24}, ${t.x + t.w / 2} ${t.y}`,
      });
      arrows.push({ x: t.x + t.w / 2, y: t.y, variant: "" });
      continue;
    }
    const mid = (y1 + y2) / 2;
    placedEdges.push({
      src: e.src, dst: e.dst, shape: e.shape,
      d: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`,
    });
  }
  for (const [dst, srcs] of feeds) {
    const t = vnodes.get(dst)!;
    const kinds = new Set(srcs.map((id) => vnodes.get(id)?.kind ?? "module"));
    if (t.y - STEM <= Math.max(...srcs.map((id) => vnodes.get(id)!.y))) continue;
    arrows.push({
      x: t.x + t.w / 2,
      y: t.y,
      variant:
        kinds.size === 1 && kinds.has("buffer") ? "frozen"
        : kinds.size === 1 && kinds.has("input") ? "port"
        : "",
    });
  }

  // ── weight ties, drawn as a dashed arc off to the right ───────────────
  const ties: PlacedTie[] = [];
  for (const group of graph.ties) {
    const cards = [
      ...new Set(
        group.map((p) => place(p.split(".").slice(0, -1).join("."))),
      ),
    ].filter((id) => vnodes.has(id));
    for (let i = 1; i < cards.length; i++) {
      const a = vnodes.get(cards[0])!;
      const b = vnodes.get(cards[i])!;
      const x = Math.max(a.x + a.w, b.x + b.w);
      const reach = Math.min(maxW - 6, x + 40);
      ties.push({
        a: cards[0],
        b: cards[i],
        d:
          `M ${a.x + a.w} ${a.y + a.h / 2} C ${reach} ${a.y + a.h / 2}, ` +
          `${reach} ${b.y + b.h / 2}, ${b.x + b.w} ${b.y + b.h / 2}`,
      });
    }
  }

  return {
    w: maxW,
    h: height,
    name: graph.name,
    params: human(graph.params_total),
    nodes: nodes.map(({ members: _members, order: _o, rank: _r, pos: _p, ...keep }) => keep),
    edges: placedEdges,
    arrows,
    ties,
    hulls,
  };
}

/** Layout for limned modelmaps — the JSON `py/limned.py` extracts from a
 * PyTorch model becomes positioned boxes, hulls and edges here, and a
 * consumer's renderer turns those into SVG in its own ink.
 *
 * Pure and synchronous on purpose: this file is bundled into the hydrate
 * script, so a browser control (a depth stepper) can re-lay the same graph
 * without a server round trip, and the PDF gets the identical geometry.
 *
 * Two halves. The semantic passes — depth projection, template folding
 * (`blocks.0..7` → one ×8 card or one opened interior), transitive
 * reduction of pseudo-source edges only (a residual skip is a finding,
 * not clutter) — decide what is on screen. The geometry is a layered
 * layout in model order: siblings keep the order they fire in and each
 * open container owns one contiguous span, so opening a card moves
 * nothing beside it and a reader's eye can hold the picture across
 * clicks.
 */

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
  /** Row in the layered layout; ports sit on row 0. */
  rank: number;
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
  /** Frame width a narrower graph is centered in; a wider graph keeps
   * its natural width. */
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
  // Ports of one structured argument share its name as a prefix
  // (`observations.node_features`); the row shows the part that differs.
  const portNames = ports.map((p) => p.port.name);
  let common = portNames.length > 1 ? portNames[0] : "";
  for (const name of portNames) {
    while (common && !name.startsWith(common)) common = common.slice(0, -1);
  }
  common = common.slice(0, common.lastIndexOf(".") + 1);
  const seenPorts = new Set<string>();
  for (const { id, port, kind } of ports) {
    if (seenPorts.has(id)) continue;
    seenPorts.add(id);
    vnodes.set(id, {
      id,
      label: port.name.slice(common.length) || port.name,
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

  // ── geometry: a model-order column layout ─────────────────────────────
  // Ranks come from the longest path through the visible module graph,
  // then each module moves as late as its consumers allow, so a side
  // branch sits beside the module that reads it instead of at the top.
  // Siblings keep execution order and each open container owns one
  // contiguous span, so a hull can never overlap a foreign card and
  // opening a subtree moves nothing that is not underneath it.
  const nodes = [...vnodes.values()];
  for (const vn of nodes) {
    const chars = Math.max(vn.label.length, vn.sub.length * 0.92);
    vn.w = Math.max(64, chars * CHAR_W + 2 * PAD_X) * vn.scale;
    vn.h = vn.h * vn.scale;
  }
  const isPort = (vn: VNode) => vn.kind === "input" || vn.kind === "buffer";
  const modules = nodes.filter((vn) => !isPort(vn));
  const moduleIds = new Set(modules.map((vn) => vn.id));
  const moduleEdges = edges.filter((e) => moduleIds.has(e.src) && moduleIds.has(e.dst));

  // Back edges (a loop the extractor saw) are left out of the ranking and
  // drawn as bows; the walk is in execution order so the loop's first
  // firing module ranks first.
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const e of moduleEdges) {
    (succ.get(e.src) ?? succ.set(e.src, []).get(e.src)!).push(e.dst);
    (pred.get(e.dst) ?? pred.set(e.dst, []).get(e.dst)!).push(e.src);
  }
  const back = new Set<string>();
  {
    const state = new Map<string, 1 | 2>();
    const walk = (id: string) => {
      state.set(id, 1);
      for (const next of succ.get(id) ?? []) {
        const s = state.get(next);
        if (s === 1) back.add(`${id}→${next}`);
        else if (!s) walk(next);
      }
      state.set(id, 2);
    };
    for (const vn of [...modules].sort((a, b) => a.order - b.order)) {
      if (!state.has(vn.id)) walk(vn.id);
    }
  }
  const forward = (src: string, dst: string) => !back.has(`${src}→${dst}`);

  // Longest path from the sources, then as-late-as-possible.
  const rank = new Map<string, number>();
  const topo: string[] = [];
  {
    const done = new Set<string>();
    const visit = (id: string) => {
      if (done.has(id)) return;
      done.add(id);
      for (const p of pred.get(id) ?? []) if (forward(p, id)) visit(p);
      topo.push(id);
    };
    for (const vn of [...modules].sort((a, b) => a.order - b.order)) visit(vn.id);
  }
  for (const id of topo) {
    let r = 1;
    for (const p of pred.get(id) ?? []) if (forward(p, id)) r = Math.max(r, rank.get(p)! + 1);
    rank.set(id, r);
  }
  for (const id of [...topo].reverse()) {
    const outs = (succ.get(id) ?? []).filter((d) => forward(id, d));
    if (outs.length) rank.set(id, Math.min(...outs.map((d) => rank.get(d)!)) - 1);
  }
  const minRank = Math.min(...[...rank.values()], 1);
  for (const [id, r] of rank) rank.set(id, r - minRank + 1);
  for (const vn of nodes) vn.rank = isPort(vn) ? 0 : rank.get(vn.id) ?? 1;

  // ── the span tree: every id prefix that is open is a container ────────
  interface Item {
    id: string;
    label: string;
    kind: "leaf" | "template" | "family";
    node?: VNode;
    children: Item[];
    leaves: VNode[];
    rmin: number;
    rmax: number;
    order: number;
    w: number;
    x: number;
    col: number;
    span: number;
    columns: { w: number; x: number }[];
    depth: number;
  }
  const item = (id: string, kind: Item["kind"], label: string, depth: number): Item => ({
    id, label, kind, children: [], leaves: [], rmin: Infinity, rmax: -Infinity,
    order: Number.MAX_SAFE_INTEGER, w: 0, x: 0, col: 0, span: 1, columns: [], depth,
  });
  const templateLabel = new Map(templateHulls.map((t) => [t.id, t.label]));
  const root = item("", "family", "", 0);
  const byPath = new Map<string, Item>([["", root]]);
  for (const vn of [...modules].sort((a, b) => a.order - b.order)) {
    const parts = vn.id.split(".");
    let at = root;
    for (let i = 1; i < parts.length; i++) {
      const path = parts.slice(0, i).join(".");
      let next = byPath.get(path);
      if (!next) {
        const last = parts[i - 1];
        next = item(
          path,
          path.endsWith(".*") ? "template" : "family",
          templateLabel.get(path) ?? pretty(last),
          at.depth + 1,
        );
        byPath.set(path, next);
        at.children.push(next);
      }
      at = next;
    }
    const leaf = item(vn.id, "leaf", vn.label, at.depth + 1);
    leaf.node = vn;
    leaf.w = vn.w;
    byPath.set(vn.id, leaf);
    at.children.push(leaf);
  }
  const summarize = (it: Item): void => {
    if (it.node) {
      it.leaves = [it.node];
      it.rmin = it.rmax = it.node.rank;
      it.order = it.node.order;
      return;
    }
    for (const c of it.children) {
      summarize(c);
      it.leaves.push(...c.leaves);
      it.rmin = Math.min(it.rmin, c.rmin);
      it.rmax = Math.max(it.rmax, c.rmax);
      it.order = Math.min(it.order, c.order);
    }
    it.children.sort((a, b) => a.order - b.order);
  };
  summarize(root);

  const HULL_PAD = 10;
  const COL_GAP = 22;
  const hullScale = (members: number) => Math.min(1.5, 1 + members / 14);
  const pack = (it: Item): number => {
    if (it.node) return it.w;
    for (const c of it.children) c.w = pack(c);
    // Which sibling each leaf belongs to, for column anchoring.
    const owner = new Map<string, Item>();
    for (const c of it.children) for (const l of c.leaves) owner.set(l.id, c);
    const wired = (c: Item, dir: "pred" | "succ"): Item[] => {
      const out: Item[] = [];
      for (const l of c.leaves) {
        for (const other of (dir === "pred" ? pred : succ).get(l.id) ?? []) {
          const o = owner.get(other);
          if (o && o !== c && !out.includes(o)) out.push(o);
        }
      }
      return out;
    };
    // A column holds items with disjoint rank ranges. Each child prefers
    // the column of the sibling feeding it, then the nearest free column
    // to that side, then a new one on the right.
    const columns: { items: Item[]; w: number; x: number }[] = [];
    const free = (col: number, c: Item) =>
      col >= 0 && col < columns.length &&
      columns[col].items.every((o) => o.rmax < c.rmin || c.rmax < o.rmin);
    const placed = new Set<Item>();
    for (const c of it.children) {
      const feeders = wired(c, "pred").filter((f) => placed.has(f));
      const anchor = feeders.length
        ? feeders.reduce((a, b) => (a.rmax > b.rmax ? a : b))
        : null;
      let col = -1;
      if (anchor) {
        const order = [anchor.col];
        for (let d = 1; d < columns.length; d++) order.push(anchor.col + d, anchor.col - d);
        col = order.find((k) => free(k, c)) ?? -1;
      } else {
        col = columns.findIndex((_, k) => free(k, c));
      }
      if (col === -1) {
        columns.push({ items: [], w: 0, x: 0 });
        col = columns.length - 1;
      }
      columns[col].items.push(c);
      c.col = col;
      placed.add(c);
    }
    // A card whose neighbours occupy a run of columns sits centered over
    // the run when the run is free at its own ranks.
    for (const c of it.children) {
      const near = [...wired(c, "succ"), ...wired(c, "pred")];
      if (!near.length) continue;
      const lo = Math.min(c.col, ...near.map((n) => n.col));
      const hi = Math.max(c.col + c.span - 1, ...near.map((n) => n.col + n.span - 1));
      let ok = true;
      for (let k = lo; k <= hi && ok; k++) {
        if (k === c.col) continue;
        ok = columns[k].items.every((o) => o === c || o.rmax < c.rmin || c.rmax < o.rmin);
      }
      if (ok && hi > lo) {
        columns[c.col].items.splice(columns[c.col].items.indexOf(c), 1);
        c.col = lo;
        c.span = hi - lo + 1;
        for (let k = lo; k <= hi; k++) if (!columns[k].items.includes(c)) columns[k].items.push(c);
      }
    }
    for (const col of columns) {
      col.w = Math.max(...col.items.filter((o) => o.span === 1).map((o) => o.w), 40);
    }
    // A spanning item wider than its run widens the run's last column.
    for (const c of it.children) {
      if (c.span === 1) continue;
      let have = -COL_GAP;
      for (let k = c.col; k < c.col + c.span; k++) have += columns[k].w + COL_GAP;
      if (c.w > have) columns[c.col + c.span - 1].w += c.w - have;
    }
    let x = HULL_PAD;
    for (const col of columns) {
      col.x = x;
      x += col.w + COL_GAP;
    }
    it.columns = columns.map((c) => ({ w: c.w, x: c.x }));
    for (const c of it.children) {
      const x0 = columns[c.col].x;
      const last = columns[c.col + c.span - 1];
      const runW = last.x + last.w - x0;
      c.x = x0 + (runW - c.w) / 2;
    }
    const labelW = it === root ? 0 : it.label.length * 6.2 * hullScale(it.leaves.length) + 28;
    return Math.max(x - COL_GAP + HULL_PAD, labelW);
  };
  root.w = pack(root);

  // ── rows ──────────────────────────────────────────────────────────────
  // Hull labels live in the gap above a container's first row; nested
  // containers opening on the same row stack their bands.
  const ROW_GAP = 40;
  const BAND = 18;
  const maxRank = Math.max(0, ...nodes.map((vn) => vn.rank));
  const bands = new Array<number>(maxRank + 2).fill(0);
  const countBands = (it: Item, stacked: number): void => {
    if (it.node) return;
    const mine = it === root ? 0 : stacked + 1;
    if (it !== root) bands[it.rmin] = Math.max(bands[it.rmin], mine);
    for (const c of it.children) countBands(c, c.rmin === it.rmin ? mine : 0);
  };
  countBands(root, 0);
  const rowH = new Array<number>(maxRank + 1).fill(0);
  for (const vn of nodes) rowH[vn.rank] = Math.max(rowH[vn.rank], vn.h);
  const rowY: number[] = [];
  let y = 10;
  for (let r = 0; r <= maxRank; r++) {
    if (r > 0) y += ROW_GAP + BAND * bands[r] + 5 * bands[r - 1];
    rowY[r] = y;
    y += rowH[r];
  }
  const height = y + 12;

  // Absolute positions: a child's x is relative to its container.
  const settle = (it: Item, x0: number): void => {
    it.x += x0;
    if (it.node) {
      it.node.x = it.x;
      it.node.y = rowY[it.node.rank] + (rowH[it.node.rank] - it.node.h) / 2;
      return;
    }
    for (const c of it.children) settle(c, it.x);
  };
  root.x = 0;
  for (const c of root.children) settle(c, 0);

  // ── ports: one row above, each over the cards that read it ────────────
  const portCards = nodes.filter(isPort);
  const declared = new Map<string, number>([
    ...graph.inputs.map((p, i) => [`input:${p.name}`, i] as [string, number]),
    ...graph.buffers.map((p, i) => [`buffer:${p.name}`, 1000 + i] as [string, number]),
  ]);
  const targets = new Map<string, number>();
  for (const p of portCards) {
    const readers = edges.filter((e) => e.src === p.id).map((e) => vnodes.get(e.dst)!);
    targets.set(
      p.id,
      readers.length
        ? readers.reduce((a, b) => a + b.x + b.w / 2, 0) / readers.length
        : root.w / 2,
    );
  }
  portCards.sort(
    (a, b) =>
      targets.get(a.id)! - targets.get(b.id)! ||
      (declared.get(a.id) ?? 0) - (declared.get(b.id) ?? 0),
  );
  const PORT_GAP = 10;
  const px = portCards.map((p) => targets.get(p.id)! - p.w / 2);
  for (let sweep = 0; sweep < 24; sweep++) {
    let moved = false;
    for (let i = 1; i < portCards.length; i++) {
      const overlap = px[i - 1] + portCards[i - 1].w + PORT_GAP - px[i];
      if (overlap > 0.5) {
        px[i - 1] -= overlap / 2;
        px[i] += overlap / 2;
        moved = true;
      }
    }
    if (!moved) break;
  }
  portCards.forEach((p, i) => {
    p.x = px[i];
    p.y = rowY[0] + (rowH[0] - p.h) / 2;
  });

  // Shift everything right of the left edge, then center in the frame.
  const left = Math.min(0, ...nodes.map((vn) => vn.x));
  const right = Math.max(root.w, ...nodes.map((vn) => vn.x + vn.w));
  const graphW = right - left + 12;
  const shift = -left + 6 + Math.max(0, ((opts.width ?? 0) - graphW) / 2);
  for (const vn of nodes) vn.x += shift;
  const maxW = Math.max(graphW, opts.width ?? 0);

  // ── hulls: one per open container, innermost last ─────────────────────
  const hulls: Hull[] = [];
  const shiftItem = (it: Item): void => {
    it.x += shift;
    for (const c of it.children) shiftItem(c);
  };
  for (const c of root.children) shiftItem(c);
  // How many open containers under `it` open on its own first row (and
  // close on its last): the outer box reaches that many bands further.
  const above = (it: Item): number =>
    it.node ? 0 : Math.max(0, ...it.children.filter((c) => c.rmin === it.rmin).map((c) => 1 + above(c)));
  const below = (it: Item): number =>
    it.node ? 0 : Math.max(0, ...it.children.filter((c) => c.rmax === it.rmax).map((c) => 1 + below(c)));
  const collect = (it: Item): void => {
    if (it.node) return;
    if (it !== root) {
      const top = rowY[it.rmin] - BAND * (1 + above(it)) + 4;
      const bottom = rowY[it.rmax] + rowH[it.rmax] + 6 + 5 * below(it);
      hulls.push({
        id: it.id,
        label: it.label,
        kind: it.kind === "template" ? "template" : "family",
        scale: hullScale(it.leaves.length),
        x: it.x,
        y: top,
        w: it.w,
        h: bottom - top,
      });
    }
    for (const c of it.children) collect(c);
  };
  collect(root);
  // Nested boxes shrink inward so their edges never coincide.
  for (const outer of hulls) {
    for (const inner of hulls) {
      if (inner === outer || !inner.id.startsWith(outer.id + ".")) continue;
      const nest = inner.id.split(".").length - outer.id.split(".").length;
      inner.x = Math.max(inner.x, outer.x + 3 * nest);
      inner.w = Math.min(inner.w, outer.x + outer.w - 3 * nest - inner.x);
    }
  }

  // ── edge paths ────────────────────────────────────────────────────────
  // Every downward edge leaves its source's bottom center and lands on
  // the destination's entry stem, so however many feeds a card has, it
  // wears one arrowhead. An edge whose straight run would cross a card
  // bows around the column; an edge that runs upward bows too.
  const STEM = 12;
  const placedEdges: PlacedEdge[] = [];
  const arrows: PlacedArrow[] = [];
  const feeds = new Map<string, string[]>();
  for (const e of edges) {
    (feeds.get(e.dst) ?? feeds.set(e.dst, []).get(e.dst)!).push(e.src);
  }
  const blockers = (s: VNode, t: VNode, x1: number, x2: number): VNode[] =>
    nodes.filter(
      (vn) =>
        vn !== s && vn !== t &&
        vn.rank > s.rank && vn.rank < t.rank &&
        vn.x < Math.max(x1, x2) + 2 && vn.x + vn.w > Math.min(x1, x2) - 2,
    );
  for (const e of edges) {
    const s = vnodes.get(e.src)!;
    const t = vnodes.get(e.dst)!;
    const x1 = s.x + s.w / 2;
    const x2 = t.x + t.w / 2;
    const y1 = s.y + s.h;
    const y2 = t.y - STEM;
    if (y2 <= y1) {
      const bow = Math.max(s.w, t.w) / 2 + 26;
      placedEdges.push({
        src: e.src, dst: e.dst, shape: e.shape,
        d: `M ${x1} ${y1} C ${x1 + bow} ${y1 + 24}, ${x2 + bow} ${t.y - 24}, ${x2} ${t.y}`,
      });
      arrows.push({ x: x2, y: t.y, variant: "" });
      continue;
    }
    const inWay = t.rank - s.rank > 1 ? blockers(s, t, x1, x2) : [];
    if (inWay.length) {
      const rightEdge = Math.max(...inWay.map((b) => b.x + b.w)) + 18;
      const leftEdge = Math.min(...inWay.map((b) => b.x)) - 18;
      const xm = rightEdge - Math.max(x1, x2) <= Math.min(x1, x2) - leftEdge ? rightEdge : leftEdge;
      const ym = (y1 + y2) / 2;
      placedEdges.push({
        src: e.src, dst: e.dst, shape: e.shape,
        d: `M ${x1} ${y1} C ${xm} ${y1 + (ym - y1) * 0.6}, ${xm} ${y2 - (y2 - ym) * 0.6}, ${x2} ${y2}`,
      });
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
    if (srcs.every((id) => t.y - STEM <= vnodes.get(id)!.y + vnodes.get(id)!.h)) continue;
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
    nodes: nodes.map(({ members: _members, order: _o, pos: _p, ...keep }) => keep),
    edges: placedEdges,
    arrows,
    ties,
    hulls,
  };
}

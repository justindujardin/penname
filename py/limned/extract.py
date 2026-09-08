"""limned — draw a PyTorch model from the model itself.

One forward pass under a provenance-tracking torch-function mode, hooks
on every submodule, and out comes a JSON *modelmap*: modules with their
classes, parameter and buffer counts, observed input/output shapes, the
dataflow edges between them, weight ties, and which declared modules
never fired. Nothing is annotated by hand — the diagram is inferred from
a reference to the model, so it cannot drift from the code the way a
hand-drawn figure does.

The reference is a ``module:attr`` symbol naming either

- a **factory function** returning ``(model, args)`` or
  ``(model, args, kwargs)`` — the example batch the forward runs on — or
- an ``nn.Module`` **class** carrying a ``__modelmap__`` classmethod
  with the same return shape (sans model).

Hooks, not tracing, on purpose: ``torch.fx`` and ``torch.export`` choke
on (or bake one path through) data-dependent control flow, and the
models this exists for are full of it. Whatever the example batch
actually executes is what is drawn; modules that hold parameters but
never fire are reported as dormant rather than guessed at.

Edges come from provenance, not from module order. Every functional op
unions its inputs' labels onto its outputs, and every module stamps its
outputs with its own name — except that a module whose output is already
fully explained by its own children keeps the deeper labels (so a trunk
returning its final norm's tensor stays attributed to the norm), while a
module whose output smuggles provenance from outside itself (a residual
block) stamps over it, which is what keeps a residual stream from
accumulating every earlier module into every later edge.

The JSON records a content hash of every project source file the import
touched, so a build can decide staleness by measurement instead of by a
version number. Rebuilds print their reason at the callsite; this file
just does the work.

Requires torch. Stdlib otherwise. Run from the consuming repo's root so
the symbol imports and the source hashes come out repo-relative:

    uv run python -m limned myproject.viz:my_model \
        --out data/modelmap/my-model.json
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import inspect
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterator

import torch
from torch import nn
from torch.overrides import TorchFunctionMode

from .annotations import CLASS_META, META, Limn

SCHEMA = 3

# ── reading the code's own annotations ──────────────────────────────────
# A model that documents its attributes with ``#:`` comments and sections
# its __init__ with banner comments has already annotated itself; these
# read that structure back so the diagram can carry it. Nothing here is
# required — a bare module still maps, just without prose.

_BANNER = re.compile(r"#\s*[─—-]{2,}\s*(.+?)\s*[─—-]*\s*$")
_DOC = re.compile(r"^\s*#:\s?(.*)$")
_ASSIGN = re.compile(r"^\s*self\.(\w+)\s*[:=]")


def _sections(cls: type) -> dict[str, dict[str, str]]:
    """Per-attribute ``doc`` and ``group`` from a class's ``__init__``.

    A run of ``#:`` lines documents the ``self.name = …`` it precedes
    (the Sphinx attribute-doc convention). A banner comment —
    ``# ── entry heads ──…`` — opens a named section that every later
    assignment belongs to, until the next banner; a bare rule with no
    words closes the section.
    """
    try:
        source = inspect.getsource(cls.__init__)
    except (OSError, TypeError):
        return {}
    out: dict[str, dict[str, str]] = {}
    group = ""
    doc: list[str] = []
    for line in source.splitlines():
        d = _DOC.match(line)
        if d:
            doc.append(d.group(1))
            continue
        b = _BANNER.search(line)
        if b:
            group = re.sub(r"\s*\(see .*?\)", "", b.group(1)).strip(" ─—-")
            doc = []
            continue
        a = _ASSIGN.match(line)
        if a:
            entry: dict[str, str] = {}
            if doc:
                entry["doc"] = _squeeze(" ".join(doc))
            if group:
                entry["group"] = group
            if entry:
                out[a.group(1)] = entry
            doc = []
        elif line.strip() and not line.strip().startswith("#"):
            doc = []
    return out


def _squeeze(text: str, cap: int = 600) -> str:
    flat = re.sub(r"\s+", " ", text).strip()
    return flat if len(flat) <= cap else flat[: cap - 1].rstrip() + "…"


def _validated_groups(cls: type, instance: nn.Module) -> dict[str, str]:
    """The class-level ``Limn.groups`` flattened to attr → label, every
    name checked against the instance's real submodules. A rename that
    orphans an annotation fails the extraction, not the reader."""
    meta = getattr(cls, CLASS_META, None)
    if not isinstance(meta, Limn):
        return {}
    modules = dict(instance.named_children())
    out: dict[str, str] = {}
    for label, names in meta.groups.items():
        for attr in names:
            if attr not in modules:
                raise SystemExit(
                    f"{cls.__name__}.__limn__ groups {attr!r} under {label!r}, "
                    f"but the instance has no submodule by that name — "
                    f"known: {', '.join(sorted(modules))}"
                )
            out[attr] = label
    return out


def _class_doc(module: nn.Module) -> str:
    """First paragraph of the class docstring — for a project-defined
    module, the best card tooltip there is. torch's own classes are
    skipped; their docstrings are API reference, not design."""
    cls = type(module)
    if cls.__module__.partition(".")[0] == "torch" or not cls.__doc__:
        return ""
    return _squeeze(cls.__doc__.split("\n\n")[0])


def _tensors(obj: Any) -> Iterator[torch.Tensor]:
    """Every tensor in a pytree of tuples, lists and dicts."""
    if isinstance(obj, torch.Tensor):
        yield obj
    elif isinstance(obj, (tuple, list)):
        for item in obj:
            yield from _tensors(item)
    elif isinstance(obj, dict):
        for item in obj.values():
            yield from _tensors(item)


class _Provenance(TorchFunctionMode):
    """Label tensors with the modules (or inputs, or buffers) they came
    from, through every functional op between module boundaries.

    Labels are keyed by ``id(tensor)``, which is only sound while the
    tensor is alive — so every labeled tensor is pinned in ``_keep`` for
    the duration of the one forward pass this mode ever runs. The pin is
    the price of catching views and in-place ops without wrapping the
    tensor type.
    """

    def __init__(self) -> None:
        super().__init__()
        self.labels: dict[int, frozenset[str]] = {}
        self._keep: list[torch.Tensor] = []

    def read(self, obj: Any) -> frozenset[str]:
        out: set[str] = set()
        for t in _tensors(obj):
            out |= self.labels.get(id(t), frozenset())
        return frozenset(out)

    def stamp(self, obj: Any, sources: frozenset[str], *, union: bool) -> None:
        for t in _tensors(obj):
            had = self.labels.get(id(t))
            self.labels[id(t)] = (had | sources) if (union and had) else sources
            self._keep.append(t)

    def __torch_function__(self, func, types, args=(), kwargs=None):
        kwargs = kwargs or {}
        out = func(*args, **kwargs)
        sources = self.read(args) | self.read(kwargs)
        if sources:
            self.stamp(out, frozenset(sources), union=True)
        return out


class _Tracer:
    """One forward pass, observed: shapes at every module, dataflow edges
    at the leaves, execution order, call counts."""

    def __init__(self, model: nn.Module) -> None:
        self.model = model
        self.mode = _Provenance()
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: dict[tuple[str, str], dict[str, Any]] = {}
        self.order = 0
        self._handles: list[Any] = []

        named = dict(model.named_modules())
        sections: dict[type, dict[str, dict[str, str]]] = {}
        grouped: dict[type, dict[str, str]] = {}
        for name, module in named.items():
            if not name:
                continue
            parent_name, _, attr = name.rpartition(".")
            parent_module = named[parent_name]
            parent = type(parent_module)
            if parent not in sections:
                sections[parent] = _sections(parent)
                grouped[parent] = _validated_groups(parent, parent_module)
            noted = sections[parent].get(attr, {})
            # Explicit beats inferred, instance beats class: `limn()` on
            # the module, then the class's `Limn.groups`, then the `#:`
            # comments and banners the source already carries.
            meta: dict[str, str] = getattr(module, META, None) or {}
            doc = (
                meta.get("doc")
                or noted.get("doc")
                or _class_doc(module)
            )
            group = meta.get("group") or grouped[parent].get(attr) or noted.get("group")
            extra = module.extra_repr()
            self.nodes[name] = {
                "id": name,
                "cls": type(module).__name__,
                "params": sum(p.numel() for p in module.parameters(recurse=False)),
                "buffers": sum(b.numel() for b in module.buffers(recurse=False)),
                "calls": 0,
                **({"extra": extra[:120]} if extra else {}),
                **({"label": meta["label"]} if "label" in meta else {}),
                **({"doc": doc} if doc else {}),
                **({"group": group} if group else {}),
            }
            leaf = not any(True for _ in module.children())
            self._handles.append(
                module.register_forward_hook(
                    self._hook(name, leaf), with_kwargs=True
                )
            )

    def _hook(self, name: str, leaf: bool):
        def hook(module, args, kwargs, output):
            rec = self.nodes[name]
            rec["calls"] += 1
            if rec["calls"] == 1:
                self.order += 1
                rec["order"] = self.order
                rec["in"] = [list(t.shape) for t in _tensors((args, kwargs))]
                rec["out"] = [list(t.shape) for t in _tensors(output)]
            if leaf:
                # Edges are recorded at leaves only; an ancestor consumes
                # the same tensors its children do, and projecting leaf
                # edges up the name hierarchy recovers every coarser view
                # without double counting.
                for t in _tensors((args, kwargs)):
                    for src in self.mode.labels.get(id(t), ()):
                        if src == name or src.startswith(name + "."):
                            continue
                        edge = self.edges.get((src, name))
                        if edge is None:
                            self.edges[(src, name)] = {
                                "shape": list(t.shape), "n": 1,
                            }
                        else:
                            edge["n"] += 1
            inside = lambda s: s == name or s.startswith(name + ".")  # noqa: E731
            for t in _tensors(output):
                had = self.mode.labels.get(id(t))
                if had and not leaf and all(inside(s) for s in had):
                    # Purely this module's own children — keep the deeper
                    # attribution so a consumer at full depth still sees
                    # the real producer.
                    continue
                self.mode.stamp(t, frozenset({name}), union=False)

        return hook

    def run(self, args: tuple, kwargs: dict) -> frozenset[str]:
        sig = inspect.signature(self.model.forward)
        bound = sig.bind(*args, **kwargs)
        self.inputs: list[dict[str, Any]] = []
        for pname, value in bound.arguments.items():
            for t in _tensors(value):
                self.inputs.append(
                    {"name": pname, "shape": list(t.shape), "dtype": str(t.dtype).removeprefix("torch.")}
                )
            self.mode.stamp(value, frozenset({f"input:{pname}"}), union=False)
        self.buffers: list[dict[str, Any]] = []
        for bname, buf in self.model.named_buffers():
            self.buffers.append(
                {"name": bname, "shape": list(buf.shape), "dtype": str(buf.dtype).removeprefix("torch.")}
            )
            self.mode.stamp(buf, frozenset({f"buffer:{bname}"}), union=False)

        self.model.eval()
        with torch.no_grad(), self.mode:
            out = self.model(*args, **kwargs)
        for handle in self._handles:
            handle.remove()
        loss = next(_tensors(out), None)
        return self.mode.read(loss) if loss is not None else frozenset()


def _ties(model: nn.Module) -> list[list[str]]:
    """Names that resolve to the same Parameter — tied weights."""
    seen: dict[int, list[str]] = {}
    for name, p in model.named_parameters(remove_duplicate=False):
        seen.setdefault(id(p), []).append(name)
    return [names for names in seen.values() if len(names) > 1]


def _sources(root: Path) -> dict[str, str]:
    """Content hashes of every imported source file under ``root`` —
    the staleness measurement a build compares against."""
    out: dict[str, str] = {}
    for module in list(sys.modules.values()):
        file = getattr(module, "__file__", None)
        if not file:
            continue
        path = Path(file).resolve()
        # torch registers generated modules under bare relative names
        # like ``_ops.py``; resolving those lands on files that do not
        # exist under the repo root.
        if not path.is_relative_to(root) or not path.is_file():
            continue
        if ".venv" in path.parts or "site-packages" in path.parts or "node_modules" in path.parts:
            continue
        out[path.relative_to(root).as_posix()] = hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
    return dict(sorted(out.items()))


def _resolve(symbol: str) -> tuple[nn.Module, tuple, dict]:
    modname, _, attr = symbol.partition(":")
    if not attr:
        raise SystemExit(f"symbol must be module:attr, got {symbol!r}")
    obj = getattr(importlib.import_module(modname), attr)
    if isinstance(obj, type) and issubclass(obj, nn.Module):
        maker = getattr(obj, "__modelmap__", None)
        if maker is None:
            raise SystemExit(
                f"{symbol} is a class with no __modelmap__ classmethod; either add "
                "one returning (model, args[, kwargs]) or point the symbol at a "
                "factory function with that return shape"
            )
        made = maker()
    elif callable(obj):
        made = obj()
    else:
        raise SystemExit(f"{symbol} is neither an nn.Module class nor a callable")
    if isinstance(made, nn.Module):
        raise SystemExit(
            f"{symbol} returned a bare module; return (model, args[, kwargs]) so "
            "limned can run one forward pass on a real example"
        )
    model, args, *rest = made
    return model, tuple(args), dict(rest[0]) if rest else {}


def generator_hash() -> str:
    """One hash over the whole package's sources — any edit to the
    extractor or the annotation layer re-extracts every cached map."""
    package = Path(__file__).parent
    digest = hashlib.sha256()
    for path in sorted(package.glob("*.py")):
        digest.update(path.read_bytes())
    return digest.hexdigest()


def extract(symbol: str) -> dict[str, Any]:
    model, args, kwargs = _resolve(symbol)
    tracer = _Tracer(model)
    sink_sources = tracer.run(args, kwargs)

    consumed = {src for src, _ in tracer.edges} | set(sink_sources)
    for buf in tracer.buffers:
        buf["consumed"] = f"buffer:{buf['name']}" in consumed

    # Groups are structure, not just captions: siblings sharing a label
    # — from `limn()`, a class `Limn`, or a banner comment — render as
    # one foldable unit, so they ship as explicit objects the layout can
    # turn into containers.
    by_group: dict[tuple[str, str], list[str]] = {}
    for name, rec in tracer.nodes.items():
        label = rec.get("group")
        if not label:
            continue
        parent = name.rpartition(".")[0]
        by_group.setdefault((parent, label), []).append(name)
    groups = [
        {"label": label, "members": sorted(members)}
        for (_, label), members in sorted(by_group.items())
        if len(members) >= 2
    ]

    class_meta = getattr(type(model), CLASS_META, None)
    return {
        "limned": SCHEMA,
        "name": type(model).__name__,
        "doc": (class_meta.doc if class_meta and class_meta.doc else _class_doc(model)),
        "symbol": symbol,
        "torch": torch.__version__,
        "params_total": sum(p.numel() for p in model.parameters()),
        "buffers_total": sum(b.numel() for b in model.buffers()),
        "inputs": tracer.inputs,
        "buffers": tracer.buffers,
        "groups": groups,
        "nodes": sorted(tracer.nodes.values(), key=lambda n: n.get("order", 10**9)),
        "edges": [
            {"src": src, "dst": dst, **data}
            for (src, dst), data in sorted(tracer.edges.items())
        ],
        "ties": _ties(model),
        "sinks": [{"name": "loss", "srcs": sorted(sink_sources)}],
        "sources": _sources(Path.cwd().resolve()),
        "generator": generator_hash(),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("symbol", help="module:attr — a factory or an annotated class")
    ap.add_argument("--out", required=True, help="where the modelmap JSON lands")
    args = ap.parse_args()

    sys.path.insert(0, str(Path.cwd()))
    graph = extract(args.symbol)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(graph, indent=1) + "\n")
    live = sum(1 for n in graph["nodes"] if n["calls"])
    print(
        f"limned {graph['name']}: {live}/{len(graph['nodes'])} modules live, "
        f"{len(graph['edges'])} edges, {graph['params_total']:,} params, "
        f"{graph['buffers_total']:,} buffer floats -> {out}"
    )

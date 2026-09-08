"""The explicit annotation layer: typed, declaration-site, optional.

Everything limned infers — ``#:`` attribute docs, banner-comment
sections, class docstrings, ``extra_repr()`` — still flows without any
of this. These are for what inference cannot reach or gets wrong, and
they win over inference wherever both speak.

Two forms, by where the metadata is allowed to live:

- ``limn(module, ...)`` wraps a module **at its assignment**, preserving
  the module's type for the checker::

      self.word_in = limn(
          nn.Linear(cfg.d_in, cfg.n_embd, bias=False),
          group="entries", doc="input vector into the trunk's width",
      )

- ``annotate(Cls, Limn(...))`` attaches class-level metadata **from
  outside the class** — the right form when the model file must not
  depend on limned (a training image that pip-installs a fixed list, a
  published package). Group members are attribute-name strings, checked
  loudly at extraction against the real module tree, so a rename cannot
  silently orphan an annotation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence, TypeVar

from torch import nn

M = TypeVar("M", bound=nn.Module)

#: Attribute the inline form stamps on a module instance.
META = "_limn_meta"

#: Attribute the class-level form stores its ``Limn`` under.
CLASS_META = "__limn__"


def limn(
    module: M,
    *,
    label: str | None = None,
    group: str | None = None,
    doc: str | None = None,
) -> M:
    """Attach rendering metadata to ``module`` and return it unchanged.

    An identity function at runtime: the module's type flows through, so
    the checker and the IDE see exactly what they would without it.
    """
    meta = {
        k: v
        for k, v in (("label", label), ("group", group), ("doc", doc))
        if v is not None
    }
    if meta:
        setattr(module, META, meta)
    return module


@dataclass(frozen=True)
class Limn:
    """Class-level annotation for a module class.

    ``groups`` maps a section label to the attribute names it covers;
    extraction validates every name against the instance's actual
    submodules and refuses to proceed on a miss. A group is structure,
    not a caption: the diagram renders its members routed together,
    foldable into a single card under the group's label — so name
    groups for the pathway they form ("the residual path"), not the section
    the code happened to declare them in.
    """

    groups: Mapping[str, Sequence[str]] = field(default_factory=dict)
    doc: str | None = None


def annotate(cls: type[nn.Module], meta: Limn) -> None:
    """Attach a :class:`Limn` to ``cls`` from outside its definition."""
    setattr(cls, CLASS_META, meta)


__all__ = ["Limn", "annotate", "limn", "META", "CLASS_META"]

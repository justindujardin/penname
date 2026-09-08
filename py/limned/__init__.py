"""limned — draw a PyTorch model from the model itself.

One forward pass under a provenance-tracking torch-function mode, hooks
on every submodule, and out comes a JSON *modelmap*: modules, dataflow
edges, shapes, parameter counts, weight ties, docs and groups. penname's
``modelmap`` layout renders it as a figure.

Most metadata is inferred from what the code already carries — ``#:``
attribute docs, ``# ── banner ──`` sections, class docstrings,
``extra_repr()``. The explicit layer in :mod:`limned.annotations` wins
over inference where both speak: :func:`limn` at an assignment,
:class:`Limn` + :func:`annotate` from outside the class.

Extraction: ``python -m limned pkg.mod:factory --out map.json``, run
from the repo root so the symbol imports.
"""

from .annotations import Limn, annotate, limn
from .extract import extract, generator_hash

__all__ = ["Limn", "annotate", "extract", "generator_hash", "limn"]

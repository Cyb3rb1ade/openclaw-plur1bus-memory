"""Strict storage namespace routing for one validated Hermes agent."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_NAMESPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


@dataclass(frozen=True)
class NamespaceRoute:
    name: str
    path: Path
    writable: bool


def resolve_namespace_routes(
    data_dir: Path,
    agent_id: str,
    config: dict[str, Any],
) -> tuple[NamespaceRoute, list[NamespaceRoute]]:
    """Resolve one writer and bounded read routes without selecting another agent."""
    raw = config.get("namespaces")
    if raw is None:
        route = NamespaceRoute(
            "default", Path(data_dir) / "lancedb" / agent_id, True
        )
        return route, [route]
    if not isinstance(raw, dict):
        raise ValueError("namespaces must be an object")
    writer = str(raw.get("activeWriteNamespace") or "")
    active = [str(value) for value in raw.get("activeRecallNamespaces") or []]
    legacy = [
        str(value) for value in raw.get("legacyReadOnlyNamespaces") or []
    ]
    for name in [writer, *active, *legacy]:
        if not _NAMESPACE.fullmatch(name):
            raise ValueError(f"invalid namespace identifier: {name!r}")
    if writer not in active:
        raise ValueError("active writer must occur in active recall namespaces")
    if set(active) & set(legacy):
        raise ValueError("active and legacy namespaces must be disjoint")
    root = Path(data_dir) / "lancedb-namespaces"
    writer_route = NamespaceRoute(writer, root / writer / agent_id, True)
    recall_names = list(dict.fromkeys(active))
    if raw.get("crossNamespaceRecall") is True:
        recall_names.extend(
            name for name in legacy if name not in recall_names
        )
    routes = [
        NamespaceRoute(name, root / name / agent_id, name == writer)
        for name in recall_names[:16]
    ]
    return writer_route, routes

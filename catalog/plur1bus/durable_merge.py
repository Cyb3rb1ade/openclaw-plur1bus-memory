"""Fail-closed durable merge proposal contracts.

Auto-apply is deliberately outside this module: a proposal is an immutable
snapshot which must be revalidated by an explicit operator/apply path.
"""
from __future__ import annotations

import hashlib
import json
import os
from .file_io import replace_file, sync_parent
import uuid
from pathlib import Path
from typing import Any

from .valid_time import has_disjoint_validity_windows, normalize_validity_window


def stable_replacement_id(agent_id: str, candidate_id: str, incoming_text: str) -> str:
    """Stable UUID prevents retry from creating competing replacements."""
    material = hashlib.sha256(incoming_text.encode("utf-8")).hexdigest()
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"plur1bus:merge:{agent_id}:{candidate_id}:{material}"))


def proposal_revision(proposal: dict[str, Any]) -> str:
    """Bind approval to all immutable proposal fields, not execution state."""
    immutable = {key: value for key, value in proposal.items() if key not in {"state", "revision"}}
    return hashlib.sha256(json.dumps(immutable, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def valid_time_marker(record: dict[str, Any]) -> str:
    start, end = normalize_validity_window(record.get("validFrom"), record.get("validUntil"))
    return f"valid-time:{start}:{end}"


def preserves_facts(a: str, b: str, merged: str) -> bool:
    """Conservative lexical guard: every number and non-trivial token survives."""
    if not isinstance(merged, str) or not merged.strip(): return False
    import re
    tokens = lambda text: {x.lower() for x in re.findall(r"[\w.-]+", text) if len(x) > 2 or x.isdigit()}
    target = tokens(merged)
    return tokens(a).issubset(target) and tokens(b).issubset(target)


def build_proposal(agent_id: str, candidate: dict[str, Any], incoming: dict[str, Any], merged_text: str) -> dict[str, Any] | None:
    """Build an immutable proposal or refuse unsafe/disjoint/fact-losing input."""
    if has_disjoint_validity_windows(candidate, incoming) or not preserves_facts(str(candidate.get("content") or ""), str(incoming.get("content") or ""), merged_text):
        return None
    replacement_id = stable_replacement_id(agent_id, str(candidate.get("id") or ""), str(incoming.get("content") or ""))
    return {"proposalId": str(uuid.uuid4()), "state": "proposed", "agentId": agent_id,
            "candidateId": str(candidate.get("id") or ""), "replacementId": replacement_id,
            "candidateSnapshot": candidate, "incomingSnapshot": incoming, "mergedText": merged_text,
            "mergedFrom": [str(candidate.get("id") or ""), valid_time_marker(candidate)]}


def persist_proposal(path: Path, proposal: dict[str, Any]) -> None:
    """Atomically persist a proposal before any possible apply workflow."""
    serialized = json.dumps(proposal, sort_keys=True)
    if len(serialized.encode("utf-8")) > 1_000_000:
        raise ValueError("merge proposal exceeds storage limit")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("unsafe proposal storage path")
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(serialized); handle.flush(); os.fsync(handle.fileno())
    replace_file(temp, path)
    sync_parent(path)


def combined_window(candidate: dict[str, Any], incoming: dict[str, Any]) -> tuple[int, int]:
    """Conservative union preserves an unknown direction as unknown."""
    a, b = normalize_validity_window(candidate.get("validFrom"), candidate.get("validUntil"))
    c, d = normalize_validity_window(incoming.get("validFrom"), incoming.get("validUntil"))
    return (min(a, c) if a and c else 0, max(b, d) if b and d else 0)

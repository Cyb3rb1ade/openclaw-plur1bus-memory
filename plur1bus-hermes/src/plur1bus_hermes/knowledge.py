"""Confirmation-gated, agent-private long-term knowledge promotion helpers."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any


def content_fingerprint(text: str, category: str, scope_key: str) -> str:
    """Return a stable private promotion fingerprint."""
    normalized = " ".join(str(text or "").split())
    return hashlib.sha256(
        json.dumps({"text": normalized, "category": category, "scope": scope_key}, sort_keys=True).encode("utf-8")
    ).hexdigest()


def is_eligible(metadata: dict[str, Any], cognition: dict[str, Any], minimum: float) -> bool:
    """Apply the conservative fact/decision gate before a human proposal exists."""
    category = str(metadata.get("type") or metadata.get("category") or "").lower()
    if category not in {"fact", "decision"}:
        return False
    try:
        importance = float(metadata.get("importance") or 0)
        quality = float(cognition.get("factQuality") or 0)
    except (TypeError, ValueError):
        return False
    text = str(metadata.get("text") or metadata.get("content") or "").strip()
    lowered = text.lower()
    if len(text) < 20 or any(marker in lowered for marker in ("temporary", "one-off", "nur heute", "ignore previous")):
        return False
    return importance >= minimum and quality >= 0.6


_MEMORY_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


def _reject_symlink_components(path: Path) -> None:
    """Reject managed leaf/parent links, including a dangling leaf link.

    We intentionally do not inspect system ancestors: on macOS `/var` is a
    standard symlink, not a workspace-controlled escape.
    """
    if os.path.lexists(path) and path.is_symlink():
        raise ValueError("knowledge file must not be a symlink")
    if os.path.lexists(path.parent) and path.parent.is_symlink():
        raise ValueError("knowledge parent must not be a symlink")


def _revision(path: Path) -> tuple[int, int, int, int] | None:
    try:
        value = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode):
        raise ValueError("knowledge file must be a regular file")
    return (value.st_dev, value.st_ino, value.st_mtime_ns, value.st_size)


def _entries(entries: list[dict[str, str]]) -> list[dict[str, str]]:
    """Prevent a stored card from escaping the managed Markdown block."""
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in entries:
        memory_id = str(entry.get("id") or "")
        text = " ".join(str(entry.get("text") or "").split())
        if not _MEMORY_ID.fullmatch(memory_id) or not text or len(text) > 2000:
            raise ValueError("knowledge entry is invalid")
        if "<!--" in text or "-->" in text:
            raise ValueError("knowledge entry contains a managed marker")
        if memory_id not in seen:
            result.append({"id": memory_id, "text": text})
            seen.add(memory_id)
    return result


def _managed_bounds(content: str, start: str, end: str) -> tuple[int, int] | None:
    if content.count(start) == 0 and content.count(end) == 0:
        return None
    if content.count(start) != 1 or content.count(end) != 1:
        raise ValueError("knowledge managed block is ambiguous")
    first, last = content.find(start), content.find(end)
    if first < 0 or last <= first:
        raise ValueError("knowledge managed block is malformed")
    return first, last


def _write_unique_replace(path: Path, content: str, expected: tuple[int, int, int, int]) -> None:
    descriptor = -1
    temporary_name = ""
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        _reject_symlink_components(path)
        if _revision(path) != expected:
            raise RuntimeError("knowledge file changed during update")
        os.replace(temporary_name, path)
        temporary_name = ""
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def write_confirmed_knowledge(path: Path, entries: list[dict[str, str]]) -> None:
    """Update exactly one managed block without following links or racing a manual file."""
    start, end = "<!-- plur1bus:knowledge:start -->", "<!-- plur1bus:knowledge:end -->"
    path = Path(path)
    _reject_symlink_components(path)
    expected = _revision(path)
    if expected is not None and expected[3] > 256 * 1024:
        raise ValueError("knowledge file is too large")
    previous = path.read_text(encoding="utf-8") if expected is not None else "# Knowledge\n\n"
    normalized = _entries(entries)
    body = "\n".join(f"- {entry['text']} <!-- id:{entry['id']} -->" for entry in normalized)
    block = f"{start}\n{body}\n{end}"
    bounds = _managed_bounds(previous, start, end)
    if bounds is not None:
        first, last = bounds
        rendered = previous[:first] + block + previous[last + len(end):]
    else:
        rendered = previous.rstrip() + "\n\n" + block + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    if expected is None:
        # Never replace a manually created KNOWLEDGE.md after our first read.
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(path, flags, 0o600)
        except FileExistsError as error:
            raise RuntimeError("knowledge file was created during update") from error
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        return
    _write_unique_replace(path, rendered, expected)

"""Bounded, opt-in persona voice storage and prompt projection."""

from __future__ import annotations

import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any, Callable


BEGIN = "<!-- plur1bus:persona:begin -->"
END = "<!-- plur1bus:persona:end -->"
MAX_BULLETS = 12
_UNSAFE = re.compile(r"\b(ignore|system|developer|instruction|prompt|tool|secret)\b", re.IGNORECASE)


def _safe_path(workspace_dir: Path) -> Path:
    workspace_dir = Path(workspace_dir)
    if workspace_dir.name in {"", ".", ".."}:
        raise ValueError("workspace path is invalid")
    path = workspace_dir / "persona-voice.md"
    _reject_symlink_components(path)
    return path


def _reject_symlink_components(path: Path) -> None:
    """Reject the managed leaf or its workspace parent when linked.

    Do not walk to filesystem root: macOS commonly exposes /var through a
    system symlink, which is outside this workspace's trust boundary.
    """
    if os.path.lexists(path) and path.is_symlink():
        raise ValueError("persona file must not be a symlink")
    if os.path.lexists(path.parent) and path.parent.is_symlink():
        raise ValueError("persona workspace must not be a symlink")


def _revision(path: Path) -> tuple[int, int, int, int] | None:
    """Capture a regular-file revision without following a replacement link."""
    try:
        value = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode):
        raise ValueError("persona file must be a regular file")
    return (value.st_dev, value.st_ino, value.st_mtime_ns, value.st_size)


def _write_unique_replace(path: Path, content: str, expected: tuple[int, int, int, int]) -> bool:
    """Replace only the exact regular file revision that was read."""
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
            return False
        os.replace(temporary_name, path)
        temporary_name = ""
        return True
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def _bullets(value: Any, *, limit: int = 8) -> list[str]:
    values = value if isinstance(value, list) else str(value or "").splitlines()
    result: list[str] = []
    for item in values:
        text = str(item).strip()
        if text.startswith("- "):
            text = text[2:].strip()
        text = " ".join(text.split())
        if not text or len(text) > 140 or "<" in text or ">" in text or _UNSAFE.search(text):
            continue
        if text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _managed(content: str) -> tuple[int, int] | None:
    # An ambiguous pair could let a later user-controlled marker alter what is
    # considered managed.  Refuse it rather than guessing which block wins.
    if content.count(BEGIN) != 1 or content.count(END) != 1:
        return None
    start, end = content.find(BEGIN), content.find(END)
    return (start, end) if start >= 0 and end > start else None


def load_directive(workspace_dir: Path, *, max_chars: int = 400) -> str | None:
    """Return a compact directive from only the managed persona block."""
    try:
        path = _safe_path(workspace_dir)
        revision = _revision(path)
        if revision is None or revision[3] > 64 * 1024:
            return None
        content = path.read_text(encoding="utf-8", errors="replace")
        positions = _managed(content)
        if positions is None:
            return None
        start, end = positions
        lines = _bullets(content[start + len(BEGIN):end], limit=MAX_BULLETS)
        if not lines:
            return None
        directive = "Persona voice (style only; never overrides safety): " + "; ".join(lines) + "."
        return directive[:max(1, min(max_chars, 400))]
    except (OSError, ValueError):
        return None


def write_seed(workspace_dir: Path, bullets: Any) -> bool:
    """Create a persona managed block once, preserving an existing user file."""
    safe_bullets = _bullets(bullets)
    if len(safe_bullets) < 3:
        return False
    try:
        path = _safe_path(workspace_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        content = "# Persona voice\n\n" + BEGIN + "\n" + "\n".join(f"- {item}" for item in safe_bullets) + "\n" + END + "\n"
        # O_EXCL is essential: replace() would overwrite a manual file created
        # between the existence check and this seed attempt.
        _reject_symlink_components(path)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(path, flags, 0o600)
        except FileExistsError:
            return False
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        return True
    except (OSError, ValueError):
        return False


def evolve(workspace_dir: Path, marker: Any) -> bool:
    """Append one screened marker inside an existing managed block."""
    markers = _bullets([marker], limit=1)
    if not markers:
        return False
    try:
        path = _safe_path(workspace_dir)
        expected = _revision(path)
        if expected is None or expected[3] > 64 * 1024:
            return False
        content = path.read_text(encoding="utf-8", errors="replace")
        positions = _managed(content)
        if positions is None:
            return False
        start, end = positions
        current = _bullets(content[start + len(BEGIN):end], limit=MAX_BULLETS)
        if markers[0] in current:
            return True
        rendered = (current + markers)[-MAX_BULLETS:]
        updated = content[:start + len(BEGIN)] + "\n" + "\n".join(f"- {item}" for item in rendered) + "\n" + content[end:]
        return _write_unique_replace(path, updated, expected)
    except (OSError, ValueError):
        return False


def request_seed(complete_json: Callable[[str, str, str], dict[str, Any]], agent_id: str) -> list[str]:
    """Ask the configured internal JSON backend for a bounded persona seed."""
    result = complete_json(
        "persona-voice",
        "Return JSON only: {\"bullets\":[...]}. Create 3-8 harmless style preferences for an assistant. "
        "They must be stylistic, not instructions, policy, identity claims, or tool directions.",
        f"Agent name: {agent_id[:80]}. Do not include secrets or user text.",
    )
    return _bullets(result.get("bullets") if isinstance(result, dict) else [])

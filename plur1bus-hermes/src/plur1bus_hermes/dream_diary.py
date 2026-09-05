"""Safe private-agent DREAMS.md managed-block writer."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .namespaces import binding_from_scope
from .validation import safe_agent_id


DIARY_FILE = "DREAMS.md"
START_MARKER = "<!-- openclaw:dreaming:diary:start -->"
END_MARKER = "<!-- openclaw:dreaming:diary:end -->"
MAX_NARRATIVE_CHARS = 8_000
MAX_FILE_BYTES = 8 * 1024 * 1024
_DIARY_LOCK = threading.RLock()


def _normalize_narrative(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return ""
    # A narrative is untrusted text.  It must not be able to close or create
    # the host-managed block that contains it.
    return text[:MAX_NARRATIVE_CHARS].rstrip().replace(
        "<!-- openclaw:dreaming:diary:", "<!-- plur1bus:untrusted-diary-marker:"
    )


def narrative_fingerprint(narrative: Any) -> str:
    """Return a stable short fingerprint used for idempotent diary appends."""
    normalized = re.sub(r"\s+", " ", _normalize_narrative(narrative)).lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def _date_text(now: datetime | None, timezone_name: str | None) -> str:
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    if timezone_name:
        try:
            moment = moment.astimezone(ZoneInfo(timezone_name))
        except Exception:
            moment = moment.astimezone(timezone.utc)
    return moment.strftime("%B %-d, %Y at %-I:%M %p %Z")


def _workspace_path(workspace_dir: str | Path, workspace_root: str | Path | None) -> Path:
    candidate = Path(workspace_dir).expanduser()
    if not candidate.is_absolute():
        raise ValueError("workspace directory is invalid")
    if workspace_root is None:
        if candidate.is_symlink() or not candidate.is_dir():
            raise ValueError("workspace directory is invalid")
        return candidate.resolve()
    root = Path(workspace_root).expanduser()
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError("workspace root is invalid")
    try:
        parts = candidate.relative_to(root).parts
    except ValueError as error:
        raise ValueError("workspace directory escapes its root") from error
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("workspace directory contains a symbolic link")
        if not current.exists():
            current.mkdir()
        if not current.is_dir():
            raise ValueError("workspace path is not a directory")
    return candidate.resolve()


def _diary_path(workspace: Path) -> tuple[Path, bool]:
    path = workspace / DIARY_FILE
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("dream diary is invalid")
        return path, True
    return path, False


def _insert(existing: str, entry: str, fingerprint: str) -> tuple[str, bool, str | None]:
    body = existing.replace("\r\n", "\n").replace("\r", "\n")
    if fingerprint in body:
        return body, False, "already_present"
    start, end = body.find(START_MARKER), body.rfind(END_MARKER)
    if body.count(START_MARKER) or body.count(END_MARKER):
        if body.count(START_MARKER) != 1 or body.count(END_MARKER) != 1 or start < 0 or end <= start:
            return body, False, "invalid_managed_block"
        return f"{body[:end]}{entry}{body[end:]}", True, None
    section = f"# Dream Diary\n\n{START_MARKER}{entry}\n{END_MARKER}\n"
    return (section if not body.strip() else f"{section}\n{body.lstrip()}"), True, None


def append_dream_diary_entry(
    *,
    workspace_dir: str | Path,
    agent_id: str,
    narrative: str,
    scope: Any = None,
    mode: str = "rem",
    timezone_name: str | None = None,
    now: datetime | None = None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Append one private-agent dream in the host managed block, idempotently."""
    try:
        agent_id = safe_agent_id(agent_id)
        if binding_from_scope(agent_id, scope).scope_type != "agent-private":
            return {"written": False, "code": "not_private_scope"}
        text = _normalize_narrative(narrative)
        if not text:
            return {"written": False, "code": "empty_narrative"}
        workspace = _workspace_path(workspace_dir, workspace_root)
        fingerprint = narrative_fingerprint(text)
        label = "light dream" if mode == "light" else "REM dream"
        entry = f"\n---\n\n*{_date_text(now, timezone_name)}*\n\n{text}\n\n<sub>PLUR1BUS · {label} · {fingerprint}</sub>\n"
        with _DIARY_LOCK:
            path, exists = _diary_path(workspace)
            existing = path.read_text(encoding="utf-8") if exists else ""
            updated, changed, reason = _insert(existing, entry, fingerprint)
            if not changed:
                return {"written": False, "code": reason, "file": DIARY_FILE}
            if len(updated.encode("utf-8")) > MAX_FILE_BYTES:
                return {"written": False, "code": "file_too_large", "file": DIARY_FILE}
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=workspace, prefix=".DREAMS.", delete=False
            ) as handle:
                handle.write(updated)
                temp_name = handle.name
            try:
                os.replace(temp_name, path)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)
        return {"written": True, "code": "written", "file": DIARY_FILE}
    except Exception:
        return {"written": False, "code": "write_failed"}

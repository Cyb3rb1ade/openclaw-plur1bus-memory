"""Bounded durable receipts for idempotent capture journal materialization."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .file_io import replace_file, sync_parent
from .validation import resolve_inside, safe_agent_id


MAX_JOURNAL_LINE_BYTES = 131_072
MAX_RECEIPT_BYTES = 262_144
RECEIPT_VERSION = 1


def text_hash(value: str) -> str:
    """Return an exact UTF-8 source hash without retaining a second body copy."""
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def receipt_integer(value: Any, *, name: str, minimum: int = 0) -> int:
    """Accept only JSON integer fields; bools and numeric strings are invalid."""
    if type(value) is not int or value < minimum:
        raise ValueError(f"capture receipt {name} is invalid")
    return value


def record_fingerprint(record: Mapping[str, Any]) -> str:
    """Fingerprint the complete durable journal/episode record for drift checks."""
    encoded = json.dumps(dict(record), sort_keys=True, separators=(",", ":"),
                         ensure_ascii=True, default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def receipt_path(data_dir: Path, agent_id: str, capture_id: str) -> Path:
    """Resolve one UUID-named per-agent capture receipt path."""
    agent_id = safe_agent_id(agent_id)
    capture_id = str(uuid.UUID(str(capture_id)))
    base = Path(data_dir).expanduser().resolve()
    return resolve_inside(str(base), "state", agent_id, "capture-journal-receipts", f"{capture_id}.json")


def _ensure_parent(path: Path) -> None:
    """Create the receipt directory without following a symlinked component."""
    base = path.parents[3]
    current = base
    for part in ("state", path.parents[1].name, "capture-journal-receipts"):
        current = current / part
        if current.is_symlink():
            raise ValueError("capture receipt path must not contain symlinks")
        current.mkdir(mode=0o700, exist_ok=True)
        if current.is_symlink() or not current.is_dir():
            raise ValueError("capture receipt directory is invalid")


def read_receipt(path: Path) -> dict[str, Any] | None:
    """Read one bounded receipt from a regular descriptor; never trust a path race."""
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ValueError("capture receipt is not a regular file") from error
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_RECEIPT_BYTES:
            raise ValueError("capture receipt is invalid")
        raw = os.read(fd, MAX_RECEIPT_BYTES + 1)
        if len(raw) > MAX_RECEIPT_BYTES:
            raise ValueError("capture receipt is invalid")
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("capture receipt is unreadable") from error
    finally:
        os.close(fd)
    if not isinstance(value, dict) or value.get("version") != RECEIPT_VERSION:
        raise ValueError("capture receipt is invalid")
    return value


def write_receipt(path: Path, value: Mapping[str, Any]) -> None:
    """Atomically publish one receipt state before/after bounded append steps."""
    _ensure_parent(path)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temporary, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(dict(value), ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    replace_file(temporary, path)
    sync_parent(path)


def append_record(path: Path, value: Mapping[str, Any]) -> tuple[int, int]:
    """Append and flush one JSONL record, returning its verified byte range."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError("capture journal path must not be a symlink")
    line = json.dumps(dict(value), ensure_ascii=False, sort_keys=True, default=str) + "\n"
    encoded = line.encode("utf-8")
    if len(encoded) > MAX_JOURNAL_LINE_BYTES:
        raise ValueError("capture journal record exceeds bounded recovery size")
    with path.open("ab") as handle:
        offset = handle.tell()
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    return offset, len(encoded)


def probe_record(path: Path, offset: int, length: int, fingerprint: str) -> bool:
    """Validate exactly one receipt-indexed journal record without history scans."""
    offset = receipt_integer(offset, name="offset")
    length = receipt_integer(length, name="length", minimum=1)
    if length > MAX_JOURNAL_LINE_BYTES:
        raise ValueError("capture receipt offset is invalid")
    if not path.is_file() or path.is_symlink() or path.stat().st_size < offset + length:
        return False
    with path.open("rb") as handle:
        handle.seek(offset)
        raw = handle.read(length)
    if len(raw) != length or not raw.endswith(b"\n"):
        return False
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(value, dict) and record_fingerprint(value) == fingerprint

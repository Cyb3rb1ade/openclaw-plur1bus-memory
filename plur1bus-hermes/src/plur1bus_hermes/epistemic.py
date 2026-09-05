"""Explicit trust state for new writes and the restore-safe epistemic cutoff.

Port of the upstream 7.4.0 contracts in ``lib/epistemic-capture.js`` and
``lib/epistemic-cutoff.js``:

- New user captures start as ``observed``; every other new write is explicitly
  ``untrusted``. ``""`` is never persisted for a new write.
- Rows written before the cutoff (legacy rows without a stored status) keep
  their absence — nothing invents ``trusted`` for them.
- The cutoff is created on the first upgrade before the first write and lives
  next to the tombstone registry as a sibling of the LanceDB tree, so a
  snapshot restore of the tree cannot lose it:
  ``{data_dir}/_epistemic/explicit-write-since.json`` and
  ``{data_dir}/_epistemic/EXPLICIT_WRITES_ENABLED``.
- A missing cutoff after the enabled marker exists, or an unreadable cutoff,
  fails closed: no recreation, ``observed`` writes downgrade to ``untrusted``.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from .inject_markers import is_injected_context_text, looks_like_prompt_injection

LOGGER = logging.getLogger(__name__)

EPISTEMIC_MARKER_DIRNAME = "_epistemic"
CUTOFF_FILENAME = "explicit-write-since.json"
ENABLED_FILENAME = "EXPLICIT_WRITES_ENABLED"

_NON_USER_ORIGINS = frozenset({"cron", "internal", "dream"})


def decide_epistemic_status_for_capture(
    *,
    text: object = "",
    source_message_role: object = "",
    origin: object = "",
    cutoff_failed: bool = False,
) -> str:
    """Return ``observed`` only for genuine user captures, else ``untrusted``."""
    if cutoff_failed is True:
        return "untrusted"
    role = str(source_message_role or "").strip().lower()
    normalized_origin = str(origin or "").strip().lower()
    if role != "user":
        return "untrusted"
    if normalized_origin in _NON_USER_ORIGINS:
        return "untrusted"
    if is_injected_context_text(text):
        return "untrusted"
    if looks_like_prompt_injection(text):
        return "untrusted"
    return "observed"


def coerce_new_write_epistemic_status(value: object) -> str:
    """Last-line store default: never persist ``""`` for a new write."""
    if value is None or value == "":
        return "untrusted"
    return str(value)


def epistemic_cutoff_dir(data_dir: Path) -> Path:
    """Directory that survives a LanceDB-tree restore."""
    return Path(data_dir) / EPISTEMIC_MARKER_DIRNAME


def epistemic_cutoff_path(data_dir: Path) -> Path:
    return epistemic_cutoff_dir(data_dir) / CUTOFF_FILENAME


def epistemic_enabled_path(data_dir: Path) -> Path:
    return epistemic_cutoff_dir(data_dir) / ENABLED_FILENAME


def _to_finite_ms(value: object) -> int | None:
    """Accept only safe integer millisecond timestamps (numbers, not bools)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _write_text_fsync(path: Path, text: str) -> None:
    """Atomic tmp+fsync+rename write (upstream ``writeTextFsync``)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as tmp_file:
            tmp_file.write(text)
            tmp_file.flush()
            os.fsync(tmp_file.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            LOGGER.warning("epistemic-cutoff: could not remove temp file %s", tmp_name)
        raise


def _write_json_fsync(path: Path, payload: dict[str, Any]) -> None:
    _write_text_fsync(path, json.dumps(payload, sort_keys=True) + "\n")


def _parse_cutoff_file(path: Path) -> dict[str, int]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    since = _to_finite_ms(raw.get("since") if isinstance(raw, dict) else None)
    if since is None or since <= 0:
        raise ValueError("invalid epistemic cutoff payload")
    created = _to_finite_ms(raw.get("createdAt") if isinstance(raw, dict) else None)
    return {"since": since, "createdAt": created or since}


def read_epistemic_cutoff(data_dir: Path) -> dict[str, Any]:
    """Read the cutoff without creating one."""
    cutoff_file = epistemic_cutoff_path(data_dir)
    enabled = epistemic_enabled_path(data_dir).exists()
    try:
        if not cutoff_file.exists():
            return {
                "ok": False,
                "since": 0,
                "enabled": enabled,
                "legacyOpen": False,
                "reason": "cutoff_missing_after_upgrade" if enabled else "cutoff_absent",
            }
        parsed = _parse_cutoff_file(cutoff_file)
        return {"ok": True, "since": parsed["since"], "enabled": enabled, "legacyOpen": True, "reason": "ok"}
    except Exception as error:  # noqa: BLE001 — fail-closed read, mirrors upstream
        LOGGER.warning("epistemic-cutoff.read failed: %s", error)
        return {"ok": False, "since": 0, "enabled": enabled, "legacyOpen": False, "reason": "cutoff_read_error"}


def ensure_epistemic_cutoff(data_dir: Path, now: int | None = None) -> dict[str, Any]:
    """Create the cutoff only when both marker files are absent.

    Earliest ``since`` wins. A missing cutoff after the enabled marker exists,
    or an unreadable cutoff, fails closed and is never recreated here.
    """
    existing = read_epistemic_cutoff(data_dir)
    if existing["ok"]:
        return existing
    if existing["reason"] == "cutoff_missing_after_upgrade" or existing["enabled"]:
        return {**existing, "legacyOpen": False}
    if existing["reason"] == "cutoff_read_error":
        return {**existing, "legacyOpen": False}
    import time

    since = _to_finite_ms(now) or int(time.time() * 1000)
    try:
        cutoff_file = epistemic_cutoff_path(data_dir)
        if cutoff_file.exists():
            raced = read_epistemic_cutoff(data_dir)
            if raced["ok"]:
                return raced
        _write_json_fsync(cutoff_file, {"since": since, "createdAt": since})
        _write_text_fsync(epistemic_enabled_path(data_dir), "1\n")
        return {"ok": True, "since": since, "enabled": True, "legacyOpen": True, "reason": "created"}
    except Exception as error:  # noqa: BLE001 — fail-closed write, mirrors upstream
        LOGGER.warning("epistemic-cutoff.write failed: %s", error)
        return {"ok": False, "since": 0, "enabled": False, "legacyOpen": False, "reason": "cutoff_write_error"}


def is_created_at_before_cutoff(created_at: object, since: object) -> bool:
    """Whether ``created_at`` is strictly before the cutoff (legacy window)."""
    ts = _to_finite_ms(created_at)
    cut = _to_finite_ms(since)
    if ts is None or cut is None or ts <= 0 or cut <= 0:
        return False
    return ts < cut


def is_created_at_on_or_after_cutoff(created_at: object, since: object) -> bool:
    """Whether ``created_at`` is at or after the cutoff (post-cutoff window)."""
    ts = _to_finite_ms(created_at)
    cut = _to_finite_ms(since)
    if ts is None or cut is None or ts <= 0 or cut <= 0:
        return False
    return ts >= cut

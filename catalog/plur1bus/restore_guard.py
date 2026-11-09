"""External restore guard survives replacement of the protected data directory."""
from __future__ import annotations
import hashlib
from pathlib import Path


def restore_guard_path(data_dir: Path) -> Path:
    """Bind a marker to one exact canonical data root, outside that root."""
    root = Path(data_dir).expanduser().resolve()
    key = hashlib.sha256(str(root).encode()).hexdigest()[:32]
    return root.parent / f".plur1bus-restore-{key}.json"


def assert_restore_idle(data_dir: Path) -> None:
    """Fail closed even for a malformed or dangling interrupted-restore marker."""
    marker = restore_guard_path(data_dir)
    if marker.exists() or marker.is_symlink():
        raise RuntimeError("snapshot restore is unfinished; resume the reviewed restore before starting PLUR1BUS")

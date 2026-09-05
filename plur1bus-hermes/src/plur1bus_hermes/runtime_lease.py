"""Cooperating runtime/generation POSIX leases; no caller-supplied offline proof."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import threading


def _lock_path(data_dir: Path) -> Path:
    if Path(data_dir).is_symlink():
        raise RuntimeError("unsafe runtime data root")
    state = Path(data_dir).resolve() / "state"
    if state.is_symlink():
        raise RuntimeError("unsafe runtime lease state path")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state.is_symlink():
        raise RuntimeError("unsafe runtime lease state path")
    return state / "runtime-generation.lock"


def _open(data_dir: Path) -> int:
    path = _lock_path(data_dir)
    if path.is_symlink():
        raise RuntimeError("unsafe runtime lease lock path")
    return os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)


class RuntimeLease:
    """One independently owned shared descriptor; closure is idempotent."""

    def __init__(self, descriptor: int):
        self.fd = descriptor
        self._lock = threading.Lock()

    def close(self) -> None:
        """Release only this holder, never unlink the shared lock inode."""
        with self._lock:
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None


def acquire_runtime_lease(data_dir: Path) -> RuntimeLease:
    """Pin the current storage generation until this runtime fully drains."""
    descriptor = _open(data_dir)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except OSError as error:
        os.close(descriptor)
        raise RuntimeError("generation lease is exclusive") from error
    return RuntimeLease(descriptor)


@contextmanager
def exclusive_generation_lease(data_dir: Path):
    """Refuse activation immediately while any cooperating runtime remains live."""
    descriptor = _open(data_dir)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(descriptor)
        raise RuntimeError("runtime lease is active") from error
    try:
        yield
    finally:
        os.close(descriptor)

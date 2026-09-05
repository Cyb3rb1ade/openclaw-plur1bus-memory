"""Reentrant process/thread coordination for native runtime memory mutations."""
from __future__ import annotations

from contextlib import contextmanager
from functools import wraps
import fcntl
import os
from pathlib import Path
import threading

from .validation import resolve_inside

_guard = threading.Lock()
_locks: dict[str, threading.RLock] = {}
_held = threading.local()


@contextmanager
def writer_lock(data_dir: Path):
    """Serialize cooperating writers; nested calls share the outer file lock."""
    path = resolve_inside(str(data_dir), "state", "memory-writer.lock")
    key = str(path)
    with _guard:
        lock = _locks.setdefault(key, threading.RLock())
    with lock:
        held = getattr(_held, "paths", None)
        if held is None:
            held = _held.paths = set()
        if key in held:
            yield
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            raise ValueError("unsafe memory writer lock")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            held.add(key)
            try:
                yield
            finally:
                held.remove(key)
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def serialized_memory_write(method):
    """Hold the table-root lock for one complete runtime mutation transaction."""
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with writer_lock(self.data_dir):
            return method(self, *args, **kwargs)
    return wrapped

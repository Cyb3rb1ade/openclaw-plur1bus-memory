"""Reentrant process/thread coordination for native runtime memory mutations."""
from __future__ import annotations

from contextlib import contextmanager
from functools import wraps
from . import file_lock as fcntl
import os
from pathlib import Path
import threading
import time
import math
import logging

from .validation import resolve_inside
from .restore_guard import assert_restore_idle

_guard = threading.Lock()
_locks: dict[str, threading.RLock] = {}
_held = threading.local()


class WriterLockTimeout(TimeoutError):
    """Acquisition failed within its budget; no mutation has started."""


@contextmanager
def writer_lock(data_dir: Path, *, restoring: bool = False, timeout: float | None = None):
    """Serialize writers; optional acquisition budget never cancels a held lease.

    Existing writers retain blocking/reentrant behavior. Maintenance may bound
    acquisition across both the thread and OS lock without a quiet-period delay.
    """
    if timeout is not None and (type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 <= timeout <= 86400):
        raise ValueError('invalid writer acquisition timeout')
    deadline = None if timeout is None else time.monotonic() + timeout
    path = resolve_inside(str(data_dir), "state", "memory-writer.lock")
    key = str(path)
    with _guard:
        lock = _locks.setdefault(key, threading.RLock())
    acquired = lock.acquire() if deadline is None else lock.acquire(timeout=max(0, deadline - time.monotonic()))
    if not acquired:
        raise WriterLockTimeout('memory writer acquisition budget exhausted')
    try:
        if not restoring:
            assert_restore_idle(data_dir)
        held = getattr(_held, "paths", None)
        if held is None:
            held = _held.paths = set()
        if key in held:
            yield
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            raise ValueError("unsafe memory writer lock")
        fd = fcntl.open_lock(path)
        try:
            if deadline is None:
                fcntl.flock(fd, fcntl.LOCK_EX)
            else:
                contention_logged = False
                while True:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if not contention_logged:
                            logging.getLogger(__name__).debug('Waiting for memory writer lease')
                            contention_logged = True
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise WriterLockTimeout('memory writer acquisition budget exhausted') from None
                        time.sleep(min(0.025, remaining))
            if not restoring:
                assert_restore_idle(data_dir)
            held.add(key)
            try:
                yield
            finally:
                held.remove(key)
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
    finally:
        lock.release()


def serialized_memory_write(method):
    """Hold the table-root lock for one complete runtime mutation transaction."""
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with writer_lock(self.data_dir):
            return method(self, *args, **kwargs)
    return wrapped

"""A bounded, cross-process file lock (stdlib only): a per-path lock in this process plus ``flock`` on
POSIX or ``msvcrt.locking`` on Windows, both taken with a deadline. Hook paths pass a short timeout and
skip their work on ``LockTimeout``; background work passes a long one."""

from __future__ import annotations

import errno
import os
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

__all__ = ["ExclusiveLockFile", "FileLock", "LockLost", "LockTimeout"]

_PROCESS_LOCKS: dict[str, threading.Lock] = {}
_GUARD = threading.Lock()


class LockTimeout(TimeoutError):
    """The lock was not free within the timeout (a ``TimeoutError``, so an ``OSError``)."""


class LockLost(OSError):
    """The lock file no longer holds this holder's nonce (it was judged stale and taken over): the critical
    section must not write."""


class FileLock:
    def __init__(self, path: str) -> None:
        self.path = path
        key = os.path.normcase(os.path.abspath(path))
        with _GUARD:
            self._local = _PROCESS_LOCKS.setdefault(key, threading.Lock())

    @contextmanager
    def hold(self, timeout: float) -> Iterator[None]:
        """Hold the lock or raise ``LockTimeout`` after ``timeout`` seconds (0 = one try)."""
        deadline = time.monotonic() + max(0.0, timeout)
        if not self._local.acquire(timeout=max(0.0, timeout)):
            raise LockTimeout(f"lock busy: {os.path.basename(self.path)}")
        try:
            os.makedirs(os.path.dirname(self.path) or ".", mode=0o700, exist_ok=True)
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                while not _try_lock(fd):
                    if time.monotonic() >= deadline:
                        raise LockTimeout(f"lock busy: {os.path.basename(self.path)}")
                    time.sleep(0.005)
                try:
                    yield
                finally:
                    _unlock(fd)
            finally:
                os.close(fd)
        finally:
            self._local.release()


def _try_lock(fd: int) -> bool:
    if os.name == "nt":
        import msvcrt

        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    import fcntl

    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def _unlock(fd: int) -> None:
    if os.name == "nt":
        import msvcrt

        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_UN)


class _Held:
    def __init__(self, lock: "ExclusiveLockFile", nonce: str) -> None:
        self._lock = lock
        self.nonce = nonce

    def verify(self) -> None:
        """Raise ``LockLost`` unless the lock file still holds this holder's nonce (waiting out a pending
        put-back, see ``_settle``). Call right before writing."""
        if not self._lock._settle(self.nonce, self._lock.RELEASE_RETRY_S):
            raise LockLost(f"lock lost: {os.path.basename(self._lock.path)}")


class ExclusiveLockFile:
    """The lock-file protocol shared with the plugin installer (``binding.mjs`` ``withRegistryLock``), used for
    the bindings registry ``hosts/.hermes-bindings.lock``. Node has no flock, so both sides exclude each other
    through the file's existence:

    * take it by creating the file with ``O_CREAT | O_EXCL`` (mode 0600; no ``fcntl``, so it works on Windows),
      write ``<pid> <hostname> <ms> <nonce>`` (nonce = 128-bit hex, unique per hold) and close the fd before the
      critical section. On Windows a ``PermissionError`` on create (name pending deletion) is retried like
      ``FileExistsError``;
    * a lock is stale when its mtime is older than ``STALE_S`` (60 s), or when it names a pid of this host that
      no longer runs and it is at least 1 s old (POSIX: ``kill(pid, 0)`` -> ``ESRCH``; Windows: ``OpenProcess``
      fails with ``ERROR_INVALID_PARAMETER`` or ``GetExitCodeProcess`` is not ``STILL_ACTIVE``; equivalent, not
      identical, to libuv's ``process.kill(pid, 0)``: where they differ (libuv's wider access rights, pid 0, exit
      code 259) one side judges alive, which only delays a break to the 60 s rule; a pid above 2**31-1 is never
      judged dead, as Node rejects it). Breaking it: ``rename`` it to ``<lock>.break-<nonce>``,
      re-read the moved file and compare dev/inode and content with what was judged stale; equal -> unlink and
      retry O_EXCL; different (someone else broke it and a fresh lock took its place) -> put it back with
      ``os.link`` (never overwrites; ``EEXIST`` = just drop the break file);
    * release: ``rename`` to ``<lock>.rel-<nonce>``; unlink only when the content holds this holder's nonce,
      otherwise put it back as above (a stolen lock is never deleted). On Windows a reader without
      ``FILE_SHARE_DELETE`` (CPython's ``open``) makes the rename fail with a sharing/access error: the release
      rename is retried (``PermissionError`` with winerror 5/32/33 or errno EACCES/EPERM/EBUSY; backoff 10 ms
      doubling to 100 ms, for at most ``RELEASE_RETRY_S`` = 2 s, then left to the stale rules). On
      ``FileNotFoundError`` the holder checks whether a ``<lock>.break-*``/``.rel-*`` file holds its nonce (the
      live lock was moved aside by a waiter or an old holder and is being put back): it waits for the put-back (same 2 s budget) and releases it,
      so an abandoned live-pid lock is not left behind. The break rename is tried once per poll round and the
      wait loop retries it until the hold deadline;
    * before writing the protected data the holder calls ``held.verify()``: ``LockLost`` when its nonce is gone
      (a pending put-back is waited out the same way);
    * ``*.break-*`` / ``*.rel-*`` leftovers older than 60 s are removed;
    * wait at most ``timeout`` seconds (poll 25 ms), then ``LockTimeout``.

    A per-path ``threading.Lock`` keeps threads of this process in line before the file is touched.
    """

    STALE_S = 60.0
    DEAD_PID_MIN_AGE_S = 1.0
    POLL_S = 0.025
    RELEASE_RETRY_S = 2.0

    def __init__(self, path: str) -> None:
        self.path = path
        key = os.path.normcase(os.path.abspath(path))
        with _GUARD:
            self._local = _PROCESS_LOCKS.setdefault(key, threading.Lock())

    @contextmanager
    def hold(self, timeout: float) -> Iterator[_Held]:
        deadline = time.monotonic() + max(0.0, timeout)
        if not self._local.acquire(timeout=max(0.0, timeout)):
            raise LockTimeout(f"lock busy: {os.path.basename(self.path)}")
        try:
            os.makedirs(os.path.dirname(self.path) or ".", mode=0o700, exist_ok=True)
            self._sweep()
            nonce = os.urandom(16).hex()
            while True:
                try:
                    fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    break
                except (FileExistsError, PermissionError) as e:
                    if isinstance(e, PermissionError) and os.name != "nt":
                        raise
                    judged = self._judge_stale()
                    if judged is not None and self._break(*judged):
                        continue  # the stale lock is gone: retry the create at once
                    if time.monotonic() >= deadline:
                        raise LockTimeout(f"lock busy: {os.path.basename(self.path)}") from None
                    time.sleep(self.POLL_S)
            try:
                os.write(fd, f"{os.getpid()} {socket.gethostname()} {int(time.time() * 1000)} {nonce}\n".encode())
            except BaseException:
                os.close(fd)
                self._release(nonce)
                raise
            os.close(fd)
            try:
                yield _Held(self, nonce)
            finally:
                self._release(nonce)
        finally:
            self._local.release()

    # -- internals ---------------------------------------------------------------------------------------

    def _read_text(self, path: str | None = None) -> str | None:
        try:
            with open(path or self.path, "rb") as f:
                return f.read().decode("utf-8", "replace")
        except OSError:
            return None

    def _judge_stale(self) -> tuple[os.stat_result, str] | None:
        try:
            st = os.stat(self.path)
        except OSError:
            return None  # gone meanwhile: the next O_EXCL try decides
        text = self._read_text()
        if text is None:
            return None
        age = time.time() - st.st_mtime
        if age > self.STALE_S:
            return st, text
        parts = text.split()
        if len(parts) < 2 or not parts[0].isdigit() or parts[1] != socket.gethostname() or age < self.DEAD_PID_MIN_AGE_S:
            return None
        return (st, text) if _pid_dead(int(parts[0])) else None

    def _break(self, st: os.stat_result, text: str) -> bool:
        """Move the lock judged stale aside and remove it; True only when that stale file was removed."""
        brk = f"{self.path}.break-{os.urandom(16).hex()}"
        try:
            os.rename(self.path, brk)
        except OSError:
            return False  # gone, or (Windows) busy: the wait loop sleeps and the next round decides
        try:
            st2 = os.stat(brk)
        except OSError:
            return False  # swept meanwhile; it was old
        same = (st2.st_dev, st2.st_ino) == (st.st_dev, st.st_ino) and self._read_text(brk) == text
        if same:
            self._unlink(brk)
            return True
        self._restore(brk)
        return False

    def _release(self, nonce: str) -> None:
        rel = f"{self.path}.rel-{nonce}"
        deadline = time.monotonic() + self.RELEASE_RETRY_S
        while True:
            try:
                if _retry_sharing(lambda: os.rename(self.path, rel), max(0.0, deadline - time.monotonic())):
                    break
            except OSError:
                return  # still busy after the retries, or e.g. a read-only directory: the stale rules apply to it
            # Gone. Either our lock was broken (lost: nothing of ours to remove), or a waiter moved it aside and
            # is putting it back; then wait for the put-back and release it, so it is not left behind.
            if not self._settle(nonce, max(0.0, deadline - time.monotonic())) or time.monotonic() >= deadline:
                return
        text = self._read_text(rel)
        try:
            if self._holds(text, nonce):
                self._unlink(rel)
            elif text is not None:
                self._restore(rel)  # our lock was broken meanwhile: never release someone else's
        except OSError:
            pass  # left to the sweep (as binding.mjs releaseLock): release never raises out of hold()

    @staticmethod
    def _holds(text: str | None, nonce: str) -> bool:
        parts = (text or "").split()
        return len(parts) >= 4 and parts[3] == nonce

    def _settle(self, nonce: str, budget_s: float) -> bool:
        """True when the lock file holds ``nonce``. When it does not but a ``<lock>.break-*`` or ``<lock>.rel-*``
        file does (a waiter renamed our live lock aside after judging its predecessor stale, or an old holder
        renamed it aside on release, and is about to put it back), wait up to ``budget_s`` for the put-back. The
        put-back links before it unlinks the moved file, so once no moved file holds the nonce one more read of
        the lock decides."""
        deadline = time.monotonic() + budget_s
        while True:
            if self._holds(self._read_text(), nonce):
                return True
            if not self._moved_aside(nonce):
                return self._holds(self._read_text(), nonce)
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)

    def _moved_aside(self, nonce: str) -> bool:
        d = os.path.dirname(self.path) or "."
        base = os.path.basename(self.path)
        prefixes = (base + ".break-", base + ".rel-")
        try:
            names = os.listdir(d)
        except OSError:
            return False
        return any(n.startswith(prefixes) and self._holds(self._read_text(os.path.join(d, n)), nonce) for n in names)

    def _restore(self, moved: str) -> None:
        """Put a lock that was moved aside by mistake back; ``os.link`` never overwrites a newer lock."""
        try:
            os.link(moved, self.path)
        except OSError:  # FileExistsError: a new lock exists, the moved one is obsolete
            pass
        self._unlink(moved)

    @staticmethod
    def _unlink(path: str) -> None:
        """Remove a moved-aside ``.break-``/``.rel-`` file; a Windows sharing error is retried briefly and then
        left to the sweep (it is never the lock's own name)."""
        try:
            _retry_sharing(lambda: os.unlink(path), 0.5)
        except PermissionError:
            if os.name != "nt":
                raise

    def _sweep(self) -> None:
        d = os.path.dirname(self.path) or "."
        base = os.path.basename(self.path)
        try:
            names = os.listdir(d)
        except OSError:
            return
        now = time.time()
        for n in names:
            if n.startswith((base + ".break-", base + ".rel-")):
                try:
                    if now - os.stat(os.path.join(d, n)).st_mtime > self.STALE_S:
                        self._unlink(os.path.join(d, n))
                except OSError:
                    pass


_SHARING_WINERRORS = (5, 32, 33)  # ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
_SHARING_ERRNOS = (errno.EACCES, errno.EPERM, errno.EBUSY)


def _retry_sharing(op, budget_s: float) -> bool:
    """Run ``op`` (a rename or unlink). True when it succeeded, False when the source is gone
    (``FileNotFoundError``). On Windows a sharing/access error is retried for ``budget_s`` (backoff 10 ms
    doubling to 100 ms) and then re-raised; any other error, and every ``PermissionError`` on POSIX, propagates."""
    deadline = time.monotonic() + budget_s
    delay = 0.01
    while True:
        try:
            op()
            return True
        except FileNotFoundError:
            return False
        except PermissionError as e:
            if os.name != "nt" or not (getattr(e, "winerror", None) in _SHARING_WINERRORS or e.errno in _SHARING_ERRNOS):
                raise
            if time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.1)


_PID_MAX = 2**31 - 1  # Node's process.kill rejects larger pids (not ESRCH), so they are never judged dead


def _pid_dead(pid: int) -> bool:
    """True only when ``pid`` certainly does not run on this host (equivalent to libuv's ``kill(pid, 0)``
    returning ``ESRCH``); any doubt -> False."""
    if pid > _PID_MAX:
        return False
    if os.name == "nt":
        return _pid_dead_nt(pid)
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except OSError:
        return False  # EPERM: it runs under another user


def _pid_dead_nt(pid: int) -> bool:
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.GetExitCodeProcess.restype = wintypes.BOOL
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    k32.CloseHandle.restype = wintypes.BOOL
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    process_query_limited_information, still_active, error_invalid_parameter = 0x1000, 259, 87
    h = k32.OpenProcess(process_query_limited_information, False, pid)
    if not h:
        return ctypes.get_last_error() == error_invalid_parameter  # ERROR_ACCESS_DENIED etc.: it runs
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
            return False
        return code.value != still_active
    finally:
        k32.CloseHandle(h)

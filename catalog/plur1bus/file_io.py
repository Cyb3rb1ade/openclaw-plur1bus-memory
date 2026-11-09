"""Durable file publication using the platform's native flush primitives.

Unix flushes the containing directory; Windows flushes the published file and
uses MOVEFILE_WRITE_THROUGH for renames. Windows does not expose POSIX directory
fsync: this is not a promise of identical power-loss semantics on every filesystem.
Use local filesystems; network shares are not a supported memory store.
"""
from __future__ import annotations
import os
from pathlib import Path
import stat


def replace_file(source, destination):
    """Replace on the same volume; Windows requests write-through publication."""
    if os.name != "nt":
        return os.replace(source, destination)
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    move = kernel.MoveFileExW
    move.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    move.restype = wintypes.BOOL
    if not move(str(Path(source).absolute()), str(Path(destination).absolute()), 0x1 | 0x8):
        raise ctypes.WinError(ctypes.get_last_error())


def sync_parent(path):
    """Flush a publication, propagating all I/O failures instead of hiding them."""
    path = Path(path)
    if os.name == "nt":
        # FlushFileBuffers requires a writable file handle, unlike Unix fsync.
        from .file_lock import open_existing
        fd = open_existing(path, writable=True)
        expected = stat.S_ISREG
    else:
        fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW)
        expected = stat.S_ISDIR
    try:
        if not expected(os.fstat(fd).st_mode):
            raise ValueError("unexpected publication file type")
        os.fsync(fd)
    finally:
        os.close(fd)

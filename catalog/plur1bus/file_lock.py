"""OS-owned shared/exclusive locks: flock on Unix, LockFileEx on Windows.

No lock files are unlinked; descriptor close releases a process lease on both OSes.
"""
from __future__ import annotations
import errno
import os
from pathlib import Path

LOCK_SH, LOCK_EX, LOCK_NB, LOCK_UN = 1, 2, 4, 8

if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class Overlapped(ctypes.Structure):
        _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                    ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]

    class AttributeTag(ctypes.Structure):
        _fields_ = [("FileAttributes", wintypes.DWORD), ("ReparseTag", wintypes.DWORD)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                 wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
    kernel.LockFileEx.restype = wintypes.BOOL
    kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.DWORD, ctypes.POINTER(Overlapped)]
    kernel.UnlockFileEx.restype = wintypes.BOOL
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                  wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL


def flock(fd, operation):
    """Lock one shared coordination byte (including beyond EOF) or unlock it."""
    if os.name != "nt":
        import fcntl
        return fcntl.flock(fd, operation)
    handle = msvcrt.get_osfhandle(fd)
    overlap = Overlapped()
    if operation == LOCK_UN:
        ok = kernel.UnlockFileEx(handle, 0, 1, 0, ctypes.byref(overlap))
    else:
        if operation & ~(LOCK_SH | LOCK_EX | LOCK_NB) or bool(operation & LOCK_SH) == bool(operation & LOCK_EX):
            raise ValueError("invalid lock operation")
        flags = (2 if operation & LOCK_EX else 0) | (1 if operation & LOCK_NB else 0)
        ok = kernel.LockFileEx(handle, flags, 0, 1, 0, ctypes.byref(overlap))
    if not ok:
        error = ctypes.get_last_error()
        if error in (32, 33):
            raise BlockingIOError(errno.EWOULDBLOCK, "coordination lock is held")
        raise ctypes.WinError(error)


def open_lock(path):
    """Open an owned lock descriptor without following a final reparse/symlink."""
    path = Path(path)
    if os.name != "nt":
        return os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    return _open_windows(path, 0xC0000000, 4, os.O_RDWR | os.O_BINARY)


def open_existing(path, writable=False):
    """Open an existing leaf without following links, never create it."""
    if os.name != "nt":
        return os.open(path, (os.O_RDWR if writable else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK)
    return _open_windows(Path(path), 0xC0000000 if writable else 0x80000000, 3,
                         (os.O_RDWR if writable else os.O_RDONLY) | os.O_BINARY)


def _open_windows(path, access, disposition, flags):
    """Transfer one validated Win32 handle into a CRT descriptor."""
    for part in (path, *path.parents):
        if part.exists() and getattr(part.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValueError("reparse-point lock path refused")
    handle = kernel.CreateFileW(str(path), access, 3, None, disposition, 0x00200080, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        info = AttributeTag()
        if not kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        if info.FileAttributes & 0x400:
            raise ValueError("reparse-point lock refused")
        return msvcrt.open_osfhandle(handle, flags)
    except BaseException:
        kernel.CloseHandle(handle)
        raise

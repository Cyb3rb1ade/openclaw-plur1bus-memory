"""Private Windows diagnostic files using pinned Win32 handles and owner ACLs.

Imports Win32 bindings only when invoked on Windows. Ancestor handles omit
FILE_SHARE_DELETE, so path components cannot be swapped while a write runs.
Local NTFS/ReFS security semantics are required; unsupported ACLs fail closed.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

from . import file_lock
from .file_io import replace_file


class _WindowsFiles:
    """Own one protected security descriptor and all pinned directory handles."""

    def __init__(self) -> None:
        import ctypes
        import msvcrt
        from ctypes import wintypes

        self.c, self.w, self.crt = ctypes, wintypes, msvcrt
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.security = ctypes.WinDLL("advapi32", use_last_error=True)
        self.handles: list[int] = []
        self.descriptor = ctypes.c_void_p()
        self.dacl = ctypes.c_void_p()

        class SecurityAttributes(ctypes.Structure):
            _fields_ = [("length", wintypes.DWORD), ("descriptor", ctypes.c_void_p), ("inherit", wintypes.BOOL)]

        self.Attributes = SecurityAttributes
        self._declare()
        self.sid = self._current_sid()
        # Explicit protected DACL: only the current user, inherited by children.
        sddl = f"O:{self.sid}D:P(A;OICI;FA;;;{self.sid})"
        if not self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(self.descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            present, defaulted = wintypes.BOOL(), wintypes.BOOL()
            if not self.security.GetSecurityDescriptorDacl(self.descriptor, ctypes.byref(present), ctypes.byref(self.dacl), ctypes.byref(defaulted)) or not present or not self.dacl:
                raise ValueError("owner-only diagnostics DACL unavailable")
            self.attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), self.descriptor, False)
        except Exception:
            self.kernel.LocalFree(self.descriptor)
            raise

    def _declare(self) -> None:
        c, w = self.c, self.w
        declarations = (
            (self.kernel.GetCurrentProcess, [], w.HANDLE),
            (self.kernel.CloseHandle, [w.HANDLE], w.BOOL),
            (self.kernel.LocalFree, [c.c_void_p], c.c_void_p),
            (self.kernel.CreateFileW, [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE),
            (self.kernel.CreateDirectoryW, [w.LPCWSTR, c.c_void_p], w.BOOL),
            (self.kernel.GetFileInformationByHandleEx, [w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL),
            (self.security.OpenProcessToken, [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)], w.BOOL),
            (self.security.GetTokenInformation, [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)], w.BOOL),
            (self.security.ConvertSidToStringSidW, [c.c_void_p, c.POINTER(w.LPWSTR)], w.BOOL),
            (self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW, [w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.POINTER(w.DWORD)], w.BOOL),
            (self.security.GetSecurityDescriptorDacl, [c.c_void_p, c.POINTER(w.BOOL), c.POINTER(c.c_void_p), c.POINTER(w.BOOL)], w.BOOL),
            (self.security.GetSecurityInfo, [w.HANDLE, c.c_int, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p, c.c_void_p, c.c_void_p, c.POINTER(c.c_void_p)], w.DWORD),
            (self.security.SetSecurityInfo, [w.HANDLE, c.c_int, w.DWORD, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p], w.DWORD),
        )
        for function, arguments, result in declarations:
            function.argtypes, function.restype = arguments, result

    def _sid_text(self, pointer) -> str:
        result = self.w.LPWSTR()
        if not self.security.ConvertSidToStringSidW(pointer, self.c.byref(result)):
            raise self.c.WinError(self.c.get_last_error())
        try:
            return result.value
        finally:
            self.kernel.LocalFree(self.c.cast(result, self.c.c_void_p))

    def _current_sid(self) -> str:
        token = self.w.HANDLE()
        if not self.security.OpenProcessToken(self.kernel.GetCurrentProcess(), 0x0008, self.c.byref(token)):
            raise self.c.WinError(self.c.get_last_error())
        try:
            length = self.w.DWORD()
            self.security.GetTokenInformation(token, 1, None, 0, self.c.byref(length))
            if not 0 < length.value <= 65_536:
                raise ValueError("invalid token identity size")
            buffer = self.c.create_string_buffer(length.value)
            if not self.security.GetTokenInformation(token, 1, buffer, length, self.c.byref(length)):
                raise self.c.WinError(self.c.get_last_error())
            return self._sid_text(self.c.cast(buffer, self.c.POINTER(self.c.c_void_p))[0])
        finally:
            self.kernel.CloseHandle(token)

    def _protect(self, handle) -> None:
        owner, descriptor = self.c.c_void_p(), self.c.c_void_p()
        result = self.security.GetSecurityInfo(handle, 1, 1, self.c.byref(owner), None, None, None, self.c.byref(descriptor))
        if result:
            raise self.c.WinError(result)
        try:
            if self._sid_text(owner) != self.sid:
                raise ValueError("diagnostics owner mismatch")
        finally:
            self.kernel.LocalFree(descriptor)
        # SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION.
        result = self.security.SetSecurityInfo(handle, 1, 0x80000004, None, None, self.dacl, None)
        if result:
            raise self.c.WinError(result)

    def _open(self, path: Path, *, directory: bool, managed: bool):
        access = 0x00020080  # READ_CONTROL | FILE_READ_ATTRIBUTES
        if managed:
            access |= 0x00040000  # WRITE_DAC
        if not directory:
            access |= 0xC0000000  # GENERIC_READ | GENERIC_WRITE
        handle = self.kernel.CreateFileW(str(path), access, 3, self.c.byref(self.attributes) if managed else None,
                                        3 if directory else 4, 0x02200080, None)
        if handle == self.c.c_void_p(-1).value:
            raise self.c.WinError(self.c.get_last_error())
        try:
            attributes = file_lock.AttributeTag()
            if not self.kernel.GetFileInformationByHandleEx(handle, 9, self.c.byref(attributes), self.c.sizeof(attributes)):
                raise self.c.WinError(self.c.get_last_error())
            if attributes.FileAttributes & 0x400 or bool(attributes.FileAttributes & 0x10) != directory:
                raise ValueError("reparse point or unexpected diagnostics file type")
            if managed and directory:
                self._protect(handle)
            return handle
        except Exception:
            self.kernel.CloseHandle(handle)
            raise

    def directory(self, path: Path, *, create: bool) -> None:
        if create and not self.kernel.CreateDirectoryW(str(path), self.c.byref(self.attributes)):
            if self.c.get_last_error() != 183:  # ERROR_ALREADY_EXISTS; validate by handle below.
                raise self.c.WinError(self.c.get_last_error())
        self.handles.append(self._open(path, directory=True, managed=create))

    def file(self, path: Path) -> int:
        handle = self._open(path, directory=False, managed=True)
        try:
            fd = self.crt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
        except Exception:
            self.kernel.CloseHandle(handle)
            raise
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("diagnostics file is not a private regular file")
            self._protect(self.crt.get_osfhandle(fd))
            return fd
        except Exception:
            os.close(fd)
            raise

    def close(self) -> None:
        for handle in reversed(self.handles):
            self.kernel.CloseHandle(handle)
        self.kernel.LocalFree(self.descriptor)


def append_windows(root: Path, parts: tuple[str, ...], encoded: bytes, limit: int) -> None:
    """Append or rotate one protected record without following Windows redirects."""
    # Device paths/ADS/UNC network shares are not supported diagnostic roots.
    if root.drive.startswith("\\\\") or any(":" in part for part in (*root.parts[1:], *parts)):
        raise ValueError("unsupported diagnostics root")
    files = _WindowsFiles()
    descriptors: list[int] = []
    try:
        path = Path(root.anchor)
        files.directory(path, create=False)
        for part in root.parts[1:]:
            path /= part
            files.directory(path, create=False)
        for part in parts:
            path /= part
            files.directory(path, create=True)
        lock = files.file(path / ".lock")
        descriptors.append(lock)
        file_lock.flock(lock, file_lock.LOCK_EX | file_lock.LOCK_NB)
        current_path = path / "llm-router-errors.jsonl"
        current = files.file(current_path)
        descriptors.append(current)
        size = os.fstat(current).st_size
        if size > limit:
            raise ValueError("unexpected oversized diagnostics file")
        if size + len(encoded) > limit:
            backup_path = current_path.with_name(current_path.name + ".1")
            backup = files.file(backup_path)
            os.close(backup)
            os.close(current)
            descriptors.pop()
            replace_file(current_path, backup_path)
            current = files.file(current_path)
            descriptors.append(current)
        os.lseek(current, 0, os.SEEK_END)
        remaining = memoryview(encoded)
        while remaining:
            written = os.write(current, remaining)
            if written <= 0:
                raise OSError("diagnostic write made no progress")
            remaining = remaining[written:]
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        files.close()

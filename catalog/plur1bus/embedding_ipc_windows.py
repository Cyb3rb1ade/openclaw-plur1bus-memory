"""Owner-bound Engine IPC named pipes on Windows.

Only local named pipes derived from the verified state directory are accepted.
The peer process SID and protected token file are checked before sending text.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import hmac
import math
import os
from pathlib import Path
import socket
import stat
import threading
import time

from .embedding_ipc import EngineIpcError, _TOKEN, _deadline
from . import file_lock
from .llm_diagnostics_windows import _WindowsFiles

_PIPE_PREFIX = "\\\\.\\pipe\\"
_ERROR_BROKEN_PIPE = 109
_ERROR_NO_DATA = 232
_ERROR_PIPE_NOT_CONNECTED = 233
_ERROR_PIPE_BUSY = 231
_ERROR_MORE_DATA = 234
_ERROR_SEM_TIMEOUT = 121


class _WindowsScope(_WindowsFiles):
    """Pin each path component and verify the private scope ACL by handle."""

    def __init__(self, root: Path, *, create: bool = False) -> None:
        super().__init__()
        try:
            # Elevated Windows tokens may create objects owned by their
            # default administrator SID. The leaf ACL is still user-only.
            self._default_owner = self._process_sid(self.kernel.GetCurrentProcess(), info_class=4)
            # Local fixed disks only. Mapped/UNC shares have different ownership
            # semantics and can block outside the named-pipe deadline.
            if self.kernel.GetDriveTypeW(root.anchor) != 3 or root.is_symlink():
                raise EngineIpcError("scoped_embedding_untrusted_peer")
            path = Path(root.anchor)
            self.directory(path, create=False)
            for part in root.parts[1:]:
                path /= part
                self.directory(path, create=False)
            for part in ("control", "embedding-ipc"):
                path /= part
                if create and not self.kernel.CreateDirectoryW(str(path), self.c.byref(self.attributes)):
                    if self.c.get_last_error() != 183:
                        raise self.c.WinError(self.c.get_last_error())
                self.directory(path, create=False)
            self._assert_owner(self.handles[-1])
            self.directory_path = path.resolve(strict=True)
            # Engine v1 uses Node realpathSync, which preserves the spelling
            # of verified non-reparse Windows paths. The legacy nonce mode
            # instead explicitly hashes a lowercased native realpath.
            self.engine_directory = path
        except BaseException:
            self.close()
            raise

    def _declare(self) -> None:
        super()._declare()
        c, w = self.c, self.w
        declarations = (
            (self.kernel.OpenProcess, [w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
            (self.kernel.GetDriveTypeW, [w.LPCWSTR], w.UINT),
            (self.kernel.GetNamedPipeClientProcessId, [w.HANDLE, c.POINTER(w.ULONG)], w.BOOL),
            (self.kernel.GetNamedPipeServerProcessId, [w.HANDLE, c.POINTER(w.ULONG)], w.BOOL),
            (self.kernel.CreateNamedPipeW, [w.LPCWSTR, w.DWORD, w.DWORD, w.DWORD, w.DWORD,
                                           w.DWORD, w.DWORD, c.c_void_p], w.HANDLE),
            (self.security.GetAclInformation, [c.c_void_p, c.c_void_p, w.DWORD, c.c_int], w.BOOL),
            (self.security.GetAce, [c.c_void_p, w.DWORD, c.POINTER(c.c_void_p)], w.BOOL),
        )
        for function, arguments, result in declarations:
            function.argtypes, function.restype = arguments, result
        self.security.GetSecurityInfo.argtypes = [
            w.HANDLE, c.c_int, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p,
            c.POINTER(c.c_void_p), c.c_void_p, c.POINTER(c.c_void_p),
        ]

    def _assert_owner(self, handle) -> None:
        c, w = self.c, self.w
        owner, acl, descriptor = c.c_void_p(), c.c_void_p(), c.c_void_p()
        result = self.security.GetSecurityInfo(
            handle, 1, 5, c.byref(owner), None, c.byref(acl), None, c.byref(descriptor),
        )
        if result:
            raise EngineIpcError("scoped_embedding_untrusted_peer")
        try:
            if not owner or self._sid_text(owner) not in {self.sid, self._default_owner}:
                raise EngineIpcError("scoped_embedding_untrusted_peer")
            sizes = (w.DWORD * 3)()  # ACL_SIZE_INFORMATION
            if not acl or not self.security.GetAclInformation(acl, sizes, c.sizeof(sizes), 2) or not 1 <= sizes[0] <= 64:
                raise EngineIpcError("scoped_embedding_untrusted_peer")
            for index in range(sizes[0]):
                ace = c.c_void_p()
                if not self.security.GetAce(acl, index, c.byref(ace)):
                    raise EngineIpcError("scoped_embedding_untrusted_peer")
                # ACCESS_ALLOWED_ACE: four byte header, DWORD mask, SID at offset 8.
                if not ace or c.c_ubyte.from_address(ace.value).value != 0:
                    raise EngineIpcError("scoped_embedding_untrusted_peer")
                if self._sid_text(c.c_void_p(ace.value + 8)) != self.sid:
                    raise EngineIpcError("scoped_embedding_untrusted_peer")
        finally:
            self.kernel.LocalFree(descriptor)

    def _process_sid(self, process, *, info_class: int = 1) -> str:
        c, w = self.c, self.w
        token = w.HANDLE()
        if not self.security.OpenProcessToken(process, 0x0008, c.byref(token)):
            raise EngineIpcError("scoped_embedding_untrusted_peer")
        try:
            length = w.DWORD()
            self.security.GetTokenInformation(token, info_class, None, 0, c.byref(length))
            if not 0 < length.value <= 65_536:
                raise EngineIpcError("scoped_embedding_untrusted_peer")
            data = c.create_string_buffer(length.value)
            if not self.security.GetTokenInformation(token, info_class, data, length, c.byref(length)):
                raise EngineIpcError("scoped_embedding_untrusted_peer")
            return self._sid_text(c.cast(data, c.POINTER(c.c_void_p))[0])
        finally:
            self.kernel.CloseHandle(token)

    def verify_peer(self, handle, *, server_side: bool) -> None:
        c, w = self.c, self.w
        identifier = self.kernel.GetNamedPipeClientProcessId if server_side else self.kernel.GetNamedPipeServerProcessId
        peer = w.ULONG()
        if not identifier(handle, c.byref(peer)) or peer.value == 0:
            raise EngineIpcError("scoped_embedding_untrusted_peer")
        process = self.kernel.OpenProcess(0x1000, False, peer.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not process:
            raise EngineIpcError("scoped_embedding_untrusted_peer")
        try:
            current = w.ULONG()
            if (self._process_sid(process) != self.sid or not identifier(handle, c.byref(current))
                    or current.value != peer.value):
                raise EngineIpcError("scoped_embedding_untrusted_peer")
        finally:
            self.kernel.CloseHandle(process)

    def _private_file(self, name: str, *, create: bool = False) -> int:
        c = self.c
        path = self.directory_path / name
        # READ_CONTROL | GENERIC_READ and optionally GENERIC_WRITE. Open the
        # object itself, with no delete-sharing or following a reparse point.
        handle = self.kernel.CreateFileW(
            str(path), 0x80020000 | (0x40000000 if create else 0), 1,
            c.byref(self.attributes) if create else None, 1 if create else 3,
            0x00200080, None,
        )
        if handle == c.c_void_p(-1).value:
            raise c.WinError(c.get_last_error())
        try:
            attributes = file_lock.AttributeTag()
            if (not self.kernel.GetFileInformationByHandleEx(handle, 9, c.byref(attributes), c.sizeof(attributes))
                    or attributes.FileAttributes & 0x410):
                raise EngineIpcError("scoped_embedding_untrusted_peer")
            self._assert_owner(handle)
            fd = self.crt.open_osfhandle(handle, (os.O_RDWR if create else os.O_RDONLY) | os.O_BINARY)
        except BaseException:
            self.kernel.CloseHandle(handle)
            raise
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise EngineIpcError("scoped_embedding_untrusted_peer")
            return fd
        except BaseException:
            os.close(fd)
            raise

    def read_token(self, name: str = "owner.token") -> bytes:
        fd = self._private_file(name)
        try:
            if not 64 <= os.fstat(fd).st_size <= 65:
                raise EngineIpcError("scoped_embedding_untrusted_peer")
            token = os.read(fd, 66)
            if not _TOKEN.fullmatch(token):
                raise EngineIpcError("scoped_embedding_untrusted_peer")
            return token.rstrip(b"\n")
        finally:
            os.close(fd)

    def write_token(self, token: bytes) -> os.stat_result:
        fd = self._private_file("owner.token", create=True)
        info = os.fstat(fd)
        try:
            try:
                data = token + b"\n"
                if os.write(fd, data) != len(data):
                    raise OSError("short Engine IPC token write")
                os.fsync(fd)
            finally:
                os.close(fd)
        except BaseException:
            self.remove_token(info)
            raise
        return info

    def _token_is_removed(self, info: os.stat_result) -> bool:
        try:
            return not os.path.samestat((self.directory_path / "owner.token").lstat(), info)
        except FileNotFoundError:
            return True

    def remove_token(self, info: os.stat_result) -> None:
        if not self._token_is_removed(info):
            (self.directory_path / "owner.token").unlink(missing_ok=True)

    def address(self, mode: str) -> str:
        if mode == "legacy":
            nonce = self.read_token("owner-pipe.nonce").decode("ascii")
            identity = f"{str(self.directory_path).lower()}\n{nonce}"
            digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:40]
            return f"{_PIPE_PREFIX}plur1bus-embedding-owner-v2-{digest}"
        digest = hashlib.sha256(str(self.engine_directory).encode("utf-8")).hexdigest()[:32]
        return f"{_PIPE_PREFIX}plur1bus-embedding-{digest}"

    def create_pipe(self, address: str, *, first: bool = False) -> int:
        # Byte streams with only local clients and an owner-only DACL. The first
        # instance establishes kernel-atomic exclusivity for this address.
        handle = self.kernel.CreateNamedPipeW(
            address, 0x40000003 | (0x00080000 if first else 0), 0x00000008,
            8, 65_536, 65_536, 0, self.c.byref(self.attributes),
        )
        if handle == self.c.c_void_p(-1).value:
            raise self.c.WinError(self.c.get_last_error())
        return handle


def _win() -> object:
    import _winapi
    return _winapi


def _wait(overlap, timeout: float) -> None:
    win = _win()
    result = win.WaitForMultipleObjects([overlap.event], False, max(1, math.ceil(timeout * 1000)))
    if result == win.WAIT_TIMEOUT:
        raise TimeoutError
    if result != win.WAIT_OBJECT_0:
        raise OSError("Engine IPC wait failed")


class _PipeConnection:
    """Socket-like bounded raw byte I/O over a Windows overlapped pipe handle."""

    def __init__(self, scope: _WindowsScope, handle: int, *, server_side: bool) -> None:
        self.scope = scope
        self.handle = handle
        self.server_side = server_side
        self.timeout = 10.0
        self._guard = threading.Lock()
        self._overlap = None
        self._shutdown = False

    def assert_peer(self) -> None:
        self.scope.verify_peer(self.handle, server_side=self.server_side)

    def settimeout(self, timeout: float) -> None:
        self.timeout = timeout

    def _io(self, function, data, deadline: float):
        with self._guard:
            if self._shutdown:
                raise OSError("Engine IPC pipe closed")
            overlap, code = function(self.handle, data, overlapped=True)
            self._overlap = overlap
        try:
            if code == _win().ERROR_IO_PENDING:
                _wait(overlap, _deadline(deadline))
            size, code = overlap.GetOverlappedResult(True)
            if code not in (0, _ERROR_MORE_DATA):
                raise OSError("Engine IPC pipe operation failed")
            return size, overlap
        except BaseException:
            overlap.cancel()
            # Keep the OVERLAPPED and its buffer alive until cancellation completes.
            overlap.GetOverlappedResult(True)
            raise
        finally:
            with self._guard:
                self._overlap = None

    def recv(self, size: int) -> bytes:
        try:
            nread, operation = self._io(_win().ReadFile, size, time.monotonic() + self.timeout)
            return bytes(operation.getbuffer()[:nread])
        except OSError as error:
            if getattr(error, "winerror", None) in {_ERROR_BROKEN_PIPE, _ERROR_NO_DATA, _ERROR_PIPE_NOT_CONNECTED}:
                return b""
            raise

    def sendall(self, data: bytes) -> None:
        deadline = time.monotonic() + self.timeout
        remaining = memoryview(data)
        while remaining:
            sent, _ = self._io(_win().WriteFile, remaining, deadline)
            if not sent:
                raise OSError("Engine IPC pipe write made no progress")
            remaining = remaining[sent:]

    def finish_reply(self, deadline: float) -> None:
        # Wait for the client to consume the response and close its end.
        # Reading a byte overlapped keeps this bounded and cancellable.
        self.settimeout(_deadline(deadline))
        self.recv(1)

    def shutdown(self, how=socket.SHUT_RDWR) -> None:
        del how
        with self._guard:
            self._shutdown = True
            if self._overlap is not None:
                self._overlap.cancel()

    def close(self) -> None:
        self.shutdown()
        if self.handle is not None:
            _win().CloseHandle(self.handle)
            self.handle = None


def _open_pipe(address: str, deadline: float) -> int:
    win = _win()
    while True:
        try:
            # SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the server
            # cannot impersonate this caller with broader privileges.
            return win.CreateFile(address, win.GENERIC_READ | win.GENERIC_WRITE, 0, win.NULL,
                                  win.OPEN_EXISTING, win.FILE_FLAG_OVERLAPPED | 0x00110000, win.NULL)
        except OSError as error:
            if error.winerror != _ERROR_PIPE_BUSY:
                raise
            try:
                win.WaitNamedPipe(address, max(1, min(250, math.ceil(_deadline(deadline) * 1000))))
            except OSError as wait_error:
                if wait_error.winerror != _ERROR_SEM_TIMEOUT:
                    raise


@contextmanager
def connect_pipe(root: Path, deadline: float, mode: str):
    scope = _WindowsScope(root)
    try:
        token = scope.read_token()
        connection = _PipeConnection(scope, _open_pipe(scope.address(mode), deadline), server_side=False)
        try:
            connection.assert_peer()
            yield connection, token
        finally:
            connection.close()
        if not hmac.compare_digest(token, scope.read_token()):
            raise EngineIpcError("scoped_embedding_owner_changed")
    finally:
        scope.close()


class WindowsPipeListener:
    """Protected, Engine-default pipe with one bounded pending connection."""

    def __init__(self, state_root: Path, token: bytes) -> None:
        self.scope = _WindowsScope(state_root, create=True)
        self.address = self.scope.address("engine")
        self.pending = None
        self.overlap = None
        self.token_info = None
        try:
            self.pending = self.scope.create_pipe(self.address, first=True)
            self.token_info = self.scope.write_token(token)
        except OSError as error:
            self.close()
            if error.winerror in {5, 80, 183, _ERROR_PIPE_BUSY}:
                raise EngineIpcError("scoped_embedding_owner_already_active") from None
            raise EngineIpcError("scoped_embedding_ipc_unavailable") from None
        except BaseException:
            self.close()
            raise

    def accept(self) -> _PipeConnection:
        win = _win()
        try:
            if self.overlap is None:
                self.overlap = win.ConnectNamedPipe(self.pending, overlapped=True)
            _wait(self.overlap, 0.2)
            _, code = self.overlap.GetOverlappedResult(True)
            if code:
                raise OSError("Engine IPC pipe accept failed")
        except OSError as error:
            if getattr(error, "winerror", None) != _ERROR_NO_DATA:
                raise
            win.CloseHandle(self.pending)
            self.pending = self.scope.create_pipe(self.address)
            self.overlap = None
            raise TimeoutError from None
        connection = _PipeConnection(self.scope, self.pending, server_side=True)
        try:
            self.pending = self.scope.create_pipe(self.address)
        except BaseException:
            connection.close()
            self.pending = None
            raise
        self.overlap = None
        return connection

    def close(self) -> None:
        try:
            if self.overlap is not None:
                self.overlap.cancel()
                self.overlap.GetOverlappedResult(True)
                self.overlap = None
            if self.pending is not None:
                _win().CloseHandle(self.pending)
                self.pending = None
            if self.token_info is not None:
                self.scope.remove_token(self.token_info)
        finally:
            self.scope.close()

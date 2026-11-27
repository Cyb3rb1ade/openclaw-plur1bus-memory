"""Profile-scoped PLUR1BUS Engine embedding IPC. One request per connection."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping
from contextlib import contextmanager
import ctypes
import errno
from dataclasses import dataclass
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import struct
import sys
import threading
import time
from typing import Any

from .validation import ValidationError, safe_agent_id

_MAX_TEXTS = 64
_MAX_REQUEST = 256 * 1024
_MAX_RESPONSE = 4 * 1024 * 1024
_FINGERPRINT = re.compile(r"embedding:v1:sha256:[a-f0-9]{64}")
_TOKEN = re.compile(rb"[a-f0-9]{64}\n?")
_SHA1 = re.compile(r"[a-f0-9]{40}")
_POSIX = {"darwin", "linux"}

_ERRORS = {
    "scoped_embedding_ipc_unavailable": "Engine embedding IPC unavailable",
    "scoped_embedding_untrusted_peer": "Engine embedding IPC peer or path is not trusted",
    "scoped_embedding_auth_failed": "Engine embedding IPC authentication failed",
    "scoped_embedding_identity_mismatch": "Engine embedding IPC identity mismatch",
    "scoped_embedding_fingerprint_mismatch": "Engine embedding IPC fingerprint identity mismatch",
    "scoped_embedding_owner_changed": "Engine embedding IPC owner changed during the request",
    "scoped_embedding_timeout": "Engine embedding IPC request timeout",
    "scoped_embedding_invalid_frame": "invalid Engine embedding IPC frame",
    "scoped_embedding_invalid_vector": "invalid Engine embedding IPC vector",
    "scoped_embedding_owner_already_active": "Engine embedding IPC owner or stale ownership file already exists",
    "scoped_embedding_closed": "Engine embedding IPC client is closed",
    "plur1bus_scoped_embedding_error": "Engine embedding IPC provider failed",
}


class EngineIpcError(RuntimeError):
    """Stable, content-free IPC failure across the local transport boundary."""

    def __init__(self, code: str) -> None:
        self.code = code if code in _ERRORS else "plur1bus_scoped_embedding_error"
        super().__init__(_ERRORS[self.code])


@dataclass(frozen=True)
class _Identity:
    model: str
    dimensions: int
    fingerprint_id: str

    def wire(self) -> dict[str, Any]:
        return {"model": self.model, "dimensions": self.dimensions, "fingerprintId": self.fingerprint_id}


def _identity(config: Mapping[str, Any]) -> _Identity:
    model, dimensions, fingerprint = (config.get(name) for name in ("model", "dimensions", "fingerprintId"))
    if not isinstance(model, str) or not model.strip() or len(model) > 200:
        raise ValidationError("Engine IPC requires an explicit model identifier")
    if type(dimensions) is not int or not 1 <= dimensions <= 8192:
        raise ValidationError("Engine IPC requires integer dimensions from 1 to 8192")
    if not isinstance(fingerprint, str) or not _FINGERPRINT.fullmatch(fingerprint):
        raise ValidationError("Engine IPC requires an immutable Engine embedding fingerprint")
    return _Identity(model, dimensions, fingerprint)


def _root(value: Any) -> Path:
    if not isinstance(value, (str, Path)) or not str(value) or "\0" in str(value):
        raise ValidationError("Engine IPC requires an absolute local stateRoot")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or path == Path(path.anchor):
        raise ValidationError("Engine IPC requires an absolute local stateRoot")
    if os.name == "nt" and (path.drive.startswith("\\\\") or any(":" in part for part in path.parts[1:])):
        raise ValidationError("Engine IPC requires a local Windows volume")
    return path


def _timeout(config: Mapping[str, Any]) -> float:
    millis = "requestTimeoutMs" in config
    value = config.get("requestTimeoutMs") if millis else config.get("timeoutSeconds", 15)
    if type(value) not in {int, float} or not 0 < value <= (120_000 if millis else 120):
        raise ValidationError("Engine IPC request timeout must be positive and at most 120 seconds")
    return value / 1000 if millis else value


def validate_ipc_config(config: Mapping[str, Any]) -> None:
    """Validate an operator-configured provider without touching files or starting a listener."""
    if config.get("provider") != "engine-ipc":
        raise ValidationError("Engine IPC requires the explicit engine-ipc provider")
    if any(config.get(field) is not None for field in ("fallback", "fallbackProvider", "address",
                                                       "baseUrl", "apiKey", "apiKeyEnv", "headers", "token")):
        raise ValidationError("Engine IPC uses its scoped local endpoint. Other routes and fallbacks are invalid")
    _root(config.get("stateRoot"))
    _identity(config)
    _timeout(config)
    pipe_mode = config.get("pipeMode", "engine")
    if pipe_mode not in ("engine", "legacy") or ("pipeMode" in config and sys.platform != "win32"):
        raise ValidationError("Engine IPC pipeMode is engine or legacy on Windows only")
    if sys.platform not in _POSIX | {"win32"}:
        raise ValidationError("Engine IPC transport is unavailable on this platform")


def _verified_root(path: Path) -> Path:
    # Parent aliases such as /tmp on Darwin are canonicalized once. The bound
    # state root and the two IPC directory entries must never be leaf symlinks.
    if path.is_symlink():
        raise EngineIpcError("scoped_embedding_untrusted_peer")
    try:
        root = path.resolve(strict=True)
        info = root.lstat()
    except FileNotFoundError:
        raise EngineIpcError("scoped_embedding_ipc_unavailable") from None
    except (OSError, RuntimeError):
        raise EngineIpcError("scoped_embedding_untrusted_peer") from None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise EngineIpcError("scoped_embedding_untrusted_peer")
    return root


def _private_dir(path: Path, *, owner_only: bool = True) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise EngineIpcError("scoped_embedding_ipc_unavailable") from None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & (0o077 if owner_only else 0o022):
        raise EngineIpcError("scoped_embedding_untrusted_peer")


def _ipc_directory(path: Path, *, create: bool = False) -> Path:
    control = _verified_root(path) / "control"
    directory = control / "embedding-ipc"
    for part in (control, directory):
        if create:
            part.mkdir(mode=0o700, exist_ok=True)
        _private_dir(part, owner_only=part == directory)
    return directory


def _filesystem_socket_path(directory: Path) -> Path:
    path = directory / "owner.sock"
    # Python requires a NUL terminator in sockaddr_un's pathname buffer.
    if len(os.fsencode(path)) >= (104 if sys.platform == "darwin" else 108):
        raise EngineIpcError("scoped_embedding_untrusted_peer")
    return path


def _private_socket(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise EngineIpcError("scoped_embedding_ipc_unavailable") from None
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise EngineIpcError("scoped_embedding_untrusted_peer")
    return info


def _read_token(directory: Path) -> bytes:
    try:
        fd = os.open(directory / "owner.token", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        raise EngineIpcError("scoped_embedding_ipc_unavailable") from None
    except OSError:
        raise EngineIpcError("scoped_embedding_untrusted_peer") from None
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_nlink != 1 or not 64 <= info.st_size <= 65):
            raise EngineIpcError("scoped_embedding_untrusted_peer")
        token = os.read(fd, 66)
    finally:
        os.close(fd)
    if not _TOKEN.fullmatch(token):
        raise EngineIpcError("scoped_embedding_untrusted_peer")
    return token.rstrip(b"\n")


def _peer_uid(connection: socket.socket) -> int:
    if sys.platform == "linux":
        peer = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("=iII"))
        return struct.unpack("=iII", peer)[1]
    if sys.platform == "darwin":
        getpeereid = ctypes.CDLL(None, use_errno=True).getpeereid
        getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        getpeereid.restype = ctypes.c_int
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        if getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) == 0:
            return uid.value
    raise EngineIpcError("scoped_embedding_untrusted_peer")


def _assert_peer(connection: socket.socket) -> None:
    try:
        trusted = _peer_uid(connection) == os.geteuid()
    except (AttributeError, OSError):
        raise EngineIpcError("scoped_embedding_untrusted_peer") from None
    if not trusted:
        raise EngineIpcError("scoped_embedding_untrusted_peer")


def _deadline(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise EngineIpcError("scoped_embedding_timeout")
    return remaining


def _write_frame(connection, value: dict, limit: int, deadline: float) -> None:
    try:
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
    except (UnicodeError, TypeError, ValueError, RecursionError):
        raise EngineIpcError("scoped_embedding_invalid_frame") from None
    if len(data) > limit:
        raise EngineIpcError("scoped_embedding_invalid_frame")
    connection.settimeout(_deadline(deadline))
    connection.sendall(data)


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate frame fields")
    return result


def _read_frame(connection, limit: int, deadline: float) -> dict:
    frame = bytearray()
    while len(frame) < limit:
        connection.settimeout(_deadline(deadline))
        block = connection.recv(min(65_536, limit - len(frame)))
        if not block:
            raise EngineIpcError("scoped_embedding_ipc_unavailable")
        frame.extend(block)
        if b"\n" in block:
            line, _, tail = frame.partition(b"\n")
            if tail.strip():
                break
            try:
                value = json.loads(line.decode("utf-8"), object_pairs_hook=_unique_pairs)
            except (UnicodeError, ValueError, RecursionError):
                break
            if isinstance(value, dict):
                return value
            break
    raise EngineIpcError("scoped_embedding_invalid_frame")


def _texts(values: Any) -> list[str]:
    if not isinstance(values, list) or not 1 <= len(values) <= _MAX_TEXTS:
        raise EngineIpcError("scoped_embedding_invalid_frame")
    try:
        sizes = [len(text.encode("utf-16-le")) // 2 for text in values
                 if isinstance(text, str) and text.strip()]
    except UnicodeError:
        raise EngineIpcError("scoped_embedding_invalid_frame") from None
    if len(sizes) != len(values) or max(sizes) > 60_000 or sum(sizes) > 120_000:
        raise EngineIpcError("scoped_embedding_invalid_frame")
    return values


def _vectors(values: Any, count: int, dimensions: int) -> list[list[float]]:
    if not isinstance(values, list) or len(values) != count:
        raise EngineIpcError("scoped_embedding_invalid_vector")
    try:
        if all(
            isinstance(vector, list) and len(vector) == dimensions
            and all(type(entry) in {int, float} and math.isfinite(entry) for entry in vector)
            for vector in values
        ):
            return [[float(entry) for entry in vector] for vector in values]
    except OverflowError:
        raise EngineIpcError("scoped_embedding_invalid_vector") from None
    raise EngineIpcError("scoped_embedding_invalid_vector")


@contextmanager
def _connect(state_root: Path, deadline: float, pipe_mode: str):
    if sys.platform == "win32":
        from .embedding_ipc_windows import connect_pipe
        with connect_pipe(state_root, deadline, pipe_mode) as connected:
            yield connected
        return
    directory = _ipc_directory(state_root)
    path = _filesystem_socket_path(directory)
    _private_socket(path)
    token = _read_token(directory)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(_deadline(deadline))
        connection.connect(str(path))
        _assert_peer(connection)
        yield connection, token
    if not hmac.compare_digest(token, _read_token(directory)):
        raise EngineIpcError("scoped_embedding_owner_changed")


class EngineIpcEmbedding:
    """Upstream-compatible client. Every request binds to the current trusted owner."""

    def __init__(self, config: Mapping[str, Any]) -> None:
        validate_ipc_config(config)
        self._identity = _identity(config)
        self._root = _root(config["stateRoot"])
        self._timeout = _timeout(config)
        self._pipe_mode = config.get("pipeMode", "engine")
        self._closed = False

    def embed(self, text: str, *, purpose: str = "passage") -> list[float]:
        return self.embed_many([text], purpose=purpose)[0]

    def embed_many(self, texts: list[str], *, purpose: str = "passage") -> list[list[float]]:
        if purpose not in {"query", "passage"}:
            raise EngineIpcError("scoped_embedding_invalid_frame")
        if self._closed:
            raise EngineIpcError("scoped_embedding_closed")
        if not texts:
            return []
        for start in range(0, len(texts), _MAX_TEXTS):
            _texts(texts[start:start + _MAX_TEXTS])
        # The v1 batch operation always embeds passages. Queries are separate
        # calls, with the same overall request deadline even for a whole batch.
        deadline = time.monotonic() + self._timeout
        size = 1 if purpose == "query" else _MAX_TEXTS
        vectors = []
        for start in range(0, len(texts), size):
            selected = texts[start:start + size]
            operation = "batch" if len(selected) > 1 else purpose
            vectors.extend(self._request(operation, selected, deadline))
        return vectors

    def _request(self, operation: str, texts: list[str], deadline: float) -> list[list[float]]:
        try:
            with _connect(self._root, deadline, self._pipe_mode) as (connection, token):
                _write_frame(connection, {"token": token.decode("ascii"), **self._identity.wire(),
                             "request": {"operation": operation, "texts": texts, "persist": False}},
                             _MAX_REQUEST, deadline)
                response = _read_frame(connection, _MAX_RESPONSE, deadline)
        except TimeoutError:
            raise EngineIpcError("scoped_embedding_timeout") from None
        except OSError:
            raise EngineIpcError("scoped_embedding_ipc_unavailable") from None
        if response.get("ok") is not True:
            error = response.get("error")
            code = error.get("code") if isinstance(error, dict) else None
            raise EngineIpcError(code if isinstance(code, str) else "plur1bus_scoped_embedding_error")
        return _vectors(response.get("vectors"), len(texts), self._identity.dimensions)

    def close(self) -> None:
        self._closed = True


class _UnixListener:
    """Bind the private owner socket and publish its token only after it listens."""

    def __init__(self, state_root: Path, token: bytes) -> None:
        self.directory = _ipc_directory(state_root, create=True)
        self.token_path = self.directory / "owner.token"
        self.token_info = None
        self.path = _filesystem_socket_path(self.directory)
        self.socket_info = None
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.socket.bind(str(self.path))
            self.socket_info = self.path.lstat()
            self.path.chmod(0o600)
            self.socket.listen(8)
            self.socket.settimeout(0.2)
            fd = os.open(self.token_path, os.O_WRONLY | os.O_NOFOLLOW | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                self.token_info = os.fstat(fd)
                content = token + b"\n"
                if os.write(fd, content) != len(content):
                    raise OSError("short Engine IPC token write")
                os.fsync(fd)
            finally:
                os.close(fd)
        except FileExistsError:
            self.close()
            raise EngineIpcError("scoped_embedding_owner_already_active") from None
        except OSError as error:
            self.close()
            code = ("scoped_embedding_owner_already_active" if error.errno == errno.EADDRINUSE
                    else "scoped_embedding_ipc_unavailable")
            raise EngineIpcError(code) from None

    def accept(self):
        return self.socket.accept()[0]

    def close(self) -> None:
        self.socket.close()
        for path, recorded in ((self.token_path, self.token_info), (self.path, self.socket_info)):
            if recorded is None:
                continue
            try:
                current = path.lstat()
            except FileNotFoundError:
                continue
            if os.path.samestat(recorded, current):
                path.unlink(missing_ok=True)


class EngineIpcServer:
    """Opt-in v1 owner. The embed callback must be memory-only and identity-pinned."""

    def __init__(self, state_root: str | Path, *, identity: Mapping[str, Any],
                 embed_many: Callable[..., list[list[float]]]) -> None:
        self._state_root = _root(state_root)
        self._identity = _identity(identity)
        self._embed_many = embed_many
        self._stop = threading.Event()
        self._guard = threading.Lock()
        self._clients: dict[threading.Thread, Any] = {}
        self._listener = None
        self._thread = None
        self._token = None
        self._accept_error = False

    def __enter__(self):
        if sys.platform not in _POSIX | {"win32"}:
            raise EngineIpcError("scoped_embedding_ipc_unavailable")
        if self._listener is not None:
            return self
        if self._stop.is_set():
            raise EngineIpcError("scoped_embedding_closed")
        self._token = secrets.token_hex(32).encode("ascii")
        if sys.platform == "win32":
            from .embedding_ipc_windows import WindowsPipeListener
            self._listener = WindowsPipeListener(self._state_root, self._token)
        else:
            self._listener = _UnixListener(self._state_root, self._token)
        self._thread = threading.Thread(target=self._accept, name="plur1bus-engine-ipc", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _accept(self) -> None:
        while not self._stop.is_set():
            try:
                connection = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                self._accept_error = True
                self._stop.set()
                return
            with self._guard:
                if self._stop.is_set() or len(self._clients) >= 4:
                    connection.close()
                    continue
                thread = threading.Thread(target=self._serve, args=(connection,), daemon=True)
                self._clients[thread] = connection
                thread.start()

    def _serve(self, connection) -> None:
        try:
            if sys.platform == "win32":
                connection.assert_peer()
            else:
                _assert_peer(connection)
            request = _read_frame(connection, _MAX_REQUEST, time.monotonic() + 10)
            vectors = self._compute(request)
            response = {"ok": True, "vectors": vectors}
        except EngineIpcError as error:
            response = {"ok": False, "error": {"code": error.code, "message": str(error)}}
        except (OSError, TimeoutError):
            response = None
        except Exception:
            error = EngineIpcError("plur1bus_scoped_embedding_error")
            response = {"ok": False, "error": {"code": error.code, "message": str(error)}}
        try:
            if response is not None and not self._stop.is_set():
                deadline = time.monotonic() + 10
                _write_frame(connection, response, _MAX_RESPONSE, deadline)
                if sys.platform == "win32":
                    connection.finish_reply(deadline)
        except (EngineIpcError, OSError):
            pass  # the local requester disconnected or its frame could not be represented
        finally:
            connection.close()
            with self._guard:
                self._clients.pop(threading.current_thread(), None)

    def _compute(self, envelope: dict) -> list[list[float]]:
        if set(envelope) != {"token", "model", "dimensions", "fingerprintId", "request"}:
            raise EngineIpcError("scoped_embedding_invalid_frame")
        presented = envelope["token"]
        if (not isinstance(presented, str) or not presented.isascii()
                or not hmac.compare_digest(presented.encode("ascii"), self._token)):
            raise EngineIpcError("scoped_embedding_auth_failed")
        if (envelope["model"] != self._identity.model or type(envelope["dimensions"]) is not int
                or envelope["dimensions"] != self._identity.dimensions):
            raise EngineIpcError("scoped_embedding_identity_mismatch")
        if envelope["fingerprintId"] != self._identity.fingerprint_id:
            raise EngineIpcError("scoped_embedding_fingerprint_mismatch")
        request = envelope["request"]
        if (not isinstance(request, dict) or set(request) - {"operation", "texts", "persist"}
                or ("persist" in request and request["persist"] is not False)):
            raise EngineIpcError("scoped_embedding_invalid_frame")
        operation = request.get("operation")
        texts = _texts(request.get("texts"))
        if operation not in ("query", "passage", "batch") or (operation != "batch" and len(texts) != 1):
            raise EngineIpcError("scoped_embedding_invalid_frame")
        purpose = "query" if operation == "query" else "passage"
        result = self._embed_many(texts, purpose=purpose)
        return _vectors(result, len(texts), self._identity.dimensions)

    def wait(self) -> None:
        """Stay in the foreground until asked to stop or the listener fails."""
        self._stop.wait()
        if self._accept_error:
            raise EngineIpcError("scoped_embedding_ipc_unavailable")

    def close(self) -> None:
        if self._listener is None:
            return
        self._stop.set()
        self._thread.join()
        with self._guard:
            clients = tuple(self._clients.items())
        for _, connection in clients:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass  # the requester already disconnected
        for thread, _ in clients:
            thread.join()
        self._listener.close()
        self._listener = None


def _native_identity(config: Mapping[str, Any]) -> dict[str, Any]:
    # Distinguish Hermes' actual encoding contract from an upstream encoder
    # merely using the same name. An owner never claims equivalence by name.
    from .reembed_staged import _semantic_embedding_config

    public = {key: value for key, value in config.items() if key not in {
        "modelDir", "cacheDir", "cachePersist", "cachePersistDebug", "cacheEnabled", "localFilesOnly",
    }}
    digest = hashlib.sha256(json.dumps(
        ["plur1bus-hermes-encoder-v1", _semantic_embedding_config(public)],
        sort_keys=True, separators=(",", ":"), ensure_ascii=True,
    ).encode("utf-8")).hexdigest()
    return {"model": config.get("model"), "dimensions": config.get("dimensions"),
            "fingerprintId": f"embedding:v1:sha256:{digest}"}


def main(argv: list[str] | None = None) -> int:
    """Serve the selected Hermes profile's pinned local embedding model in the foreground."""
    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("--hermes-home", type=Path, required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--state-root", type=Path, help="Existing local state directory. Default is the profile's plur1bus directory.")
    args = parser.parse_args(argv)
    try:
        from .operator_cli import runtime_view
        from .runtime import EmbeddingBackend, validate_native_embedding_config

        profile = safe_agent_id(args.profile)
        home = _root(args.hermes_home)
        profile_home = home if profile == "default" else home / "profiles" / profile
        if not profile_home.is_dir() or profile_home.is_symlink():
            raise ValidationError("An existing Hermes profile is required")
        runtime = runtime_view(home, profile)
        config = dict(runtime.config["embedding"])
        revision = config.get("revision")
        if (config.get("provider") not in {"local-onnx", "local-transformers"}
                or not isinstance(revision, str) or not _SHA1.fullmatch(revision)
                or config.get("fallback") is not None or config.get("fallbackProvider") is not None):
            raise ValidationError("A pinned local model without a fallback is required to serve Engine IPC")
        validate_native_embedding_config(config)
        root = _root(args.state_root or profile_home / "plur1bus")
        if args.state_root is None:
            root.mkdir(mode=0o700, exist_ok=True)
        identity = _native_identity(config)
        backend = EmbeddingBackend({**config, "cachePersist": False}, root, credential_home=profile_home)
        try:
            with EngineIpcServer(root, identity=identity, embed_many=backend.embed_many) as server:
                print(json.dumps({"provider": "engine-ipc", "stateRoot": str(root), **identity}), flush=True)
                if threading.current_thread() is threading.main_thread():
                    previous = signal.signal(signal.SIGTERM, lambda *_: server._stop.set())
                    try:
                        server.wait()
                    finally:
                        signal.signal(signal.SIGTERM, previous)
                else:
                    server.wait()
        finally:
            backend.close()
    except KeyboardInterrupt:
        return 0
    except EngineIpcError as error:
        print(str(error), file=sys.stderr)
        return 4
    except (OSError, ValueError, KeyError, TypeError):
        print("Engine IPC serve requires an existing profile and a pinned local model", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

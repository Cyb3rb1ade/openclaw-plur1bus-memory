"""Opt-in, owner-bound LLM diagnostics; ordinary logs contain only enums."""

from __future__ import annotations

import errno
import hashlib
import json
import logging
import os
import re
import stat
import threading
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .llm_cache import LLM_RESULT_CACHE_PURPOSES
from .validation import resolve_inside, safe_agent_id

LOGGER = logging.getLogger(__name__)
MAX_FILE_BYTES = 65_536
_WINDOWS = os.name == "nt"
_FEATURES = LLM_RESULT_CACHE_PURPOSES | {
    "skill-workshop-mining", "skill-workshop-benefit-backfill", "episode-extraction",
    "emotion-tier3", "critical-classification", "dream-narrative", "persona-voice",
    "reminder-extraction", "light-dream", "meta-reflection",
}
_CODES = {
    "LLM_COMPLETION_ABORTED": "host-aborted",
    "LLM_RUNTIME_UNAVAILABLE": "runtime-unavailable",
    "ETIMEDOUT": "timeout", "ECONNRESET": "network", "ECONNREFUSED": "network",
    "EPIPE": "network", "ENETUNREACH": "network", "EHOSTUNREACH": "network",
    "EAI_AGAIN": "network", "ENOTFOUND": "network", "ABORT_ERR": "aborted",
}
# Windows errno.errorcode can prefer WSA* aliases for the same integer.
# Derive the reverse mapping from our canonical allowlist, not that alias map.
_OS_CODES = {getattr(errno, name): name for name in _CODES if hasattr(errno, name)}
_HINTS = tuple((re.compile(pattern, re.I), hint) for pattern, hint in (
    (r"requires an injected runtime config scope", "no-config-scope"),
    (r"configured agent runtime is unavailable", "runtime-unavailable"),
    (r"does not support isolated completion|unavailable for isolated completion", "harness-unsupported"),
    (r"(?:isolated completion )?input was rejected", "input-rejected"),
    (r"isolated completion output was rejected|stop reason|internal LLM (?:returned invalid|JSON result)", "output-rejected"),
    (r"isolated completion timed out|completion timed out after", "host-timeout"),
    (r"isolated completion was aborted|completion was aborted", "host-aborted"),
    (r"plugin llm completion failed", "host-failed"),
    (r"abort", "aborted"),
    (r"timeout|timed out|etimedout", "timeout"),
    (r"rate.?limit|too many requests|\b429\b", "rate-limited"),
    (r"quota|budget|credit|exhaust", "quota"),
    (r"unauthor|forbidden|\b401\b|\b403\b|api[_ -]?key|credential", "auth"),
    (r"busy|concurrent|in flight|already running|queue", "busy"),
    (r"not allowed|permission|policy|override|denied", "denied"),
    (r"unavailable|not available|not configured|no runtime|disposed|closed|destroyed|shut ?down", "unavailable"),
    (r"network|socket|econn|fetch failed|dns|tls", "network"),
    (r"\b5\d\d\b|internal server", "server-error"),
    (r"\b4\d\d\b|invalid|malformed|unsupported", "request-rejected"),
))
_SECRET_KEY = re.compile(r"authorization|credential|password|secret|token|apikey|accesskey", re.I)
_REDACTIONS = tuple(re.compile(pattern, re.I) for pattern in (
    r"\bAuthorization[\"']?[ \t]*[:=][ \t]*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*",
    r"\bBearer\s+(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;]+)",
    r"\b(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|bot[_-]?token|token|password|(?:client|private|shared)?[_-]?secret|secret[_-]?access[_-]?key|credential)[\"']?\s*[:=]\s*(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;]+)",
    r"\bsk-[A-Za-z0-9_+=./-]{8,}",
    r"\bgh[pousr]_[A-Za-z0-9]{20,}",
    r"\b\d{6,12}:[A-Za-z0-9_+=./-]{20,}",
    r"https?://[^\s\"'<>]+",
))


def _error_fields(error: BaseException) -> tuple[str, str, Any]:
    """Read exception data without invoking foreign message/code properties."""
    args = BaseException.args.__get__(error)
    message = " ".join(value for value in args if type(value) is str)
    attributes = object.__getattribute__(error, "__dict__")
    name = attributes.get("name")
    if type(name) is not str:
        name = type.__getattribute__(type(error), "__name__")
    # HTTPError stores its reason separately; never read its response body.
    if isinstance(error, urllib.error.HTTPError) and type(attributes.get("msg")) is str:
        message = attributes["msg"]
    elif isinstance(error, urllib.error.URLError):
        reason = attributes.get("reason")
        if type(reason) is str:
            message = reason
        elif isinstance(reason, BaseException):
            message = " ".join(value for value in BaseException.args.__get__(reason) if type(value) is str)
    return message, name, attributes.get("code")


def classify_error(error: BaseException) -> dict[str, str]:
    """Return fixed categories and allowlisted codes, never arbitrary exception text."""
    try:
        message, _, code = _error_fields(error)
        error_class = next((kind.__name__ for kind in (
            urllib.error.HTTPError, urllib.error.URLError, TimeoutError,
            ConnectionError, PermissionError, OSError, ValueError, TypeError, RuntimeError,
        ) if isinstance(error, kind)), "Error")
        result = {"errorClass": error_class, "errorHint": "other"}
        if isinstance(error, urllib.error.HTTPError) and type(code) is int and 100 <= code <= 599:
            result["errorCode"] = f"HTTP_{code}"
            result["errorHint"] = ({401: "auth", 403: "auth", 408: "timeout", 429: "rate-limited"}.get(code)
                                   or ("server-error" if code >= 500 else "request-rejected"))
            return result
        if type(code) is str and code in _CODES:
            result.update(errorCode=code, errorHint=_CODES[code])
            return result
        if isinstance(error, OSError):
            number = OSError.errno.__get__(error)
            os_code = _OS_CODES.get(number) if type(number) is int else None
            if os_code in _CODES:
                result.update(errorCode=os_code, errorHint=_CODES[os_code])
                return result
        if isinstance(error, TimeoutError):
            result["errorHint"] = "timeout"
            return result
        for pattern, hint in _HINTS:
            if pattern.search(message[:16_384]):
                result["errorHint"] = hint
                break
        return result
    except Exception:
        return {"errorClass": "Error", "errorHint": "other"}


def _credentials(config: Any) -> set[str]:
    values: set[str] = set()
    if isinstance(config, dict):
        for key, value in config.items():
            if isinstance(key, str) and _SECRET_KEY.search(re.sub(r"[^a-zA-Z]", "", key)):
                if isinstance(value, str) and value:
                    values.add(value)
                    authorization = re.fullmatch(r"(?:Bearer|Basic)\s+(.+)", value, re.I)
                    if authorization:
                        values.add(authorization.group(1))
            values.update(_credentials(value))
    elif isinstance(config, (tuple, list)):
        for value in config:
            values.update(_credentials(value))
    elif isinstance(config, str) and config.startswith(("https://", "http://")):
        parsed = urllib.parse.urlsplit(config)
        values.update(urllib.parse.unquote(value) for value in (parsed.username, parsed.password) if value)
        values.update(value for _, value in urllib.parse.parse_qsl(parsed.query) if value)
    return values


def _redact(value: str, secrets: set[str], limit: int) -> str:
    # Redact before truncating; a token crossing the output limit must not leak.
    for secret in sorted(secrets, key=len, reverse=True):
        value = value.replace(secret, "[REDACTED]")
    for pattern in _REDACTIONS:
        value = pattern.sub("[REDACTED]", value)
    return value[:limit] + (" [truncated]" if len(value) > limit else "")


class LlmErrorReporter:
    """Bind optional diagnostic writes to one runtime owner, profile and scope.

    The runtime supplies paths; configuration cannot choose a diagnostics file.
    Two 64 KiB segments are retained. POSIX uses descriptor-relative no-follow
    writes; Windows uses pinned handles, reparse guards and owner-only DACLs.
    """

    def __init__(self, config: dict[str, Any], agent_id: str, *,
                 data_dir: Path | None = None, scope_key: str | None = None) -> None:
        self.enabled = isinstance(config.get("llmRouter"), dict) and config["llmRouter"].get("errorDiagnostics") is True
        self._lock = threading.Lock()
        self._root: Path | None = None
        self._lexical: Path | None = None
        self._parts: tuple[str, ...] = ()
        self._secrets: set[str] = set()
        if not self.enabled:
            return
        try:
            owner = safe_agent_id(agent_id)
            if data_dir is None or not isinstance(scope_key, str) or not scope_key:
                raise ValueError("diagnostics require an explicit runtime binding")
            self._lexical = Path(data_dir).expanduser().absolute()
            if self._lexical.is_symlink():
                raise ValueError("symlink diagnostics root")
            if any(getattr(part.lstat(), "st_file_attributes", 0) & 0x400
                   for part in (self._lexical, *self._lexical.parents) if part.exists()):
                raise ValueError("reparse diagnostics root")
            self._root = self._lexical.resolve()
            profile = [str(config.get("hermesHome") or self._root), str(config.get("_hermesProfile") or "")]
            binding = hashlib.sha256(json.dumps([profile, owner, scope_key]).encode()).hexdigest()
            self._parts = ("diagnostics", "llm-router", owner, binding)
            self._secrets = _credentials(config)
        except Exception:
            self.enabled = False
            try:
                LOGGER.debug("LLM diagnostics unavailable: invalid-runtime-binding")
            except Exception:
                pass  # Diagnostics, including a foreign logger, remain optional.

    def report(self, error: BaseException, purpose: str) -> dict[str, str]:
        """Emit safe metadata and optionally a redacted record; never raise."""
        fields = classify_error(error)
        feature = purpose if type(purpose) is str and purpose in _FEATURES else "unknown"
        try:
            LOGGER.warning("LLM transport-failed feature=%s route=http-json errorClass=%s errorHint=%s errorCode=%s",
                           feature, fields["errorClass"], fields["errorHint"], fields.get("errorCode", "none"))
        except Exception:
            pass  # A foreign logging handler must not replace the LLM outcome.
        if not self.enabled:
            return fields
        try:
            message, name, code = _error_fields(error)
            entry = {
                "at": datetime.now(timezone.utc).isoformat(), "feature": feature,
                "route": "http-json", **fields,
                "message": _redact(message, self._secrets, 512),
                "name": _redact(name, self._secrets, 80),
                "code": _redact(code, self._secrets, 80) if type(code) is str else fields.get("errorCode"),
            }
            encoded = (json.dumps(entry, ensure_ascii=False) + "\n").encode("utf-8")
            if len(encoded) > 8192:
                raise ValueError("diagnostic record exceeds hard limit")
            if not self._lock.acquire(blocking=False):
                return fields
            try:
                self._append(encoded)
            finally:
                self._lock.release()
        except Exception:
            try:
                LOGGER.debug("LLM diagnostics skipped: diagnostic-write-failed")
            except Exception:
                pass  # Fail open even if both diagnostics and the logger fail.
        return fields

    @staticmethod
    def _file(directory: int, name: str) -> int:
        fd = os.open(name, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK,
                     0o600, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
                raise ValueError("unsafe diagnostics file")
            os.fchmod(fd, 0o600)
            return fd
        except Exception:
            os.close(fd)
            raise

    def _append(self, encoded: bytes) -> None:
        if not self._root or not self._lexical or self._lexical.is_symlink() or self._lexical.resolve() != self._root:
            raise ValueError("diagnostics root changed")
        resolve_inside(str(self._root), *self._parts, "llm-router-errors.jsonl")
        if _WINDOWS:
            from .llm_diagnostics_windows import append_windows
            append_windows(self._root, self._parts, encoded, MAX_FILE_BYTES)
            return
        import fcntl

        descriptors: list[int] = []
        try:
            # Open every canonical ancestor without following a replaced link.
            directory = os.open(self._root.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors.append(directory)
            for part in self._root.parts[1:]:
                directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                descriptors.append(directory)
            for part in self._parts:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=directory)
                except FileExistsError:
                    pass  # Existing directories are validated via their open descriptor.
                directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                descriptors.append(directory)
                if os.fstat(directory).st_uid != os.getuid():
                    raise ValueError("diagnostics directory owner mismatch")
                os.fchmod(directory, 0o700)
            lock = self._file(directory, ".lock")
            descriptors.append(lock)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            name = "llm-router-errors.jsonl"
            current = self._file(directory, name)
            descriptors.append(current)
            if os.fstat(current).st_size > MAX_FILE_BYTES:
                raise ValueError("unexpected oversized diagnostics file")
            if os.fstat(current).st_size + len(encoded) > MAX_FILE_BYTES:
                # Validate the sole retained backup before replacing it; never
                # clobber symlinks, hardlinks, directories, or another uid's file.
                backup = self._file(directory, name + ".1")
                os.close(backup)
                os.replace(name, name + ".1", src_dir_fd=directory, dst_dir_fd=directory)
                current = self._file(directory, name)
                descriptors.append(current)
            remaining = memoryview(encoded)
            while remaining:
                written = os.write(current, remaining)
                if written <= 0:
                    raise OSError("diagnostic write made no progress")
                remaining = remaining[written:]
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

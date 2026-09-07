"""Confirmed, separate Windows ARM desktop launcher; never changes Hermes shortcuts."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import time


LAUNCHER = "bin/plur1bus-native-arm-desktop.cmd"
RECEIPT = "plur1bus-native-arm-launcher.json"
BACKUPS = "plur1bus-native-arm-launcher-backups"


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def redirected(path: Path) -> bool:
    try:
        return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)
    except FileNotFoundError:
        return path.is_symlink()


def safe_absolute(value: str | Path, *, directory: bool = False) -> Path:
    """Return a non-redirected existing path, rejecting every parent redirect."""
    raw = str(value)
    if not raw or len(raw) > 4096 or any(character in raw for character in ("\0", "\r", "\n")):
        raise ValueError("invalid native launcher path")
    path = Path(raw).expanduser().absolute()
    chain = []
    current = path
    while current != current.parent:
        chain.append(current)
        current = current.parent
    for item in reversed(chain):
        if redirected(item):
            # macOS exposes these two OS-owned aliases as symlinks. They are
            # canonicalized before any managed child is considered; arbitrary
            # redirects (and all Windows reparse points) remain refused.
            if os.name != "nt" and item in (Path("/var"), Path("/tmp")):
                continue
            raise ValueError("native launcher redirects are refused")
    exists = path.is_dir() if directory else path.is_file()
    if not exists:
        raise ValueError("native launcher input is missing")
    # Re-walk this path immediately before every managed write: a directory can
    # be replaced after this preflight.
    return path.resolve()


def pe_machine(path: Path) -> int:
    with path.open("rb") as stream:
        header = stream.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise ValueError("native launcher requires a Windows PE executable")
        offset = struct.unpack_from("<I", header, 0x3C)[0]
        if offset < 64 or offset > 1024 * 1024:
            raise ValueError("native launcher PE header is invalid")
        stream.seek(offset)
        pe = stream.read(6)
    if len(pe) != 6 or pe[:4] != b"PE\0\0":
        raise ValueError("native launcher PE header is invalid")
    return struct.unpack_from("<H", pe, 4)[0]


def python_state(python: Path) -> dict:
    code = ("import json,platform,sys,sysconfig; print(json.dumps({'version':list(sys.version_info[:2]),"
            "'venv':sys.prefix!=sys.base_prefix,'platform':sys.platform,'machine':platform.machine(),"
            "'implementation':sys.implementation.name,'freeThreaded':bool(sysconfig.get_config_var('Py_GIL_DISABLED'))}))")
    try:
        result = subprocess.run([str(python), "-I", "-X", "utf8", "-c", code], capture_output=True, text=True,
                                encoding="utf-8", timeout=15)
    except subprocess.TimeoutExpired as error:
        raise ValueError("native launcher Python preflight timed out") from error
    if result.returncode:
        raise ValueError("native launcher Python preflight failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("native launcher Python preflight is invalid") from error


def _cmd_value(path: Path) -> str:
    value = str(path)
    # set "NAME=value" is safe for ordinary Unicode paths. Reject cmd's
    # expansion/control grammar rather than attempting lossy escaping.
    if any(character in value for character in ('"', "%", "!", "&", "|", "<", ">", "^", "\r", "\n", "\0")):
        raise ValueError("native launcher path is unsafe for the Windows command processor")
    return value


def _inside(home: Path, relative: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_.\-/]+", relative) or ".." in relative.split("/"):
        raise ValueError("invalid native launcher managed path")
    path = home
    for part in relative.split("/"):
        path /= part
        if redirected(path):
            raise ValueError("native launcher managed path is redirected")
    if not path.resolve().is_relative_to(home.resolve()):
        raise ValueError("native launcher path escaped its Hermes home")
    return path


def _fingerprints(home: Path, root: Path, python: Path, desktop: Path) -> dict:
    marker = root / "hermes_cli" / "main.py"
    config = home / "config.yaml"
    if (not marker.is_file() or redirected(root / "hermes_cli") or redirected(marker)
            or not config.is_file() or redirected(config)):
        raise ValueError("native launcher home/root is incomplete")
    return {"homeConfig": digest_file(config), "rootMarker": digest_file(marker),
            "nativePython": digest_file(python), "desktopExe": digest_file(desktop)}


def _validate(home, root, python, desktop, *, system: str | None = None) -> tuple[Path, Path, Path, Path, dict]:
    if (sys.platform if system is None else system) != "win32":
        raise ValueError("native desktop launcher is available only on Windows")
    home, root = safe_absolute(home, directory=True), safe_absolute(root, directory=True)
    python, desktop = safe_absolute(python), safe_absolute(desktop)
    if not (root / "hermes_cli" / "main.py").is_file():
        raise ValueError("native desktop root is not a Hermes source root")
    if pe_machine(python) != 0xAA64 or pe_machine(desktop) != 0xAA64:
        raise ValueError("native desktop Python and executable must both be Windows ARM64")
    state = python_state(python)
    if (state.get("version") != [3, 13] or state.get("venv") is not True or state.get("platform") != "win32"
        or str(state.get("machine", "")).upper() not in {"ARM64", "AARCH64"}
        or state.get("implementation") != "cpython" or state.get("freeThreaded") is not False):
        raise ValueError("native desktop requires CPython 3.13 ARM64 in a standard Hermes virtual environment")
    for path in (home, root, python, desktop):
        _cmd_value(path)
    return home, root, python, desktop, _fingerprints(home, root, python, desktop)


def _template(home: Path, root: Path, python: Path, desktop: Path) -> bytes:
    values = {"HERMES_HOME": _cmd_value(home), "HERMES_DESKTOP_HERMES_ROOT": _cmd_value(root),
              "HERMES_DESKTOP_PYTHON": _cmd_value(python), "DESKTOP_EXE": _cmd_value(desktop)}
    # These first lines are deliberately ASCII. cmd.exe consumes batch files
    # through the active console code page, not a UTF-16LE contract. Restore
    # that shared console state after start while retaining its error level.
    text = ("@echo off\r\nsetlocal DisableDelayedExpansion\r\n"
            + "for /f \"tokens=2 delims=:\" %%A in ('chcp') do set \"ORIGINAL_CODEPAGE=%%A\"\r\n"
            + "chcp 65001 >nul\r\n"
            + "".join(f'set "{key}={value}"\r\n' for key, value in values.items())
            + 'start "PLUR1BUS Native ARM" /D "%HERMES_DESKTOP_HERMES_ROOT%" "%DESKTOP_EXE%"\r\n'
            + "set \"START_ERRORLEVEL=%ERRORLEVEL%\"\r\n"
            + "chcp %ORIGINAL_CODEPAGE% >nul\r\n"
            + "endlocal & exit /b %START_ERRORLEVEL%\r\n")
    return text.encode("utf-8")


def plan(home, root, native_python, desktop_exe, *, system: str | None = None) -> dict:
    """Return a no-write, fully pinned plan for an additional ARM launcher."""
    home, root, python, desktop, fingerprints = _validate(home, root, native_python, desktop_exe, system=system)
    launcher, receipt = _inside(home, LAUNCHER), _inside(home, RECEIPT)
    previous = None
    if launcher.exists() or receipt.exists():
        if not launcher.is_file() or not receipt.is_file():
            raise ValueError("native launcher conflict is not a managed regular file")
        try:
            previous = json.loads(receipt.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("native launcher receipt is invalid") from error
        if (not isinstance(previous, dict) or previous.get("schema") != 1
            or previous.get("launcherSha256") != digest_file(launcher)):
            raise ValueError("native launcher file is not owned by its receipt")
    result = {"schema": 1, "operation": "native-arm-desktop-launcher", "home": str(home), "root": str(root),
              "nativePython": str(python), "desktopExe": str(desktop), "fingerprints": fingerprints,
              "launcher": str(launcher), "receipt": str(receipt),
              "previous": None if previous is None else {"launcherSha256": digest_file(launcher),
                                                           "receiptSha256": digest_file(receipt)},
              "effects": "Create or update only a separate PLUR1BUS Native ARM launcher. Existing Hermes shortcuts, profiles, registry, PATH, and global environment remain unchanged. A pre-existing ARM CPython 3.13 venv is required; no interpreter or venv is provisioned."}
    result["confirmation"] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return result


def _atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".plur1bus-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply(plan_value: dict, confirmation: str, *, system: str | None = None) -> Path:
    """Create the separately named launcher after exact plan revalidation."""
    if not isinstance(plan_value, dict) or confirmation != plan_value.get("confirmation"):
        raise ValueError("native launcher confirmation is invalid")
    fresh = plan(plan_value.get("home"), plan_value.get("root"), plan_value.get("nativePython"),
                 plan_value.get("desktopExe"), system=system)
    if fresh != plan_value:
        raise ValueError("native launcher plan is stale; no files were written")
    home = Path(plan_value["home"])
    lock = _inside(home, ".plur1bus-native-arm-launcher-lock")
    lock.mkdir()
    try:
        if plan(plan_value["home"], plan_value["root"], plan_value["nativePython"], plan_value["desktopExe"], system=system) != plan_value:
            raise ValueError("native launcher changed while acquiring lock")
        launcher, receipt = _inside(home, LAUNCHER), _inside(home, RECEIPT)
        backup = _inside(home, BACKUPS) / time.strftime("%Y%m%d-%H%M%S")
        launcher.parent.mkdir(mode=0o700, exist_ok=True)
        _inside(home, "bin")
        if launcher.exists():
            backup.mkdir(parents=True, mode=0o700)
            _inside(home, BACKUPS)
            _atomic(backup / "launcher-before.cmd", launcher.read_bytes())
            _atomic(backup / "receipt-before.json", receipt.read_bytes())
        old_launcher = launcher.read_bytes() if launcher.exists() else None
        old_receipt = receipt.read_bytes() if receipt.exists() else None
        content = _template(Path(plan_value["home"]), Path(plan_value["root"]), Path(plan_value["nativePython"]), Path(plan_value["desktopExe"]))
        record = {"schema": 1, "launcherSha256": hashlib.sha256(content).hexdigest(),
                  "plan": {key: plan_value[key] for key in ("home", "root", "nativePython", "desktopExe", "fingerprints", "confirmation")},
                  "backup": str(backup) if backup.exists() else None}
        try:
            _atomic(launcher, content)
            _atomic(receipt, json.dumps(record, sort_keys=True, indent=2).encode("utf-8"))
        except Exception:
            # A managed update either becomes complete or returns to the exact
            # previous pair; a fresh install leaves no orphan launcher/receipt.
            if old_launcher is None:
                if launcher.exists():
                    launcher.unlink()
                if receipt.exists():
                    receipt.unlink()
            else:
                _atomic(launcher, old_launcher)
                _atomic(receipt, old_receipt)
            raise
        return launcher
    finally:
        lock.rmdir()

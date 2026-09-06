#!/usr/bin/env python3
"""PLUR1BUS portable installer. Default: verified read-only plan, never implicit activation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

MANIFEST = "distribution.json"
RECEIPT = "plur1bus-install.json"
DESKTOP_RECEIPT = "plur1bus-desktop-install.json"


def redirected(path):
    """Include Windows junctions on Python 3.11 (before Path.is_junction)."""
    try:
        return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)
    except FileNotFoundError:
        return path.is_symlink()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def resolve_inside(root, relative):
    """Constrain paths on Windows and POSIX, including junctions and absent targets."""
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise ValueError("invalid relative path")
    part = Path(relative)
    if part.is_absolute() or any(p in {"..", "."} for p in relative.split("/")):
        raise ValueError("path traversal refused")
    target = root
    for component in part.parts:
        if os.name == "nt" and (component.endswith((" ", ".")) or re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", component)):
            raise ValueError("reserved Windows path refused")
        target = target / component
        if redirected(target):
            raise ValueError("symbolic links/junctions are not installation targets")
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("path escapes installation root")
    return target


def root_path(value):
    path = Path(value).expanduser().absolute()
    # macOS /var and /tmp aliases are resolved only for the parent; final homes
    # and all managed descendants must be real directories, not redirects.
    if redirected(path):
        raise ValueError("redirected root refused")
    return path.resolve()


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".plur1bus-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run_python(python, code, data=None):
    result = subprocess.run([str(python), "-I", "-c", code], input=data, capture_output=True, text=True)
    if result.returncode:
        raise ValueError("Hermes Python preflight failed; inspect its installation (no raw config is logged)")
    return result.stdout


def read_config(python, path):
    return json.loads(run_python(python,
        "import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()) or {}))", path.read_text(encoding="utf-8")))


def config_bytes(python, config):
    return run_python(python,
        "import json,sys,yaml; print(yaml.safe_dump(json.load(sys.stdin),allow_unicode=True,sort_keys=False),end='')",
        json.dumps(config)).encode("utf-8")


def verify_bundle(bundle):
    manifest = json.loads(resolve_inside(bundle, MANIFEST).read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("schema") != 1 or not isinstance(manifest.get("files"), dict):
        raise ValueError("unsupported distribution manifest")
    if not re.fullmatch(r"\d+\.\d+\.\d+-hermes(?:\.\d+)?", str(manifest.get("version", ""))) or not re.fullmatch(r"\d+\.\d+\.\d+(?:\.post\d+)?", str(manifest.get("pythonVersion", ""))):
        raise ValueError("invalid distribution version identity")
    for name, expected in manifest["files"].items():
        path = resolve_inside(bundle, name)
        if not path.is_file() or digest(path.read_bytes()) != expected:
            raise ValueError("distribution checksum mismatch: " + name)
    return manifest


def targets(home, profiles, desktop_only=False):
    selected = sorted(set(profiles or ["default"]))
    if "all" in selected:
        if selected != ["all"]:
            raise ValueError("all cannot be combined with profile names")
        selected = ["default"]
        directory = resolve_inside(home, "profiles")
        if directory.exists():
            selected += sorted(p.name for p in directory.iterdir() if p.is_dir() and (desktop_only or (p / "config.yaml").is_file()))
    result = {}
    for name in sorted(selected):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
            raise ValueError("invalid profile")
        target = home if name == "default" else resolve_inside(home, "profiles/" + name)
        if not target.is_dir() or (not desktop_only and not resolve_inside(target, "config.yaml").is_file()):
            raise ValueError("profile does not exist: " + name)
        result[name] = target
    return result


def interpreter(home, override=None):
    if override:
        return Path(override).expanduser().absolute()
    for relative in ("hermes-agent/venv/Scripts/python.exe", "hermes-agent/venv/bin/python",
                     "hermes-agent/.venv/Scripts/python.exe", "hermes-agent/.venv/bin/python"):
        candidate = home / relative
        if candidate.is_file():
            return candidate
    raise ValueError("Hermes Python not found; pass --python pointing to the Hermes virtual environment")


def managed(relative):
    return isinstance(relative, str) and any(relative.startswith(prefix) for prefix in (
        "plugins/plur1bus/", "plugins/plur1bus-controls/", "desktop-plugins/plur1bus/"))


def plan_install(bundle, home, profiles=None, python=None, activate=False, dependencies=True, desktop_only=False):
    bundle, home = root_path(bundle), root_path(home)
    manifest = verify_bundle(bundle)
    if not home.is_dir() or (not desktop_only and not (home / "config.yaml").is_file()):
        raise ValueError("select an existing Hermes root home")
    if home.parent.name == "profiles":
        raise ValueError("pass the root Hermes home and select --profile separately")
    if desktop_only and activate:
        raise ValueError("desktop-only cannot activate a backend provider")
    info = None
    if not desktop_only:
        python = interpreter(home, python)
        info = json.loads(run_python(python, "import json,sys,platform,sysconfig; print(json.dumps({'version':list(sys.version_info[:3]),'venv':sys.prefix!=sys.base_prefix,'prefix':sys.prefix,'platform':sys.platform,'architecture':platform.machine(),'implementation':sys.implementation.name,'freeThreaded':bool(sysconfig.get_config_var('Py_GIL_DISABLED'))}))"))
        if info["version"] < [3, 11, 0] or not info["venv"] or info["platform"] != sys.platform:
            raise ValueError("same-platform Python >=3.11 in a Hermes virtual environment required; global or Windows/WSL-crossed pip refused")
    selected = targets(home, profiles, desktop_only)
    destinations, configs, receipts = {}, {}, {}
    payload = {key[8:]: key for key in manifest["files"] if key.startswith("payload/")}
    if desktop_only:
        payload = {key: value for key, value in payload.items() if key.startswith("desktop-plugins/plur1bus/")}
    if not payload or not all(managed(name) for name in payload):
        raise ValueError("invalid plugin payload")
    wheels = sorted(key for key in manifest["files"] if key.startswith("wheels/") and key.endswith(".whl"))
    if len(wheels) != 2:
        raise ValueError("both Python wheels are required")
    native = manifest.get("nativeDependencies", {})
    if not isinstance(native, dict) or set(native) - {"darwin/x86_64", "win32/ARM64"}:
        raise ValueError("unsupported bundled native dependency mapping")
    for key, wheel in native.items():
        if key == "win32/ARM64":
            expected = ["vendor/windows-arm64/lancedb-0.34.0-cp39-abi3-win_arm64.whl",
                        "vendor/windows-arm64/pyarrow-25.0.1-cp313-cp313-win_arm64.whl"]
            if wheel != expected or not all(path in manifest["files"] for path in expected):
                raise ValueError("invalid bundled ARM native dependency pair")
        elif (not isinstance(wheel, str) or wheel not in manifest["files"]
            or not re.fullmatch(r"vendor/macos-x86_64/lancedb-0\.34\.0-cp3\d+-abi3-macosx_\d+_\d+_x86_64\.whl", wheel)):
            raise ValueError("invalid bundled native dependency")
    native_wheels = []
    if not desktop_only and dependencies:
        target = info["platform"] + "/" + str(info.get("architecture", ""))
        if target in native:
            if target == "win32/ARM64":
                if (info["version"][:2] != [3, 13] or info.get("implementation") != "cpython"
                    or info.get("freeThreaded") is not False):
                    raise ValueError("bundled Windows ARM storage requires native CPython / Python 3.13 with the standard GIL ABI")
                native_wheels = list(native[target])
            else:
                native_wheels = [native[target]]
    for name, target in selected.items():
        config_path = resolve_inside(target, "config.yaml")
        configs[name] = digest(config_path.read_bytes()) if config_path.exists() else None
        if not desktop_only:
            config = read_config(python, config_path)
            if not isinstance(config, dict):
                raise ValueError("invalid Hermes config mapping")
        receipt = resolve_inside(target, DESKTOP_RECEIPT if desktop_only else RECEIPT)
        receipts[name] = digest(receipt.read_bytes()) if receipt.exists() else None
        previous = json.loads(receipt.read_text(encoding="utf-8")) if receipt.exists() else {}
        if tuple(map(int, re.findall(r"\d+", previous.get("version", "0")))) > tuple(map(int, re.findall(r"\d+", manifest["version"]))):
            raise ValueError("downgrade refused; restore a compatible backup instead")
        old_files = previous.get("files", {})
        if not isinstance(old_files, dict) or not all(managed(relative) and (not desktop_only or relative.startswith("desktop-plugins/plur1bus/")) for relative in old_files):
            raise ValueError("invalid previous installation receipt")
        for relative in set(payload) | set(old_files):
            dest = resolve_inside(target, relative)
            if dest.exists() and not dest.is_file():
                raise ValueError("file destination is not a regular file")
            destinations[name + "/" + relative] = digest(dest.read_bytes()) if dest.exists() else None
    result = {"schema": 1, "version": manifest["version"], "bundle": str(bundle), "home": str(home),
              "manifest": digest((bundle / MANIFEST).read_bytes()), "python": str(python) if not desktop_only else None, "pythonInfo": info,
              "desktopOnly": desktop_only,
              "profiles": list(selected), "activate": activate, "dependencies": dependencies,
              "configs": configs, "receipts": receipts, "destinations": destinations, "wheels": wheels,
              "nativeWheels": native_wheels,
              "effects": "Install Python wheels into selected Hermes venv, back up and update selected plugin/UI files; optional explicit activation. No models, memory migration, host patch, restart or unselected profile writes. File rollback does not roll back pip dependencies."}
    if not desktop_only:
        environment = subprocess.run([str(python), "-I", "-m", "pip", "freeze"], capture_output=True, check=True)
        result["environmentFingerprint"] = digest(environment.stdout)
    else:
        result["effects"] = "Install desktop frontend only. No Python, backend, model, provider configuration or host patch changes."
    # A frozen one-file executable extracts into a different directory per run.
    # Bind to verified content, not that ephemeral extraction path.
    result["confirmation"] = digest(json.dumps({k: v for k, v in result.items() if k != "bundle"}, sort_keys=True).encode())
    return result


def apply_install(plan, confirmation, stopped=False):
    if not stopped:
        raise ValueError("stop affected Hermes runtimes and pass --runtimes-stopped")
    fresh = plan_install(plan["bundle"], plan["home"], plan["profiles"], plan["python"], plan["activate"], plan["dependencies"], plan["desktopOnly"])
    if fresh != plan or confirmation != plan["confirmation"]:
        raise ValueError("stale plan or invalid confirmation; no writes performed")
    home, bundle = root_path(plan["home"]), root_path(plan["bundle"])
    lock = resolve_inside(home, ".plur1bus-install-lock")
    lock.mkdir()  # Refuse concurrent installation; never steal an existing lock.
    transaction = None
    journal = {"schema": 1, "status": "preparing", "home": str(home), "files": {}, "version": plan["version"], "pipChanged": False}
    try:
        # Recheck under the lock, including every target and configuration digest.
        if plan_install(bundle, home, plan["profiles"], plan["python"], plan["activate"], plan["dependencies"], plan["desktopOnly"]) != plan:
            raise ValueError("installation changed while acquiring lock")
        backups = resolve_inside(home, "plur1bus-install-backups")
        backups.mkdir(exist_ok=True)
        transaction = Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%d-%H%M%S-"), dir=backups))
        def record():
            atomic_write(transaction / "journal.json", json.dumps(journal, indent=2).encode())
        atomic_write(transaction / "plan.json", json.dumps(plan, indent=2).encode())
        selected = targets(home, plan["profiles"], plan["desktopOnly"])
        manifest = verify_bundle(bundle)
        incoming = {}
        for name, target in selected.items():
            prefix = "" if name == "default" else "profiles/" + name + "/"
            receipt_files = {}
            receipt_name = DESKTOP_RECEIPT if plan["desktopOnly"] else RECEIPT
            receipt = target / receipt_name
            previous = json.loads(receipt.read_text(encoding="utf-8")) if receipt.exists() else {}
            for relative in previous.get("files", {}):
                if "payload/" + relative not in manifest["files"]:
                    incoming[prefix + relative] = None
            for key, sha in manifest["files"].items():
                if key.startswith("payload/"):
                    relative = key[8:]
                    if plan["desktopOnly"] and not relative.startswith("desktop-plugins/plur1bus/"):
                        continue
                    incoming[prefix + relative] = resolve_inside(bundle, key).read_bytes()
                    receipt_files[relative] = sha
            if plan["activate"]:
                config = read_config(plan["python"], target / "config.yaml")
                memory = config.setdefault("memory", {})
                plugins = config.setdefault("plugins", {})
                if not isinstance(memory, dict) or not isinstance(plugins, dict):
                    raise ValueError("invalid memory/plugins configuration")
                enabled, disabled = plugins.get("enabled", []), plugins.get("disabled", [])
                if not isinstance(enabled, list) or not isinstance(disabled, list) or not all(isinstance(v, str) for v in enabled + disabled):
                    raise ValueError("invalid plugin allow/deny lists")
                memory["provider"] = "plur1bus"
                plugins["enabled"] = sorted(set(enabled) | {"plur1bus", "plur1bus-controls"})
                plugins["disabled"] = [v for v in disabled if v not in {"plur1bus", "plur1bus-controls"}]
                incoming[prefix + "config.yaml"] = config_bytes(plan["python"], config)
            incoming[prefix + receipt_name] = json.dumps({"schema": 1, "version": plan["version"], "files": receipt_files}, indent=2).encode()
        for relative, data in incoming.items():
            destination = resolve_inside(home, relative)
            old = destination.read_bytes() if destination.exists() else None
            if old is not None:
                atomic_write(resolve_inside(transaction, "before/" + relative), old)
            journal["files"][relative] = {"before": digest(old) if old is not None else None, "after": digest(data) if data is not None else None}
        record()
        # Pip changes are intentionally separate from the file transaction and
        # recorded honestly; restoring files cannot undo an environment resolver.
        if not plan["desktopOnly"]:
            before = subprocess.run([plan["python"], "-I", "-m", "pip", "freeze"], capture_output=True, check=True)
            atomic_write(transaction / "pip-before.txt", before.stdout)
            before_check = subprocess.run([plan["python"], "-I", "-m", "pip", "check"], capture_output=True, text=True)
            atomic_write(transaction / "pip-check-before.txt", before_check.stdout.encode())
            journal.update(status="installing-python", pipChanged=True)
            record()
            with (transaction / "pip.log").open("w", encoding="utf-8") as log:
                command = [plan["python"], "-I", "-m", "pip", "install", "--disable-pip-version-check"]
                if not plan["dependencies"]:
                    command += ["--no-deps", "--force-reinstall"]
                command += [str(resolve_inside(bundle, wheel)) for wheel in plan["nativeWheels"]]
                command += [str(resolve_inside(bundle, wheel)) + ("[local-onnx]" if plan["dependencies"] and Path(wheel).name.startswith("plur1bus_hermes-") else "") for wheel in plan["wheels"]]
                subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
                if plan["dependencies"]:
                    # Resolve dependencies normally, but do not let pip's same-
                    # version shortcut retain stale wheel code from an old build.
                    subprocess.run([plan["python"], "-I", "-m", "pip", "install", "--no-deps", "--force-reinstall",
                                    *[str(resolve_inside(bundle, wheel)) for wheel in plan["nativeWheels"] + plan["wheels"]]],
                                   stdout=log, stderr=subprocess.STDOUT, check=True)
            after_check = subprocess.run([plan["python"], "-I", "-m", "pip", "check"], capture_output=True, text=True)
            atomic_write(transaction / "pip-check-after.txt", after_check.stdout.encode())
            if after_check.returncode and (not after_check.stdout.strip() or set(after_check.stdout.splitlines()) - set(before_check.stdout.splitlines())):
                raise ValueError("new dependency conflicts; plugin files not activated, inspect pip-check-after.txt")
            expected = manifest["pythonVersion"]
            run_python(plan["python"], "import plur1bus_hermes,plur1bus_controls,sys; from pathlib import Path; "
                       "assert plur1bus_hermes.__version__ == plur1bus_controls.__version__ == " + repr(expected) + "; "
                       "assert all(Path(module.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()) "
                       "for module in (plur1bus_hermes, plur1bus_controls)), 'wheel import escaped target venv'")
        journal["status"] = "writing-files"
        record()
        for relative, data in incoming.items():
            destination = resolve_inside(home, relative)
            if data is None:
                if destination.exists():
                    retired = resolve_inside(transaction, "retired/" + relative)
                    retired.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(destination, retired)
            else:
                atomic_write(destination, data)
        for relative, state in journal["files"].items():
            destination = resolve_inside(home, relative)
            if (digest(destination.read_bytes()) if destination.exists() else None) != state["after"]:
                raise ValueError("installed-file verification failed")
        journal["status"] = "installed-restart-required"
        record()
        print("Installed; restart affected Hermes runtimes. Receipt/backup: " + str(transaction))
        return transaction
    except BaseException:
        if transaction is not None:
            journal["status"] = "failed-review-required"
            atomic_write(transaction / "journal.json", json.dumps(journal, indent=2).encode())
            print("Installation stopped. Inspect backup/journal; Python dependency changes may require separate recovery: " + str(transaction), file=sys.stderr)
        raise
    finally:
        lock.rmdir()


def rollback(home, transaction, confirmation=None, stopped=False):
    home = root_path(home)
    backup = resolve_inside(home, "plur1bus-install-backups/" + transaction)
    raw = resolve_inside(backup, "journal.json").read_bytes()
    journal = json.loads(raw)
    if journal.get("home") != str(home):
        raise ValueError("backup belongs to another installation")
    current = {}
    for relative, item in journal["files"].items():
        destination = resolve_inside(home, relative)
        # Restrict even a manipulated local journal to our explicit file domains.
        stripped = re.sub(r"^profiles/[A-Za-z0-9_-]{1,64}/", "", relative)
        if stripped not in {"config.yaml", RECEIPT, DESKTOP_RECEIPT} and not managed(stripped):
            raise ValueError("invalid rollback target")
        sha = digest(destination.read_bytes()) if destination.exists() else None
        if sha not in {item["before"], item["after"]}:
            raise ValueError("file changed since installation; manual merge required: " + relative)
        if item["before"] is not None and digest(resolve_inside(backup, "before/" + relative).read_bytes()) != item["before"]:
            raise ValueError("backup checksum mismatch")
        current[relative] = sha
    token = digest(raw + json.dumps(current, sort_keys=True).encode())
    if confirmation is None:
        return {"confirmation": token, "files": len(current), "pipRollback": False}
    if not stopped or confirmation != token:
        raise ValueError("stop runtimes and confirm the exact rollback plan")
    lock = resolve_inside(home, ".plur1bus-install-lock")
    lock.mkdir()
    try:
        if rollback(home, transaction)["confirmation"] != token:
            raise ValueError("stale rollback")
        for relative, item in journal["files"].items():
            destination = resolve_inside(home, relative)
            if item["before"] is not None:
                atomic_write(destination, resolve_inside(backup, "before/" + relative).read_bytes())
            elif destination.exists():
                # Recoverable removal, never recursively delete an installed tree.
                removed = resolve_inside(backup, "removed/" + relative)
                removed.parent.mkdir(parents=True, exist_ok=True)
                os.replace(destination, removed)
        journal["status"] = "files-restored-python-unchanged"
        atomic_write(backup / "journal.json", json.dumps(journal, indent=2).encode())
    finally:
        lock.rmdir()
    return {"restored": True, "pipRollback": False}


def retrieval_command(args):
    """Run the installed adapter's migration API in its own verified interpreter."""
    if args.desktop_only or args.rollback or args.activate or args.no_deps:
        raise ValueError("retrieval changes are a separate backend operation; omit package/rollback flags")
    home = root_path(args.home)
    if home.parent.name == "profiles":
        raise ValueError("use the root Hermes home and select --profile separately")
    selected = targets(home, args.profile)
    if len(selected) != 1 or args.profile == ["all"]:
        raise ValueError("review and migrate one explicitly selected profile at a time")
    python = interpreter(home, args.python)
    manifest = verify_bundle(root_path(args.bundle))
    info = json.loads(run_python(python, "import json,sys; print(json.dumps({'venv':sys.prefix!=sys.base_prefix,'platform':sys.platform}))"))
    if not info["venv"] or info["platform"] != sys.platform:
        raise ValueError("same-platform Hermes virtual environment required")
    request = {"home": str(home), "profile": next(iter(selected)), "kind": args.retrieval_kind,
               "target": json.loads(Path(args.retrieval_target).read_text(encoding="utf-8")),
               "action": args.retrieval_action, "confirmation": args.confirm, "stopped": args.runtimes_stopped}
    if request["action"] in {"prepare", "stage", "activate"} and not args.apply:
        raise ValueError("retrieval stage/activation requires --apply and its own confirmation")
    if request["action"] in {"plan", "validate"} and args.apply:
        raise ValueError("retrieval plan/validation is read-only; omit --apply")
    code = ("import json,sys,plur1bus_hermes; from pathlib import Path; "
            "from plur1bus_hermes.setup_retrieval import execute; "
            "assert plur1bus_hermes.__version__ == " + repr(manifest["pythonVersion"]) + "; "
            "request=json.load(sys.stdin); request['home']=Path(request['home']); "
            "print(json.dumps(execute(**request),indent=2))")
    return json.loads(run_python(python, code, json.dumps(request)))


def main():
    if sys.platform == "win32" and getattr(sys, "frozen", False):
        # The one-file loader's DLL directory must not leak into external Hermes
        # Python/pip subprocesses (PyInstaller common-issues guidance).
        import ctypes
        if not ctypes.windll.kernel32.SetDllDirectoryW(None):
            raise ctypes.WinError()
    parser = argparse.ArgumentParser(description=__doc__)
    default_bundle = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    parser.add_argument("--bundle", default=str(default_bundle))
    parser.add_argument("--home")
    parser.add_argument("--interactive", action="store_true", help="guided console installer; requires a TTY")
    parser.add_argument("--python")
    parser.add_argument("--profile", action="append", help="existing name, default, or all")
    parser.add_argument("--activate", action="store_true")
    parser.add_argument("--desktop-only", action="store_true", help="UI for a separate WSL/remote backend; no Python or config changes")
    parser.add_argument("--no-deps", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    parser.add_argument("--runtimes-stopped", action="store_true")
    parser.add_argument("--rollback", help="transaction directory name from the backup receipt")
    parser.add_argument("--retrieval-target", help="explicit embedding/reranker JSON; separate from package installation")
    parser.add_argument("--retrieval-kind", choices=("embedding", "reranker"), default="embedding")
    parser.add_argument("--retrieval-action", choices=("plan", "prepare", "stage", "validate", "activate"), default="plan")
    args = parser.parse_args()
    interactive = (args.interactive or len(sys.argv) == 1) and sys.stdin.isatty()
    try:
        if interactive:
            print("PLUR1BUS for Hermes — package installation and model/memory changes require separate review. Stop affected runtimes before writes.")
            suggested_home = os.environ.get("HERMES_HOME") or str(Path(os.environ["LOCALAPPDATA"]) / "hermes" if sys.platform == "win32" and "LOCALAPPDATA" in os.environ else Path.home() / ".hermes")
            args.home = input("Hermes root home [" + suggested_home + "]: ").strip() or suggested_home
            args.profile = [input("Existing profile name [default], or all: ").strip() or "default"]
            args.desktop_only = input("Desktop UI only, backend in WSL/remote? [y/N]: ").strip().lower() == "y"
            if not args.desktop_only:
                args.python = input("Hermes venv Python executable [automatic]: ").strip() or None
                if input("Operation: package install or model/memory change? [install/retrieval]: ").strip().lower() == "retrieval":
                    args.retrieval_target = input("Path to explicit target-model JSON: ").strip()
                    if not args.retrieval_target:
                        raise ValueError("an explicit target-model JSON is required")
                    args.retrieval_kind = input("Model kind [embedding/reranker]: ").strip() or "embedding"
                    args.retrieval_action = "plan"
                else:
                    args.activate = input("Activate PLUR1BUS for these profiles? [y/N]: ").strip().lower() == "y"
        if not args.home:
            raise ValueError("--home is required in noninteractive use; no writes performed")
        if args.retrieval_target:
            result = retrieval_command(args)
            print(json.dumps(result, indent=2))
            if interactive:
                action = input("Next action [plan/prepare/stage/validate/activate; default plan]: ").strip() or "plan"
                if action not in {"plan", "prepare", "stage", "validate", "activate"}:
                    raise ValueError("unknown retrieval action")
                if action == "plan":
                    return 0
                args.retrieval_action = action
                if action in {"prepare", "stage", "activate"}:
                    if input("After reviewing provider data transfer and stopping runtimes, type CHANGE: ") != "CHANGE":
                        return 0
                    args.apply, args.runtimes_stopped, args.confirm = True, True, result["confirmation"]
                print(json.dumps(retrieval_command(args), indent=2))
            return 0
        if args.rollback:
            result = rollback(args.home, args.rollback, args.confirm if args.apply else None, args.runtimes_stopped)
        else:
            result = plan_install(args.bundle, args.home, args.profile, args.python, args.activate, not args.no_deps, args.desktop_only)
            print(json.dumps({k: v for k, v in result.items() if k != "destinations"}, indent=2))
            if interactive:
                if input("After reviewing the plan and stopping runtimes, type INSTALL: ") != "INSTALL":
                    return 0
                args.apply, args.runtimes_stopped, args.confirm = True, True, result["confirmation"]
            if args.apply:
                apply_install(result, args.confirm, args.runtimes_stopped)
                return 0
        if args.rollback:
            print(json.dumps(result, indent=2))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print("Refused/failed: " + str(error), file=sys.stderr)
        if interactive:
            input("Press Enter to close.")
        return 4


if __name__ == "__main__":
    raise SystemExit(main())

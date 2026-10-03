#!/usr/bin/env python3
"""Native Windows ARM64 acceptance for the official Hermes PM install path.

All mutable state is confined to an explicitly-created disposable QA root. The
source checkout must be at ``<qa-root>/home/hermes-agent`` and the Hermes home
is ``<qa-root>/home``. This runs Hermes' own PM bootstrap, then the real
PLUR1BUS installer plan/apply and native storage/runtime probes.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile


QA_PREFIX = "plur1bus-hermes-pm-qa-"
EXPECTED_PM_WHEELS = {
    "payload/plugins/plur1bus/vendor/windows-arm64/lancedb-0.34.0-cp39-abi3-win_arm64.whl",
    "payload/plugins/plur1bus/vendor/windows-arm64/pyarrow-25.0.1-cp314-cp314-win_arm64.whl",
}


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def validate_qa_layout(qa_root: Path, source: Path, bundle: Path) -> tuple[Path, Path, Path]:
    """Validate that every writable target belongs to the fresh temp QA root."""
    if not qa_root.is_absolute() or qa_root.is_symlink() or not qa_root.is_dir():
        raise ValueError("--qa-root must be an existing, real temporary directory")
    root = qa_root.resolve(strict=True)
    if not root.name.startswith(QA_PREFIX):
        raise ValueError(f"--qa-root must have the unique {QA_PREFIX}<id> temporary name")
    temp_root = Path(tempfile.gettempdir()).resolve()
    if not _inside(root, temp_root) or root == temp_root:
        raise ValueError("--qa-root must be a unique directory beneath the system temp directory")
    if root == Path.home().resolve() or _inside(root, Path.home().resolve()):
        raise ValueError("--qa-root cannot be inside the current user home")

    expected_source = root / "home" / "hermes-agent"
    if source.is_symlink() or not source.is_dir() or source.resolve(strict=True) != expected_source.resolve():
        raise ValueError("--hermes-source must be the fresh checkout at <qa-root>/home/hermes-agent")
    home = root / "home"
    if home.is_symlink() or not home.is_dir() or not _inside(home.resolve(), root):
        raise ValueError("Hermes QA home must be a real directory inside --qa-root")
    if (home / "config.yaml").exists() or (home / "installs").exists() or (home / "plugins").exists():
        raise ValueError("QA Hermes home is not fresh; refusing to reuse existing config, PM state, or plugins")
    if {item.name for item in home.iterdir()} != {"hermes-agent"}:
        raise ValueError("QA Hermes home must contain only the fresh source checkout")
    source_root = source.resolve(strict=True)
    git_metadata = source_root / ".git"
    if git_metadata.is_symlink() or not git_metadata.exists():
        raise ValueError("Hermes source must be a real pinned Git checkout")

    if bundle.is_symlink() or not bundle.is_dir():
        raise ValueError("--bundle must be an expanded directory")
    bundle_root = bundle.resolve(strict=True)
    if bundle_root == root or _inside(bundle_root, root):
        raise ValueError("bundle must be separate from the disposable QA root")
    return root, source_root, home.resolve()


def load_installer(bundle: Path):
    """Load the verified bundle installer without modifying its files."""
    path = bundle / "installer.py"
    spec = importlib.util.spec_from_file_location("plur1bus_qa_installer", path)
    if spec is None or spec.loader is None:
        raise ValueError("expanded bundle has no loadable installer.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def isolated_environment(home: Path, qa_root: Path) -> dict[str, str]:
    """Pass only OS essentials; keep credentials and production app overrides out."""
    allowed = {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
        "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS",
    }
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    environment["HERMES_HOME"] = str(home)
    environment["UV_CACHE_DIR"] = str(qa_root / "uv-cache")
    environment["PYTHONNOUSERSITE"] = "1"
    environment.pop("PYTHONPATH", None)
    environment.pop("PYTHONHOME", None)
    return environment


def run_checked(command: list[str], *, cwd: Path, env: dict[str, str], label: str,
                 input_text: str | None = None, timeout: int = 3600) -> subprocess.CompletedProcess:
    """Run a QA subprocess without copying arbitrary output or secrets to CI logs."""
    try:
        result = subprocess.run(command, cwd=cwd, env=env, input=input_text,
                                capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"{label} timed out after {timeout} seconds") from error
    if result.returncode:
        raise RuntimeError(f"{label} failed with exit code {result.returncode}; raw process output suppressed")
    return result


def module_smoke_code(data_root: Path) -> str:
    """Return an isolated import + two-agent capture/recall/scope smoke."""
    return r'''
import importlib, importlib.metadata, json, sys
from pathlib import Path
import plur1bus_hermes, plur1bus_controls
from plur1bus_hermes.runtime import Plur1busRuntime
assert plur1bus_hermes.__version__ == plur1bus_controls.__version__ == sys.argv[1]
for name in ("onnxruntime", "tokenizers", "lancedb", "pyarrow"):
    importlib.import_module(name)
versions = {name: importlib.metadata.version(name) for name in
            ("onnxruntime", "tokenizers", "lancedb", "pyarrow")}
assert versions["lancedb"] == "0.34.0", versions
assert versions["pyarrow"] == "25.0.1", versions
root = Path(sys.argv[2])
def runtime(agent):
    value = Plur1busRuntime(root, {"embedding": {"dimensions": 2}}, agent)
    value._embedding.embed = lambda text, purpose="passage": [0.1, 0.2]
    value._reranker.rerank = lambda query, rows: rows
    value._domain.on_memory = lambda *args, **kwargs: None
    return value
first, second = runtime("qa-agent-one"), runtime("qa-agent-two")
try:
    first._remember("PM native storage acceptance marker", "package-qa", "user")
    assert "PM native storage acceptance marker" in first.recall("native storage acceptance")
    assert "PM native storage acceptance marker" not in second.recall("native storage acceptance")
finally:
    first.shutdown()
    second.shutdown()
print(json.dumps({"pluginVersion": sys.argv[1], "dependencies": versions,
                  "agentScopeIsolation": True, "captureRecall": True}))
'''


def verify(hermes_source: Path, bundle: Path, qa_root: Path) -> dict:
    """Run official Hermes PM bootstrap and native PLUR1BUS package acceptance."""
    root, source, home = validate_qa_layout(qa_root, hermes_source, bundle)
    if sys.platform != "win32" or platform.machine().upper() not in {"ARM64", "AARCH64"}:
        raise RuntimeError("This acceptance must run on native Windows ARM64")
    if sys.version_info[:2] != (3, 14) or sys.implementation.name != "cpython":
        raise RuntimeError("The acceptance launcher must be standard CPython 3.14")
    if sysconfig_free_threaded():
        raise RuntimeError("Free-threaded Python is not the supported Hermes ARM ABI")

    bundle = bundle.resolve(strict=True)
    installer = load_installer(bundle)
    manifest = installer.verify_bundle(bundle)
    declared = set(manifest.get("pmNativeDependencies", {}).get("win32/ARM64/cp314", []))
    if declared != EXPECTED_PM_WHEELS:
        raise ValueError("bundle does not contain the complete pinned CPython 3.14 ARM64 native pair")
    for relative in declared:
        path = installer.resolve_inside(bundle, relative)
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError("bundled native wheel is missing or redirected")

    env = isolated_environment(home, root)
    checkout = run_checked(["git", "-C", str(source), "rev-parse", "--verify", "HEAD"],
                           cwd=source, env=env, label="Hermes source revision check")
    revision = checkout.stdout.strip()
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", revision):
        raise ValueError("Hermes source checkout did not return a full commit id")
    clean = run_checked(["git", "-C", str(source), "status", "--porcelain"], cwd=source,
                        env=env, label="Hermes source cleanliness check")
    if clean.stdout.strip():
        raise ValueError("Hermes source checkout must be clean and pinned before QA")
    (home / "config.yaml").write_text('memory:\n  provider: builtin\n', encoding="utf-8")
    # This is Hermes' own public bootstrap/launcher path. Its HERMES_HOME is
    # bound to the isolated QA home; it cannot see the runner's live profile.
    run_checked([sys.executable, "-m", "pm.cli", "install"], cwd=source, env=env,
                label="official Hermes PM bootstrap and initial install")

    plan_result = run_checked([sys.executable, str(bundle / "installer.py"), "--bundle", str(bundle),
                               "--home", str(home), "--profile", "default", "--activate"],
                              cwd=root, env=env, label="PLUR1BUS installer plan")
    plan = json.loads(plan_result.stdout)
    if not plan.get("pmManaged") or plan.get("profiles") != ["default"] or not plan.get("activate"):
        raise ValueError("installer did not select the fresh default profile through Hermes PM")
    if set(plan.get("pmNativeWheels", [])) != EXPECTED_PM_WHEELS:
        raise ValueError("installer plan did not select both bundled CPython 3.14 native wheels")
    confirmation = plan.get("confirmation")
    if not isinstance(confirmation, str) or not re.fullmatch(r"[a-f0-9]{64}", confirmation):
        raise ValueError("installer plan did not produce a valid confirmation")
    run_checked([sys.executable, str(bundle / "installer.py"), "--bundle", str(bundle),
                 "--home", str(home), "--profile", "default", "--activate", "--apply",
                 "--confirm", confirmation, "--runtimes-stopped"], cwd=root, env=env,
                label="confirmed PLUR1BUS install and Hermes PM admission")

    project = source.resolve()
    key = hashlib.sha256(str(project).encode("utf-8")).hexdigest()[:16]
    facts_path = home / "installs" / key / "facts.json"
    facts = json.loads(facts_path.read_text(encoding="utf-8"))
    selected_value = facts["packages"]["venv"]["environment"]
    selected = Path(selected_value).resolve(strict=True)
    generations = (home / "installs" / key / "environments").resolve()
    if not _inside(selected, generations) or not (selected / "pyvenv.cfg").is_file():
        raise ValueError("Hermes PM facts do not select an environment in this QA install")
    python = selected / "Scripts" / "python.exe"
    if not python.is_file():
        raise ValueError("Hermes PM selected environment has no Windows Python executable")

    info = json.loads(run_checked([str(python), "-I", "-c",
        "import json,platform,sys,sysconfig; print(json.dumps({'version':list(sys.version_info[:3]),'machine':platform.machine(),'implementation':sys.implementation.name,'freeThreaded':bool(sysconfig.get_config_var('Py_GIL_DISABLED'))}))"],
        cwd=root, env=env, label="selected Hermes PM interpreter probe").stdout)
    if info["version"][:2] != [3, 14] or info["machine"].upper() not in {"ARM64", "AARCH64"} or info["implementation"] != "cpython" or info["freeThreaded"]:
        raise ValueError("Hermes PM did not select the required standard-ABI CPython 3.14 ARM64 generation")

    installer.verify_pm_plugin_imports(python, home, selected, manifest, manifest["pythonVersion"])
    has_pip = json.loads(run_checked([str(python), "-I", "-c",
        "import importlib.util,json; print(json.dumps(importlib.util.find_spec('pip') is not None))"],
        cwd=root, env=env, label="selected environment pip availability probe").stdout)
    if has_pip:
        run_checked([str(python), "-I", "-m", "pip", "check"], cwd=root, env=env,
                    label="selected Hermes PM environment pip check", timeout=300)
        check_method = "pip check"
    else:
        # Ask the official PM tool resolver for its pinned uv, then check the
        # exact generation chosen by facts.json. Do not treat a failed check as
        # equivalent to PM's separate lock/store doctor.
        uv_probe = r'''
import json,sys
sys.path.insert(0, sys.argv[1])
from pm._uv import _toolchain
resolved = _toolchain(realize=False)
if resolved is None:
    raise SystemExit("Hermes PM's pinned uv is unavailable")
print(json.dumps(str(resolved[0])))
'''
        uv = json.loads(run_checked([sys.executable, "-I", "-c", uv_probe, str(source)],
            cwd=source, env=env, label="official Hermes PM pinned uv resolver").stdout)
        run_checked([uv, "pip", "check", "--python", str(python)], cwd=root, env=env,
                    label="selected Hermes PM environment uv pip check", timeout=300)
        check_method = "Hermes PM pinned uv pip check"

    storage = root / "native-storage-verifier.py"
    storage_source = Path(__file__).with_name("verify-windows-arm64-storage.py")
    if not storage_source.is_file():
        raise ValueError("native Windows ARM64 storage verifier is missing")
    storage.write_bytes(storage_source.read_bytes())
    run_checked([str(python), "-I", str(storage)], cwd=root, env=env,
                label="native LanceDB/PyArrow ARM64 storage verifier", timeout=900)

    smoke = run_checked([str(python), "-I", "-c", module_smoke_code(root / "runtime-data"),
                         manifest["pythonVersion"], str(root / "runtime-data")], cwd=root, env=env,
                        label="installed plugin import, real capture/recall, and agent-scope smoke", timeout=900)
    result = json.loads(smoke.stdout.strip().splitlines()[-1])
    return {"officialPmBootstrap": True, "hermesSourceRevision": revision,
            "pmFacts": str(facts_path), "selectedPython": info,
            "selectedEnvironment": str(selected), "nativePair": sorted(declared),
            "dependencyCheck": check_method, "runtimeSmoke": result}


def sysconfig_free_threaded() -> bool:
    import sysconfig
    return bool(sysconfig.get_config_var("Py_GIL_DISABLED"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", required=True, type=Path)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--qa-root", required=True, type=Path,
                        help=f"new directory beneath system temp named {QA_PREFIX}<id>")
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.hermes_source, args.bundle, args.qa_root), indent=2))
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"Hermes PM native acceptance failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

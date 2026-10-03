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
import tomllib

# When imported by the distribution unit tests this file is not the process
# entrypoint, so retain the sibling-module lookup used by the frozen/script form.
_DISTRIBUTION_DIR = str(Path(__file__).resolve().parent)
if _DISTRIBUTION_DIR not in sys.path:
    sys.path.insert(0, _DISTRIBUTION_DIR)
from native_launcher import apply as apply_native_launcher
from native_launcher import plan as plan_native_launcher

MANIFEST = "distribution.json"
RECEIPT = "plur1bus-install.json"
DESKTOP_RECEIPT = "plur1bus-desktop-install.json"
SHARED_DESKTOP_RECEIPT = "plur1bus-shared-desktop-install.json"
CPU_TORCH_INDEX = "https://download.pytorch.org/whl/cpu"


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


def run_python(python, code, data=None, timeout=None):
    try:
        arguments = [str(python), "-I", "-X", "utf8", "-c", code]
        options = {"input": data, "capture_output": True, "text": True, "encoding": "utf-8"}
        if timeout is not None:
            options["timeout"] = timeout
        result = subprocess.run(arguments, **options)
    except subprocess.TimeoutExpired as error:
        raise ValueError("Hermes Python preflight timed out") from error
    if result.returncode:
        raise ValueError("Hermes Python preflight failed; inspect its installation (no raw config is logged)")
    return result.stdout


def module_path_allowed(module_path, prefix, managed_plugin_root):
    """Allow venv imports plus Hermes' in-home plugin bridge, never outside it."""
    path = Path(module_path).resolve()
    roots = (Path(prefix).resolve(), Path(managed_plugin_root).resolve())
    return any(path == root or root in path.parents for root in roots)


def read_config(python, path):
    return json.loads(run_python(python,
        "import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()) or {}))", path.read_text(encoding="utf-8")))


def config_bytes(python, config):
    return run_python(python,
        "import json,sys,yaml; print(yaml.safe_dump(json.load(sys.stdin),allow_unicode=True,sort_keys=False),end='')",
        json.dumps(config)).encode("utf-8")


def environment_state(python):
    """Fingerprint a venv without pip, suppressing raw direct-URL credentials."""
    code = """
# PLUR1BUS_ENVIRONMENT_STATE: read-only, standard-library-only preflight.
import hashlib, importlib.metadata, importlib.util, json
packages = sorted((dist.metadata.get('Name', ''), dist.version,
                   dist.read_text('direct_url.json') or '')
                  for dist in importlib.metadata.distributions())
print(json.dumps({'fingerprint': hashlib.sha256(json.dumps(packages).encode()).hexdigest(),
                  'pipAvailable': importlib.util.find_spec('pip') is not None,
                  'ensurepipAvailable': importlib.util.find_spec('ensurepip') is not None}))
"""
    return json.loads(run_python(python, code))


def run_pm_selection(home, profile_home, enabled, disabled, expected_config):
    """Ask Hermes PM to publish one profile selection and its dependency generation."""
    project = home / "hermes-agent"
    python = interpreter(home)
    selection = {"home": str(profile_home.resolve()), "enabled": sorted(enabled),
                 "disabled": sorted(disabled), "extra_dirs": [], "expected_config": expected_config}
    code = (
        "import json,sys; from pathlib import Path; "
        "project=Path(sys.argv[1]).resolve(); sys.path.insert(0,str(project)); "
        "from pm.client import sync_venv; from pm.plugin_inputs import Selection; "
        "sync_venv(explicit=True, plugins=Selection(json.load(sys.stdin)), project_root=project)"
    )
    environment = dict(os.environ)
    environment["HERMES_HOME"] = str(home)
    try:
        result = subprocess.run([str(python), "-I", "-X", "utf8", "-c", code, str(project)],
                                input=json.dumps(selection), capture_output=True, text=True,
                                encoding="utf-8", env=environment, timeout=1800)
    except subprocess.TimeoutExpired as error:
        raise ValueError("Hermes PM admission timed out; inspect Hermes PM state before retrying") from error
    if result.returncode:
        raise ValueError("Hermes PM refused the plugin selection; config and dependency selection were not admitted")


def _is_within(path, roots):
    return any(path == root or root in path.parents for root in roots)


def pm_plugin_source_root(selected_environment):
    """Return a non-redirected PM workspace plugin source root if present."""
    generation = Path(selected_environment).resolve().parent
    candidate = resolve_inside(generation, "workspace/plugin-sources")
    if not candidate.exists():
        return None
    if not candidate.is_dir():
        raise ValueError("Hermes PM plugin source workspace is not a directory")
    return candidate.resolve()


def validate_pm_import_locations(home, selected_environment, module_paths, expected_hashes):
    """Require imported packages under trusted roots and matching bundled Python sources."""
    selected = Path(selected_environment).resolve()
    roots = [selected, resolve_inside(home, "plugins/plur1bus").resolve(),
             resolve_inside(home, "plugins/plur1bus-controls").resolve()]
    workspace_sources = pm_plugin_source_root(selected)
    if workspace_sources is not None:
        roots.append(workspace_sources)
    if not isinstance(module_paths, dict) or set(module_paths) != {"plur1bus_hermes", "plur1bus_controls"}:
        raise ValueError("Hermes PM plugin import verification returned invalid paths")
    for module_name, plugin_name in (("plur1bus_hermes", "plur1bus"),
                                     ("plur1bus_controls", "plur1bus-controls")):
        raw_path = module_paths[module_name]
        if not isinstance(raw_path, str) or not raw_path:
            raise ValueError("Hermes PM plugin import verification returned invalid paths")
        module_path = Path(raw_path)
        try:
            module_path = module_path.resolve(strict=True)
        except OSError as error:
            raise ValueError("Hermes PM plugin import target is missing") from error
        if module_path.suffix != ".py" or not _is_within(module_path, roots):
            raise ValueError("Hermes PM plugin import escaped its trusted runtime roots")
        expected = expected_hashes.get(plugin_name)
        if not isinstance(expected, dict) or "__init__.py" not in expected:
            raise ValueError("verified bundle is missing canonical plugin Python sources")
        source_root = module_path.parent
        for relative, expected_hash in expected.items():
            try:
                source = resolve_inside(source_root, relative).resolve(strict=True)
            except (OSError, ValueError) as error:
                raise ValueError("Hermes PM imported plugin source is incomplete") from error
            if not source.is_file() or digest(source.read_bytes()) != expected_hash:
                raise ValueError("Hermes PM imported plugin source differs from the verified bundle")


def verify_pm_plugin_imports(python, home, selected_environment, manifest, expected_version):
    """Probe selected PM imports, then verify their trusted paths and bundled code hashes."""
    state = json.loads(run_python(python, """
import json
import plur1bus_hermes, plur1bus_controls
print(json.dumps({
    'version': [plur1bus_hermes.__version__, plur1bus_controls.__version__],
    'paths': {'plur1bus_hermes': plur1bus_hermes.__file__,
              'plur1bus_controls': plur1bus_controls.__file__},
}))
"""))
    if (not isinstance(state, dict) or state.get("version") != [expected_version, expected_version]
            or not isinstance(state.get("paths"), dict)):
        raise ValueError("Hermes PM plugin version verification failed")
    expected_hashes = {}
    for plugin_name in ("plur1bus", "plur1bus-controls"):
        prefix = f"payload/plugins/{plugin_name}/"
        expected_hashes[plugin_name] = {
            name[len(prefix):]: sha for name, sha in manifest["files"].items()
            if name.startswith(prefix) and name.endswith(".py")
        }
    validate_pm_import_locations(home, selected_environment, state["paths"], expected_hashes)


def _desired_plugin_selection(config):
    """Return current allow/deny lists with the two PLUR1BUS plugins enabled."""
    plugins = config.get("plugins", {})
    if not isinstance(plugins, dict):
        raise ValueError("invalid Hermes plugin configuration")
    enabled, disabled = plugins.get("enabled", []), plugins.get("disabled", [])
    if (not isinstance(enabled, list) or not isinstance(disabled, list)
            or not all(isinstance(value, str) for value in enabled + disabled)):
        raise ValueError("invalid Hermes plugin allow/deny lists")
    selected = {"plur1bus", "plur1bus-controls"}
    return sorted(set(enabled) | selected), sorted(set(disabled) - selected)


def pm_member_project_bytes(data, plugin_name, profile_home):
    """Give same-code profile members distinct uv names while retaining import aliases."""
    try:
        document = tomllib.loads(data.decode("utf-8"))
        original = document["project"]["name"]
    except (UnicodeError, tomllib.TOMLDecodeError, KeyError, TypeError) as error:
        raise ValueError("invalid bundled Hermes PM plugin project metadata") from error
    if not isinstance(original, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", original):
        raise ValueError("invalid bundled Hermes PM project name")
    identity = hashlib.sha256(str(profile_home.resolve()).encode("utf-8")).hexdigest()[:16]
    normalized = re.sub(r"[^A-Za-z0-9-]+", "-", plugin_name).strip("-").lower()
    unique_name = f"{normalized}-profile-{identity}"
    text = data.decode("utf-8")
    heading = re.search(r"(?m)^\[project\]\s*$", text)
    if heading is None:
        raise ValueError("Hermes PM plugin pyproject has no [project] table")
    next_table = re.search(r"(?m)^\[", text[heading.end():])
    stop = heading.end() + next_table.start() if next_table else len(text)
    section = text[heading.end():stop]
    updated, count = re.subn(r'(?m)^name\s*=\s*["\'][^"\']+["\']\s*$',
                             'name = "' + unique_name + '"', section)
    if count != 1:
        raise ValueError("Hermes PM plugin project name could not be uniquely rewritten")
    return (text[:heading.end()] + updated + text[stop:]).encode("utf-8")


def check_unselected_pm_profiles(home, selected_names, python, bundle, manifest, expected_plugin_version):
    """Refuse mixed or duplicate active members in Hermes PM's all-profile workspace."""
    for name, target in targets(home, ["all"]).items():
        if name in selected_names:
            continue
        config_path = resolve_inside(target, "config.yaml")
        config = read_config(python, config_path)
        if not isinstance(config, dict):
            raise ValueError("invalid Hermes profile configuration")
        plugins = config.get("plugins", {})
        if not isinstance(plugins, dict):
            raise ValueError("invalid Hermes plugin configuration")
        enabled, disabled = plugins.get("enabled", []), set(plugins.get("disabled", []))
        if not isinstance(enabled, list) or not all(isinstance(value, str) for value in enabled):
            raise ValueError("invalid Hermes plugin allow/deny lists")
        if "plur1bus" not in enabled or {"plur1bus", "plur1bus-controls"} & disabled:
            continue
        plugin_manifest = resolve_inside(target, "plugins/plur1bus/plugin.yaml")
        if not plugin_manifest.is_file():
            raise ValueError("an unselected active Hermes profile has no verifiable PLUR1BUS version; select all profiles")
        installed = read_config(python, plugin_manifest)
        if not isinstance(installed, dict) or installed.get("version") != expected_plugin_version:
            raise ValueError("an unselected active Hermes profile has different PLUR1BUS code; select all profiles")
        prefixes = ("payload/plugins/plur1bus/", "payload/plugins/plur1bus-controls/")
        for source_name, expected_hash in manifest["files"].items():
            if not source_name.startswith(prefixes):
                continue
            relative = source_name[8:]
            if not relative.endswith(".py") and relative not in {
                "plugins/plur1bus/plugin.yaml", "plugins/plur1bus-controls/plugin.yaml"
            }:
                continue
            current = resolve_inside(target, relative)
            if not current.is_file() or digest(current.read_bytes()) != expected_hash:
                raise ValueError("an unselected active Hermes profile has different PLUR1BUS code; select all profiles")
        for plugin_name in ("plur1bus", "plur1bus-controls"):
            project_file = resolve_inside(target, f"plugins/{plugin_name}/pyproject.toml")
            bundled_project = resolve_inside(bundle, f"payload/plugins/{plugin_name}/pyproject.toml")
            if not project_file.is_file() or not bundled_project.is_file():
                raise ValueError("an unselected active Hermes profile has unverifiable PM project metadata; select all profiles")
            try:
                expected_name = tomllib.loads(pm_member_project_bytes(
                    bundled_project.read_bytes(), plugin_name, target
                ).decode("utf-8"))["project"]["name"]
                actual_name = tomllib.loads(project_file.read_text(encoding="utf-8"))["project"]["name"]
            except (OSError, UnicodeError, tomllib.TOMLDecodeError, KeyError, TypeError) as error:
                raise ValueError("an unselected active Hermes profile has invalid PM project metadata; select all profiles") from error
            if actual_name != expected_name:
                raise ValueError("an unselected active Hermes profile has a non-unique PM project name; select all profiles")


def torch_version(python):
    """Read installed Torch metadata without importing its native extension."""
    value = run_python(python, """
import importlib.metadata, json
try:
    value = importlib.metadata.version('torch')
except importlib.metadata.PackageNotFoundError:
    value = None
print(json.dumps(value))
""")
    version = json.loads(value)
    if version is not None and (not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9.+!_-]{1,128}", version)):
        raise ValueError("invalid installed Torch metadata")
    return version


def cpu_torch_decision(info, installed, dependencies):
    """Bind CPU Torch only for a fresh Linux/Windows-x64 dependency install."""
    platform_name = info["platform"]
    machine = str(info.get("architecture", "")).upper()
    eligible = (platform_name == "linux" and machine in {"AMD64", "X86_64"}) or (
        platform_name == "win32" and machine in {"AMD64", "X86_64"})
    if installed:
        return {"action": "preserve", "version": installed, "index": None}
    if dependencies and eligible:
        return {"action": "install-cpu", "version": None, "index": CPU_TORCH_INDEX}
    return {"action": "resolver-default", "version": None, "index": None}


def pm_native_target_supported(info):
    """Current PM payload metadata does not support bundled Windows ARM wheels."""
    return not (info.get("platform") == "win32"
                and str(info.get("architecture", "")).upper() in {"ARM64", "AARCH64"})


def verify_cpu_torch(python, expected_version, require_cpu=True):
    """Probe Torch's native loader, requiring CPU-only identity when requested."""
    state = json.loads(run_python(python, """
import json
try:
    import torch
    state = {'ok': True, 'version': torch.__version__,
             'cuda': getattr(torch.version, 'cuda', None),
             'hip': getattr(torch.version, 'hip', None)}
except Exception as error:
    # Keep installer diagnostics useful without exposing DLL paths, environment,
    # or arbitrary exception text from the target installation.
    state = {'ok': False, 'errorType': type(error).__name__}
    winerror = getattr(error, 'winerror', None)
    if isinstance(winerror, int) and not isinstance(winerror, bool):
        state['winerror'] = winerror
print(json.dumps(state))
""", timeout=60))
    if not isinstance(state, dict) or not isinstance(state.get("ok"), bool):
        raise ValueError("Torch native runtime probe returned invalid data")
    if not state["ok"]:
        error_type = state.get("errorType")
        if not isinstance(error_type, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", error_type):
            raise ValueError("Torch native runtime probe returned invalid failure data")
        detail = error_type
        winerror = state.get("winerror")
        if winerror is not None:
            if not isinstance(winerror, int) or isinstance(winerror, bool) or not 0 <= winerror <= 0xFFFFFFFF:
                raise ValueError("Torch native runtime probe returned invalid failure data")
            detail += ", WinError " + str(winerror)
        raise ValueError("Torch native runtime could not load (" + detail + "); inspect target native runtime prerequisites; no installer fallback was applied")
    if state.get("version") != expected_version:
        raise ValueError("installed Torch version differs from the confirmed runtime")
    if require_cpu and (state.get("cuda") is not None or state.get("hip") is not None):
        raise ValueError("installed Torch is not the confirmed CPU runtime")
    return state


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
    selected = pm_selected_environment(home)
    if selected is not None:
        candidate = selected / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        executable_dir = candidate.parent
        if redirected(executable_dir) or not executable_dir.is_dir() or not candidate.is_file():
            raise ValueError("Hermes PM selected Python is missing; repair it with Hermes PM")
        # Standard venvs may symlink bin/python to Hermes' managed base runtime.
        # Keep invoking the lexical venv path so CPython discovers this venv's
        # pyvenv.cfg; resolve only for validating the final executable target.
        resolved_candidate = candidate.resolve()
        managed_tools = home / "tools"
        trusted_roots = [selected.resolve()]
        if managed_tools.is_dir() and not redirected(managed_tools):
            trusted_roots.append(managed_tools.resolve())
        if not resolved_candidate.is_file() or not any(
                resolved_candidate == root or root in resolved_candidate.parents for root in trusted_roots):
            raise ValueError("Hermes PM selected Python target is outside its trusted runtime roots")
        if os.name != "nt" and not os.access(resolved_candidate, os.X_OK):
            raise ValueError("Hermes PM selected Python is not executable; repair it with Hermes PM")
        return candidate
    for relative in ("hermes-agent/venv/Scripts/python.exe", "hermes-agent/venv/bin/python",
                     "hermes-agent/.venv/Scripts/python.exe", "hermes-agent/.venv/bin/python"):
        candidate = home / relative
        if candidate.is_file():
            return candidate
    raise ValueError("Hermes Python not found; pass --python pointing to the Hermes virtual environment")


def pm_selected_environment(home):
    """Read Hermes PM's committed generation without booting its mutating launcher."""
    project = home / "hermes-agent"
    if project.is_dir() and not redirected(project):
        # Match pm.environments.install_key/runtime_facts_path. The in-tree venv
        # predates PM and can have the wrong ABI after a managed Python upgrade.
        # Do not run Hermes' launch bootstrap: it may synchronize dependencies.
        project = project.resolve()
        key = hashlib.sha256(str(project).encode("utf-8")).hexdigest()[:16]
        state_root = home / "installs" / key
        facts_path = resolve_inside(home, f"installs/{key}/facts.json")
        if facts_path.exists():
            try:
                facts = json.loads(facts_path.read_text(encoding="utf-8-sig"))
                environment = facts["packages"]["venv"]["environment"]
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise ValueError("Hermes PM dependency selection is invalid; repair it with Hermes PM") from error
            if not isinstance(environment, str) or not Path(environment).is_absolute():
                raise ValueError("Hermes PM dependency selection is invalid; repair it with Hermes PM")
            selected = Path(environment)
            generations = state_root / "environments"
            try:
                relative = selected.relative_to(generations.absolute())
            except ValueError as error:
                raise ValueError("Hermes PM dependency selection is outside its managed environment store") from error
            selected = resolve_inside(generations, relative.as_posix())
            if not selected.resolve().is_relative_to(generations.resolve()):
                raise ValueError("Hermes PM dependency selection is outside its managed environment store")
            selected = selected.resolve()
            if not (selected / "pyvenv.cfg").is_file():
                raise ValueError("Hermes PM selected environment is missing; repair it with Hermes PM")
            return selected
    return None


def managed(relative):
    return isinstance(relative, str) and any(relative.startswith(prefix) for prefix in (
        "plugins/plur1bus/", "plugins/plur1bus-controls/", "desktop-plugins/plur1bus/"))


def activation_status(config):
    """Report provider/plugin consistency without exposing profile secrets."""
    memory, plugins = config.get("memory", {}), config.get("plugins", {})
    if not isinstance(memory, dict) or not isinstance(plugins, dict):
        raise ValueError("invalid memory/plugins configuration")
    enabled, disabled = plugins.get("enabled", []), plugins.get("disabled", [])
    if not isinstance(enabled, list) or not isinstance(disabled, list) or not all(isinstance(v, str) for v in enabled + disabled):
        raise ValueError("invalid plugin allow/deny lists")
    provider = memory.get("provider") == "plur1bus"
    memory_enabled = memory.get("memory_enabled", True) is True
    missing = sorted({"plur1bus", "plur1bus-controls"} - (set(enabled) - set(disabled)))
    return {"providerSelected": provider, "memoryEnabled": memory_enabled, "missingPlugins": missing,
            "active": provider and memory_enabled and not missing,
            "inconsistent": provider and (not memory_enabled or bool(missing))}


def inspect_profiles(home, python=None):
    """Read existing profiles for setup; never create profiles or modify config."""
    home = root_path(home)
    if home.parent.name == "profiles":
        raise ValueError("select the root Hermes home, not a named profile")
    python = interpreter(home, python)
    rows = []
    for name, target in targets(home, ["all"]).items():
        config = read_config(python, resolve_inside(target, "config.yaml"))
        if not isinstance(config, dict):
            raise ValueError("invalid Hermes config mapping")
        rows.append({"name": name, **activation_status(config)})
    return {"home": str(home), "python": str(python), "profiles": rows}


def shared_desktop_receipt(home, manifest):
    """Track app-wide UI separately from backend versions, including legacy installs."""
    receipt = resolve_inside(home, SHARED_DESKTOP_RECEIPT)
    incoming_version = tuple(map(int, re.findall(r"\d+", manifest["version"])))
    if receipt.exists():
        previous = json.loads(receipt.read_text(encoding="utf-8"))
        if (not isinstance(previous, dict) or previous.get("schema") != 1
            or not re.fullmatch(r"\d+\.\d+\.\d+-hermes(?:\.\d+)?", str(previous.get("version", "")))
            or not re.fullmatch(r"[a-f0-9]{64}", str(previous.get("entrySha256", "")))):
            raise ValueError("invalid shared desktop version receipt")
        if tuple(map(int, re.findall(r"\d+", previous["version"]))) > incoming_version:
            raise ValueError("shared desktop downgrade refused")
    else:
        # Before this receipt existed a newer named profile could supply the
        # app-wide frontend while the default backend receipt stayed older.
        roots = [home]
        profiles = resolve_inside(home, "profiles")
        if profiles.exists():
            for profile in profiles.iterdir():
                if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", profile.name) and (profile.is_dir() or redirected(profile)):
                    roots.append(resolve_inside(home, "profiles/" + profile.name))
        for root in roots:
            for name in (RECEIPT, DESKTOP_RECEIPT):
                legacy = resolve_inside(root, name)
                if not legacy.exists():
                    continue
                previous = json.loads(legacy.read_text(encoding="utf-8"))
                if not isinstance(previous, dict) or not isinstance(previous.get("files"), dict):
                    raise ValueError("invalid legacy desktop installation receipt")
                if not {"plugins/plur1bus/desktop/plugin.js", "desktop-plugins/plur1bus/plugin.js"}.intersection(previous["files"]):
                    continue
                version = previous.get("version", "0")
                if not isinstance(version, str):
                    raise ValueError("invalid legacy desktop installation version")
                if tuple(map(int, re.findall(r"\d+", version))) > incoming_version:
                    raise ValueError("shared desktop downgrade refused")
    return json.dumps({"schema": 1, "version": manifest["version"],
                      "entrySha256": manifest["files"]["payload/desktop-plugins/plur1bus/plugin.js"]}, indent=2).encode()


def shared_desktop_updates(bundle, home, selected, manifest, desktop_only=False):
    """Refresh existing app-wide UI without installing an unselected backend."""
    unified = "plugins/plur1bus/desktop/plugin.js"
    materialized = "desktop-plugins/plur1bus/plugin.js"
    # Also record a fresh named-profile install: Hermes can move/materialize
    # that UI into the app root later, outside this installation transaction.
    incoming = {SHARED_DESKTOP_RECEIPT: shared_desktop_receipt(home, manifest)}
    def source_bytes():
        key = "payload/" + materialized
        if key not in manifest["files"]:
            raise ValueError("verified desktop entry is required for shared UI updates")
        return resolve_inside(bundle, key).read_bytes()
    if "default" not in selected:
        directory = home / "desktop-plugins/plur1bus"
        if directory.exists() or redirected(directory):
            directory = resolve_inside(home, "desktop-plugins/plur1bus")
            if not directory.is_dir():
                raise ValueError("shared desktop destination is not a directory")
            incoming[materialized] = source_bytes()
    if "default" not in selected or desktop_only:
        path = home / unified
        if path.exists() or redirected(path):
            path = resolve_inside(home, unified)
            if not path.is_file():
                raise ValueError("shared desktop source is not a regular file")
            incoming[unified] = source_bytes()
    # Our distribution owns standalone desktop entries. Archive host-generated
    # materialization markers so reconciliation cannot recursively replace the
    # refreshed directory and discard local sibling files on the next launch.
    marker_homes = dict(selected)
    if materialized in incoming:
        marker_homes["default"] = home
    for name, target in marker_homes.items():
        relative = "desktop-plugins/plur1bus/.hermes-package.json"
        marker = target / relative
        if marker.exists() or redirected(marker):
            marker = resolve_inside(target, relative)
            if not marker.is_file():
                raise ValueError("desktop materialization marker is not a regular file")
            prefix = "" if name == "default" else "profiles/" + name + "/"
            incoming[prefix + relative] = None
    for relative in incoming:
        path = resolve_inside(home, relative)
        if path.exists() and not path.is_file():
            raise ValueError("shared desktop destination is not a regular file")
    hashes = {relative: digest(data) if data is not None else None for relative, data in incoming.items()
              if not relative.startswith("profiles/") and relative != SHARED_DESKTOP_RECEIPT}
    if "default" in selected:
        hashes[materialized] = digest(source_bytes())
        if not desktop_only and "payload/" + unified in manifest["files"]:
            hashes[unified] = manifest["files"]["payload/" + unified]
    if not hashes:
        return incoming
    for receipt_name in (RECEIPT, DESKTOP_RECEIPT):
        if "default" in selected and receipt_name == (DESKTOP_RECEIPT if desktop_only else RECEIPT):
            continue
        receipt = resolve_inside(home, receipt_name)
        if not receipt.exists():
            continue
        previous = json.loads(receipt.read_text(encoding="utf-8"))
        if not isinstance(previous, dict) or not isinstance(previous.get("files"), dict):
            raise ValueError("invalid shared desktop installation receipt")
        if not all(managed(relative) for relative in previous["files"]):
            raise ValueError("invalid shared desktop installation receipt")
        if tuple(map(int, re.findall(r"\d+", previous.get("version", "0")))) > tuple(map(int, re.findall(r"\d+", manifest["version"]))):
            raise ValueError("shared desktop downgrade refused")
        updated = {relative: value for relative, value in hashes.items() if relative in previous["files"]}
        if updated:
            for relative, value in updated.items():
                if value is None:
                    previous["files"].pop(relative, None)
                else:
                    previous["files"][relative] = value
            incoming[receipt_name] = json.dumps(previous, indent=2).encode()
    return incoming


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
    pm_managed = False
    if not desktop_only:
        selected_pm_environment = pm_selected_environment(home)
        pm_managed = selected_pm_environment is not None
        if pm_managed:
            selected_python = interpreter(home)
            if python is not None and Path(python).expanduser().absolute() != selected_python:
                raise ValueError("explicit --python cannot override Hermes PM's selected generation")
            python = selected_python
        else:
            python = interpreter(home, python)
        info = json.loads(run_python(python, "import json,sys,platform,sysconfig; print(json.dumps({'version':list(sys.version_info[:3]),'venv':sys.prefix!=sys.base_prefix,'prefix':sys.prefix,'platform':sys.platform,'architecture':platform.machine(),'implementation':sys.implementation.name,'freeThreaded':bool(sysconfig.get_config_var('Py_GIL_DISABLED'))}))"))
        if info["version"] < [3, 11, 0] or not info["venv"] or info["platform"] != sys.platform:
            raise ValueError("same-platform Python >=3.11 in a Hermes virtual environment required; global or Windows/WSL-crossed pip refused")
        if pm_managed and not pm_native_target_supported(info):
            raise ValueError("Hermes PM admission cannot yet include the bundled Windows ARM native wheels; no files or dependencies were changed")
        if pm_managed and activate and not dependencies:
            raise ValueError("Hermes PM admission resolves the complete plugin dependency graph; --no-deps cannot activate a PM-managed profile")
    selected = targets(home, profiles, desktop_only)
    destinations, configs, receipts = {}, {}, {}
    profile_status, warnings = {}, []
    payload = {key[8:]: key for key in manifest["files"] if key.startswith("payload/")}
    if desktop_only:
        payload = {key: value for key, value in payload.items() if key.startswith("desktop-plugins/plur1bus/")}
    if not payload or not all(managed(name) for name in payload):
        raise ValueError("invalid plugin payload")
    shared_updates = shared_desktop_updates(bundle, home, selected, manifest, desktop_only)
    shared_desktop = {
        relative: {"before": digest(resolve_inside(home, relative).read_bytes()) if resolve_inside(home, relative).exists() else None,
                   "after": digest(data) if data is not None else None}
        for relative, data in shared_updates.items()
    }
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
    if pm_managed and native_wheels:
        raise ValueError("this bundled native wheel has no Hermes PM dependency declaration; no environment was changed")
    for name, target in selected.items():
        config_path = resolve_inside(target, "config.yaml")
        configs[name] = digest(config_path.read_bytes()) if config_path.exists() else None
        if not desktop_only:
            config = read_config(python, config_path)
            if not isinstance(config, dict):
                raise ValueError("invalid Hermes config mapping")
            profile_status[name] = activation_status(config)
            if not activate and profile_status[name]["inconsistent"]:
                warnings.append(f"{name}: PLUR1BUS is selected but memory or required plugins are disabled/missing; memory, dashboard or controls may be unavailable. Re-run with --activate to repair.")
            elif not activate and not profile_status[name]["active"]:
                warnings.append(f"{name}: files will be installed WITHOUT activating PLUR1BUS. Use --activate to enable it.")
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
    if pm_managed:
        bundled_manifest = resolve_inside(bundle, "payload/plugins/plur1bus/plugin.yaml")
        if not bundled_manifest.is_file():
            raise ValueError("Hermes PM installation requires the plugin manifest in the verified payload")
        bundled_plugin = read_config(python, bundled_manifest)
        plugin_version = bundled_plugin.get("version") if isinstance(bundled_plugin, dict) else None
        if not isinstance(plugin_version, str):
            raise ValueError("Hermes PM plugin version is missing from the verified payload")
        check_unselected_pm_profiles(home, set(selected), python, bundle, manifest, plugin_version)
    torch = None if desktop_only else (
        {"action": "pm-managed", "version": torch_version(python), "index": None}
        if pm_managed else cpu_torch_decision(info, torch_version(python), dependencies)
    )
    result = {"schema": 1, "version": manifest["version"], "bundle": str(bundle), "home": str(home),
              "manifest": digest((bundle / MANIFEST).read_bytes()), "python": str(python) if not desktop_only else None, "pythonInfo": info,
              "desktopOnly": desktop_only, "pmManaged": pm_managed,
              "profiles": list(selected), "activate": activate, "dependencies": dependencies,
              "profileStatus": profile_status, "warnings": warnings,
              "sharedDesktop": shared_desktop,
              "configs": configs, "receipts": receipts, "destinations": destinations, "wheels": wheels,
              "nativeWheels": native_wheels, "torch": torch,
              "effects": ("Stage plugin files and use Hermes PM to atomically admit the dependency selection when activated; no direct pip writes to a PM-owned generation."
                         if pm_managed else "Install Python wheels into the selected legacy Hermes venv, back up and update selected plugin/UI files; optional explicit activation. No models, memory migration, host patch, restart or unselected profile configuration/backend writes. File rollback does not roll back pip dependencies.")}
    if not desktop_only:
        environment = environment_state(python)
        if not pm_managed and not environment["pipAvailable"] and not environment["ensurepipAvailable"]:
            raise ValueError("Hermes venv has neither pip nor ensurepip; provision pip with its environment manager first")
        result["environmentFingerprint"] = environment["fingerprint"]
        result["bootstrapPip"] = not pm_managed and not environment["pipAvailable"]
        if result["bootstrapPip"]:
            result["effects"] += " Confirmed apply first bootstraps pip in this venv using Python's bundled ensurepip."
        if torch["action"] == "pm-managed":
            if not activate and dependencies:
                result["warnings"].append("Python dependencies remain deferred until Hermes PM admits the plugins.")
            result["effects"] += " Hermes PM owns the dependency graph and publishes a replacement generation; restart Hermes after admission."
        elif torch["action"] == "install-cpu":
            result["effects"] += " Confirmed apply installs Torch from PyTorch's official CPU index before resolving PLUR1BUS dependencies; the resolver is constrained to that CPU version."
        elif torch["action"] == "preserve":
            result["effects"] += " Existing Torch is preserved and constrained against replacement during dependency resolution."
    else:
        result["effects"] = "Install desktop frontend only. No Python, backend, model, provider configuration or host patch changes."
    if shared_desktop:
        result["effects"] += " The shared Desktop UI version is tracked separately from profile backend versions, including backup and rollback."
        result["effects"] += " Also refresh existing app-wide Desktop entries and existing default unified UI; their receipt hashes, backups and rollback are included under sharedDesktop."
        result["effects"] += " Existing Hermes materialization markers are archived so these standalone installer-owned Desktop entries retain local sibling files on restart."
    # A frozen one-file executable extracts into a different directory per run.
    # Bind to verified content, not that ephemeral extraction path.
    result["confirmation"] = digest(json.dumps({k: v for k, v in result.items() if k != "bundle"}, sort_keys=True).encode())
    return result


def apply_install(plan, confirmation, stopped=False):
    if not stopped:
        raise ValueError("stop affected Hermes runtimes and pass --runtimes-stopped")
    python_arg = None if plan.get("pmManaged") else plan["python"]
    fresh = plan_install(plan["bundle"], plan["home"], plan["profiles"], python_arg, plan["activate"], plan["dependencies"], plan["desktopOnly"])
    if fresh != plan or confirmation != plan["confirmation"]:
        raise ValueError("stale plan or invalid confirmation; no writes performed")
    home, bundle = root_path(plan["home"]), root_path(plan["bundle"])
    lock = resolve_inside(home, ".plur1bus-install-lock")
    lock.mkdir()  # Refuse concurrent installation; never steal an existing lock.
    transaction = None
    journal = {"schema": 1, "status": "preparing", "home": str(home), "files": {}, "version": plan["version"],
               "pipChanged": False, "pmSelections": [],
               "torch": None if plan["torch"] is None else dict(plan["torch"])}
    try:
        # Recheck under the lock, including every target and configuration digest.
        if plan_install(bundle, home, plan["profiles"], python_arg, plan["activate"], plan["dependencies"], plan["desktopOnly"]) != plan:
            raise ValueError("installation changed while acquiring lock")
        backups = resolve_inside(home, "plur1bus-install-backups")
        backups.mkdir(exist_ok=True)
        transaction = Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%d-%H%M%S-"), dir=backups))
        def record():
            atomic_write(transaction / "journal.json", json.dumps(journal, indent=2).encode())
        atomic_write(transaction / "plan.json", json.dumps(plan, indent=2).encode())
        selected = targets(home, plan["profiles"], plan["desktopOnly"])
        manifest = verify_bundle(bundle)
        incoming = shared_desktop_updates(bundle, home, selected, manifest, plan["desktopOnly"])
        pm_requests = {}
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
                    data = resolve_inside(bundle, key).read_bytes()
                    if plan["pmManaged"] and relative.endswith("/pyproject.toml"):
                        plugin_root = relative.rsplit("/pyproject.toml", 1)[0]
                        if plugin_root in {"plugins/plur1bus", "plugins/plur1bus-controls"}:
                            data = pm_member_project_bytes(data, Path(plugin_root).name, target)
                    incoming[prefix + relative] = data
                    receipt_files[relative] = digest(data)
            if plan["activate"]:
                config = read_config(plan["python"], target / "config.yaml")
                if plan["pmManaged"]:
                    memory = config.get("memory", {})
                    if not isinstance(memory, dict):
                        raise ValueError("invalid Hermes memory configuration")
                    enabled, disabled = _desired_plugin_selection(config)
                    before_config = resolve_inside(target, "config.yaml").read_bytes()
                    pm_requests[name] = {"target": target, "enabled": enabled, "disabled": disabled,
                                         "beforeConfig": before_config, "prefix": prefix}
                    plugins = config.get("plugins", {})
                    journal["pmSelections"].append({
                        "profile": name,
                        "beforeEnabled": sorted(set(plugins.get("enabled", []))),
                        "beforeDisabled": sorted(set(plugins.get("disabled", []))),
                        "applied": False,
                    })
                else:
                    memory = config.setdefault("memory", {})
                    plugins = config.setdefault("plugins", {})
                    if not isinstance(memory, dict) or not isinstance(plugins, dict):
                        raise ValueError("invalid memory/plugins configuration")
                    enabled, disabled = plugins.get("enabled", []), plugins.get("disabled", [])
                    if not isinstance(enabled, list) or not isinstance(disabled, list) or not all(isinstance(v, str) for v in enabled + disabled):
                        raise ValueError("invalid plugin allow/deny lists")
                    memory["provider"] = "plur1bus"
                    memory["memory_enabled"] = True
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
            if old is not None and relative.endswith("plugins/plur1bus/desktop/plugin.js"):
                # Restoring a host marker also restores the source timestamp it
                # refers to, so rollback cannot trigger a destructive recopy.
                journal["files"][relative]["beforeMtimeNs"] = destination.stat().st_mtime_ns
        for request in pm_requests.values():
            relative = request["prefix"] + "config.yaml"
            old = request["beforeConfig"]
            atomic_write(resolve_inside(transaction, "before/" + relative), old)
            journal["files"][relative] = {"before": digest(old), "after": None}
        record()
        # Legacy installs use pip separately. PM-managed profiles are admitted
        # after the plugin files are staged, through PM's generation publisher.
        if not plan["desktopOnly"] and not plan["pmManaged"]:
            if plan["bootstrapPip"]:
                journal.update(status="bootstrapping-pip", pipChanged=True)
                record()
                with (transaction / "pip-bootstrap.log").open("w", encoding="utf-8") as log:
                    subprocess.run([plan["python"], "-I", "-m", "ensurepip"],
                                   stdout=log, stderr=subprocess.STDOUT, check=True)
            before = subprocess.run([plan["python"], "-I", "-m", "pip", "freeze"], capture_output=True, check=True)
            atomic_write(transaction / "pip-before.txt", before.stdout)
            before_check = subprocess.run([plan["python"], "-I", "-m", "pip", "check"], capture_output=True, text=True)
            atomic_write(transaction / "pip-check-before.txt", before_check.stdout.encode())
            constraint = None
            if plan["torch"]["action"] == "install-cpu":
                journal.update(status="installing-cpu-torch", pipChanged=True)
                record()
                with (transaction / "pip-cpu-torch.log").open("w", encoding="utf-8") as log:
                    subprocess.run([plan["python"], "-I", "-m", "pip", "install", "--disable-pip-version-check",
                                    "--no-cache-dir", "--only-binary=:all:", "--index-url", plan["torch"]["index"], "torch"],
                                   stdout=log, stderr=subprocess.STDOUT, check=True)
                installed_torch = torch_version(plan["python"])
                if not installed_torch or not installed_torch.endswith("+cpu"):
                    raise ValueError("official CPU index did not install a CPU Torch build")
                verify_cpu_torch(plan["python"], installed_torch)
                constraint = transaction / "torch-constraint.txt"
                atomic_write(constraint, ("torch==" + installed_torch + "\n").encode("utf-8"))
                journal["torch"]["version"] = installed_torch
                record()
            elif plan["torch"]["action"] == "preserve":
                # Existing installations are never replaced, including GPU
                # builds, but must still load before the resolver is allowed to
                # retain them through a constraint.
                verify_cpu_torch(plan["python"], plan["torch"]["version"], require_cpu=False)
                constraint = transaction / "torch-constraint.txt"
                atomic_write(constraint, ("torch==" + plan["torch"]["version"] + "\n").encode("utf-8"))
            journal.update(status="installing-python", pipChanged=True)
            record()
            with (transaction / "pip.log").open("w", encoding="utf-8") as log:
                command = [plan["python"], "-I", "-m", "pip", "install", "--disable-pip-version-check"]
                if constraint is not None:
                    command += ["--constraint", str(constraint)]
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
            if plan["torch"]["action"] == "install-cpu" and torch_version(plan["python"]) != journal["torch"]["version"]:
                raise ValueError("dependency resolver changed the planned CPU Torch version")
            if plan["torch"]["action"] == "install-cpu":
                verify_cpu_torch(plan["python"], journal["torch"]["version"])
            if plan["torch"]["action"] == "preserve" and torch_version(plan["python"]) != plan["torch"]["version"]:
                raise ValueError("dependency resolver replaced an existing Torch installation")
            if plan["torch"]["action"] == "preserve":
                verify_cpu_torch(plan["python"], plan["torch"]["version"], require_cpu=False)
            expected = manifest["pythonVersion"]
            managed_plugin_root = resolve_inside(home, "plugins/plur1bus").resolve()
            run_python(plan["python"], "import plur1bus_hermes,plur1bus_controls,sys; from pathlib import Path; "
                       "assert plur1bus_hermes.__version__ == plur1bus_controls.__version__ == " + repr(expected) + "; "
                       "roots = (Path(sys.prefix).resolve(), Path(" + repr(str(managed_plugin_root)) + ").resolve()); "
                       "assert all(any(path == root or root in path.parents for root in roots) "
                       "for path in (Path(plur1bus_hermes.__file__).resolve(), Path(plur1bus_controls.__file__).resolve())), "
                       "'wheel import escaped target venv or managed Hermes plugin root'")
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
        for name, request in pm_requests.items():
            before = request["beforeConfig"]
            run_pm_selection(home, request["target"], request["enabled"], request["disabled"], digest(before))
            config_path = resolve_inside(request["target"], "config.yaml")
            config_after_selection = config_path.read_bytes()
            selection_record = next(row for row in journal["pmSelections"] if row["profile"] == name)
            selection_record["applied"] = True
            relative = request["prefix"] + "config.yaml"
            journal["files"][relative]["after"] = digest(config_after_selection)
            record()
            selected_python = interpreter(home)
            config = read_config(selected_python, config_path)
            memory = config.setdefault("memory", {})
            if not isinstance(memory, dict):
                raise ValueError("invalid Hermes memory configuration")
            memory["provider"] = "plur1bus"
            memory["memory_enabled"] = True
            atomic_write(config_path, config_bytes(selected_python, config))
            journal["files"][relative]["after"] = digest(config_path.read_bytes())
            record()
        if pm_requests:
            selected_python = interpreter(home)
            verify_pm_plugin_imports(selected_python, home, pm_selected_environment(home),
                                     manifest, manifest["pythonVersion"])
        for relative, state in journal["files"].items():
            destination = resolve_inside(home, relative)
            if (digest(destination.read_bytes()) if destination.exists() else None) != state["after"]:
                raise ValueError("installed-file verification failed")
        if plan["activate"]:
            verification_python = interpreter(home) if plan["pmManaged"] else plan["python"]
            for target in targets(home, plan["profiles"]).values():
                if not activation_status(read_config(verification_python, resolve_inside(target, "config.yaml")))["active"]:
                    raise ValueError("installed profile activation verification failed")
        journal["status"] = "installed-restart-required"
        record()
        print("Installed; restart affected Hermes runtimes. Receipt/backup: " + str(transaction))
        return transaction
    except BaseException:
        if transaction is not None:
            journal["status"] = "failed-review-required"
            atomic_write(transaction / "journal.json", json.dumps(journal, indent=2).encode())
            print("Installation stopped. Inspect backup/journal and Hermes PM state before retrying: " + str(transaction), file=sys.stderr)
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
        if relative != SHARED_DESKTOP_RECEIPT and stripped not in {"config.yaml", RECEIPT, DESKTOP_RECEIPT} and not managed(stripped):
            raise ValueError("invalid rollback target")
        sha = digest(destination.read_bytes()) if destination.exists() else None
        if sha not in {item["before"], item["after"]}:
            raise ValueError("file changed since installation; manual merge required: " + relative)
        if item["before"] is not None and digest(resolve_inside(backup, "before/" + relative).read_bytes()) != item["before"]:
            raise ValueError("backup checksum mismatch")
        if "beforeMtimeNs" in item and (not isinstance(item["beforeMtimeNs"], int) or isinstance(item["beforeMtimeNs"], bool)):
            raise ValueError("invalid backup source timestamp")
        current[relative] = sha
    token = digest(raw + json.dumps(current, sort_keys=True).encode())
    if confirmation is None:
        return {"confirmation": token, "files": len(current), "pipRollback": False,
                "pmSelectionRollback": bool(journal.get("pmSelections"))}
    if not stopped or confirmation != token:
        raise ValueError("stop runtimes and confirm the exact rollback plan")
    lock = resolve_inside(home, ".plur1bus-install-lock")
    lock.mkdir()
    try:
        if rollback(home, transaction)["confirmation"] != token:
            raise ValueError("stale rollback")
        selections = journal.get("pmSelections", [])
        if not isinstance(selections, list):
            raise ValueError("invalid PM selection journal")
        journal["status"] = "rollback-started"
        atomic_write(backup / "journal.json", json.dumps(journal, indent=2).encode())

        def restore_file(relative, item):
            destination = resolve_inside(home, relative)
            if item["before"] is not None:
                atomic_write(destination, resolve_inside(backup, "before/" + relative).read_bytes())
                if "beforeMtimeNs" in item:
                    os.utime(destination, ns=(item["beforeMtimeNs"], item["beforeMtimeNs"]))
            elif destination.exists():
                # Recoverable removal, never recursively delete an installed tree.
                removed = resolve_inside(backup, "removed/" + relative)
                removed.parent.mkdir(parents=True, exist_ok=True)
                os.replace(destination, removed)

        config_paths = {("" if row.get("profile") == "default" else "profiles/" + str(row.get("profile")) + "/") + "config.yaml"
                        for row in selections if isinstance(row, dict)}
        try:
            # Restore every package/project file before PM scans the workspace.
            # Otherwise PM would resolve dependencies against the new declarations
            # and the restored source could then fail its version/import guard.
            for relative, item in journal["files"].items():
                if relative not in config_paths:
                    restore_file(relative, item)
            journal["status"] = "rollback-files-restored-awaiting-pm"
            atomic_write(backup / "journal.json", json.dumps(journal, indent=2).encode())

            pm_failures = []
            pm_admission_attempted = False
            for selection in reversed(selections):
                if not isinstance(selection, dict) or not isinstance(selection.get("profile"), str):
                    raise ValueError("invalid PM selection journal")
                profile = selection["profile"]
                if profile != "default" and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", profile):
                    raise ValueError("invalid PM selection journal")
                enabled, disabled = selection.get("beforeEnabled"), selection.get("beforeDisabled")
                if (not isinstance(enabled, list) or not isinstance(disabled, list)
                        or not all(isinstance(value, str) for value in enabled + disabled)):
                    raise ValueError("invalid PM selection journal")
                profile_home = home if profile == "default" else resolve_inside(home, "profiles/" + profile)
                config_path = resolve_inside(profile_home, "config.yaml")
                current_config = config_path.read_bytes()
                before_hash = journal["files"].get(
                    ("" if profile == "default" else "profiles/" + profile + "/") + "config.yaml", {}
                ).get("before")
                if digest(current_config) != before_hash:
                    pm_admission_attempted = True
                    try:
                        run_pm_selection(home, profile_home, enabled, disabled, digest(current_config))
                    except Exception as error:
                        # Do not persist arbitrary PM diagnostics (which may
                        # contain paths, URLs, or environment details).
                        pm_failures.append({"profile": profile, "errorType": type(error).__name__})
                    else:
                        journal["status"] = "rollback-pm-profile-admitted"
                        journal["lastPmProfile"] = profile
                        atomic_write(backup / "journal.json", json.dumps(journal, indent=2).encode())

            # Restore original config bytes last, after PM has seen old package
            # declarations. PM may publish a compatible regenerated graph; it
            # cannot guarantee byte-for-byte restoration of its prior generation.
            for relative in config_paths:
                if relative in journal["files"]:
                    restore_file(relative, journal["files"][relative])
            for relative, item in journal["files"].items():
                if relative not in config_paths and item["before"] is None:
                    # Newly-added files are removed earlier into the recoverable
                    # backup tree; this second pass is intentionally idempotent.
                    restore_file(relative, item)

            if pm_failures:
                journal["status"] = "files-restored-pm-repair-required"
                journal["pmRollbackFailures"] = pm_failures
                journal["pmGenerationRecovery"] = "repair-required"
            elif pm_admission_attempted:
                journal["status"] = "files-restored-pm-selection-admitted"
                journal["pmGenerationRecovery"] = "admitted-compatible-graph; original-generation-identity-unverified"
            elif selections:
                journal["status"] = "files-restored-pm-selection-unchanged"
                journal["pmGenerationRecovery"] = "not-modified"
            else:
                journal["status"] = "files-restored-python-unchanged"
            atomic_write(backup / "journal.json", json.dumps(journal, indent=2).encode())
        except BaseException as error:
            journal["status"] = "rollback-failed-review-required"
            journal["rollbackErrorType"] = type(error).__name__
            atomic_write(backup / "journal.json", json.dumps(journal, indent=2).encode())
            raise
    finally:
        lock.rmdir()
    result = {"restored": True, "pipRollback": False}
    if selections:
        result["pmGenerationRecovery"] = journal.get("pmGenerationRecovery", "unknown")
        result["repairRequired"] = bool(journal.get("pmRollbackFailures"))
    return result


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
    parser.add_argument("--inspect-profiles", action="store_true", help="read-only profile activation inventory for setup")
    parser.add_argument("--desktop-only", action="store_true", help="UI for a separate WSL/remote backend; no Python or config changes")
    parser.add_argument("--no-deps", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    parser.add_argument("--runtimes-stopped", action="store_true")
    parser.add_argument("--rollback", help="transaction directory name from the backup receipt")
    parser.add_argument("--retrieval-target", help="explicit embedding/reranker JSON; separate from package installation")
    parser.add_argument("--retrieval-kind", choices=("embedding", "reranker"), default="embedding")
    parser.add_argument("--retrieval-action", choices=("plan", "prepare", "stage", "validate", "activate"), default="plan")
    parser.add_argument("--native-arm-launcher", action="store_true", help="plan/apply a separate Windows ARM desktop launcher; never changes Hermes shortcuts")
    parser.add_argument("--native-root", help="existing Hermes source root bound to the separate ARM launcher")
    parser.add_argument("--native-python", help="existing ARM64 CPython 3.13 Hermes venv executable")
    parser.add_argument("--native-desktop-exe", help="existing ARM64 Hermes Desktop executable")
    args = parser.parse_args()
    interactive = (args.interactive or len(sys.argv) == 1) and sys.stdin.isatty()
    try:
        if args.inspect_profiles:
            if not args.home or any((args.apply, args.activate, args.rollback, args.retrieval_target, args.native_arm_launcher, args.desktop_only, args.interactive)):
                raise ValueError("--inspect-profiles requires --home and cannot perform installation actions")
            print(json.dumps(inspect_profiles(args.home, args.python)))
            return 0
        if args.native_arm_launcher:
            if not args.home or not all((args.native_root, args.native_python, args.native_desktop_exe)):
                raise ValueError("--native-arm-launcher requires --home, --native-root, --native-python, and --native-desktop-exe")
            if any((args.interactive, args.profile, args.activate, args.desktop_only, args.no_deps,
                    args.runtimes_stopped, args.rollback, args.retrieval_target)):
                raise ValueError("native ARM launcher mode cannot be combined with package or retrieval operations")
            result = plan_native_launcher(args.home, args.native_root, args.native_python, args.native_desktop_exe)
            print(json.dumps(result, indent=2))
            if args.apply:
                apply_native_launcher(result, args.confirm)
            return 0
        if any((args.native_root, args.native_python, args.native_desktop_exe)):
            raise ValueError("native ARM launcher paths require --native-arm-launcher")
        if interactive:
            print("PLUR1BUS for Hermes — package installation and model/memory changes require separate review. Stop affected runtimes before writes.")
            suggested_home = os.environ.get("HERMES_HOME") or str(Path(os.environ["LOCALAPPDATA"]) / "hermes" if sys.platform == "win32" and "LOCALAPPDATA" in os.environ else Path.home() / ".hermes")
            args.home = input("Hermes root home [" + suggested_home + "]: ").strip() or suggested_home
            print("Profiles: all = ALL existing profiles; default = root profile only; or enter one existing name.")
            print("New profiles created later require setup again. No profiles are created here.")
            args.profile = [input("Install for which profiles? [all]: ").strip() or "all"]
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
                    print("Activation selects PLUR1BUS as memory provider and enables its dashboard and controls. Models and memories are not changed.")
                    activation = input("Install AND activate PLUR1BUS for the selected profiles? [Y/n]: ").strip().lower()
                    if activation not in {"", "y", "yes", "n", "no"}:
                        raise ValueError("answer yes or no for activation")
                    args.activate = activation in {"", "y", "yes"}
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
                print("Profiles: " + ", ".join(result["profiles"]))
                print("Action: " + ("INSTALL AND ACTIVATE" if result["activate"] else "INSTALL FILES ONLY; activation unchanged"))
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

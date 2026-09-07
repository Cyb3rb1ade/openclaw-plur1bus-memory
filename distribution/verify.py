#!/usr/bin/env python3
"""Real bundle install/rollback smoke in a disposable home, never the user's Hermes."""
import argparse
import importlib.util
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import venv
import site

from installer import verify_bundle


def verify_entrypoint(bundle):
    """Start the shipped CLI in isolation before importing any artifact code."""
    subprocess.run([sys.executable, "-I", str(bundle / "installer.py"), "--help"],
                   check=True, timeout=30, capture_output=True, text=True, encoding="utf-8")


def dependency_modules(system, architecture):
    """Import the supported local provider stack, without requiring Torch on ONNX-only targets."""
    modules = ["lancedb", "numpy", "onnxruntime", "tokenizers", "certifi"]
    if (system, architecture.lower()) not in {("win32", "arm64"), ("darwin", "x86_64")}:
        modules.append("sentence_transformers")
    return modules


def verify(bundle, executable=None):
    manifest = verify_bundle(bundle)
    verify_entrypoint(bundle)
    spec = importlib.util.spec_from_file_location("artifact_installer", bundle / "installer.py")
    implementation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(implementation)
    plan_install, apply_install, rollback = implementation.plan_install, implementation.apply_install, implementation.rollback
    with tempfile.TemporaryDirectory(prefix="plur1bus-package-qa-") as directory:
        root = Path(directory).resolve()
        home = root / "Hermes Home"
        home.mkdir()
        original = b'{"memory":{"provider":"builtin"},"model":{"name":"preserve-me"}}\n'
        (home / "config.yaml").write_bytes(original)
        environment = root / "venv"
        # Inherit already-provisioned QA dependencies, never a production venv.
        venv.EnvBuilder(with_pip=True, system_site_packages=True).create(environment)
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        # Nested venvs inherit the base interpreter's packages, not the invoking
        # QA venv. Add read-only dependency search paths explicitly for this test.
        # On Windows getsitepackages()[0] is the venv root, not Lib/site-packages.
        # A .pth there can put inherited packages before the actual wheel install.
        child_site = Path(subprocess.check_output([str(python), "-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], text=True).strip())
        child_site.mkdir(parents=True, exist_ok=True)
        (child_site / "qa-dependencies.pth").write_text("\n".join(site.getsitepackages()) + "\n", encoding="utf-8")
        native_target = f"{sys.platform}/{platform.machine()}"
        native_install = native_target in manifest.get("nativeDependencies", {})
        plan = plan_install(bundle, home, python=python, activate=True, dependencies=native_install)
        if native_install:
            assert plan["nativeWheels"], "Native package test must install its bundled storage wheels"
        transaction = apply_install(plan, plan["confirmation"], True)
        smoke = """
import sys, importlib, json
from pathlib import Path
import plur1bus_hermes, plur1bus_controls
for name in json.loads(sys.argv[3]):
    importlib.import_module(name)
for name in json.loads(sys.argv[4]):
    module = importlib.import_module(name)
    assert Path(module.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()), (name, module.__file__)
from plur1bus_hermes.runtime import Plur1busRuntime
assert plur1bus_hermes.__version__ == plur1bus_controls.__version__ == sys.argv[2]
for module in (plur1bus_hermes, plur1bus_controls):
    assert Path(module.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()), (module.__file__, sys.prefix)
runtime = Plur1busRuntime(Path(sys.argv[1]), {'embedding': {'dimensions': 2}}, 'main')
runtime._embedding.embed = lambda text, purpose='passage': [0.1, 0.2]
runtime._reranker.rerank = lambda query, rows: rows
runtime._domain.on_memory = lambda *args, **kwargs: None
try:
    runtime._remember('portable package smoke memory', 'package-qa', 'user')
    assert 'portable package smoke memory' in runtime.recall('package smoke')
finally:
    runtime.shutdown()
print('Installed wheel import and real LanceDB capture/recall passed (stub embeddings, no model download).')
"""
        native_modules = ["lancedb"] + (["pyarrow"] if sys.platform == "win32" else []) if native_install else []
        subprocess.run([str(python), "-I", "-c", smoke, str(root / "data"), manifest["pythonVersion"],
                        json.dumps(dependency_modules(sys.platform, platform.machine())), json.dumps(native_modules)], check=True)
        target = root / "reranker-target.json"
        target.write_text('{"provider":"disabled"}', encoding="utf-8")
        retrieval = [str(python), "-I", str(bundle / "installer.py"), "--bundle", str(bundle),
                     "--home", str(home), "--python", str(python), "--profile", "default",
                     "--retrieval-kind", "reranker", "--retrieval-target", str(target)]
        settings_plan = json.loads(subprocess.check_output(retrieval, text=True))
        subprocess.run(retrieval + ["--retrieval-action", "activate", "--apply", "--confirm",
                                   settings_plan["confirmation"], "--runtimes-stopped"], check=True)
        assert json.loads((home / "plugins/plur1bus/config.json").read_text())["reranker"]["provider"] == "disabled"
        review = rollback(home, transaction.name)
        rollback(home, transaction.name, review["confirmation"], True)
        assert (home / "config.yaml").read_bytes() == original
        assert not (home / "plugins/plur1bus/__init__.py").exists()
        if executable:
            # Two independent extractions must produce the same confirmation.
            base = [str(executable), "--home", str(home), "--desktop-only"]
            frozen = json.loads(subprocess.check_output(base, text=True))
            subprocess.run(base + ["--apply", "--confirm", frozen["confirmation"], "--runtimes-stopped"], check=True)
            assert (home / "desktop-plugins/plur1bus/plugin.js").is_file()
            assert (home / "config.yaml").read_bytes() == original
    print("Portable package verification passed; disposable home removed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--exe", type=Path)
    args = parser.parse_args()
    verify(args.bundle.resolve(), args.exe)

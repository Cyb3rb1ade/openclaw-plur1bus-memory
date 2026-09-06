#!/usr/bin/env python3
"""Real bundle install/rollback smoke in a disposable home, never the user's Hermes."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import venv
import site

from installer import verify_bundle


def verify(bundle, executable=None):
    manifest = verify_bundle(bundle)
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
        child_site = Path(subprocess.check_output([str(python), "-I", "-c", "import site; print(site.getsitepackages()[0])"], text=True).strip())
        child_site.mkdir(parents=True, exist_ok=True)
        (child_site / "qa-dependencies.pth").write_text("\n".join(site.getsitepackages()) + "\n", encoding="utf-8")
        plan = plan_install(bundle, home, python=python, activate=True, dependencies=False)
        transaction = apply_install(plan, plan["confirmation"], True)
        smoke = """
import sys
from pathlib import Path
import plur1bus_hermes, plur1bus_controls
import lancedb, numpy, sentence_transformers, onnxruntime
from plur1bus_hermes.runtime import Plur1busRuntime
assert plur1bus_hermes.__version__ == plur1bus_controls.__version__ == sys.argv[2]
assert Path(plur1bus_hermes.__file__).is_relative_to(Path(sys.prefix))
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
        subprocess.run([str(python), "-I", "-c", smoke, str(root / "data"), manifest["pythonVersion"]], check=True)
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

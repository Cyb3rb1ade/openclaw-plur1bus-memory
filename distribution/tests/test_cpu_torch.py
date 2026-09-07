"""Fresh-vs-existing Torch policy must stay explicit and platform-bounded."""
import importlib.util
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import sys
from unittest.mock import patch

import pytest


SPEC = importlib.util.spec_from_file_location("portable_installer_cpu_torch", Path(__file__).resolve().parents[1] / "installer.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


@pytest.mark.parametrize("info,installed,dependencies,expected", [
    ({"platform": "linux", "architecture": "x86_64"}, None, True, "install-cpu"),
    ({"platform": "linux", "architecture": "aarch64"}, None, True, "resolver-default"),
    ({"platform": "win32", "architecture": "AMD64"}, None, True, "install-cpu"),
    ({"platform": "win32", "architecture": "ARM64"}, None, True, "resolver-default"),
    ({"platform": "darwin", "architecture": "arm64"}, None, True, "resolver-default"),
    ({"platform": "linux", "architecture": "x86_64"}, None, False, "resolver-default"),
    ({"platform": "linux", "architecture": "x86_64"}, "2.9.1+cu128", True, "preserve"),
])
def test_cpu_torch_policy_is_fresh_and_platform_bounded(info, installed, dependencies, expected):
    decision = installer.cpu_torch_decision(info, installed, dependencies)
    assert decision["action"] == expected
    if expected == "install-cpu":
        assert decision["index"] == "https://download.pytorch.org/whl/cpu"
    if expected == "preserve":
        assert decision["version"] == installed
        assert decision["index"] is None


def test_cpu_torch_apply_is_no_cache_and_resolver_constrained():
    source = Path(installer.__file__).read_text(encoding="utf-8")
    assert '"--no-cache-dir", "--only-binary=:all:", "--index-url", plan["torch"]["index"], "torch"' in source
    assert '("torch==" + installed_torch + "\\n").encode("utf-8")' in source
    assert 'dependency resolver changed the planned CPU Torch version' in source
    assert 'dependency resolver replaced an existing Torch installation' in source
    assert '"torch": None if plan["torch"] is None else dict(plan["torch"])' in source


def test_cpu_runtime_verification_requires_no_cuda_or_hip(monkeypatch):
    timeouts = []
    monkeypatch.setattr(installer, "run_python", lambda *_, **kwargs: timeouts.append(kwargs.get("timeout")) or '{"version":"2.9.1+cpu","cuda":null,"hip":null}')
    installer.verify_cpu_torch("python", "2.9.1+cpu")
    assert timeouts == [60]
    monkeypatch.setattr(installer, "run_python", lambda *_, **__: '{"version":"2.9.1+cpu","cuda":"12.8","hip":null}')
    with pytest.raises(ValueError, match="CPU runtime"):
        installer.verify_cpu_torch("python", "2.9.1+cpu")


def test_retrieval_bridge_does_not_inherit_cpu_probe_timeout():
    source = Path(installer.__file__).read_text(encoding="utf-8")
    retrieval = source.split("def retrieval_command", 1)[1].split("def main", 1)[0]
    assert "timeout=" not in retrieval


class TestCpuTorchApply:
    def setup_method(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle"
        self.home = self.root / "home"
        self.bundle.mkdir()
        self.home.mkdir()
        (self.home / "config.yaml").write_text("memory: {}\nplugins: {}\n", encoding="utf-8")
        self.files = {
            "payload/plugins/plur1bus/__init__.py": b"provider",
            "payload/plugins/plur1bus-controls/__init__.py": b"controls",
            "payload/desktop-plugins/plur1bus/plugin.js": b"ui",
            "wheels/plur1bus_hermes-1-py3-none-any.whl": b"hermes",
            "wheels/plur1bus_controls-1-py3-none-any.whl": b"controls",
        }
        for name, contents in self.files.items():
            target = self.bundle / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(contents)
        (self.bundle / "distribution.json").write_text(json.dumps({
            "schema": 1, "version": "7.12.0-hermes.2", "pythonVersion": "7.12.0.post2",
            "files": {name: installer.digest(contents) for name, contents in self.files.items()},
        }), encoding="utf-8")
        self.torch = {"version": None}
        self.commands = []

    def teardown_method(self):
        self.temp.cleanup()

    def fake_python(self, python, code, data=None):
        if "sys.version_info" in code:
            return json.dumps({"version": [3, 12, 0], "venv": True, "prefix": str(self.root / "venv"),
                               "platform": "linux", "architecture": "x86_64", "implementation": "cpython",
                               "freeThreaded": False})
        if "import plur1bus_" in code:
            return ""
        if "importlib.metadata.distributions" in code:
            return json.dumps({"fingerprint": "environment", "pipAvailable": True, "ensurepipAvailable": True})
        if "yaml.safe_load" in code:
            return json.dumps({"memory": {}, "plugins": {}})
        if "yaml.safe_dump" in code:
            return data
        raise AssertionError(code)

    def fake_run(self, command, **kwargs):
        self.commands.append(command)
        if "pip" in command:
            if "install" in command and command[-1] == "torch":
                self.torch["version"] = "2.9.1+cpu"
            output = "" if kwargs.get("text") else b""
            return subprocess.CompletedProcess(command, 0, output, "")
        raise AssertionError(command)

    def execute(self, *, dependencies=True, torch=None):
        self.torch["version"] = torch
        with patch.object(installer.sys, "platform", "linux"), \
             patch.object(installer, "run_python", side_effect=self.fake_python), \
             patch.object(installer, "torch_version", side_effect=lambda _: self.torch["version"]), \
             patch.object(installer, "verify_cpu_torch") as verify, \
             patch.object(installer.subprocess, "run", side_effect=self.fake_run):
            plan = installer.plan_install(self.bundle, self.home, python=sys.executable, dependencies=dependencies)
            reviewed = copy.deepcopy(plan)
            installer.apply_install(plan, plan["confirmation"], True)
        return plan, reviewed, verify

    def test_fresh_cpu_install_precedes_resolver_and_does_not_mutate_plan(self):
        plan, reviewed, verify = self.execute()
        assert plan == reviewed
        assert plan["torch"]["action"] == "install-cpu"
        installs = [command for command in self.commands if "pip" in command and "install" in command]
        cpu, resolver = installs[0], installs[1]
        assert cpu[-1] == "torch"
        assert "--index-url" in cpu and installer.CPU_TORCH_INDEX in cpu and "--no-cache-dir" in cpu
        assert "--constraint" in resolver
        assert verify.call_count == 2

    def test_no_deps_skips_cpu_provisioning_and_existing_gpu_is_preserved(self):
        no_deps, _, _ = self.execute(dependencies=False)
        assert no_deps["torch"]["action"] == "resolver-default"
        assert not any(command[-1:] == ["torch"] for command in self.commands)
        self.commands.clear()
        gpu, _, _ = self.execute(torch="2.9.1+cu128")
        assert gpu["torch"]["action"] == "preserve"
        installs = [command for command in self.commands if "pip" in command and "install" in command]
        assert not any(command[-1:] == ["torch"] for command in installs)
        assert "--constraint" in installs[0]

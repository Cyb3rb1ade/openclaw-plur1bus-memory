"""uv-created Hermes venvs need no pip until the confirmed installer writes."""
from unittest.mock import patch
import json
import subprocess
import sys

import pytest
import test_installer as fixtures

installer = fixtures.installer


def test_target_python_pipes_are_explicit_utf8():
    real_run = subprocess.run
    commands = []
    def run(command, **kwargs):
        commands.append((command, kwargs))
        return real_run(command, **kwargs)
    with patch.object(installer.subprocess, "run", side_effect=run):
        assert installer.run_python(sys.executable, "import sys; print(sys.stdin.read(),end='')", "Grüße 🧠 中文") == "Grüße 🧠 中文"
    command, kwargs = commands[0]
    assert command[1:4] == ["-I", "-X", "utf8"]
    assert kwargs["encoding"] == "utf-8"


class PiplessInstallerTests(fixtures.InstallerTests):
    def setUp(self):
        super().setUp()
        self.pip_available = False
        self.ensurepip_available = True
        self.commands = []

    def fake_python(self, python, code, data=None):
        if "PLUR1BUS_ENVIRONMENT_STATE" in code:
            return json.dumps({"pipAvailable": self.pip_available,
                               "ensurepipAvailable": self.ensurepip_available,
                               "fingerprint": "fixture-fingerprint"})
        return super().fake_python(python, code, data)

    def fake_run(self, command, **kwargs):
        self.commands.append(command)
        if "ensurepip" in command:
            self.pip_available = True
            return subprocess.CompletedProcess(command, 0, "", "")
        if "pip" in command and not self.pip_available:
            raise AssertionError("pip used before confirmed bootstrap")
        return super().fake_run(command, **kwargs)

    def test_pipless_plan_is_readonly_and_apply_bootstraps_before_pip(self):
        plan = self.plan()
        assert plan["bootstrapPip"] is True
        assert not any("pip" in command or "ensurepip" in command for command in self.commands)
        assert not (self.home / "plur1bus-install-backups").exists()
        self.apply(plan)
        bootstrap = next(i for i, command in enumerate(self.commands) if "ensurepip" in command)
        first_pip = next(i for i, command in enumerate(self.commands) if "pip" in command)
        assert bootstrap < first_pip
        assert "-I" in self.commands[bootstrap]

    def test_missing_bootstrap_refused_before_writes(self):
        self.ensurepip_available = False
        with pytest.raises(ValueError, match="pip.*ensurepip"):
            self.plan()
        assert not any("pip" in command or "ensurepip" in command for command in self.commands)
        assert not (self.home / "plur1bus-install-backups").exists()

    def test_existing_pip_never_bootstrapped(self):
        self.pip_available = True
        plan = self.plan()
        assert plan["bootstrapPip"] is False
        self.apply(plan)
        assert not any("ensurepip" in command for command in self.commands)

    def test_pip_appearing_after_plan_invalidates_approval(self):
        plan = self.plan()
        self.pip_available = True
        with patch.object(installer.subprocess, "run", side_effect=self.fake_run), patch.object(installer, "run_python", side_effect=self.fake_python):
            with pytest.raises(ValueError, match="stale plan"):
                installer.apply_install(plan, plan["confirmation"], True)
        assert not any("pip" in command or "ensurepip" in command for command in self.commands)

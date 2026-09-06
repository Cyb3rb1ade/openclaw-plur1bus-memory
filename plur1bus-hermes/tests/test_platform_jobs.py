"""Native schedule construction is tested without registering host jobs."""
import json
from pathlib import Path
import plistlib
import subprocess
import sys
from unittest.mock import patch
import xml.etree.ElementTree as ET

import pytest

from plur1bus_hermes.job_install import main
from plur1bus_hermes.platform_jobs import build_platform_jobs, install_platform_jobs


def jobs(root, backend, agents=None):
    return build_platform_jobs(root / "data", root / "config.json", agents or ["main", "bernhardine"],
                               backend=backend, destination=root / "definitions", python_executable=sys.executable)


@pytest.mark.parametrize("backend", ["launchd", "systemd", "windows"])
def test_preview_is_read_only_and_definitions_keep_exact_agent_and_config(tmp_path, backend):
    root = tmp_path.resolve() / "new"
    definitions = jobs(root, backend)
    assert not root.exists()
    assert len(definitions) == 4
    for job in definitions:
        args = job["programArguments"]
        assert args[args.index("--agent") + 1] == job["agentId"]
        assert args[args.index("--config") + 1] == str(root / "config.json")
    assert len({job["label"] for job in definitions}) == 4
    other = build_platform_jobs(root / "data", root / "profile2.json", ["main"], backend=backend)
    assert {job["label"] for job in definitions}.isdisjoint(job["label"] for job in other)


def test_launchd_has_staggered_non_startup_calendar(tmp_path):
    definitions = jobs(tmp_path, "launchd")
    payloads = [plistlib.loads(next(iter(job["files"].values())).encode()) for job in definitions]
    assert [p["StartCalendarInterval"] for p in payloads] == [
        {"Minute": 0}, {"Hour": 3, "Minute": 15}, {"Minute": 17}, {"Hour": 3, "Minute": 28}]
    assert all(p["RunAtLoad"] is False for p in payloads)


def test_systemd_escaping_and_timer_contract(tmp_path):
    definitions = jobs(tmp_path / 'space $HOME %n "quote"', "systemd")
    service, timer = definitions[0]["files"].values()
    assert "$$HOME %%n \\\"quote\\\"" in service
    assert "OnCalendar=*-*-* *:00:00" in timer
    assert "Persistent=false" in timer
    assert "UMask=0077" in service
    assert "TimeoutStartSec=infinity" in service
    assert "WantedBy=timers.target" in timer


def test_windows_xml_is_interactive_least_privilege_and_no_shell(tmp_path):
    definitions = jobs(tmp_path / "space & memory", "windows")
    ns = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
    for job in definitions:
        root = ET.fromstring(next(iter(job["files"].values())))
        assert root.findtext("t:Principals/t:Principal/t:LogonType", namespaces=ns) == "InteractiveToken"
        assert root.findtext("t:Principals/t:Principal/t:RunLevel", namespaces=ns) == "LeastPrivilege"
        assert root.findtext("t:Settings/t:MultipleInstancesPolicy", namespaces=ns) == "IgnoreNew"
        assert root.findtext("t:Actions/t:Exec/t:Command", namespaces=ns) == str(Path(sys.executable).absolute())
        assert root.findtext("t:Actions/t:Exec/t:Arguments", namespaces=ns) == subprocess.list2cmdline(job["programArguments"][1:])
        if job["mode"] == "hourly":
            assert root.findtext("t:Triggers/t:CalendarTrigger/t:Repetition/t:Interval", namespaces=ns) == "PT1H"


@pytest.mark.parametrize("backend", ["launchd", "systemd", "windows"])
def test_apply_files_is_idempotent_private_and_does_not_load(tmp_path, backend):
    definitions = jobs(tmp_path.resolve(), backend)
    with patch("plur1bus_hermes.platform_jobs.subprocess.run") as run:
        first = install_platform_jobs(definitions)
        assert install_platform_jobs(definitions) == first
        run.assert_not_called()
    assert all(job["loaded"] is False for job in first)
    for path in (tmp_path / "definitions").iterdir():
        if sys.platform != "win32":
            assert path.stat().st_mode & 0o777 == 0o600


def test_changed_definition_fails_before_any_new_file_is_written(tmp_path):
    definitions = jobs(tmp_path.resolve(), "systemd")
    directory = tmp_path / "definitions"
    directory.mkdir()
    last_name = list(definitions[-1]["files"])[-1]
    foreign = directory / last_name
    foreign.write_text("user changes")
    with pytest.raises(ValueError, match="existing scheduler file differs"):
        install_platform_jobs(definitions)
    assert list(directory.iterdir()) == [foreign]
    assert foreign.read_text() == "user changes"


@pytest.mark.skipif(sys.platform == "win32", reason="symlink privilege is not available in every Windows user account")
def test_symlink_destination_is_refused(tmp_path):
    definitions = jobs(tmp_path.resolve(), "systemd")
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "definitions").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        install_platform_jobs(definitions)
    assert not list(outside.iterdir())


def test_wrong_os_load_is_refused_before_writes(tmp_path):
    backend = "systemd" if sys.platform == "win32" else "windows"
    definitions = jobs(tmp_path.resolve(), backend)
    with pytest.raises(ValueError, match="another operating system"):
        install_platform_jobs(definitions, load=True)
    assert not (tmp_path / "definitions").exists()


def test_systemd_manager_unavailable_fails_before_files(tmp_path):
    definitions = jobs(tmp_path.resolve(), "systemd")
    with patch("plur1bus_hermes.platform_jobs.sys.platform", "linux"), patch(
        "plur1bus_hermes.platform_jobs.subprocess.run", side_effect=subprocess.CalledProcessError(1, "systemctl")
    ), patch("plur1bus_hermes.platform_jobs.Path.home", return_value=tmp_path.resolve()):
        for job in definitions:
            job["destination"] = str(tmp_path / ".config/systemd/user")
        with pytest.raises(subprocess.CalledProcessError):
            install_platform_jobs(definitions, load=True)
    assert not (tmp_path / ".config").exists()


@pytest.mark.parametrize("backend,platform", [("launchd", "darwin"), ("systemd", "linux"), ("windows", "win32")])
def test_load_invokes_only_selected_user_scheduler(tmp_path, backend, platform):
    root = tmp_path.resolve()
    definitions = jobs(root, backend, ["main"])
    if backend == "systemd":
        for job in definitions:
            job["destination"] = str(root / ".config/systemd/user")
    with patch("plur1bus_hermes.platform_jobs.sys.platform", platform), patch(
        "plur1bus_hermes.platform_jobs.subprocess.run") as run, patch(
        "plur1bus_hermes.platform_jobs.Path.home", return_value=root), patch(
        "plur1bus_hermes.platform_jobs.os.getuid", return_value=501, create=True):
        assert all(job["loaded"] for job in install_platform_jobs(definitions, load=True))
    commands = [call.args[0] for call in run.call_args_list]
    assert all(call.kwargs["check"] is True for call in run.call_args_list)
    if backend == "systemd":
        assert commands[0] == ["systemctl", "--user", "show-environment"]
        assert commands[1] == ["systemctl", "--user", "daemon-reload"]
        assert all(command[1] == "--user" for command in commands)
    elif backend == "windows":
        assert all(command[:2] == ["schtasks.exe", "/Create"] and "/F" not in command for command in commands)
    else:
        assert all(command[:3] == ["launchctl", "bootstrap", "gui/501"] for command in commands)


@pytest.mark.parametrize("agents", [[], ["main", "main"], ["../escape"], [str(i) for i in range(61)]])
def test_invalid_agents_refused(tmp_path, agents):
    with pytest.raises(ValueError):
        build_platform_jobs(tmp_path, tmp_path / "config.json", agents, backend="systemd")


def test_control_characters_cannot_inject_systemd_directives(tmp_path):
    with pytest.raises(ValueError, match="control characters"):
        jobs(tmp_path / "a\nExecStart=bad", "systemd")


def test_cli_auto_preview_does_not_write(tmp_path, capsys):
    root = tmp_path / "missing"
    assert main(["--data-dir", str(root), "--config", str(root / "config.json"), "--agent", "main"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "preview"
    assert len(report["jobs"]) == 2
    assert not root.exists()

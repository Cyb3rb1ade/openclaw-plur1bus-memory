"""Reviewed per-user maintenance schedules; never install a system service."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
from typing import Any
import xml.etree.ElementTree as ET

from .file_io import sync_parent
from .validation import safe_agent_id, resolve_inside


def _argument(value: str) -> str:
    if not value or any(ord(character) < 32 for character in value):
        raise ValueError("scheduler arguments must be nonempty and contain no control characters")
    return value


def _systemd_argument(value: str) -> str:
    # ExecStart is not a shell, but systemd expands both specifiers and $vars.
    return '"' + _argument(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'


def _windows_task(label: str, arguments: list[str], minute: int, mode: str) -> str:
    ns = "http://schemas.microsoft.com/windows/2004/02/mit/task"
    ET.register_namespace("", ns)

    def child(parent, name, value=None):
        element = ET.SubElement(parent, f"{{{ns}}}{name}")
        if value is not None:
            element.text = value
        return element

    root = ET.Element(f"{{{ns}}}Task", {"version": "1.2"})
    info = child(root, "RegistrationInfo")
    child(info, "Description", f"PLUR1BUS Hermes per-user maintenance: {label}")
    trigger = child(child(root, "Triggers"), "CalendarTrigger")
    if mode == "hourly":
        repetition = child(trigger, "Repetition")
        child(repetition, "Interval", "PT1H")
        child(repetition, "Duration", "P1D")
        child(repetition, "StopAtDurationEnd", "false")
    child(trigger, "StartBoundary", f"2020-01-01T{'00' if mode == 'hourly' else '03'}:{minute:02d}:00")
    child(trigger, "Enabled", "true")
    child(child(trigger, "ScheduleByDay"), "DaysInterval", "1")
    principal = child(child(root, "Principals"), "Principal")
    principal.set("id", "Owner")
    # No password, service account, admin elevation or other user's session.
    # schtasks binds an omitted UserId to the registering interactive user.
    child(principal, "LogonType", "InteractiveToken")
    child(principal, "RunLevel", "LeastPrivilege")
    settings = child(root, "Settings")
    child(settings, "MultipleInstancesPolicy", "IgnoreNew")
    child(settings, "DisallowStartIfOnBatteries", "false")
    child(settings, "StopIfGoingOnBatteries", "false")
    child(settings, "StartWhenAvailable", "false")
    child(settings, "ExecutionTimeLimit", "PT0S")
    actions = child(root, "Actions")
    actions.set("Context", "Owner")
    execute = child(actions, "Exec")
    child(execute, "Command", arguments[0])
    child(execute, "Arguments", subprocess.list2cmdline(arguments[1:]))
    return ET.tostring(root, encoding="unicode", xml_declaration=True)


def build_platform_jobs(data_dir: Path, config_path: Path, agents: list[str], *,
                        backend: str, python_executable: str | None = None,
                        destination: Path | None = None) -> list[dict[str, Any]]:
    """Preview native scheduler files with identity bound to data AND config."""
    if backend not in {"launchd", "systemd", "windows"}:
        raise ValueError("unsupported scheduler backend")
    executable = _argument(str(Path(python_executable or sys.executable).absolute()))
    data_dir, config_path = Path(data_dir).absolute(), Path(config_path).absolute()
    _argument(str(data_dir))
    _argument(str(config_path))
    agents = [safe_agent_id(agent) for agent in agents]
    if not agents or len(set(agents)) != len(agents) or len(agents) > 60:
        raise ValueError("specify 1-60 unique agent IDs")
    identity = hashlib.sha256(f"{data_dir.resolve()}\0{config_path.resolve()}".encode()).hexdigest()[:16]
    if destination is None:
        destination = {"launchd": Path.home() / "Library/LaunchAgents",
                       "systemd": Path.home() / ".config/systemd/user",
                       "windows": data_dir / "state/scheduled-tasks"}[backend]
    destination = Path(destination).absolute()
    jobs = []
    for index, agent in enumerate(agents):
        for mode in ("hourly", "daily"):
            label = f"com.plur1bus.hermes.{identity}.{agent}.{mode}"
            minute = (index * 17 if mode == "hourly" else 15 + index * 13) % 60
            arguments = [executable, "-m", "plur1bus_hermes.jobs", "--data-dir", str(data_dir),
                         "--config", str(config_path), "--agent", agent, "--mode", mode]
            files = {}
            if backend == "launchd":
                plist = {"Label": label, "ProgramArguments": arguments, "RunAtLoad": False,
                         "ProcessType": "Background", "StartCalendarInterval": {"Minute": minute}}
                if mode == "daily":
                    plist["StartCalendarInterval"]["Hour"] = 3
                # Reports are written by jobs.py; native scheduler owns stdout.
                files[f"{label}.plist"] = plistlib.dumps(plist, sort_keys=True).decode()
            elif backend == "systemd":
                files[f"{label}.service"] = (
                    "[Unit]\nDescription=PLUR1BUS Hermes maintenance\n[Service]\nType=oneshot\n"
                    "TimeoutStartSec=infinity\nUMask=0077\nExecStart="
                    + " ".join(_systemd_argument(arg) for arg in arguments) + "\n")
                calendar = f"*-*-* {'*' if mode == 'hourly' else '03'}:{minute:02d}:00"
                files[f"{label}.timer"] = (
                    "[Unit]\nDescription=PLUR1BUS Hermes maintenance timer\n[Timer]\n"
                    f"OnCalendar={calendar}\nPersistent=false\nUnit={label}.service\n"
                    "[Install]\nWantedBy=timers.target\n")
            else:
                files[f"{label}.xml"] = _windows_task(label, arguments, minute, mode)
            jobs.append({"backend": backend, "label": label, "agentId": agent, "mode": mode,
                         "destination": str(destination), "programArguments": arguments, "files": files})
    return jobs


def install_platform_jobs(jobs: list[dict[str, Any]], *, load: bool = False) -> list[dict[str, Any]]:
    """Publish reviewed files; refuse foreign/changed files and wrong-OS loading.

    Existing identical files are idempotent. A changed definition requires a
    separate reviewed removal, never a silent overwrite of a user's schedule.
    """
    expected = "windows" if sys.platform == "win32" else "launchd" if sys.platform == "darwin" else "systemd"
    if load and any(job["backend"] != expected for job in jobs):
        raise ValueError("cannot load a scheduler for another operating system")
    if load and expected == "systemd" and any(
        Path(job["destination"]).resolve() != (Path.home() / ".config/systemd/user").resolve()
        for job in jobs
    ):
        raise ValueError("systemd loading requires the default user unit directory; omit --destination")
    publications = []
    # Preflight all files before any writes or scheduler calls.
    for job in jobs:
        directory = Path(job["destination"])
        for parent in (directory, *directory.parents):
            if parent.is_symlink() or (parent.exists() and getattr(parent.lstat(), "st_file_attributes", 0) & 0x400):
                raise ValueError("scheduler destination contains a symlink/reparse point")
        for name, content in job["files"].items():
            path = directory / name
            if path.is_symlink():
                raise ValueError("scheduler file is a symlink")
            path = resolve_inside(str(directory), name)
            if path.exists() and (not path.is_file() or path.read_text() != content):
                raise ValueError(f"existing scheduler file differs; review before replacing: {path}")
            publications.append((path, content))
    if load and expected == "systemd":
        # WSL without a running user systemd manager is not silently 'installed'.
        subprocess.run(["systemctl", "--user", "show-environment"], check=True, capture_output=True)
    for path, content in publications:
        if path.exists():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".plur1bus-schedule-", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            # Hard-link publication is no-clobber even if a file appears after
            # preflight. Local filesystems required, as for memory storage.
            os.link(temporary, path)
            sync_parent(path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    if load and expected == "systemd":
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    installed = []
    for job in jobs:
        if load:
            directory = Path(job["destination"])
            if job["backend"] == "launchd":
                subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(directory / f"{job['label']}.plist")], check=True)
            elif job["backend"] == "systemd":
                subprocess.run(["systemctl", "--user", "enable", "--now", f"{job['label']}.timer"], check=True)
            else:
                # No /F: a registered task is NEVER silently overwritten.
                subprocess.run(["schtasks.exe", "/Create", "/TN", job["label"], "/XML", str(directory / f"{job['label']}.xml")], check=True)
        installed.append({key: job[key] for key in ("backend", "label", "agentId", "mode", "destination")}
                         | {"loaded": load})
    return installed

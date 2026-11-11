"""Isolated adapter for the selected Hermes installation's lifecycle APIs.

Only gateway control endpoints and proven native service owners are operated.
No process-table substring kills, arbitrary command replay or forced termination.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


class RuntimeRefused(ValueError):
    """A credential-free actionable lifecycle refusal."""


def scoped_home(home, root):
    home = Path(home).resolve()
    return home == root or home.parent == root / "profiles"


def process(pid):
    import psutil
    return psutil.Process(pid)


def birth(proc):
    from hermes_cli.process_identity import worker_birth
    return worker_birth(proc)


def same_process(entry):
    import psutil
    try:
        proc = process(entry["pid"])
        return abs(birth(proc) - entry["born"]) < .001 and proc.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def identify(home):
    from gateway.control_socket import identify_gateway
    from gateway.status import live_gateway_pid_for_home
    identity = identify_gateway(Path(home))
    pid = live_gateway_pid_for_home(Path(home))
    if pid and not identity:
        # A multiplexed profile's canonical PID belongs to the root gateway;
        # the control socket is published only under that owner's home.
        from hermes_cli.update_fleet_scope import gateway_pid_home
        owner_home = gateway_pid_home(pid)
        if owner_home and Path(owner_home).resolve() != Path(home).resolve():
            identity = identify_gateway(Path(owner_home))
    if identity and identity.get("pid") != pid:
        raise RuntimeRefused("gateway socket and canonical process identity disagree")
    if pid and not identity:
        raise RuntimeRefused("running gateway lacks supported control protocol; update Hermes or stop it explicitly")
    return identity


def service_owners():
    if sys.platform == "win32":
        from hermes_cli.gateway import find_windows_gateway_services
        result = []
        for service in find_windows_gateway_services():
            result.append({"kind": "windows-service", "name": service.name,
                           "pid": int(service.gateway_pid), "service_pid": int(service.service_pid),
                           "service_born": float(service.service_create_time)})
        return result
    from hermes_cli.update_cmd_posix_pause import _discover_launchd, _discover_systemd
    return _discover_launchd() if sys.platform == "darwin" else _discover_systemd()


def service_fingerprint(owner):
    """Bind the supervisor definition, not merely its reusable label."""
    kind = owner["kind"]
    if kind == "launchd":
        data = Path(owner["plist"]).read_bytes()
    elif kind == "systemd":
        from hermes_cli.update_cmd_posix_pause import _scope_cmd
        result = subprocess.run(_scope_cmd(owner) + ["cat", owner["unit"]],
                                capture_output=True, check=True, timeout=15)
        data = result.stdout
    else:
        import psutil
        service = psutil.win_service_get(owner["name"])
        data = json.dumps([service.binpath(), service.username()], sort_keys=True).encode()
    return hashlib.sha256(data).hexdigest()


def manual_options(argv, project):
    # Only documented gateway startup arguments are replayable. A shell command,
    # arbitrary Python program, inline credential or custom launcher is refused.
    if "gateway" not in argv:
        raise RuntimeRefused("unsupported manual gateway launcher")
    index = argv.index("gateway")
    if argv[index:index + 2] != ["gateway", "run"]:
        raise RuntimeRefused("unsupported manual gateway launcher")
    options = argv[index + 2:]
    if any(arg not in {"--verbose", "--quiet"} for arg in options):
        raise RuntimeRefused("custom gateway startup options require explicit external stop/restart")
    scripts = {str(project / "hermes_cli/main.py"), str(project / "cli.py")}
    module = ["-m", "hermes_cli.main"]
    if not any(str(Path(arg).resolve()) in scripts for arg in argv[:index] if not arg.startswith("-")) and not any(argv[i:i + 2] == module for i in range(index)):
        raise RuntimeRefused("gateway launcher does not belong to the selected Hermes installation")
    return options


def inspect_clients(home, project, excluded_pids):
    """Extension seam for Desktop/interactive client lifecycle (currently fail closed)."""
    import psutil
    from hermes_cli.update_cmd_windows import _hermes_holder_subcommand
    for proc in psutil.process_iter(["pid", "cmdline"]):
        if proc.pid in excluded_pids or proc.pid == os.getpid():
            continue
        argv = proc.info.get("cmdline") or []
        if not argv:
            continue
        # Classification uses Hermes' parser, and ownership requires an exact
        # source-tree path plus the process's selected home; argv is never logged.
        source = any(Path(arg).is_absolute() and Path(arg).is_relative_to(project) for arg in argv)
        if not source:
            continue
        try:
            target = proc.environ().get("HERMES_HOME")
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            raise RuntimeRefused("cannot verify a Hermes client owner; close Hermes clients and retry")
        if target and not scoped_home(target, home):
            continue
        kind = _hermes_holder_subcommand(subprocess.list2cmdline(argv))
        if kind is not None:
            raise RuntimeRefused("a Hermes Desktop/CLI/job client is still running; close it and retry (automatic client restoration is not supported)")


def served_profiles(identity):
    """Normalize both legacy names and current session-authority home records."""
    launch = Path(identity["hermes_home"]).resolve()
    root = launch.parent.parent if launch.parent.name == "profiles" else launch
    names = []
    for profile in identity.get("served_profiles", []):
        if isinstance(profile, str) and "/" not in profile and "\\" not in profile:
            names.append(profile)
        elif isinstance(profile, dict) and isinstance(profile.get("home"), str):
            home = Path(profile["home"]).resolve()
            if not scoped_home(home, root):
                raise RuntimeRefused("gateway serves a profile outside the selected home")
            names.append("default" if home == root else home.name)
        else:
            raise RuntimeRefused("unsupported served-profile identity from Hermes")
    return sorted(set(names))


def inventory(root, project):
    from gateway.control_socket import launch_supervisor
    from hermes_cli.update_fleet_scope import gateway_pid_home
    homes = [root]
    profiles = root / "profiles"
    if profiles.is_dir():
        homes += [p.resolve() for p in profiles.iterdir() if p.is_dir() and not p.is_symlink()]
    owners = {entry["pid"]: entry for entry in service_owners()}
    entries = {}
    for home in homes:
        identity = identify(home)
        if not identity:
            continue
        pid = identity["pid"]
        actual_home = Path(identity.get("hermes_home", "")).resolve()
        if not scoped_home(actual_home, root) or actual_home not in homes:
            raise RuntimeRefused("gateway endpoint belongs to a foreign home")
        observed_home = gateway_pid_home(pid)
        if not observed_home or Path(observed_home).resolve() != actual_home:
            raise RuntimeRefused("gateway process home could not be verified")
        proc = process(pid)
        argv = proc.cmdline()
        # All owners must launch this source tree, even if their names look like Hermes.
        if "-m" in argv and Path(proc.cwd()).resolve() != project:
            raise RuntimeRefused("module gateway belongs to another Hermes source checkout")
        options = manual_options(argv, project) if pid not in owners else []
        entry = dict(pid=pid, born=birth(proc), home=str(actual_home),
                     served_profiles=served_profiles(identity))
        if pid in owners:
            owner = owners[pid]
            if owner.get("home") and Path(owner["home"]).resolve() != actual_home:
                raise RuntimeRefused("native service belongs to another home")
            entry.update(kind=owner["kind"], owner=owner, ownerFingerprint=service_fingerprint(owner))
        elif launch_supervisor(identity) == "manual":
            if sys.platform != "win32":
                from hermes_cli.update_cmd_posix_pause import _supervisor_markers
                if _supervisor_markers(pid):
                    raise RuntimeRefused("custom external supervisor is unsupported; stop it through its owner")
            entry.update(kind="manual", options=options)
        else:
            raise RuntimeRefused("gateway is Desktop-managed or externally supervised; its owner must stop it first")
        if not same_process(entry):
            raise RuntimeRefused("gateway process identity changed during inspection")
        entries[pid] = entry
    inspect_clients(root, project, set(entries))
    return list(entries.values())


def verify_entry(entry):
    if not same_process(entry):
        raise RuntimeRefused("gateway PID was replaced; refusing shutdown")
    identity = identify(Path(entry["home"]))
    if not identity or identity["pid"] != entry["pid"] or Path(identity["hermes_home"]).resolve() != Path(entry["home"]).resolve():
        raise RuntimeRefused("gateway identity changed before shutdown")
    if entry.get("owner"):
        current = next((o for o in service_owners() if o["pid"] == entry["pid"]), None)
        if not current or current != entry["owner"] or service_fingerprint(current) != entry["ownerFingerprint"]:
            raise RuntimeRefused("native service ownership changed before shutdown")
    return identity


def stop(entry):
    from gateway.control_socket import pause_gateway_for_update
    verify_entry(entry)
    ack = pause_gateway_for_update(Path(entry["home"]))
    if not ack or ack.get("pid") != entry["pid"] or not (ack.get("pausing") or ack.get("already_stopping")):
        raise RuntimeRefused("gateway did not acknowledge normal graceful shutdown")
    budget = max(30, float(ack.get("drain_timeout") or 30) + 30)
    if budget > 780:
        raise RuntimeRefused("gateway shutdown interval exceeds installer wait budget; recovery receipt retained")
    deadline = time.monotonic() + budget
    while same_process(entry) and time.monotonic() < deadline:
        time.sleep(.25)
    if same_process(entry):
        raise RuntimeRefused("gateway has not finished graceful shutdown; no forced kill was attempted")
    owner = entry.get("owner")
    if owner:
        if service_fingerprint(owner) != entry["ownerFingerprint"]:
            raise RuntimeRefused("native service definition changed during shutdown")
        if entry["kind"] == "windows-service":
            from hermes_cli.update_cmd_windows import _stop_windows_gateway_service, _win_service
            # A service wrapper may exit with its drained gateway. Otherwise
            # retain the SCM owner's exact birth witness before sending stop.
            if _win_service(owner["name"])[1].status() != "stopped":
                _stop_windows_gateway_service(owner["name"], expected_service_identity=(owner["service_pid"], owner["service_born"]))
        else:
            from hermes_cli.update_cmd_posix_pause import _stop_job, _stop_unit
            if entry["kind"] == "launchd":
                _stop_job(owner, drained=True)
            else:
                _stop_unit(owner)
    return {"stopped": entry["pid"]}


def ready(entry, identity):
    return bool(identity and identity.get("state") == "ready"
                and Path(identity.get("hermes_home", "")).resolve() == Path(entry["home"]).resolve()
                and set(entry["served_profiles"]) == set(served_profiles(identity)))


def resume(entry, project):
    # A pre-write failure may leave an acknowledged pause in flight. Never
    # claim that draining process as restored or launch a competing gateway.
    identity = identify(Path(entry["home"]))
    if same_process(entry):
        if ready(entry, identity):
            return {"pid": identity["pid"]}
        deadline = time.monotonic() + 90
        while same_process(entry) and time.monotonic() < deadline:
            time.sleep(.25)
        if same_process(entry):
            raise RuntimeRefused("original gateway is still draining; recovery required")
    elif identity:
        raise RuntimeRefused("another gateway appeared while paused; automatic restoration refused")
    owner = entry.get("owner")
    if owner:
        if service_fingerprint(owner) != entry["ownerFingerprint"]:
            raise RuntimeRefused("native service definition changed while paused")
        if entry["kind"] == "windows-service":
            from hermes_cli.update_cmd_windows import _start_windows_gateway_service
            _start_windows_gateway_service(owner["name"])
        else:
            from hermes_cli.update_cmd_posix_pause import _start_job, _start_unit
            (_start_job if entry["kind"] == "launchd" else _start_unit)(owner)
    else:
        from tools.environments.local import served_profile_child_env
        env = served_profile_child_env(target_home=entry["home"], inherit_credentials=True)
        for key in ("INVOCATION_ID", "JOURNAL_STREAM", "HERMES_UPDATE_PAUSED", "_HERMES_GATEWAY"):
            env.pop(key, None)
        log_dir = Path(entry["home"]) / "logs"
        log_dir.mkdir(exist_ok=True)
        with (log_dir / "plur1bus-runtime-resume.log").open("ab") as log:
            subprocess.Popen([sys.executable, str(project / "hermes_cli/main.py"), "gateway", "run", *entry.get("options", [])],
                             cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=True, close_fds=True)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            identity = identify(Path(entry["home"]))
        except RuntimeRefused:
            identity = None  # pid reservation precedes the ready control socket
        if ready(entry, identity):
            return {"pid": identity["pid"]}
        time.sleep(.5)
    raise RuntimeRefused("gateway restarted but readiness/served profiles were not verified; inspect runtime receipt")


def main():
    root = Path(sys.argv[1]).resolve()
    project = root / "hermes-agent"
    if not project.is_dir() or project.is_symlink():
        raise RuntimeRefused("selected home has no supported Hermes source installation")
    os.environ["HERMES_HOME"] = str(root)
    sys.path.insert(0, str(project))
    action = sys.argv[2]
    entry = json.load(sys.stdin)
    if entry and not scoped_home(entry["home"], root):
        raise RuntimeRefused("foreign runtime home refused")
    if entry is not None:
        os.environ["HERMES_HOME"] = str(Path(entry["home"]).resolve())
    # Hermes helpers sometimes print progress; the worker protocol is JSON only.
    with contextlib.redirect_stdout(sys.stderr):
        if action == "inventory":
            result = inventory(root, project)
        elif action == "stop":
            result = stop(entry)
        elif action == "resume":
            result = resume(entry, project)
        else:
            raise RuntimeRefused("unknown runtime operation")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Only our bounded ValueErrors are suitable for the public receipt/UI.
        message = str(error) if type(error) is RuntimeRefused else "Hermes runtime operation failed (" + type(error).__name__ + "); inspect the recovery receipt"
        print(json.dumps({"error": message}))
        sys.exit(1)

"""Isolated adapter for the selected Hermes installation's lifecycle APIs.

Only gateway control endpoints and proven native service owners are operated.
No process-table substring kills, arbitrary command replay or forced termination.
"""
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time


if __package__:
    from .runtime_service_identity import RuntimeRefused, gateway_options, prove_service_source, prove_restart_source, windows_definition_fingerprint
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from runtime_service_identity import RuntimeRefused, gateway_options, prove_service_source, prove_restart_source, windows_definition_fingerprint


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
        return windows_definition_fingerprint(owner)
    return hashlib.sha256(data).hexdigest()


def manual_options(argv, project):
    return gateway_options(argv, Path(project).resolve(), Path(project).resolve(), manual=True)


def restart_budget(entry):
    """Resolve Hermes' complete exit envelope in the actual owner's profile/env."""
    from hermes_cli.gateway import _get_restart_exit_wait_budget
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    keys = ("HERMES_RESTART_DRAIN_TIMEOUT", "HERMES_RESTART_AFTER_TURN_TIMEOUT", "HERMES_CRON_DRAIN_TIMEOUT")
    owner_env = process(entry["pid"]).environ()
    previous = {key: os.environ.get(key) for key in keys}
    token = set_hermes_home_override(entry["home"])
    try:
        for key in keys:
            if key in owner_env:
                os.environ[key] = owner_env[key]
            else:
                os.environ.pop(key, None)
        budget = float(_get_restart_exit_wait_budget())
    finally:
        reset_hermes_home_override(token)
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    if not math.isfinite(budget) or budget <= 0:
        raise RuntimeRefused("owning gateway shutdown budget is unbounded or unavailable; stop it externally before installing")
    return budget


def inspect_clients(home, project, excluded_pids):
    if __package__:
        from .runtime_clients import inspect_clients as inspect
    else:
        from runtime_clients import inspect_clients as inspect
    return inspect(home, project, excluded_pids)


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


def installer_protected():
    if __package__:
        from .runtime_clients import protected_pids
    else:
        from runtime_clients import protected_pids
    return protected_pids()


def native_chain(proc, owner):
    if proc.pid == owner["pid"]:
        return []
    chain = []
    for parent in proc.parents():
        chain.append({"pid": parent.pid, "born": birth(parent)})
        if parent.pid == owner["pid"]:
            return chain
    raise RuntimeRefused("native wrapper ancestry changed")


def owner_for_gateway(proc, owners):
    direct = [owner for owner in owners if owner["pid"] == proc.pid]
    if direct:
        return direct[0], {"pid": proc.pid, "born": birth(proc)}
    ancestors = {parent.pid: parent for parent in proc.parents()}
    matches = [owner for owner in owners if owner["pid"] in ancestors]
    if len(matches) > 1:
        raise RuntimeRefused("gateway has multiple native supervisor ancestors")
    if not matches:
        return None, None
    owner = matches[0]
    return owner, {"pid": owner["pid"], "born": birth(ancestors[owner["pid"]])}


def client_shutdown_budget(entry):
    owners = ([*entry["backends"], *entry.get("gateways", [])]
              if entry["kind"] == "desktop" else [entry])
    return max((restart_budget(owner) for owner in owners), default=30)


def inventory(root, project):
    from gateway.control_socket import launch_supervisor
    from hermes_cli.update_fleet_scope import gateway_pid_home
    homes = [root]
    profiles = root / "profiles"
    if profiles.is_dir():
        homes += [p.resolve() for p in profiles.iterdir() if p.is_dir() and not p.is_symlink()]
    owners = service_owners()
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
        owner, owner_process = owner_for_gateway(proc, owners)
        options = gateway_options(argv, project, Path(proc.cwd()).resolve(), manual=owner is None, home=actual_home)
        if pid in installer_protected():
            raise RuntimeRefused("gateway owns this installer; launch setup outside that runtime")
        entry = dict(pid=pid, born=birth(proc), home=str(actual_home),
                     served_profiles=served_profiles(identity))
        if owner is not None:
            if owner.get("home") and Path(owner["home"]).resolve() != actual_home:
                raise RuntimeRefused("native service belongs to another home")
            prove_service_source(owner, project, actual_home)
            if owner["kind"] == "systemd":
                from hermes_cli.update_cmd_posix_pause import _inside, _pid_cgroup
                if not owner.get("cgroup") or _inside(_pid_cgroup(), owner["cgroup"]):
                    raise RuntimeRefused("installer is inside or cannot verify the gateway service cgroup")
            entry.update(kind=owner["kind"], owner=owner, ownerProcess=owner_process,
                         ownerChain=native_chain(proc, owner), ownerFingerprint=service_fingerprint(owner))
        elif launch_supervisor(identity) == "manual":
            if sys.platform != "win32":
                from hermes_cli.update_cmd_posix_pause import _supervisor_markers
                if _supervisor_markers(pid):
                    raise RuntimeRefused("custom external supervisor is unsupported; stop it through its owner")
            entry.update(kind="manual", options=options)
        elif launch_supervisor(identity) == "desktop":
            entry.update(kind="desktop-gateway")
        else:
            raise RuntimeRefused("gateway is externally supervised; its owner must stop it first")
        if not same_process(entry):
            raise RuntimeRefused("gateway process identity changed during inspection")
        entry["shutdownBudget"] = restart_budget(entry)
        entries[pid] = entry
    excluded = set(entries) | {member["pid"] for entry in entries.values() for member in entry.get("ownerChain", [])}
    clients = inspect_clients(root, project, excluded)
    for client in clients:
        client["shutdownBudget"] = client_shutdown_budget(client)
    for pid, entry in list(entries.items()):
        if entry["kind"] != "desktop-gateway":
            continue
        ancestors = {p.pid for p in process(pid).parents()}
        owners = [c for c in clients if c["kind"] == "desktop" and c["pid"] in ancestors]
        if len(owners) != 1:
            raise RuntimeRefused("Desktop gateway has no verified app owner")
        app = owners[0]
        if __package__:
            from .runtime_clients import identity as client_identity
        else:
            from runtime_clients import identity as client_identity
        app["members"].append(client_identity(process(pid)))
        app.setdefault("gateways", []).append(entry)
        app["shutdownBudget"] = max(app["shutdownBudget"], entry["shutdownBudget"])
        del entries[pid]
    return [*clients, *entries.values()]


def verify_entry(entry):
    if not same_process(entry):
        raise RuntimeRefused("gateway PID was replaced; refusing shutdown")
    identity = identify(Path(entry["home"]))
    if not identity or identity["pid"] != entry["pid"] or Path(identity["hermes_home"]).resolve() != Path(entry["home"]).resolve():
        raise RuntimeRefused("gateway identity changed before shutdown")
    home = Path(entry["home"]).resolve()
    project = (home.parent.parent if home.parent.name == "profiles" else home) / "hermes-agent"
    proc = process(entry["pid"])
    gateway_options(proc.cmdline(), project, Path(proc.cwd()).resolve(), manual=not entry.get("owner"), home=home)
    if entry.get("owner"):
        current, owner_process = owner_for_gateway(proc, service_owners())
        if owner_process != entry.get("ownerProcess") or (current and native_chain(proc, current) != entry.get("ownerChain", [])):
            raise RuntimeRefused("native service wrapper identity changed before shutdown")
        if not current or current != entry["owner"] or service_fingerprint(current) != entry["ownerFingerprint"]:
            raise RuntimeRefused("native service ownership changed before shutdown")
        prove_service_source(current, project, home)
    return identity


def stop(entry):
    if entry.get("kind") in {"desktop", "cli"}:
        if __package__:
            from .runtime_clients import stop as stop_client
        else:
            from runtime_clients import stop as stop_client
        return stop_client(entry)
    from gateway.control_socket import pause_gateway_for_update
    verify_entry(entry)
    budget = restart_budget(entry)
    recorded = entry.get("shutdownBudget")
    if not isinstance(recorded, (int, float)) or not math.isfinite(recorded) or budget > recorded:
        raise RuntimeRefused("owning gateway shutdown budget changed; inspect a fresh runtime plan before stopping")
    budget = float(recorded)
    ack = pause_gateway_for_update(Path(entry["home"]))
    if not ack or ack.get("pid") != entry["pid"] or not (ack.get("pausing") or ack.get("already_stopping")):
        raise RuntimeRefused("gateway did not acknowledge normal graceful shutdown")
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


def start_native(owner, project, home):
    """Start the verified definition without the updater's source-repair hooks."""
    if owner["kind"] == "launchd":
        result = subprocess.run(["launchctl", "bootstrap", owner["domain"], owner["plist"]],
                                capture_output=True, timeout=90, check=False)
        if result.returncode:
            # A prior retry may already have loaded it. Verify the loaded
            # definition before kickstart; never boot out an unknown occupant.
            prove_service_source(owner, project, home)
        subprocess.run(["launchctl", "kickstart", owner["domain"] + "/" + owner["label"]],
                       capture_output=True, timeout=30, check=True)
    else:
        from hermes_cli.update_cmd_posix_pause import _manage_cmd
        command = _manage_cmd(owner["scope"])
        if command is None:
            raise RuntimeRefused("no privilege to start the verified native service")
        subprocess.run([*command, "reset-failed", owner["unit"]], capture_output=True, timeout=15, check=True)
        subprocess.run([*command, "start", owner["unit"]], capture_output=True, timeout=120, check=True)


def resume(entry, project):
    if entry.get("kind") in {"desktop", "cli"}:
        if __package__:
            from .runtime_clients import resume as resume_client
        else:
            from runtime_clients import resume as resume_client
        return resume_client(entry, project)
    if entry.get("kind") not in {"manual", "launchd", "systemd", "windows-service"}:
        raise RuntimeRefused("unsupported runtime receipt kind")
    if entry.get("owner"):
        if entry["owner"].get("kind") != entry["kind"]:
            raise RuntimeRefused("runtime receipt service kind differs from its owner")
        prove_restart_source(entry["owner"], project, Path(entry["home"]))
    else:
        options = entry.get("options", [])
        if not isinstance(options, list) or not all(isinstance(value, str) for value in options):
            raise RuntimeRefused("invalid runtime receipt options")
        gateway_options([sys.executable, str(project / "hermes_cli/main.py"), "gateway", "run", *options],
                        project, project, manual=True, home=Path(entry["home"]))
    # A pre-write failure may leave an acknowledged pause in flight. Never
    # claim that draining process as restored or launch a competing gateway.
    identity = identify(Path(entry["home"]))
    if same_process(entry):
        if ready(entry, identity):
            return {"pid": identity["pid"]}
        budget = entry.get("shutdownBudget")
        if not isinstance(budget, (int, float)) or not math.isfinite(budget) or budget <= 0:
            raise RuntimeRefused("runtime receipt lacks a finite shutdown budget; manual recovery required")
        deadline = time.monotonic() + budget
        while same_process(entry) and time.monotonic() < deadline:
            time.sleep(.25)
        if same_process(entry):
            raise RuntimeRefused("original gateway is still draining; recovery required")
    elif identity:
        # A previous helper may have spawned successfully then lost its reply.
        # Re-inventory the native owner/source; readiness alone is insufficient.
        candidates = inventory(project.parent, project)
        for candidate in candidates:
            keys = ("kind", "home", "served_profiles", "options", "ownerFingerprint")
            owner_keys = ("kind", "label", "domain", "plist", "unit", "scope", "name")
            if (candidate["pid"] == identity["pid"] and ready(entry, identity)
                    and all(candidate.get(key) == entry.get(key) for key in keys)
                    and all(candidate.get("owner", {}).get(key) == entry.get("owner", {}).get(key) for key in owner_keys)):
                return {"pid": identity["pid"]}
        raise RuntimeRefused("another gateway appeared while paused; automatic restoration refused")
    owner = entry.get("owner")
    if owner:
        if service_fingerprint(owner) != entry["ownerFingerprint"]:
            raise RuntimeRefused("native service definition changed while paused")
        if entry["kind"] == "windows-service":
            from hermes_cli.update_cmd_windows import _start_windows_gateway_service
            _start_windows_gateway_service(owner["name"])
        else:
            start_native(owner, project, Path(entry["home"]))
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

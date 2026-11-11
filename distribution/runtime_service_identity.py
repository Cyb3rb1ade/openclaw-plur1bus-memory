"""Exact source binding for supported Hermes launchers and native definitions."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import subprocess


class RuntimeRefused(ValueError):
    """A credential-free actionable lifecycle refusal."""


def _identity_api(project):
    from hermes_cli import gateway, gateway_runtime_service_identity
    if Path(gateway.PROJECT_ROOT).resolve() != project:
        raise RuntimeRefused("service identity helper belongs to another source installation")
    return gateway_runtime_service_identity


def _source_arguments(argv, project, cwd):
    """Unwrap only exact vendor launch templates, never arbitrary shell/Python."""
    for _ in range(4):
        if not argv:
            break
        executable = Path(argv[0])
        if executable.resolve() in {(project / ".hermes/bin/hermes").resolve(), (project / ".hermes/bin/hermes.exe").resolve()}:
            if argv[1:2] != ["--run-module"]:
                return argv[1:]
        if re.fullmatch(r"python(?:w|\d+(?:\.\d+)*)?(?:\.exe)?", executable.name.lower()):
            offset = 1
            while offset < len(argv) and argv[offset] in {"-B", "-u", "-I"}:
                offset += 1
            if offset < len(argv) and Path(argv[offset]).is_absolute():
                if Path(argv[offset]).resolve() == project / "hermes_cli/main.py":
                    return argv[offset + 1:]
                raise RuntimeRefused("gateway script belongs to another source installation")
        api = _identity_api(project)
        if argv[0] == "/usr/bin/osascript":
            argv, _ = api._launchd_command(argv)
            continue
        module = api._launch_module(argv)
        if module is None:
            break
        name, args = module
        if argv[1:2] == ["-m"] and (cwd is None or Path(cwd).resolve() != project):
            raise RuntimeRefused("module gateway belongs to another source checkout")
        if name == "hermes_cli.main":
            return args
        if name == "gateway.run":
            return ["gateway", "run", *args]
        if name == "hermes_cli.stderr_timestamp" and len(args) >= 4 and args[0] == "--error-log" and args[2] == "--":
            argv = args[3:]
            continue
        break
    raise RuntimeRefused("gateway launcher is not bound to the selected source installation")


def gateway_options(argv, project, cwd, *, manual, home=None):
    project = Path(project).resolve()
    args = list(_source_arguments(argv, project, cwd))
    if args[:1] and (args[0] in {"--profile", "-p"} or args[0].startswith("--profile=")):
        if args[0].startswith("--profile="):
            selector, args = args[0].split("=", 1)[1], args[1:]
        elif len(args) >= 2:
            selector, args = args[1], args[2:]
        else:
            raise RuntimeRefused("invalid gateway profile selector")
        if home is not None:
            home = Path(home).resolve()
            expected = home.name if home.parent.name == "profiles" else "default"
            if selector != expected:
                raise RuntimeRefused("service launch profile differs from its verified home")
    if args[:2] != ["gateway", "run"]:
        raise RuntimeRefused("unsupported gateway launch command")
    options = []
    for arg in args[2:]:
        if arg in {"--replace", "--force"}:
            # One-time takeover authority is never re-armed during restoration.
            continue
        if arg in {"--quiet", "-q"}:
            options.append("--quiet")
        elif arg == "--verbose":
            options.append(arg)
        elif re.fullmatch(r"-v+", arg):
            options.extend(["--verbose"] * (len(arg) - 1))
        elif arg in {"--no-supervise", "--idle-exit"}:
            options.append(arg)
        elif arg == "--external-supervisor" and not manual:
            options.append(arg)
        else:
            raise RuntimeRefused("custom gateway startup options require explicit external stop/restart")
    return options


def _run(argv):
    return subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", check=True, timeout=15).stdout


def _launchd_records(owner, home, project):
    api = _identity_api(project)
    definition = plistlib.loads(api.read_definition(Path(owner["plist"])))
    api.verify_launchd_plist(definition, owner["label"], home)
    loaded = _run(["launchctl", "print", owner["domain"] + "/" + owner["label"]])
    import pwd
    api.verify_launchd_loaded(loaded, home, uid=os.getuid(), username=pwd.getpwuid(os.getuid()).pw_name)
    blocks = re.findall(r"^\targuments = \{\n(.*?)^\t\}", loaded, re.MULTILINE | re.DOTALL)
    if len(blocks) != 1:
        raise RuntimeRefused("loaded launchd command cannot be verified")
    argv = [line.strip() for line in blocks[0].splitlines()]
    if argv != definition["ProgramArguments"]:
        raise RuntimeRefused("loaded launchd command differs from its restart definition")
    working = re.findall(r"^\tworking directory = (.+)$", loaded, re.MULTILINE)
    return [(argv, working[0] if len(working) == 1 else None),
            (definition["ProgramArguments"], definition.get("WorkingDirectory"))]


def _systemd_records(owner, home, project):
    api = _identity_api(project)
    from hermes_cli.update_cmd_posix_pause import _scope_cmd
    command = _scope_cmd(owner)
    output = _run(command + ["show", owner["unit"], "--no-pager", "--all",
                             "--property=" + ",".join((*api.SYSTEMD_IDENTITY_PROPERTIES, "WorkingDirectory", "NeedDaemonReload"))])
    props = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    if props.get("NeedDaemonReload") != "no":
        raise RuntimeRefused("systemd loaded definition differs from disk; reload through Hermes before installing")
    api.verify_systemd(props, _run(command + ["show-environment"]), home, system=owner["scope"] == "system")
    match = re.fullmatch(r"\{ path=(.*?) ; argv\[\]=(.*?) ; ignore_errors=(?:yes|no) ;(?:.*?)\}", props["ExecStart"])
    if not match:
        raise RuntimeRefused("systemd loaded command cannot be verified")
    return [(shlex.split(match[2]), props.get("WorkingDirectory"))]


def _windows_split(command):
    """Use Windows' own argv grammar for SCM/stock wrapper definitions."""
    import ctypes
    from ctypes import wintypes
    count = ctypes.c_int()
    shell = ctypes.WinDLL("shell32", use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    pointer = shell.CommandLineToArgvW(command, ctypes.byref(count))
    if not pointer:
        raise RuntimeRefused("Windows service command cannot be decoded")
    try:
        return [pointer[i] for i in range(count.value)]
    finally:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree(pointer)


def _windows_product(executable):
    # Read the version resource; never execute the service wrapper to identify it.
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command",
                             "[Diagnostics.FileVersionInfo]::GetVersionInfo($env:PLUR1BUS_WRAPPER_PATH).ProductName"],
                            env=dict(os.environ, PLUR1BUS_WRAPPER_PATH=str(executable)),
                            capture_output=True, text=True, encoding="utf-8", check=True, timeout=15)
    return result.stdout.strip()


def _windows_definition(owner):
    """Stock NSSM registry or WinSW XML; arbitrary SCM wrapper code is unsupported."""
    import psutil
    argv = _windows_split(psutil.win_service_get(owner["name"]).binpath())
    if len(argv) != 1 or not Path(argv[0]).is_absolute():
        raise RuntimeRefused("unsupported custom Windows service wrapper")
    executable = Path(argv[0])
    product = _windows_product(executable)
    if re.fullmatch(r"(?i)nssm(?: (?:32|64)-bit)?", product):
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, "SYSTEM\\CurrentControlSet\\Services\\" + owner["name"] + "\\Parameters") as key:
            values = {name: winreg.QueryValueEx(key, name)[0] for name in ("Application", "AppParameters", "AppDirectory")}
            environment = {}
            for name in ("AppEnvironment", "AppEnvironmentExtra"):
                try:
                    entries = winreg.QueryValueEx(key, name)[0]
                except FileNotFoundError:
                    entries = []
                values[name] = entries
                for item in entries:
                    name, sep, value = item.partition("=")
                    if not sep:
                        raise RuntimeRefused("invalid NSSM launch environment")
                    environment[name] = value
        return [values["Application"], *_windows_split('placeholder ' + values["AppParameters"])[1:]], values["AppDirectory"], values, environment
    if product != "Windows Service Wrapper":
        raise RuntimeRefused("unsupported custom Windows service wrapper")
    import xml.etree.ElementTree as ET
    from hermes_cli.gateway_runtime_service_identity import read_definition
    definition = read_definition(executable.with_suffix(".xml"))
    root = ET.fromstring(definition)
    if root.tag != "service" or root.findtext("id") != owner["name"]:
        raise RuntimeRefused("Windows service is not a bound stock WinSW definition")
    if any(root.find(tag) is not None for tag in ("extensions", "prestart", "poststart", "download")):
        raise RuntimeRefused("custom WinSW execution hooks are unsupported")
    def expand(value):
        value = value.replace("%BASE%", str(executable.parent))
        if "%" in value or "$" in value:
            raise RuntimeRefused("Windows wrapper contains unresolved launch variables")
        return value
    application, arguments, directory = (expand(root.findtext(key, "")) for key in ("executable", "arguments", "workingdirectory"))
    environment = {item.get("name", ""): expand(item.get("value", "")) for item in root.findall("env")}
    return [application, *_windows_split('placeholder ' + arguments)[1:]], directory, definition.decode("utf-8-sig"), environment


def windows_definition_fingerprint(owner):
    import psutil
    service = psutil.win_service_get(owner["name"])
    _, _, definition, _ = _windows_definition(owner)
    return hashlib.sha256(json.dumps([service.binpath(), service.username(), definition], sort_keys=True).encode()).hexdigest()


def prove_service_source(owner, project, home):
    """Prove loaded/current launch definition before recording a restart obligation."""
    if owner["kind"] == "launchd":
        records = _launchd_records(owner, home, project)
    elif owner["kind"] == "systemd":
        records = _systemd_records(owner, home, project)
    else:
        argv, cwd, _, environment = _windows_definition(owner)
        configured = environment.get("HERMES_HOME")
        if not configured or Path(configured).resolve() != Path(home).resolve():
            raise RuntimeRefused("Windows service definition does not bind the verified Hermes home")
        records = [(argv, cwd)]
    for argv, cwd in records:
        gateway_options(argv, project, cwd, manual=False, home=home)

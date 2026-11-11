"""Verified standard Desktop and interactive CLI lifecycle; no command replay."""
import hashlib
import json
import math
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time

if __package__:
    from .runtime_service_identity import RuntimeRefused, _source_arguments
else:
    from runtime_service_identity import RuntimeRefused, _source_arguments


def identity(proc):
    from hermes_cli.process_identity import worker_birth, _live_boot_id
    return {'pid': proc.pid, 'born': worker_birth(proc), 'exe': str(Path(proc.exe()).resolve()), 'boot': _live_boot_id()}


def matches(entry):
    import psutil
    from hermes_cli.process_identity import _live_boot_id
    if entry.get('boot') and entry['boot'] != _live_boot_id():
        return False
    try:
        current = identity(psutil.Process(entry['pid']))
        return current['exe'] == entry['exe'] and abs(current['born'] - entry['born']) < .001 and psutil.Process(entry['pid']).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def protected_pids():
    import psutil
    return {os.getpid(), *(p.pid for p in psutil.Process(os.getpid()).parents())}


def _scoped(path, root):
    path = Path(path).resolve()
    return path == root or path.parent == root / 'profiles'


def _fingerprint(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def desktop_target(proc):
    """Capture only a packaged app entry, never arbitrary argv or shell text."""
    exe = Path(proc.exe()).resolve()
    if exe.parent.name == 'MacOS' and exe.parent.parent.name == 'Contents':
        app = exe.parent.parent.parent
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        if not app.name.endswith('.app') or info.get('CFBundleExecutable') != exe.name or exe.name != 'Hermes':
            raise RuntimeRefused('Desktop app executable identity is unsupported')
        target = app
        witness = app / 'Contents/Info.plist'
    else:
        env = proc.environ()
        appimage = env.get('APPIMAGE')
        if appimage:
            target = Path(appimage).resolve()
            if not target.is_file() or not str(exe).startswith(str(Path(env.get('APPDIR', '/nonexistent')).resolve()) + os.sep):
                raise RuntimeRefused('Desktop AppImage launch identity cannot be verified')
            witness = target
        elif exe.name.lower() in {'hermes', 'hermes.exe'} and (exe.parent / 'resources/app.asar').is_file():
            target = exe
            witness = exe.parent / 'resources/app.asar'
        else:
            raise RuntimeRefused('Desktop is not a verified standard packaged app')
    return {'path': str(target), 'witness': str(witness), 'sha256': _fingerprint(witness), 'exeSha256': _fingerprint(exe)}


# Paths consumed by Electron's data-paths.mjs. Receipts never retain arbitrary
# environment values (in particular provider/plugin credentials).
_DESKTOP_PATH_ENV = {'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
                     'XDG_DATA_HOME', 'HERMES_DESKTOP_USER_DATA_DIR', 'HERMES_RUNTIME_DIR',
                     'HERMES_DESKTOP_HERMES_ROOT'}


def desktop_scope(proc):
    """Mirror Electron data-paths.mjs using the original app's environment/cwd."""
    env = proc.environ()
    cwd = Path(proc.cwd())
    def resolved(value):
        return (cwd / value).resolve()
    launch = {key: str(resolved(env[key])) for key in _DESKTOP_PATH_ENV if env.get(key)}
    suffix = env.get('HERMES_DATA_DIR_SUFFIX', '')
    if suffix:
        if any(char in suffix for char in ('/', '\\', '\x00')):
            raise RuntimeRefused('Desktop data directory suffix is unsupported')
        launch['HERMES_DATA_DIR_SUFFIX'] = suffix
    home = env.get('HERMES_HOME')
    if not home and env.get('HERMES_DESKTOP_USER_DATA_DIR'):
        return resolved(env['HERMES_DESKTOP_USER_DATA_DIR']) / 'hermes-home', launch
    if not home and sys.platform == 'win32' and 'HERMES_HOME' not in env:
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
                home = winreg.QueryValueEx(key, 'HERMES_HOME')[0]
        except FileNotFoundError:
            pass
    if home:
        root = resolved(home)
        return (root.parent.parent if root.parent.name.lower() == 'profiles' else root), launch
    user_home = env.get('USERPROFILE' if sys.platform == 'win32' else 'HOME')
    if not user_home and sys.platform != 'win32':
        import pwd
        user_home = pwd.getpwuid(os.getuid()).pw_dir
    if not user_home:
        raise RuntimeRefused('Desktop user home cannot be verified')
    user_home = resolved(user_home)
    if sys.platform == 'win32':
        base = resolved(env['LOCALAPPDATA']) if env.get('LOCALAPPDATA', '').strip() else user_home / 'AppData/Local'
        root = Path(str(base / 'hermes') + suffix)
        legacy = user_home / '.hermes'
        if not suffix and not root.is_dir() and legacy.is_dir():
            root = legacy
    else:
        root = Path(str(user_home / '.hermes') + suffix)
    return root, launch


def packaged_desktops(processes, root, project, excluded, legacy_owners):
    """Find current native-gateway apps without relying on the legacy ledger."""
    import psutil
    entries, foreign = {}, set()
    for proc in processes:
        argv = proc.info.get('cmdline') or []
        if proc.pid in excluded or proc.pid in legacy_owners or not argv or Path(argv[0]).name.lower() not in {'hermes', 'hermes.exe'}:
            continue
        if any(arg == '--type' or arg.startswith('--type=') for arg in argv[1:]):
            continue  # Electron helper, subsequently grouped through its kernel parent.
        try:
            if Path(proc.exe()).name.lower() not in {'hermes', 'hermes.exe'}:
                continue
            target = desktop_target(proc)
            home, launch = desktop_scope(proc)
            if home != root:
                foreign.update([proc.pid, *(child.pid for child in proc.children(recursive=True))])
                continue
            env = proc.environ()
            source = Path(launch.get('HERMES_DESKTOP_HERMES_ROOT', home / 'hermes-agent'))
            if source != project:
                foreign.update([proc.pid, *(child.pid for child in proc.children(recursive=True))])
                continue
            resources = (Path(target['path']) / 'Contents/Resources' if Path(target['path']).suffix == '.app'
                         else Path(proc.exe()).parent / 'resources')
            if (resources / 'agent-payload').exists() or env.get('HERMES_DESKTOP_HERMES') or env.get('HERMES_DESKTOP_IGNORE_EXISTING') == '1':
                raise RuntimeRefused('Desktop backend override requires explicit external close/reopen')
            _supervised(proc)
            entries[proc.pid] = dict(identity(proc), kind='desktop', home=str(home), target=target,
                                    launchEnvironment=launch, connectionMode='gateway',
                                    members=[], backends=[], restorePolicy='reopen')
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            raise RuntimeRefused('Desktop process identity is unreadable; no shutdown was attempted') from None
    return entries, foreign


def _ledger_live(row, proc):
    from hermes_cli.process_identity import _pid_alive_matches, _entry_boot
    return _pid_alive_matches(proc.pid, row.get('create_time'), strict=True, boot=_entry_boot(row, 'boot_start'))


def _source_bound(proc, project):
    try:
        return list(_source_arguments(proc.cmdline(), project, Path(proc.cwd()).resolve()))
    except RuntimeRefused:
        return None


def _supervised(proc):
    if sys.platform != 'win32':
        from hermes_cli.update_cmd_posix_pause import _supervisor_markers
        if _supervisor_markers(proc.pid):
            raise RuntimeRefused('custom supervised client must be stopped through its owner')


def gateway_plugin_host(proc, env, project, excluded):
    """The gateway owns its exact pipe-bound plugin host, including its shutdown."""
    argv = proc.cmdline()
    if len(argv) != 3 or argv[1:] != ['-m', 'hermes_cli.plugin_host_child']:
        return False
    parent = proc.parent()
    if parent is None or parent.pid not in excluded:
        return False
    if env.get('HERMES_PLUGIN_HOST_PROCESS') != '1' or not env.get('HERMES_HOME'):
        return False
    if Path(proc.cwd()).resolve() != Path(env['HERMES_HOME']).resolve():
        return False
    if not env.get('PYTHONPATH'):
        return False
    source = Path(env['PYTHONPATH'].split(os.pathsep)[0]).resolve()
    if source != project:
        from pm.environments import committed_venv
        selected = committed_venv(project)
        if selected is None:
            return False
        if source != (selected.parent / 'workspace').resolve():
            # A gateway can outlive a PM transaction. Its preceding workspace
            # must still match a direct interpreter or live generation lease.
            if source.name != 'workspace' or source.parent.parent != selected.parent.parent:
                return False
            if not generation_bound(parent, source.parent / 'venv'):
                return False
    if Path(argv[0]).resolve() != Path(proc.exe()).resolve() or proc.exe() != parent.exe():
        return False
    if __package__:
        from .runtime_worker import identify
    else:
        from runtime_worker import identify
    owner = identity(parent)
    actual = identify(Path(env['HERMES_HOME']))
    return bool(actual and actual['pid'] == owner['pid'] and matches(owner))


def inspect_clients(root, project, excluded_pids):
    import psutil
    from hermes_cli.process_identity import _read_ledger, LEDGER_FILENAME, install_id
    from hermes_cli.update_cmd_windows import _hermes_holder_subcommand
    rows = _read_ledger(root / LEDGER_FILENAME)
    if rows is None:
        raise RuntimeRefused('Hermes client ledger is corrupt; repair it before installation')
    excluded = set(excluded_pids) | protected_pids()
    relevant = {row.get('pid'): row for row in rows if row.get('install') == install_id(project)
                and row.get('hermes_home') and _scoped(row['hermes_home'], root)}
    processes = list(psutil.process_iter(['pid', 'cmdline']))
    legacy_owners = {row.get('spawner_pid') for row in relevant.values() if row.get('purpose') in {'serve', 'dashboard'}}
    desktop, foreign = packaged_desktops(processes, root, project, excluded, legacy_owners)
    excluded |= foreign
    clients, unclassified = [], []
    for proc in processes:
        if proc.pid in excluded:
            continue
        try:
            argv = proc.info.get('cmdline') or []
            row = relevant.get(proc.pid)
            # Inspect exact entry paths first; unrelated system processes need
            # neither environment access nor privileged process inspection.
            candidate = row or any(Path(arg).is_absolute() and (Path(arg).absolute().is_relative_to(project)
                                  or Path(arg).resolve().is_relative_to(project)
                                  or Path(arg).absolute().is_relative_to(root / 'installs')) for arg in argv)
            if not candidate:
                continue
            env = proc.environ()
            home = env.get('HERMES_HOME') or (row or {}).get('hermes_home')
            if home and not _scoped(home, root):
                continue
            if gateway_plugin_host(proc, env, project, excluded_pids):
                continue
            args = _source_bound(proc, project)
            if args is None and not row:
                unclassified.append(proc.pid)
                continue  # Packaged apps/helpers can live inside the source tree.
            if not home:
                raise RuntimeRefused('client home cannot be verified; close this custom holder first')
            if args is None:
                raise RuntimeRefused('unclassified custom holder of the selected Hermes installation')
            if row and not _ledger_live(row, proc):
                raise RuntimeRefused('client ledger identity changed; inspect a fresh runtime plan')
            role = _hermes_holder_subcommand(subprocess.list2cmdline(argv))
            if role in {'serve', 'dashboard'}:
                if not row or row.get('purpose') not in {'serve', 'dashboard'}:
                    raise RuntimeRefused('backend lacks a verified Desktop owner ledger')
                owner_pid = row.get('spawner_pid')
                ancestors = proc.parents()
                parent = next((p for p in ancestors if p.pid == owner_pid), None)
                # A current kernel lineage also covers Windows' Python shim.
                # Never infer ownership from an inherited PID variable alone.
                if not owner_pid or parent is None or owner_pid in excluded:
                    raise RuntimeRefused('Desktop backend owner cannot be verified or owns this installer')
                owner = identity(parent)
                from hermes_cli.process_identity import process_birth
                if row.get('spawner_create') is not None and abs(process_birth(parent) - row['spawner_create']) >= .001:
                    raise RuntimeRefused('Desktop owner identity changed')
                _supervised(parent)
                target = desktop_target(parent)
                if any(r.get('spawner_pid') == owner_pid and r.get('hermes_home') and not _scoped(r['hermes_home'], root) for r in rows):
                    raise RuntimeRefused('Desktop also owns another installation; close it explicitly')
                entry = desktop.setdefault(owner_pid, dict(owner, kind='desktop', home=str(Path(home).resolve()), target=target,
                                                          members=[], backends=[], restorePolicy='reopen'))
                entry.pop('connectionMode', None)
                entry.setdefault('launchEnvironment', desktop_scope(parent)[1])
                entry['members'].append(identity(proc))
                for ancestor in ancestors:
                    if ancestor.pid == owner_pid:
                        break
                    if ancestor.pid in excluded:
                        raise RuntimeRefused('Desktop backend lineage owns this installer')
                    if ancestor.pid not in {m['pid'] for m in entry['members']}:
                        entry['members'].append(identity(ancestor))
                entry['backends'].append({'pid': proc.pid, 'home': str(Path(home).resolve()), 'role': role, 'port': row.get('port'), 'host': row.get('host')})
            elif role in {None, 'chat'} and row and row.get('purpose') == 'cli':
                require_native_close('cli')
                _supervised(proc)
                clients.append(dict(identity(proc), kind='cli', home=str(Path(home).resolve()), restorePolicy='saved-session', members=[]))
            else:
                raise RuntimeRefused('unclassified custom Hermes job/client; stop it through its owner before installation')
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            raise RuntimeRefused('client process identity is unreadable; no shutdown was attempted') from None
    for entry in desktop.values():
        parent = psutil.Process(entry['pid'])
        known = {m['pid'] for m in entry['members']}
        app = Path(entry['target']['path'])
        for child in parent.children(recursive=True):
            if child.pid in known or child.pid in excluded:
                continue
            exe = Path(child.exe()).resolve()
            if exe == Path(entry['exe']) or (app.suffix == '.app' and exe.is_relative_to(app)):
                entry['members'].append(identity(child))
        clients.append(entry)
    classified = {client['pid'] for client in clients} | {m['pid'] for c in clients for m in c['members']}
    if any(pid not in classified for pid in unclassified):
        raise RuntimeRefused('unclassified custom holder of the selected Hermes installation')
    return clients


def require_native_close(kind):
    # Windows terminate() is TerminateProcess, and a CLI ledger proves neither
    # a console process group nor a cooperative per-client shutdown endpoint.
    if kind == 'cli' and sys.platform == 'win32':
        raise RuntimeRefused('Close interactive Hermes CLI sessions yourself, then retry setup; safely scoped graceful Windows CLI shutdown is unavailable. This CLI was not stopped.')


def native_close(entry):
    """Request ordinary native quit; escalation is separately identity checked."""
    require_native_close(entry['kind'])
    if entry['kind'] != 'desktop' or sys.platform not in {'darwin', 'win32'}:
        import psutil
        psutil.Process(entry['pid']).terminate()
        return
    if sys.platform == 'darwin':
        import ctypes
        ctypes.CDLL('/System/Library/Frameworks/AppKit.framework/AppKit')
        objc = ctypes.CDLL('/usr/lib/libobjc.A.dylib')
        objc.objc_getClass.restype = ctypes.c_void_p
        objc.objc_getClass.argtypes = [ctypes.c_char_p]
        objc.sel_registerName.restype = ctypes.c_void_p
        objc.sel_registerName.argtypes = [ctypes.c_char_p]
        address = ctypes.cast(objc.objc_msgSend, ctypes.c_void_p).value
        get_app = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int)(address)
        app = get_app(objc.objc_getClass(b'NSRunningApplication'), objc.sel_registerName(b'runningApplicationWithProcessIdentifier:'), entry['pid'])
        if not app:
            raise RuntimeRefused('native Desktop application identity disappeared before quit')
        terminate = ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(address)
        terminate(app, objc.sel_registerName(b'terminate'))
    else:
        import ctypes
        from ctypes import wintypes
        user = ctypes.WinDLL('user32', use_last_error=True)
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
        @callback_type
        def close_window(window, _param):
            pid = wintypes.DWORD()
            user.GetWindowThreadProcessId(window, ctypes.byref(pid))
            if pid.value == entry['pid']:
                user.PostMessageW(window, 0x0010, 0, 0)  # WM_CLOSE
            return True
        user.EnumWindows(close_window, 0)


def _living(entries):
    return [entry for entry in entries if matches(entry)]


def _wait(entries, seconds):
    deadline = time.monotonic() + seconds
    while _living(entries) and time.monotonic() < deadline:
        time.sleep(.25)
    return _living(entries)


def stop(entry):
    require_native_close(entry['kind'])
    import psutil
    entries = [entry, *entry.get('members', [])]
    if any(item['pid'] in protected_pids() for item in entries):
        raise RuntimeRefused('client owns this installer; refusing shutdown')
    if not matches(entry):
        raise RuntimeRefused('client process identity changed before shutdown')
    budget = entry.get('shutdownBudget')
    if not isinstance(budget, (int, float)) or not math.isfinite(budget) or budget <= 0:
        raise RuntimeRefused('client shutdown budget is not finite')
    if __package__:
        from .runtime_worker import client_shutdown_budget
    else:
        from runtime_worker import client_shutdown_budget
    if entry['kind'] == 'desktop':
        members = {member['pid']: member for member in entry['members']}
        for owner in [*entry['backends'], *entry.get('gateways', [])]:
            member = members.get(owner['pid'])
            if member is None or not matches(member):
                raise RuntimeRefused('Desktop backend identity changed before shutdown')
    if client_shutdown_budget(entry) > budget:
        raise RuntimeRefused('client shutdown budget changed; inspect a fresh runtime plan before stopping')
    native_close(entry)
    remaining = _wait(entries, budget)
    # Explicit --stop-runtimes consent includes bounded interruption. Every
    # signal targets the same exe + birth, never a process group or new PID.
    for item in remaining:
        if matches(item):
            psutil.Process(item['pid']).terminate()
    remaining = _wait(entries, 5)
    for item in remaining:
        if matches(item):
            psutil.Process(item['pid']).kill()
    if _wait(entries, 5):
        raise RuntimeRefused('verified client failed to exit; installation remains blocked')
    return {'stopped': entry['pid']}


def generation_bound(proc, selected):
    argv = proc.cmdline()
    # A direct venv interpreter is also a canonical PM launch; only the
    # published bootstrap keeps the store argv and uses a generation lease.
    if argv and Path(argv[0]).is_absolute():
        interpreter = Path(argv[0])
        if interpreter.parent in {selected / 'bin', selected / 'Scripts'} and interpreter.resolve() == Path(proc.exe()).resolve():
            return True
    return any(Path(row.path).parent == selected.parent / '.leases' for row in proc.open_files())


def generation_ready(pid, project):
    import psutil
    from pm.environments import committed_venv
    proc = psutil.Process(pid)
    selected = committed_venv(project)
    if selected is not None:
        # PM's published launcher keeps the store executable and activates
        # dependencies in sys.path. Its live lease proves the actual generation.
        if not generation_bound(proc, selected):
            return False
    elif str(sys.executable) not in proc.cmdline():
        return False
    return True


def backend_ready(backend, project):
    import psutil
    if not generation_ready(backend['pid'], project):
        return False
    proc = psutil.Process(backend['pid'])
    return any(c.status == psutil.CONN_LISTEN and c.laddr.port == backend['port']
               for c in proc.net_connections(kind='tcp'))


def _desktop_launch_identity(launch, project):
    allowed = _DESKTOP_PATH_ENV | {'HERMES_DATA_DIR_SUFFIX'}
    if set(launch) - allowed:
        raise RuntimeRefused('Desktop receipt contains unsupported launch environment')
    normalized = {key: str(Path(value).resolve()) for key, value in launch.items()
                  if key in _DESKTOP_PATH_ENV and value}
    # Inventory already proved the selected source. Resume makes that default
    # explicit, including for legacy apps whose first backend is a named profile.
    normalized.setdefault('HERMES_DESKTOP_HERMES_ROOT', str(project.resolve()))
    if launch.get('HERMES_DATA_DIR_SUFFIX'):
        normalized['HERMES_DATA_DIR_SUFFIX'] = launch['HERMES_DATA_DIR_SUFFIX']
    return normalized


def _desktop_instance_matches(entry, current, project):
    if not current or current['target'] != entry['target']:
        return False
    if entry.get('connectionMode', 'backend') != current.get('connectionMode', 'backend'):
        return False
    def root(record):
        home = Path(record.get('home', project.parent)).resolve()
        return home.parent.parent if home.parent.name.lower() == 'profiles' else home
    if root(entry) != root(current):
        return False
    # Older receipts have no launch isolation evidence; retain their existing
    # backend ownership contract, without weakening newer recorded obligations.
    if 'launchEnvironment' not in entry:
        return True
    return ('launchEnvironment' in current
            and _desktop_launch_identity(entry['launchEnvironment'], project)
            == _desktop_launch_identity(current['launchEnvironment'], project))


def _desktop_ready(entry, current, project):
    if not _desktop_instance_matches(entry, current, project):
        return False
    expected = {(b['home'], b['role']) for b in entry['backends']}
    if expected != {(b['home'], b['role']) for b in current['backends']}:
        return False
    if not all(backend_ready(backend, project) for backend in current['backends']):
        return False
    gateways = [*entry.get('gateways', []), *entry.get('gatewayDependencies', [])]
    if entry.get('connectionMode') == 'gateway' and not gateways:
        return False
    if gateways:
        if __package__:
            from .runtime_worker import identify, ready
        else:
            from runtime_worker import identify, ready
        for gateway in gateways:
            actual = identify(Path(gateway['home']))
            if not ready(gateway, actual) or not generation_ready(actual['pid'], project):
                return False
    return True


def resume(entry, project):
    if entry['kind'] == 'cli':
        if matches(entry):
            raise RuntimeRefused('original interactive CLI is still running; close it before retrying')
        return {'pid': None, 'disposition': 'closed-session-saved',
                'message': 'Interactive CLI closed. Saved sessions can be resumed in Hermes; commands and jobs were not replayed.'}
    target = entry['target']
    if _fingerprint(target['witness']) != target['sha256']:
        raise RuntimeRefused('Desktop launch target changed since shutdown')
    launch = Path(entry['exe']) if Path(target['path']).suffix == '.app' else Path(target['path'])
    if Path(target['witness']) != launch and _fingerprint(launch) != target['exeSha256']:
        raise RuntimeRefused('Desktop executable changed since shutdown')
    root = project.parent
    def observed():
        if __package__:
            from .runtime_worker import inventory
        else:
            from runtime_worker import inventory
        candidates = inventory(root, project)
        return next((c for c in candidates if c['kind'] == 'desktop' and _desktop_instance_matches(entry, c, project)), None)
    current = observed()
    if _desktop_ready(entry, current, project):
        return {'pid': current['pid']}
    if any(matches(item) for item in [entry, *entry.get('members', [])]):
        raise RuntimeRefused('original Desktop/backend is still closing; retry restoration after it exits')
    if current is None:
        if __package__:
            from .runtime_worker import profile_environment
        else:
            from runtime_worker import profile_environment
        env = profile_environment(entry['home'], project)
        if 'launchEnvironment' in entry:
            allowed = _DESKTOP_PATH_ENV | {'HERMES_DATA_DIR_SUFFIX'}
            if set(entry['launchEnvironment']) - allowed:
                raise RuntimeRefused('Desktop receipt contains unsupported launch environment')
            for key in allowed:
                env.pop(key, None)
            env.update(entry['launchEnvironment'])
            env['HERMES_DESKTOP_HERMES_ROOT'] = str(project)
        log_dir = root / 'logs'
        log_dir.mkdir(exist_ok=True)
        with (log_dir / 'plur1bus-desktop-resume.log').open('ab') as log:
            subprocess.Popen([str(launch)], cwd=project, env=env, stdin=subprocess.DEVNULL,
                             stdout=log, stderr=log, start_new_session=True, close_fds=True)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        current = observed()
        if _desktop_ready(entry, current, project):
            return {'pid': current['pid']}
        time.sleep(.5)
    raise RuntimeRefused('Desktop reopened but selected-generation backend readiness was not verified; retry using the receipt')

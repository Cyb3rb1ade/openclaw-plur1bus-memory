"""Native close smoke using disposable processes, never Hermes."""
import os
import json
import platform
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from distribution.runtime_clients import native_close


def windows_fixture(marker):
    import ctypes
    from ctypes import wintypes
    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    user.DefWindowProcW.restype = ctypes.c_ssize_t
    user.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    @callback_type
    def window_proc(hwnd, message, wparam, lparam):
        if message == 2:  # WM_DESTROY
            user.PostQuitMessage(0)
            return 0
        return user.DefWindowProcW(hwnd, message, wparam, lparam)
    class WNDCLASS(ctypes.Structure):
        _fields_ = [('style', wintypes.UINT), ('proc', callback_type), ('extra_class', ctypes.c_int),
                    ('extra_window', ctypes.c_int), ('instance', wintypes.HINSTANCE), ('icon', wintypes.HICON),
                    ('cursor', wintypes.HANDLE), ('background', wintypes.HBRUSH), ('menu', wintypes.LPCWSTR),
                    ('name', wintypes.LPCWSTR)]
    kernel.GetModuleHandleW.restype = wintypes.HMODULE
    instance = kernel.GetModuleHandleW(None)
    cls = WNDCLASS(0, window_proc, 0, 0, instance, None, None, None, None, 'Plur1busNativeFixture')
    user.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASS)]
    if not user.RegisterClassW(ctypes.byref(cls)):
        raise ctypes.WinError(ctypes.get_last_error())
    user.CreateWindowExW.restype = wintypes.HWND
    user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU,
        wintypes.HINSTANCE, wintypes.LPVOID]
    hwnd = user.CreateWindowExW(0, cls.name, 'fixture', 0, 0, 0, 100, 100, None, None, instance, None)
    if not hwnd:
        raise ctypes.WinError(ctypes.get_last_error())
    Path(marker).write_text('ready')
    msg = wintypes.MSG()
    while True:
        result = user.GetMessageW(ctypes.byref(msg), None, 0, 0)
        if result == -1:
            raise ctypes.WinError(ctypes.get_last_error())
        if result == 0:
            break
        user.TranslateMessage(ctypes.byref(msg))
        user.DispatchMessageW(ctypes.byref(msg))


def process_smoke():
    with tempfile.TemporaryDirectory(prefix='plur1bus-native-client-') as directory:
        processes = []
        try:
            for index in range(2):
                marker = Path(directory) / str(index)
                command = ([sys.executable, __file__, '--fixture', str(marker)] if sys.platform == 'win32'
                           else [sys.executable, '-c', 'import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); time.sleep(120)', str(marker)])
                proc = subprocess.Popen(command)
                processes.append(proc)
                deadline = time.monotonic() + 10
                while not marker.exists() and proc.poll() is None and time.monotonic() < deadline:
                    time.sleep(.1)
                if not marker.exists():
                    raise RuntimeError('native fixture failed to start')
            native_close({'kind': 'desktop', 'pid': processes[0].pid})
            processes[0].wait(timeout=10)
            expected = 0 if sys.platform == 'win32' else -15
            if processes[0].returncode != expected or processes[1].poll() is not None:
                raise RuntimeError('native close did not preserve unrelated process')
            print('PASS native ' + ('WM_CLOSE' if sys.platform == 'win32' else 'SIGTERM') + ' target; unrelated fixture remained running')
        finally:
            for proc in processes:
                if proc.poll() is None:
                    proc.terminate()
                proc.wait(timeout=10)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        windows_fixture(sys.argv[2])
        return
    if sys.platform in {'win32', 'linux'}:
        process_smoke()
        return
    if sys.platform != 'darwin':
        raise SystemExit('Native Cocoa smoke requires macOS')
    with tempfile.TemporaryDirectory(prefix='plur1bus-native-client-') as directory:
        root = Path(directory)
        source = root / 'Fixture.swift'
        source.write_text('''import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
try! Data("ready".utf8).write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
app.run()
''')
        binary = root / 'Fixture'
        subprocess.run(['/usr/bin/swiftc', str(source), '-o', str(binary)], check=True, timeout=60)
        processes = []
        try:
            for index in range(2):
                app = root / ('Fixture' + str(index) + '.app')
                executable = app / 'Contents/MacOS/Fixture'
                executable.parent.mkdir(parents=True)
                executable.write_bytes(binary.read_bytes())
                executable.chmod(0o700)
                (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable': 'Fixture', 'CFBundleIdentifier': 'test.plur1bus.runtime.fixture' + str(index), 'CFBundlePackageType': 'APPL'}))
                marker = root / ('ready' + str(index))
                proc = subprocess.Popen([str(executable), str(marker)], env=dict(os.environ, HOME=str(root), HERMES_HOME=str(root / 'state'), HERMES_RUNTIME_DIR=str(root / 'runtime')), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                processes.append(proc)
                deadline = time.monotonic() + 10
                while not marker.exists() and proc.poll() is None and time.monotonic() < deadline:
                    time.sleep(.1)
                if not marker.exists():
                    raise RuntimeError('fixture app did not become ready')
            native_close({'kind': 'desktop', 'pid': processes[0].pid})
            processes[0].wait(timeout=10)
            if processes[0].returncode != 0 or processes[1].poll() is not None:
                raise RuntimeError('native quit did not preserve the other fixture app')
            print('PASS native NSRunningApplication quit: target exited normally; unrelated fixture remained running')
        finally:
            for proc in processes:
                if proc.poll() is None:
                    proc.terminate()
                proc.communicate(timeout=10)


if __name__ == '__main__':
    main()
    output = os.environ.get('PLUR1BUS_NATIVE_CLIENT_EVIDENCE')
    if output and '--fixture' not in sys.argv:
        primitive = {'darwin': 'NSRunningApplication', 'win32': 'WM_CLOSE', 'linux': 'SIGTERM'}[sys.platform]
        Path(output).write_text(json.dumps({'schema': 1, 'status': 'passed', 'primitive': primitive,
            'platform': sys.platform, 'architecture': platform.machine(),
            'packageSourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
            'targetExited': True, 'unrelatedPreserved': True}, indent=2) + '\n', encoding='utf-8')

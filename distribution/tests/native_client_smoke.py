"""Opt-in macOS native-quit smoke using two disposable Cocoa apps, never Hermes."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from distribution.runtime_clients import native_close


def main():
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

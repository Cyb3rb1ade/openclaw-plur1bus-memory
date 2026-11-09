"""Run the Hermes 0.23.0 volume-flush backport in installer processes only."""

import ctypes
import hashlib
import importlib.abc
import importlib.util
import inspect
import json
import os
from pathlib import Path
import runpy
import sys


# Hermes v0.23.0, commit 2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19.
# Pin the modified modules and the private PM worker launch contract.
STOCK_PM_SHA256 = {
    "__init__.py": "67adcba1f0e4db2b2967d07e6b630aca4214b1fac9bd8649dcf221b4bf3fcfac",
    "client.py": "8dcca7cd9ecce89f43122c89aa273dfdf6c8e6775e4a36c0ae5f3e5f815d46f1",
    "environments.py": "bfddba8093866c66fae12115389d78a2a65adc84f68b634a989775923c42268b",
    "install.py": "2f48a18bb2b8c452432ddd675599bb859e7a1dcdcbadd5326b252376d1b4b1a0",
    "operations.py": "65cd03cdfa35d6a2873d38df663112b6395b00205e279bcd669fa78a8d08b44c",
    "runtime.py": "68d6ae47d2e0143f3cc377e462e3588abbb0e857bbc9f22442a3f66ebe54c478",
    "worker.py": "1a1920583f06d2ef47000560a11cc7ad0e526793039fc6a67349fc9ef8fb75fa",
    "worker_operations.py": "d433093daa7f0d23cd4be16e04d1c562c997721d2ca5cc44fdf9dd2a0edbfac9",
}


def approved_sources(project):
    """Read the complete PM sources that bind the installer workaround."""
    pm = project / "pm"
    if pm.is_symlink():
        return None
    sources = {}
    for name, expected in STOCK_PM_SHA256.items():
        path = pm / name
        if path.is_symlink() or not path.is_file():
            return None
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            return None
        sources[name] = data
    return sources


def _flush_volume(generation):
    sync_volume = ctypes.CDLL(None).sync_volume_np
    sync_volume.argtypes = (ctypes.c_char_p, ctypes.c_int)
    sync_volume.restype = ctypes.c_int
    fullsync, wait = 0x01, 0x02
    error = sync_volume(os.fsencode(generation), fullsync | wait)
    if error:
        raise OSError(error, os.strerror(error), os.fspath(generation))


class _ScopedSources(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Load the backport with Hermes' original module names and file paths."""

    def __init__(self, project, sources):
        self.project = project
        self.sources = sources

    def find_spec(self, fullname, path=None, target=None):
        if fullname in self.sources:
            original = self.project / "pm" / (fullname.split(".")[-1] + ".py")
            return importlib.util.spec_from_file_location(fullname, original, loader=self)
        return None

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        exec(compile(self.sources[module.__name__], module.__file__, "exec"), vars(module))
        if module.__name__ == "pm.environments":
            module.flush_before_selecting = _flush_volume


def enable_volume_sync(project, required=False):
    """Backport Hermes PR #151491 in this process after checking the host files."""
    stock = approved_sources(project)
    if stock is None:
        if required:
            raise ValueError("Hermes PM source changed after approving the volume sync workaround")
        return False
    source = {
        "pm.environments": stock["environments.py"],
        "pm.install": stock["install.py"].replace(
            b'        if change is not None:\n'
            b'            change.publish(paths.repo_root())\n'
            b'        if not current:\n'
            b'            if result.get("environment") is not None:\n'
            b'                from pm.environments import flush_before_selecting\n'
            b'                flush_before_selecting()\n',
            b'        if not current and result.get("environment") is not None:\n'
            b'            from pm.environments import flush_before_selecting\n'
            b'            flush_before_selecting(result["environment"])\n'
            b'        if change is not None:\n'
            b'            change.publish(paths.repo_root())\n'
            b'        if not current:\n',
        ),
        "pm.operations": stock["operations.py"].replace(
            b"            flush_before_selecting()\n", b"            flush_before_selecting(generation)\n"
        ),
    }
    if source["pm.install"] == stock["install.py"] or source["pm.operations"] == stock["operations.py"]:
        raise ValueError("Hermes PM volume sync backport does not match the approved call sites")
    if source.keys() & sys.modules.keys():
        raise ValueError("Hermes PM modules were already loaded before the volume sync workaround")
    sys.meta_path.insert(0, _ScopedSources(project, source))
    return True


def volume_sync_worker(command_builder):
    """Run Hermes' real worker protocol inside a second isolated backport process."""
    def build(spec, arguments, worker, environment):
        command = command_builder(spec, arguments, worker, environment)
        if not command or command[-1] != str(worker):
            raise ValueError("unexpected Hermes PM worker command")
        return command[:-1] + [str(Path(__file__).resolve()), "worker", str(worker)]

    return build


def main():
    if sys.platform != "darwin":
        raise ValueError("the Hermes PM volume sync helper requires macOS")
    mode, source, *args = sys.argv[1:]
    if mode == "worker":
        worker = Path(source).resolve(strict=True)
        project = worker.parents[1]
        if worker != project / "pm" / "worker.py":
            raise ValueError("unexpected Hermes PM worker path")
        sys.path.insert(0, str(project))
        enable_volume_sync(project, required=True)
        sys.argv = [str(worker)]
        runpy.run_path(str(worker), run_name="__main__")
        return

    project = Path(source).resolve(strict=True)
    requirement, *args = args
    sys.path.insert(0, str(project))
    scoped = enable_volume_sync(project, required=requirement == "required")
    if mode == "probe":
        from pm import environments

        flush = getattr(environments, "flush_before_selecting", None)
        if flush is not None:
            if inspect.signature(flush).parameters:
                flush(args[0])
            else:
                flush()
    elif mode == "admit":
        from pm import client
        from pm.plugin_inputs import Selection

        if scoped:
            client._worker_command = volume_sync_worker(client._worker_command)
        client.sync_venv(explicit=True, plugins=Selection(json.load(sys.stdin)), project_root=project)
    else:
        raise ValueError("unknown Hermes PM volume sync helper mode")


if __name__ == "__main__":
    main()

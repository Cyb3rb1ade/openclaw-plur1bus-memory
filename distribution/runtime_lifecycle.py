"""Durable, scoped runtime restart obligations for a single installer transaction."""
import json
import math
import os
from pathlib import Path
import subprocess
import time


class RuntimeLifecycle:
    def __init__(self, home, python, persist, progress=None, *, worker=None):
        self.home = Path(home).resolve()
        self.python = python
        self.persist = persist
        self.progress = progress or (lambda event: None)
        self.worker = worker or self._worker
        self.state = {"original": [], "stopped": [], "restored": []}

    def _worker(self, action, entry=None):
        environment = dict(os.environ, HERMES_HOME=str(self.home))
        # The selected interpreter is resolved for EVERY operation: PM may have
        # published a new generation while the gateway was paused.
        command = [str(self.python()), "-I", "-B", str(Path(__file__).with_name("runtime_worker.py")), str(self.home), action]
        budget = entry.get("shutdownBudget", 0) if entry else 0
        if not isinstance(budget, (int, float)) or not math.isfinite(budget) or budget < 0:
            raise ValueError("invalid runtime shutdown budget")
        # Complete after-turn/drain envelope, native service operations (up to
        # 120s), then readiness (90s), plus helper startup/IPC headroom.
        timeout = budget + 300 if action in {"stop", "resume"} else 900
        started = time.monotonic()
        with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, encoding="utf-8", env=environment) as proc:
            payload = json.dumps(entry)
            while True:
                try:
                    stdout, _stderr = proc.communicate(payload, timeout=10)
                    break
                except subprocess.TimeoutExpired:
                    payload = None
                    elapsed = int(time.monotonic() - started)
                    if elapsed >= timeout:
                        proc.kill()
                        proc.communicate()
                        raise ValueError("Hermes runtime helper exceeded its deadline; recovery receipt retained")
                    self.progress({"phase": "restarting-runtimes" if action == "resume" else "waiting-for-runtimes",
                                   "elapsedSeconds": elapsed})
            result = subprocess.CompletedProcess(command, proc.returncode, stdout)
        if result.returncode:
            # Worker errors are deliberately bounded and exclude argv/env/secrets.
            try:
                message = json.loads(result.stdout)["error"]
            except (ValueError, KeyError):
                message = "Hermes lifecycle helper failed; inspect the runtime receipt"
            raise ValueError(message)
        return json.loads(result.stdout)

    def pause(self):
        self.progress({"phase": "inspecting-runtimes"})
        unique = {}
        for entry in self.worker("inventory"):
            home = Path(entry["home"]).resolve()
            if home != self.home and (home.parent != self.home / "profiles"):
                raise ValueError("runtime belongs to another Hermes home")
            pid = entry["pid"]
            if pid in unique and unique[pid] != entry:
                raise ValueError("conflicting runtime identity for shared PID")
            unique[pid] = entry
        self.state["original"] = [dict(entry, state="running") for entry in unique.values()]
        self.persist(self.state)
        for entry in self.state["original"]:
            self.progress({"phase": "stopping-runtimes", "pid": entry["pid"]})
            entry["state"] = "stop-requested"
            self.persist(self.state)
            self.progress({"phase": "waiting-for-runtimes", "pid": entry["pid"]})
            self.worker("stop", entry)
            entry["state"] = "stopped"
            self.state["stopped"].append(entry["pid"])
            self.persist(self.state)
        self.verify_stopped()

    def verify_stopped(self):
        if self.worker("inventory"):
            raise ValueError("Hermes runtime still running or respawned; no installation writes allowed")

    def restore(self):
        failures = []
        for entry in self.state["original"]:
            if entry["state"] in {"running", "restored"}:
                continue
            self.progress({"phase": "restarting-runtimes", "pid": entry["pid"]})
            try:
                result = self.worker("resume", entry)
                entry["state"] = "restored"
                entry["restoredPid"] = result["pid"]
                self.state["restored"].append(entry["pid"])
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                entry["error"] = str(error) if isinstance(error, ValueError) else type(error).__name__
                entry["state"] = "restart-failed"
                failures.append(entry["pid"])
            self.persist(self.state)
        if failures:
            raise ValueError("Hermes runtime restoration not verified; inspect runtime receipt for PIDs " + ", ".join(map(str, failures)))

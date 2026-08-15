"""Scheduled maintenance runner for the Hermes PLUR1BUS provider."""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .runtime import Plur1busRuntime
from .validation import safe_agent_id
from .rate_gate import JobRateGate


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _lock_pid_is_alive(lock_path: Path) -> bool:
    try:
        pid = int(lock_path.read_text(encoding="ascii").strip())
        if pid <= 0:
            return False
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def run_jobs(
    data_dir: Path,
    config: dict[str, Any],
    agent_id: str,
    mode: str,
    *,
    runtime_factory: Callable[..., Any] = Plur1busRuntime,
    acl_bindings: Any = None,
    scope_key: str | None = None,
    scope: Any = None,
    aclBindings: Any = None,
    scopeKey: str | None = None,
) -> dict[str, Any]:
    """Run one agent's maintenance jobs under a non-overlapping file lock."""
    acl_bindings = aclBindings if aclBindings is not None else acl_bindings
    scope_key = scopeKey if scopeKey is not None else scope_key
    if acl_bindings is None and scope is not None:
        acl_bindings = scope
    agent_id = safe_agent_id(agent_id)
    if mode not in {"hourly", "daily", "all"}:
        raise ValueError("mode must be hourly, daily, or all")
    state_dir = Path(data_dir) / "state" / agent_id
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / "maintenance.lock"
    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        age = time.time() - lock_path.stat().st_mtime
        if age <= 21_600 and _lock_pid_is_alive(lock_path):
            return {"status": "skipped", "reason": "job-already-running", "agentId": agent_id}
        lock_path.unlink()
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(lock_fd, f"{os.getpid()}\n".encode("ascii"))
    os.close(lock_fd)
    runtime = None
    try:
        runtime_scope = acl_bindings if acl_bindings is not None else scope
        runtime = runtime_factory(
            Path(data_dir),
            config,
            agent_id,
            runtime_scope if runtime_scope is not None else {"agent_id": agent_id},
        )
        table, _ = runtime._table(create=False)
        if table is None:
            report = {
                "status": "skipped",
                "reason": "memory-table-unavailable",
                "agentId": agent_id,
                "mode": mode,
                "completedAt": _utcnow(),
            }
        else:
            domain = runtime._domain
            gate = JobRateGate(state_dir / "job-rate-limits.json")
            results: dict[str, Any] = {}

            scope_kwargs = {}
            if acl_bindings is not None:
                scope_kwargs["acl_bindings"] = acl_bindings
            if scope_key is not None:
                scope_kwargs["scope_key"] = scope_key

            def scoped_call(method: Callable[..., Any], *args: Any) -> Any:
                return method(*args, **scope_kwargs) if scope_kwargs else method(*args)

            if mode in {"hourly", "all"}:
                results["dynamics"] = gate.run(
                    "dynamics", 3_600, lambda: scoped_call(domain.run_dynamics)
                )
                results["proactiveCheck"] = gate.run(
                    "proactive-check", 1_800, domain.proactive_check
                )
                # Deliberate divergence from upstream 7.1.9 (a130015): upstream
                # raised this cadence to 3 h to save model-carrier tokens. The
                # port's afterthought is LLM-free and deterministic
                # (proactive.py), so the token rationale does not apply, and the
                # hourly launchd cadence lands inside the 30-120 min proactive
                # window far better than a 3 h spacing.
                results["afterthought"] = gate.run(
                    "afterthought", 1_800, domain.run_afterthought
                )
                reminders = scoped_call(domain.due_reminders)
                results["reminders"] = {"due": len(reminders)}
                _atomic_json(state_dir / "pending-reminders.json", {
                    "generatedAt": _utcnow(),
                    "agentId": agent_id,
                    "reminders": reminders,
                })
            if mode in {"daily", "all"}:
                results["metaReflection"] = gate.run(
                    "meta-reflection", 604_800, domain.run_meta_reflection
                )
                results["criticalAutoAccept"] = gate.run(
                    "critical-auto-accept",
                    86_400,
                    domain.auto_accept_stale_criticals,
                )
                results["consolidation"] = gate.run(
                    "consolidation", 86_400, lambda: scoped_call(domain.run_consolidation, table)
                )
                if (config.get("gc") or {}).get("enabled") is True:
                    results["gc"] = gate.run(
                        "gc", 86_400, lambda: scoped_call(domain.run_gc, table)
                    )
                results["dreaming"] = gate.run(
                    "rem-dream", 604_800, lambda: scoped_call(domain.run_dreaming, table)
                )
                results["indexes"] = gate.run(
                    "indexes", 86_400, lambda: scoped_call(domain.rebuild_indexes, table)
                )
                results["obsidian"] = gate.run(
                    "obsidian", 86_400, lambda: scoped_call(domain.maintain_obsidian)
                )
                results["codeIndex"] = gate.run(
                    "code-index", 86_400, domain.rebuild_code_index
                )
            report = {
                "status": "completed",
                "agentId": agent_id,
                "mode": mode,
                "completedAt": _utcnow(),
                "results": results,
            }
        _atomic_json(state_dir / f"maintenance-{mode}.json", report)
        return report
    finally:
        if runtime is not None:
            runtime.shutdown(timeout_seconds=30)
        lock_path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for launchd, cron, or manual maintenance."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--mode", choices=("hourly", "daily", "all"), default="all")
    arguments = parser.parse_args(argv)
    config = json.loads(arguments.config.read_text(encoding="utf-8"))
    result = run_jobs(arguments.data_dir, config, arguments.agent, arguments.mode)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] in {"completed", "skipped"} else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Scheduled maintenance runner for the Hermes PLUR1BUS provider."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .runtime import Plur1busRuntime
from .namespaces import binding_from_scope
from .validation import safe_agent_id
from .rate_gate import JobRateGate
from . import file_lock
from .validation import resolve_inside


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


def _owner_state_dir(
    data_dir: Path,
    agent_id: str,
    acl_bindings: Any,
    scope_key: str | None,
) -> tuple[Path, str, str]:
    """Resolve an owner-bound job state directory without path-using raw input."""
    if acl_bindings is None and scope_key is None:
        binding = binding_from_scope(agent_id)
        return Path(data_dir) / "state" / agent_id, binding.scope_key, binding.scope_type
    if acl_bindings is not None:
        binding = binding_from_scope(agent_id, acl_bindings)
        if scope_key is not None and str(scope_key) != binding.scope_key:
            raise ValueError("scopeKey does not match ACL binding")
        resolved_key = binding.scope_key
        scope_type = binding.scope_type
    else:
        resolved_key = str(scope_key or "").strip()
        if not resolved_key:
            raise ValueError("scopeKey is required")
        scope_type = "opaque"
    storage_key = (
        resolved_key
        if len(resolved_key) == 64
        and all(character in "0123456789abcdef" for character in resolved_key)
        else hashlib.sha256(f"{scope_type}:{resolved_key}".encode("utf-8")).hexdigest()
    )
    return (
        Path(data_dir) / "state" / agent_id / "scopes" / storage_key,
        resolved_key,
        scope_type,
    )


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
    if acl_bindings is None and config.get("scopeType"):
        acl_bindings = {
            "scopeType": config.get("scopeType"),
            "workspaceIdentity": config.get("workspaceId")
            or config.get("workspaceIdentity"),
            "platform": config.get("platform"),
            "userId": config.get("userId") or config.get("ownerUserId"),
            "chatId": config.get("chatId"),
            "account": config.get("account"),
        }
    agent_id = safe_agent_id(agent_id)
    if mode not in {"hourly", "daily", "all"}:
        raise ValueError("mode must be hourly, daily, or all")
    state_dir, resolved_scope_key, scope_type = _owner_state_dir(
        Path(data_dir), agent_id, acl_bindings, scope_key
    )
    state_dir = resolve_inside(str(data_dir), str(state_dir.relative_to(Path(data_dir))))
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / "maintenance.lock"
    lock_fd = file_lock.open_lock(lock_path)
    try:
        file_lock.flock(lock_fd, file_lock.LOCK_EX | file_lock.LOCK_NB)
    except BlockingIOError:
        os.close(lock_fd)
        return {"status": "skipped", "reason": "job-already-running", "agentId": agent_id}
    except BaseException:
        os.close(lock_fd)
        raise
    if os.fstat(lock_fd).st_size:
        # Pre-OS-lease versions wrote a PID then removed this file at exit.
        # Do not guess that an old owner is dead (PID reuse, Windows os.kill).
        os.close(lock_fd)
        return {"status": "partial", "reason": "legacy-maintenance-lock-needs-review", "agentId": agent_id}
    runtime = None
    try:
        runtime_scope = acl_bindings if acl_bindings is not None else scope
        runtime = runtime_factory(
            Path(data_dir),
            config,
            agent_id,
            runtime_scope,
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
            elif acl_bindings is not None:
                scope_kwargs["scope_key"] = resolved_scope_key

            def scoped_call(method: Callable[..., Any], *args: Any) -> Any:
                return method(*args, **scope_kwargs) if scope_kwargs else method(*args)

            if mode in {"hourly", "all"}:
                if (config.get("obsidianBridge") or {}).get("watch") is True:
                    from .obsidian_sync import watch_obsidian
                    results["obsidianWatch"] = gate.run("obsidian-watch", 3600, lambda: watch_obsidian(runtime))
                results["dynamics"] = gate.run(
                    "dynamics", 3_600, lambda: scoped_call(domain.run_dynamics)
                )
                results["proactiveCheck"] = (
                    gate.run("proactive-check", 1_800, domain.proactive_check)
                    if scope_type == "agent-private"
                    else {"skipped": True, "reason": "agent-private-only"}
                )
                # Deliberate divergence from upstream 7.1.9 (a130015): upstream
                # raised this cadence to 3 h to save model-carrier tokens. The
                # port's afterthought is LLM-free and deterministic
                # (proactive.py), so the token rationale does not apply, and the
                # hourly launchd cadence lands inside the 30-120 min proactive
                # window far better than a 3 h spacing.
                results["afterthought"] = (
                    gate.run("afterthought", 1_800, domain.run_afterthought)
                    if scope_type == "agent-private"
                    else {"skipped": True, "reason": "agent-private-only"}
                )
                reminders = scoped_call(domain.due_reminders)
                results["reminders"] = {"due": len(reminders)}
                _atomic_json(state_dir / "pending-reminders.json", {
                    "generatedAt": _utcnow(),
                    "agentId": agent_id,
                    "scopeKey": resolved_scope_key,
                    "reminders": reminders,
                })
            if mode in {"daily", "all"}:
                if callable(getattr(domain, "run_episode_narratives", None)):
                    results["episodeNarratives"] = gate.run(
                        "episode-narratives", 86_400, lambda: scoped_call(domain.run_episode_narratives)
                    )
                results["metaReflection"] = (
                    gate.run("meta-reflection", 604_800, domain.run_meta_reflection)
                    if scope_type == "agent-private"
                    else {"skipped": True, "reason": "agent-private-only"}
                )
                # These optional LLM features are deliberately job-bound, not
                # prompt-path work.  Each implementation validates its own
                # configured opt-in and returns a clear skipped reason.
                results["llmMetaReflection"] = (
                    gate.run("llm-meta-reflection", 604_800, domain.run_llm_meta_reflection)
                    if scope_type == "agent-private" and callable(getattr(domain, "run_llm_meta_reflection", None))
                    else {"skipped": True, "reason": "agent-private-only-or-unavailable"}
                )
                results["lightDream"] = (
                    gate.run("light-dream", 86_400, lambda: scoped_call(domain.run_light_dream))
                    if scope_type == "agent-private" and callable(getattr(domain, "run_light_dream", None))
                    else {"skipped": True, "reason": "agent-private-only-or-unavailable"}
                )
                results["knowledgeProposals"] = (
                    gate.run("knowledge-promotions", 86_400, lambda: scoped_call(domain.propose_knowledge_promotions))
                    if scope_type == "agent-private" and callable(getattr(domain, "propose_knowledge_promotions", None))
                    else {"skipped": True, "reason": "agent-private-only-or-unavailable"}
                )
                results["personaSeed"] = (
                    gate.run("persona-seed", 86_400, lambda: scoped_call(domain.ensure_persona_voice_seed))
                    if scope_type == "agent-private" and callable(getattr(domain, "ensure_persona_voice_seed", None))
                    else {"skipped": True, "reason": "agent-private-only-or-unavailable"}
                )
                results["criticalAutoAccept"] = gate.run(
                    "critical-auto-accept",
                    86_400,
                    lambda: scoped_call(domain.auto_accept_stale_criticals),
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
                results["codeIndex"] = (
                    gate.run("code-index", 86_400, domain.rebuild_code_index)
                    if scope_type == "agent-private"
                    else {"skipped": True, "reason": "agent-private-only"}
                )
            incomplete = any(
                isinstance(result, dict) and result.get("complete") is False
                for result in results.values()
            )
            report = {
                "status": "partial" if incomplete else "completed",
                "agentId": agent_id,
                "scopeKey": resolved_scope_key,
                "mode": mode,
                "completedAt": _utcnow(),
                "results": results,
            }
        _atomic_json(state_dir / f"maintenance-{mode}.json", report)
        return report
    finally:
        try:
            if runtime is not None:
                runtime.shutdown(timeout_seconds=30)
        finally:
            # Never unlink an OS lock: another process may already have the
            # same inode open. Descriptor close also releases locks on crashes.
            os.close(lock_fd)


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

"""Explicit local-operator commands; no gateway activation or model switching."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace

from .namespaces import NamespaceRoute, binding_from_scope, normalize_scope_context, resolve_namespace_routes
from .operator_status import optimize_runtime_table, read_operator_status
from .provider import Plur1busMemoryProvider
from .validation import safe_agent_id


def runtime_view(home: Path, profile: str, *, apply_generation: bool = True) -> SimpleNamespace:
    """Resolve explicit operator identity without initializing a capture runtime."""
    home = home.expanduser()
    if not home.is_absolute() or not home.is_dir() or home.is_symlink():
        raise ValueError("an existing absolute Hermes home is required")
    profile = safe_agent_id(profile)
    provider = object.__new__(Plur1busMemoryProvider)
    provider._hermes_home = home
    provider._supplied_config = {}
    config = provider._runtime_config(profile)
    aliases = config.get("agentAliases", {})
    # Match ``Plur1busMemoryProvider.initialize`` exactly: Hermes supplies the
    # active profile as agent_identity, and only an explicit alias remaps it.
    # ``config.agentId`` is merely the provider's fallback when the host did
    # not supply an identity, which cannot happen for this explicit CLI.
    agent_id = safe_agent_id(str(aliases.get(profile, profile))) if isinstance(aliases, dict) else profile
    data_dir = Path(str(config.get("dataDir") or "plur1bus")).expanduser()
    if not data_dir.is_absolute():
        data_dir = home / data_dir
    if apply_generation:
        from .generation import effective_generation_config
        config = effective_generation_config(data_dir, agent_id, config)
    scope = normalize_scope_context({
        "scopeType": config.get("scopeType"),
        "workspace": config.get("workspaceId") or config.get("workspaceIdentity"),
        "platform": config.get("platform"), "user": config.get("userId") or config.get("ownerUserId"),
        "chat": config.get("chatId"), "account": config.get("account"),
    })
    # Recovery must not resolve an unverified pointer through namespaces.  The
    # activation API itself rejects namespace configurations, so this private
    # canonical route is sufficient until it obtains its exclusive lease.
    writer = (NamespaceRoute("default", data_dir / "lancedb" / agent_id, True)
              if not apply_generation else resolve_namespace_routes(data_dir, agent_id, config)[0])
    return SimpleNamespace(agent_id=agent_id, data_dir=data_dir, config=config,
                           scope_binding=binding_from_scope(agent_id, scope), _writer_route=writer)


def main(argv: list[str] | None = None) -> int:
    """Run a read-only command by default; every storage mutation needs --apply."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-home", required=True, type=Path)
    parser.add_argument("--agent", required=True, help="explicit profile or agent identity")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    compact = commands.add_parser("compact")
    compact.add_argument("--apply", action="store_true")
    source_sync = commands.add_parser("source-sync")
    source_sync.add_argument("--source", required=True, type=Path)
    source_sync.add_argument("--apply", action="store_true")
    source_sync.add_argument("--approved-revision", help="exact revision from read-only preview")
    consent = commands.add_parser("workspace-source", help="destination-bound source consent")
    consent.add_argument("action", choices=("plan", "approve", "apply", "revoke"))
    consent.add_argument("--source", required=True, type=Path)
    consent.add_argument("--approved-revision")
    reembed = commands.add_parser("reembed")
    reembed.add_argument("--target-embedding", required=True, type=Path, help="JSON embedding config; source config stays unchanged")
    reembed.add_argument("--plan", type=Path, help="saved JSON plan from an earlier read-only invocation")
    reembed.add_argument("--apply", action="store_true", help="write one batch into a separate staging directory")
    reembed.add_argument("--validate", action="store_true", help="validate completed staging against the unchanged source")
    reembed.add_argument("--activate", action="store_true", help="atomically activate one validated saved stage")
    reembed.add_argument("--recover", action="store_true", help="resume one saved interrupted activation")
    reembed.add_argument("--approved-plan-id", help="exact saved plan ID explicitly approved for activation or recovery")
    reembed.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args(argv)
    try:
        # Activation/recovery must be able to inspect an interrupted pointer
        # and the original target config.  Do not let normal runtime routing
        # instantiate/apply that pointer before its exclusive lease transition.
        raw_generation = args.command == "reembed" and (args.activate or args.recover)
        runtime = runtime_view(args.hermes_home, args.agent, apply_generation=not raw_generation)
        if args.command == "status":
            result = read_operator_status(runtime)
        elif args.command == "compact":
            result = optimize_runtime_table(runtime, authorized=True) if args.apply else {
                "dryRun": True, "operation": "physical_compaction", "status": read_operator_status(runtime),
            }
        elif args.command == "workspace-source":
            from .workspace_consent import (
                plan_workspace_consent, approve_workspace_consent,
                apply_workspace_consent, revoke_workspace_consent,
            )
            if args.action == "plan":
                result = plan_workspace_consent(runtime, args.source)
            elif not args.approved_revision:
                raise ValueError("an exact destination-bound approval revision is required")
            elif args.action == "approve":
                plan = plan_workspace_consent(runtime, args.source)
                result = approve_workspace_consent(runtime, plan, approved_revision=args.approved_revision)
            elif args.action == "revoke":
                result = revoke_workspace_consent(runtime, args.source, approved_revision=args.approved_revision)
            else:
                from .runtime import Plur1busRuntime
                writer = Plur1busRuntime(runtime.data_dir, runtime.config, runtime.agent_id,
                                         runtime.scope_binding.as_dict())
                try:
                    result = apply_workspace_consent(writer, args.source,
                                                     approved_revision=args.approved_revision)
                finally:
                    writer.shutdown()
        elif args.command == "source-sync":
            from .source_sync import plan_source_sync, apply_source_sync
            from .runtime import Plur1busRuntime
            plan = plan_source_sync(args.source)
            if not args.apply:
                result = {**plan, "agentId": runtime.agent_id, "scopeKey": runtime.scope_binding.scope_key}
            else:
                if args.approved_revision != plan["revision"]:
                    raise ValueError("explicit matching source revision approval is required")
                writer = Plur1busRuntime(runtime.data_dir, runtime.config, runtime.agent_id,
                                         runtime.scope_binding.as_dict())
                try:
                    result = apply_source_sync(writer, plan, approved_revision=args.approved_revision)
                finally:
                    writer.shutdown()
        else:
            from .reembed_staged import apply_staged_reembed, plan_staged_reembed, validate_staged_reembed
            embedding = json.loads(args.target_embedding.read_text(encoding="utf-8"))
            if not isinstance(embedding, dict):
                raise ValueError("target embedding must be a JSON object")
            config = {**runtime.config, "embedding": embedding}
            actions = [name for name, enabled in (
                ("apply", args.apply), ("validate", args.validate),
                ("activate", args.activate), ("recover", args.recover),
            ) if enabled]
            if len(actions) > 1:
                raise ValueError("choose exactly one re-embedding action")
            if actions:
                if args.plan is None:
                    raise ValueError("a mutating re-embedding action requires a saved --plan")
                plan = json.loads(args.plan.read_text(encoding="utf-8"))
                if not isinstance(plan, dict):
                    raise ValueError("saved re-embedding plan must be a JSON object")
                if args.activate or args.recover:
                    if args.approved_plan_id != str(plan.get("planId") or ""):
                        raise ValueError("an exact approved plan ID matching the saved plan is required")
                if args.validate:
                    result = validate_staged_reembed(plan, runtime.data_dir, runtime.agent_id, config)
                elif args.activate:
                    from .generation import activate_staged_generation
                    result = activate_staged_generation(
                        plan, runtime.data_dir, runtime.agent_id, config,
                        approved_plan_id=args.approved_plan_id,
                    )
                elif args.recover:
                    from .generation import recover_generation
                    result = recover_generation(
                        runtime.data_dir, runtime.agent_id, config,
                        approved_plan_id=args.approved_plan_id,
                    )
                else:
                    result = apply_staged_reembed(plan, runtime.data_dir, runtime.agent_id, config,
                                                 batch_size=args.batch_size)
            else:
                result = plan_staged_reembed(runtime.data_dir, runtime.agent_id, config)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as error:
        # Backend exceptions may contain endpoint credentials or memory content.
        print(json.dumps({"ok": False, "error": "operator_action_failed", "type": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Explicit local-operator commands; no gateway activation or model switching."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace

from .namespaces import binding_from_scope, normalize_scope_context, resolve_namespace_routes
from .operator_status import optimize_runtime_table, read_operator_status
from .provider import Plur1busMemoryProvider
from .validation import safe_agent_id


def runtime_view(home: Path, profile: str) -> SimpleNamespace:
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
    scope = normalize_scope_context({
        "scopeType": config.get("scopeType"),
        "workspace": config.get("workspaceId") or config.get("workspaceIdentity"),
        "platform": config.get("platform"), "user": config.get("userId") or config.get("ownerUserId"),
        "chat": config.get("chatId"), "account": config.get("account"),
    })
    writer, _ = resolve_namespace_routes(data_dir, agent_id, config)
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
    reembed = commands.add_parser("reembed")
    reembed.add_argument("--target-embedding", required=True, type=Path, help="JSON embedding config; source config stays unchanged")
    reembed.add_argument("--plan", type=Path, help="saved JSON plan from an earlier read-only invocation")
    reembed.add_argument("--apply", action="store_true", help="write one batch into a separate staging directory")
    reembed.add_argument("--validate", action="store_true", help="validate completed staging against the unchanged source")
    reembed.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args(argv)
    try:
        runtime = runtime_view(args.hermes_home, args.agent)
        if args.command == "status":
            result = read_operator_status(runtime)
        elif args.command == "compact":
            result = optimize_runtime_table(runtime, authorized=True) if args.apply else {
                "dryRun": True, "operation": "physical_compaction", "status": read_operator_status(runtime),
            }
        else:
            from .reembed_staged import apply_staged_reembed, plan_staged_reembed, validate_staged_reembed
            embedding = json.loads(args.target_embedding.read_text(encoding="utf-8"))
            if not isinstance(embedding, dict):
                raise ValueError("target embedding must be a JSON object")
            config = {**runtime.config, "embedding": embedding}
            if args.apply and args.validate:
                raise ValueError("choose apply or validate, not both")
            if args.apply or args.validate:
                if args.plan is None:
                    raise ValueError("--apply requires a saved --plan")
                plan = json.loads(args.plan.read_text(encoding="utf-8"))
                if args.validate:
                    result = validate_staged_reembed(plan, runtime.data_dir, runtime.agent_id, config)
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

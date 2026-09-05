"""Read-only dashboard status for the server-selected PLUR1BUS profile."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi import APIRouter, HTTPException

from plur1bus_hermes.namespaces import binding_from_scope, normalize_scope_context, resolve_namespace_routes
from plur1bus_hermes.operator_status import read_operator_status
from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.validation import safe_agent_id

router = APIRouter()


def _active_runtime_view() -> Any:
    """Build a read-only view of the dashboard server's active provider route.

    The browser supplies no profile, agent, table, or filesystem value.  Configuration
    resolution deliberately reuses the provider's current read-only merge semantics;
    this keeps a dashboard process scoped with ``HERMES_HOME`` on its own profile.
    """
    from hermes_constants import get_hermes_home
    from hermes_cli.profiles import get_active_profile_name

    hermes_home = Path(get_hermes_home()).expanduser()
    profile = get_active_profile_name()
    # Config resolution is an instance method, but a full provider constructor
    # starts a prefetch executor and shutdown changes process health state.  A
    # bare instance has exactly the read-only fields used by _runtime_config.
    provider = object.__new__(Plur1busMemoryProvider)
    provider._hermes_home = hermes_home
    provider._supplied_config = {}
    # The host passes this exact value as ``agent_identity`` to the provider,
    # including the literal ``default`` and ``custom`` profile identities.
    config = provider._runtime_config(profile)
    agent_id = profile
    aliases = config.get("agentAliases")
    if isinstance(aliases, dict):
        agent_id = str(aliases.get(agent_id, agent_id))
    agent_id = safe_agent_id(agent_id)
    data_dir = Path(str(config.get("dataDir") or "plur1bus")).expanduser()
    if not data_dir.is_absolute():
        data_dir = hermes_home / data_dir
    scope = normalize_scope_context({
        "scopeType": config.get("scopeType"),
        "workspace": config.get("workspaceId") or config.get("workspaceIdentity"),
        "platform": config.get("platform"),
        "user": config.get("userId") or config.get("ownerUserId"),
        "chat": config.get("chatId"),
        "account": config.get("account"),
    })
    binding = binding_from_scope(agent_id, scope)
    writer_route, _ = resolve_namespace_routes(data_dir, agent_id, config)
    return SimpleNamespace(
        agent_id=agent_id,
        data_dir=data_dir,
        config=config,
        scope_binding=binding,
        _writer_route=writer_route,
    )


@router.get("/status")
def get_status() -> dict[str, Any]:
    """Return the safe status projection for only the server-derived profile."""
    try:
        return read_operator_status(_active_runtime_view())
    except Exception:
        # Configuration and storage details can include a local path or endpoint.
        raise HTTPException(status_code=503, detail="status_unavailable")

"""Installable Hermes memory-provider plugin for PLUR1BUS."""

__version__ = "7.18.20"

if __name__ == "plur1bus_hermes":
    from .provider import Plur1busMemoryProvider
    from .service import Plur1busServiceContainer
    from .validation import ValidationError, fingerprint_text, resolve_inside, safe_agent_id, safe_memory_id, safe_status, safe_type
else:
    # Hermes imports directory plugins under profile-owned namespaces. Reuse
    # the installed canonical package so provider, Controls and dashboard share
    # the same service container and health registry, not duplicate modules.
    from plur1bus_hermes import __version__ as _installed_version
    if _installed_version != __version__:
        raise RuntimeError("PLUR1BUS directory and runtime versions differ; rerun the installer")
    from plur1bus_hermes.provider import Plur1busMemoryProvider
    from plur1bus_hermes.service import Plur1busServiceContainer
    from plur1bus_hermes.validation import ValidationError, fingerprint_text, resolve_inside, safe_agent_id, safe_memory_id, safe_status, safe_type


def register(ctx) -> None:
    """Register the provider through Hermes' memory-plugin collector."""
    ctx.register_memory_provider(Plur1busMemoryProvider())


__all__ = ["Plur1busMemoryProvider", "Plur1busServiceContainer", "ValidationError", "fingerprint_text", "register", "resolve_inside", "safe_agent_id", "safe_memory_id", "safe_status", "safe_type"]

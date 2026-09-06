"""Installable Hermes memory-provider plugin for PLUR1BUS."""

__version__ = "7.12.0.post1"

from .provider import Plur1busMemoryProvider
from .service import Plur1busServiceContainer
from .validation import ValidationError, fingerprint_text, resolve_inside, safe_agent_id, safe_memory_id, safe_status, safe_type


def register(ctx) -> None:
    """Register the provider through Hermes' memory-plugin collector."""
    ctx.register_memory_provider(Plur1busMemoryProvider())


__all__ = ["Plur1busMemoryProvider", "Plur1busServiceContainer", "ValidationError", "fingerprint_text", "register", "resolve_inside", "safe_agent_id", "safe_memory_id", "safe_status", "safe_type"]

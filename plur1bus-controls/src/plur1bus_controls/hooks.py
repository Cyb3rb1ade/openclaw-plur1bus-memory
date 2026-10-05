"""Passive Hermes lifecycle hooks for PLUR1BUS controls."""

from __future__ import annotations

from .service import PLUR1BUS_CONTROLS_CONTAINER
from .request_context import capture_gateway_identity
from .group_reasoning import foreign_reasoning


class HookCollector:
    """Register only documented, non-blocking general-plugin hook callbacks."""

    def __init__(self, gateway_callback=None, config=None) -> None:
        self.gateway_callback = gateway_callback
        self.config = config or {}

    def register(self, ctx: object) -> None:
        register_hook = getattr(ctx, "register_hook", None)
        if not callable(register_hook):
            return
        for event_name in (
            "on_session_start",
            "on_session_end",
            "pre_llm_call",
            "post_llm_call",
        ):
            register_hook(event_name, self._record)
        register_hook("pre_gateway_dispatch", self._capture_gateway)

    def _capture_gateway(self, *args, **kwargs):
        del args
        identity = capture_gateway_identity(kwargs.get("event"))
        if foreign_reasoning(kwargs.get("event"), identity, self.config):
            PLUR1BUS_CONTROLS_CONTAINER.put("last_hook", "foreign-reasoning-skipped")
            return {"action": "skip", "reason": "plur1bus-foreign-group-reasoning"}
        if callable(self.gateway_callback):
            self.gateway_callback(
                kwargs.get("event"),
                kwargs.get("gateway"),
                identity,
            )
        PLUR1BUS_CONTROLS_CONTAINER.put("last_hook", "pre_gateway_dispatch")
        return {"action": "allow"}

    def _record(self, *args, **kwargs):
        del args, kwargs
        PLUR1BUS_CONTROLS_CONTAINER.put("last_hook", "observed")
        return None

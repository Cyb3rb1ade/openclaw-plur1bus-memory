"""Minimal control bridge hooks used by the controls plugin."""

from __future__ import annotations

from .service import PLUR1BUS_SERVICE


def register_shared_controls_bridge(bridge_name: str, payload: dict) -> None:
    """Register Hermes-side control metadata in the shared container."""
    registry = PLUR1BUS_SERVICE.get("controls") or {}
    registry[bridge_name] = {
        "registeredAt": payload.get("registeredAt"),
        "status": payload.get("status", "ok"),
        "payload": payload,
    }
    PLUR1BUS_SERVICE.set("controls", registry)


def controls_bridge_health() -> dict:
    """Expose control bridge health for `/plur1bus status` style reporting."""
    controls = PLUR1BUS_SERVICE.get("controls", {})
    return {
        "installed": bool(controls),
        "bridges": sorted(controls.keys()),
    }


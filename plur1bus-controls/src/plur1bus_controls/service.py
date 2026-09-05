"""Shared control surface container."""

from __future__ import annotations

from datetime import datetime, timezone


class _Container:
    def __init__(self) -> None:
        self._services: dict[str, object] = {}
        self._registered_at = datetime.now(tz=timezone.utc).isoformat()

    def put(self, name: str, value: object) -> None:
        self._services[name] = value

    def get(self, name: str, default: object | None = None) -> object | None:
        return self._services.get(name, default)

    def snapshot(self) -> dict:
        return {
            "registeredAt": self._registered_at,
            "services": sorted(self._services.keys()),
        }


PLUR1BUS_CONTROLS_CONTAINER = _Container()


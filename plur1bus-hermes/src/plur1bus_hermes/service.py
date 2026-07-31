"""Shared runtime service container for the Hermes PLUR1BUS stack."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Plur1busServiceState:
    """Mutable runtime state used by provider and controls."""

    provider_ready: bool = False
    active_profiles: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_health: dict[str, Any] = field(default_factory=dict)


class Plur1busServiceContainer:
    """A process-local component registry with deterministic lifecycle."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._registry: dict[str, Any] = {}
        self._state = Plur1busServiceState()

    def get(self, name: str, default: Any = None) -> Any:
        with self._lock:
            return self._registry.get(name, default)

    def set(self, name: str, value: Any) -> None:
        with self._lock:
            self._registry[name] = value

    def get_or_create(self, name: str, factory: Callable[[], Any]) -> Any:
        with self._lock:
            if name not in self._registry:
                self._registry[name] = factory()
            return self._registry[name]

    def state(self) -> Plur1busServiceState:
        return self._state

    def collect_health(self) -> dict:
        return {
            "provider_ready": self._state.provider_ready,
            "active_profile_count": len(self._state.active_profiles),
            "registry_keys": sorted(self._registry.keys()),
            "last_health": self._state.last_health,
        }


PLUR1BUS_SERVICE = Plur1busServiceContainer()


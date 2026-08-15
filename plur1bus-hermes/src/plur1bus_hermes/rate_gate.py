"""Persistent per-agent rate gates for maintenance jobs."""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path
from typing import Any, Callable


class JobRateGate:
    """Run a job only when its persisted interval has elapsed."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def _state(self) -> dict[str, float]:
        if not self.path.is_file():
            return {}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError("rate-gate state must be a JSON object")
            state = {}
            for key, timestamp in value.items():
                parsed = float(timestamp)
                if not math.isfinite(parsed) or parsed < 0:
                    raise ValueError("rate-gate timestamps must be finite and non-negative")
                state[str(key)] = parsed
            return state
        except (OSError, TypeError, ValueError) as error:
            raise RuntimeError(f"rate-gate state is unreadable: {error}") from error

    def run(
        self,
        name: str,
        interval_seconds: int,
        operation: Callable[[], Any],
        *,
        now: float | None = None,
    ) -> Any:
        state = self._state()
        current = float(now if now is not None else time.time())
        last = float(state.get(name) or 0)
        if last and current - last < interval_seconds:
            return {
                "skipped": True,
                "reason": "rate-limited",
                "nextEligibleAt": last + interval_seconds,
            }
        result = operation()
        if isinstance(result, dict) and result.get("complete") is False:
            return result
        state[name] = current
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(state, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)
        return result

"""Resolve configured credentials in the Hermes profile that owns the work."""

from __future__ import annotations

import os
from pathlib import Path


def profile_secret(name: str, home: str | Path | None = None) -> str:
    if not name:
        return ""
    try:
        from agent.secret_scope import (
            UnscopedSecretError, build_profile_secret_scope, current_secret_scope_home,
            get_secret, reset_secret_scope, set_secret_scope,
        )
        from hermes_constants import get_routing_process_hermes_home
    except ImportError:
        # Standalone tooling has no Hermes credential service or routed worker.
        launch_home = os.getenv("HERMES_HOME")
        if home and launch_home and Path(home).resolve() != Path(launch_home).resolve():
            return ""
        return os.getenv(name, "")

    if home:
        owner = Path(home).resolve()
        bound = current_secret_scope_home()
        # Workers can lack a scope. Read the owner afresh so rotations reach them.
        credentials = build_profile_secret_scope(owner)
        if name in credentials:
            scope = set_secret_scope(credentials, profile_home=str(owner))
            try:
                return get_secret(name, "") or ""
            finally:
                reset_secret_scope(scope)
        if owner != get_routing_process_hermes_home().resolve() or (bound and Path(bound).resolve() != owner):
            return ""
    try:
        return get_secret(name, "") or ""
    except UnscopedSecretError:
        return ""

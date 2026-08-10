"""Hermes convention-based CLI extension for the active PLUR1BUS provider."""

from __future__ import annotations

import json

from .migrate import main as migrate_main
from .provider import Plur1busMemoryProvider


def register_cli(subparser) -> None:
    """Register ``hermes plur1bus status`` and ``hermes plur1bus migrate``."""
    commands = subparser.add_subparsers(dest="plur1bus_command")
    commands.add_parser("status", help="Show PLUR1BUS provider status")
    commands.add_parser("migrate", help="Run the PLUR1BUS migration utility")


def plur1bus_command(args) -> int:
    if getattr(args, "plur1bus_command", None) == "migrate":
        return migrate_main(getattr(args, "remaining_args", None))
    provider = Plur1busMemoryProvider()
    print(json.dumps({"provider": provider.name, "available": provider.is_available(), "version": "0.2.0"}, sort_keys=True))
    return 0


def main() -> int:
    return migrate_main()

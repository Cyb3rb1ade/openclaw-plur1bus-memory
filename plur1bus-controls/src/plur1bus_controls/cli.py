"""CLI entrypoint for the PLUR1BUS Hermes controls package."""

from __future__ import annotations

import argparse
import json

from .plugin import Plur1busControlsPlugin
from .service import PLUR1BUS_CONTROLS_CONTAINER


def build_status() -> dict:
    return {
        "status": "scaffold",
        "service": PLUR1BUS_CONTROLS_CONTAINER.snapshot(),
        "commands": sorted(PLUR1BUS_CONTROLS_CONTAINER.get("commands", {}).keys()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="PLUR1BUS controls helper")
    parser.add_argument("--status", action="store_true", help="print controls status")
    args, _ = parser.parse_known_args()

    if args.status:
        print(json.dumps(build_status(), indent=2, sort_keys=True))
        return 0

    plugin = Plur1busControlsPlugin()
    print(json.dumps({"status": "ready", "commands": sorted(plugin.commands.keys())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


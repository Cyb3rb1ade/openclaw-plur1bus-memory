"""Install per-agent launchd schedules for PLUR1BUS Hermes maintenance."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path
from typing import Any

from .validation import safe_agent_id


def build_launchd_jobs(
    data_dir: Path,
    config_path: Path,
    agents: list[str],
    *,
    python_executable: str | None = None,
    launch_agents_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Build deterministic hourly and daily launchd job definitions."""
    executable = python_executable or sys.executable
    destination = launch_agents_dir or (Path.home() / "Library" / "LaunchAgents")
    log_dir = Path(data_dir) / "logs"
    jobs = []
    for agent_index, raw_agent in enumerate(agents):
        agent = safe_agent_id(raw_agent)
        for mode in ("hourly", "daily"):
            label = f"com.plur1bus.hermes.{agent}.{mode}"
            arguments = [
                executable,
                "-m",
                "plur1bus_hermes.jobs",
                "--data-dir",
                str(Path(data_dir)),
                "--config",
                str(Path(config_path)),
                "--agent",
                agent,
                "--mode",
                mode,
            ]
            plist: dict[str, Any] = {
                "Label": label,
                "ProgramArguments": arguments,
                "RunAtLoad": False,
                "ProcessType": "Background",
                "StandardOutPath": str(log_dir / f"{agent}-{mode}.log"),
                "StandardErrorPath": str(log_dir / f"{agent}-{mode}.error.log"),
            }
            if mode == "hourly":
                plist["StartCalendarInterval"] = {"Minute": (agent_index * 17) % 60}
            else:
                plist["StartCalendarInterval"] = {
                    "Hour": 3,
                    "Minute": (15 + agent_index * 13) % 60,
                }
            jobs.append({
                "agentId": agent,
                "mode": mode,
                "label": label,
                "path": destination / f"{label}.plist",
                "plist": plist,
            })
    return jobs


def install_launchd_jobs(
    jobs: list[dict[str, Any]],
    *,
    load: bool = False,
) -> list[dict[str, Any]]:
    """Write launchd plists atomically and optionally bootstrap them."""
    installed = []
    for job in jobs:
        path = Path(job["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        Path(job["plist"]["StandardOutPath"]).parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".plist.tmp")
        temporary.write_bytes(plistlib.dumps(job["plist"], sort_keys=True))
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        if load:
            target = f"gui/{os.getuid()}/{job['label']}"
            subprocess.run(
                ["launchctl", "bootout", target],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            subprocess.run(
                ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)],
                check=True,
            )
        installed.append({
            "agentId": job["agentId"],
            "mode": job["mode"],
            "label": job["label"],
            "path": str(path),
            "loaded": load,
        })
    return installed


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint; dry-run is the default."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--agent", action="append", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--load", action="store_true")
    arguments = parser.parse_args(argv)
    jobs = build_launchd_jobs(arguments.data_dir, arguments.config, arguments.agent)
    if arguments.load and not arguments.apply:
        parser.error("--load requires --apply")
    if arguments.apply:
        result = {"status": "installed", "jobs": install_launchd_jobs(jobs, load=arguments.load)}
    else:
        result = {
            "status": "preview",
            "jobs": [
                {
                    "agentId": job["agentId"],
                    "mode": job["mode"],
                    "label": job["label"],
                    "path": str(job["path"]),
                    "programArguments": job["plist"]["ProgramArguments"],
                }
                for job in jobs
            ],
        }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

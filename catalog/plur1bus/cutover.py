"""Activate a completed PLUR1BUS migration as real Hermes profiles."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .domain import Plur1busDomain
from .identity_migrate import (
    ensure_hermes_identity as _ensure_hermes_identity,
    sanitize_hermes_context_files as _sanitize_hermes_context_files,
)
from .job_install import build_launchd_jobs, install_launchd_jobs
from .parity import parity_report


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path) -> dict[str, Any]:
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError(f"expected JSON object: {path}")
    return loaded


def _configure_profile_llm(profile_home: Path, provider_config: dict[str, Any]) -> dict[str, Any]:
    llm = provider_config.get("llm")
    if not isinstance(llm, dict) or not llm.get("model"):
        return {"configured": False}
    model = str(llm["model"])
    base_url = str(llm.get("baseUrl") or "http://127.0.0.1:8000/v1").rstrip("/")
    env_file = profile_home / ".env"
    env_file.touch(mode=0o600, exist_ok=True)
    os.chmod(env_file, 0o600)
    existing = env_file.read_text(encoding="utf-8")
    if not any(line.startswith("OMLX_API_KEY=") for line in existing.splitlines()):
        with env_file.open("a", encoding="utf-8") as handle:
            handle.write("OMLX_API_KEY=local\n")
    _run(["hermes", "config", "set", "model.provider", "omlx"], profile_home)
    _run(["hermes", "config", "set", "model.default", model], profile_home)
    _run(["hermes", "config", "set", "model.base_url", base_url], profile_home)
    _run(["hermes", "config", "set", "model.api_mode", "chat_completions"], profile_home)
    return {"configured": True, "provider": "omlx", "model": model, "baseUrl": base_url}


def build_plan(target: Path, hermes_home: Path) -> dict[str, Any]:
    """Validate the completed migration and describe an additive profile cutover."""
    manifest_path = target / "manifests" / "workspace-migration.json"
    errors = []
    manifest: dict[str, Any] = {}
    if not manifest_path.is_file():
        errors.append("completed workspace migration manifest is missing")
    else:
        manifest = _read_json(manifest_path)
        if manifest.get("status") != "completed":
            errors.append("workspace migration manifest is not completed")
    profiles = []
    profiles_root = target / "profiles"
    if profiles_root.is_dir():
        for source in sorted(path for path in profiles_root.iterdir() if path.is_dir()):
            profile_file = source / "profile.json"
            if not profile_file.is_file():
                continue
            profile = _read_json(profile_file)
            internal_id = str(profile.get("id") or source.name)
            profile_name = str(profile.get("profileName") or ("bernd" if internal_id == "main" else internal_id))
            destination = hermes_home / "profiles" / profile_name
            profiles.append({
                "profileName": profile_name,
                "internalAgentId": internal_id,
                "displayName": str(profile.get("displayName") or profile_name.capitalize()),
                "source": str(source),
                "destination": str(destination),
                "alreadyExists": destination.exists(),
            })
    if not profiles:
        errors.append("migration contains no staged Hermes profiles")
    parity = parity_report()
    if (
        parity.get("status") != "complete"
        or parity.get("coverageStatus") != "complete"
    ):
        errors.append(
            f"PLUR1BUS feature parity is incomplete for v{parity.get('coverageVersion')}: "
            f"{parity['readyRequired']}/{parity['totalRequired']}"
        )
    return {
        "generatedAt": _utcnow(),
        "status": "ready" if not errors else "blocked",
        "target": str(target),
        "manifest": str(manifest_path),
        "profiles": profiles,
        "parity": {
            "status": parity["status"],
            "coverageStatus": parity.get("coverageStatus", "incomplete"),
            "readyRequired": parity["readyRequired"],
            "totalRequired": parity["totalRequired"],
        },
        "errors": errors,
    }


def apply_cutover(plan: dict[str, Any], hermes_home: Path, restart: bool = False) -> dict[str, Any]:
    """Create profiles, install plugins, bind agent aliases, and optionally restart."""
    if plan["status"] != "ready":
        return plan
    target = Path(plan["target"])
    provider_source = hermes_home / "plugins" / "plur1bus"
    controls_source = hermes_home / "plugins" / "plur1bus-controls"
    omlx_provider_source = hermes_home / "plugins" / "model-providers" / "omlx"
    if not provider_source.is_dir() or not controls_source.is_dir():
        plan["status"] = "blocked"
        plan["errors"].append("root PLUR1BUS plugins must be installed before cutover")
        return plan
    activated = []
    for profile in plan["profiles"]:
        profile_name = profile["profileName"]
        internal_id = profile["internalAgentId"]
        destination = Path(profile["destination"])
        reused = destination.exists()
        if reused:
            existing_config_path = destination / "plugins" / "plur1bus" / "config.json"
            if not existing_config_path.is_file():
                plan["status"] = "blocked"
                plan["errors"].append(f"existing Hermes profile is not a PLUR1BUS cutover: {profile_name}")
                return plan
            existing_config = _read_json(existing_config_path)
            if str(existing_config.get("agentId") or "") != internal_id:
                plan["status"] = "blocked"
                plan["errors"].append(f"existing Hermes profile has a different agent ID: {profile_name}")
                return plan
        else:
            _run([
                "hermes", "profile", "create", profile_name, "--no-skills",
                "--description", f"Migrated PLUR1BUS agent {profile['displayName']}",
            ], hermes_home)
        workspace = Path(profile["source"]) / "workspace"
        if workspace.is_dir():
            shutil.copytree(workspace, destination, dirs_exist_ok=True)
        context_result = _sanitize_hermes_context_files(destination)
        identity_result = _ensure_hermes_identity(destination)
        plugin_root = destination / "plugins"
        shutil.copytree(provider_source, plugin_root / "plur1bus", dirs_exist_ok=True)
        shutil.copytree(controls_source, plugin_root / "plur1bus-controls", dirs_exist_ok=True)
        config_path = plugin_root / "plur1bus" / "config.json"
        provider_config = _read_json(config_path)
        llm = provider_config.get("llm")
        if isinstance(llm, dict) and llm.get("model"):
            if not omlx_provider_source.is_dir():
                raise RuntimeError(
                    "oMLX model-provider plugin is missing; rerun install-hermes-plugins.sh"
                )
            shutil.copytree(
                omlx_provider_source,
                plugin_root / "model-providers" / "omlx",
                dirs_exist_ok=True,
            )
        provider_config["dataDir"] = str(target)
        provider_config["agentId"] = internal_id
        provider_config["agentAliases"] = {profile_name: internal_id}
        config_path.write_text(json.dumps(provider_config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        llm_result = _configure_profile_llm(destination, provider_config)
        if reused:
            index_result = {"status": "preserved-from-completed-cutover"}
        else:
            try:
                import lancedb
                memory_table = lancedb.connect(str(target / "lancedb" / internal_id)).open_table("memories")
                index_result = Plur1busDomain(target, internal_id).rebuild_indexes(memory_table)
            except Exception as error:
                raise RuntimeError(f"index rebuild failed for {internal_id}: {error}") from error
        _run(["hermes", "config", "set", "memory.provider", "plur1bus"], destination)
        _run(["hermes", "config", "set", "memory.memory_enabled", "false"], destination)
        _run(["hermes", "config", "set", "memory.user_profile_enabled", "true"], destination)
        _run(["hermes", "config", "set", "memory.user_char_limit", "12000"], destination)
        _run(["hermes", "config", "set", "terminal.cwd", str(destination)], destination)
        _run(["hermes", "plugins", "enable", "plur1bus-controls"], destination)
        activated.append({
            "profileName": profile_name,
            "internalAgentId": internal_id,
            "home": str(destination),
            "reused": reused,
            "llm": llm_result,
            "identity": identity_result,
            "contextFiles": context_result,
            "indexes": index_result,
        })
    scheduled_jobs: list[dict[str, Any]] = []
    if sys.platform == "darwin":
        jobs = build_launchd_jobs(
            target,
            provider_source / "config.json",
            [entry["internalAgentId"] for entry in plan["profiles"]],
            python_executable=sys.executable,
        )
        scheduled_jobs = install_launchd_jobs(jobs, load=True)
    if restart:
        _run(
            [
                "hermes",
                "gateway",
                "install",
                "--force",
                "--start-now",
                "--start-on-login",
            ],
            hermes_home,
        )
    plan["status"] = "completed"
    plan["activatedProfiles"] = activated
    plan["scheduledJobs"] = scheduled_jobs
    plan["hermesRestarted"] = restart
    report_path = target / "manifests" / "hermes-cutover.json"
    report_path.write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    plan["reportPath"] = str(report_path)
    return plan


def _run(command: list[str], hermes_home: Path) -> None:
    environment = {**os.environ, "HERMES_HOME": str(hermes_home)}
    completed = subprocess.run(command, env=environment, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "command failed"
        raise RuntimeError(f"{' '.join(command)}: {message}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Activate a completed PLUR1BUS migration as Hermes profiles")
    parser.add_argument("target", help="Completed Hermes PLUR1BUS data root")
    parser.add_argument("--hermes-home", default="~/.hermes", help="Hermes root containing the default profile")
    parser.add_argument("--apply", action="store_true", help="Create and configure profiles")
    parser.add_argument("--restart", action="store_true", help="Restart all Hermes gateways after successful cutover")
    parser.add_argument("--report", default="", help="Optional dry-run/apply report path")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    target = Path(args.target).expanduser().resolve()
    hermes_home = Path(args.hermes_home).expanduser().resolve()
    try:
        report = build_plan(target, hermes_home)
        if args.apply:
            report = apply_cutover(report, hermes_home, restart=args.restart)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        report = {"generatedAt": _utcnow(), "status": "blocked", "errors": [str(error)]}
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.report:
        report_path = Path(args.report).expanduser().resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if report["status"] in {"ready", "completed"} else 2


if __name__ == "__main__":
    raise SystemExit(main())

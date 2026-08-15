"""Hermes general-plugin control surface for PLUR1BUS."""

from __future__ import annotations

import shlex
import asyncio
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.critical_review import (
    build_preview,
    translate_reason,
    translate_source_role,
    translate_type,
)

from .commands import CANONICAL_SUBCOMMANDS, build_command_table
from .hooks import HookCollector
from .service import PLUR1BUS_CONTROLS_CONTAINER
from .request_context import RequestIdentity, current_identity, is_mutation_authorized
from .command_parse import parse_correction
from .confirmations import ConfirmationStore


def _utcnow() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


class Plur1busControlsPlugin:
    """Registers the single canonical ``/plur1bus`` command and passive hooks."""

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = dict(config or {})
        self.commands = build_command_table()
        self._delivery_tasks: set[str] = set()
        self._confirmations = ConfirmationStore()

    def _is_control_event(self, event: Any) -> bool:
        """Konservativ Slash-/Control-Ereignisse erkennen.

        Pending-Reviews dürfen nicht wie eine Antwort auf einen Slash-Befehl,
        einen abgelehnten ``/learn``-Befehl oder einen Mid-Turn-Fehler wirken.
        Falls der Adapter keinen besseren Lifecycle-Hook anbietet, filtert diese
        Prüfung konservativ; fehlende Felder bedeuten „kein Control-Event“.
        """
        text = None
        for attr in ("text", "message", "content", "body"):
            raw = getattr(event, attr, None)
            if isinstance(raw, str):
                text = raw
                break
            if isinstance(raw, dict):
                text = str(raw.get("text") or raw.get("content") or raw.get("body") or "")
                break
        if text is not None and str(text).strip().startswith("/"):
            return True
        kind = str(
            getattr(event, "type", None)
            or getattr(event, "kind", None)
            or getattr(event, "event_type", None)
            or ""
        ).lower()
        if kind in {"command", "control", "slash", "learn", "system", "error", "internal"}:
            return True
        return False

    def _on_gateway_dispatch(self, event: Any, gateway: Any, identity: Any) -> None:
        """Schedule one non-blocking proactive delivery pass for an authorized route."""
        if event is None or gateway is None or identity is None:
            return
        if self._is_control_event(event):
            return
        agent = identity.profile or self.config.get("defaultAgentId") or "default"
        try:
            runtime = (
                self._runtime(agent, identity)
                if identity is not None
                else self._runtime(agent)
            )
        except Exception as error:
            PLUR1BUS_CONTROLS_CONTAINER.put(
                "last_delivery_error", f"{type(error).__name__}: {error}"
            )
            return
        if not is_mutation_authorized(runtime.config, identity):
            return
        route_key = f"{identity.platform}:{identity.chat_id}:{agent}"
        if route_key in self._delivery_tasks:
            return
        self._delivery_tasks.add(route_key)
        try:
            task = asyncio.create_task(
                self._deliver_proactive(event, gateway, runtime)
            )
        except RuntimeError as error:
            self._delivery_tasks.discard(route_key)
            PLUR1BUS_CONTROLS_CONTAINER.put(
                "last_delivery_error", f"{type(error).__name__}: {error}"
            )
            return

        def completed(future):
            self._delivery_tasks.discard(route_key)
            error = future.exception()
            if error is not None:
                PLUR1BUS_CONTROLS_CONTAINER.put(
                    "last_delivery_error",
                    f"{type(error).__name__}: {error}",
                )

        task.add_done_callback(completed)

    def _render_critical_message(self, item: dict[str, Any], ref: str) -> str:
        """Verständliche Critical-Review-Nachricht statt ``reason=...``-Rohwerten."""
        reason = translate_reason(
            str(item.get("reason") or ""),
            type_fallback=str(item.get("type") or ""),
            lang="de",
        )
        source = translate_source_role(str(item.get("sourceRole") or ""), "de")
        preview = build_preview(item, lang="de")
        lines = [
            "🧠 PLUR1BUS hat eine Erinnerung als möglicherweise besonders wichtig erkannt.",
            "",
        ]
        if preview["suppressed"]:
            lines.append(f"„{preview['reason']}“")
        elif preview["text"]:
            lines.append(f"„{preview['text']}“")
        lines.extend([
            f"Grund: {reason}",
            f"Quelle: {source}",
            f"Referenz: {ref}",
            "",
            "Soll diese Erinnerung besonders hervorgehoben werden?",
            "",
            f"Bestätigen: /plur1bus critical accept {ref}",
            f"Nicht hervorheben: /plur1bus critical reject {ref}",
            f"Korrigieren: /plur1bus critical edit {ref}",
            "",
            "Hinweis: „Nicht hervorheben“ löscht die Erinnerung nicht, sondern verwirft nur die besondere Kennzeichnung.",
        ])
        return "\n".join(lines)

    async def _deliver_proactive(self, event: Any, gateway: Any, runtime: Any) -> None:
        """Deliver due reminders and pending critical reviews through the live adapter."""
        source = getattr(event, "source", None)
        resolve_adapter = getattr(gateway, "_adapter_for_source", None)
        adapter = resolve_adapter(source) if callable(resolve_adapter) else None
        if adapter is None or source is None:
            return
        domain = runtime._domain
        reminders = domain.due_reminders()
        criticals = [
            item
            for item in domain.critical_items("pending_review")
            if not item.get("notifiedAt")
        ]
        proactive = domain.proactive_messages()
        if not reminders and not criticals and not proactive:
            return
        ref_map = domain.critical_reference_map()
        lines = []
        if reminders:
            lines.append("PLUR1BUS reminders:")
            lines.extend(
                f"- [{item['id']}] {str(item.get('text') or '')[:500]}"
                for item in reminders
            )
        if criticals:
            for item in criticals:
                ref = ref_map.get(str(item["id"]), "")
                lines.append(self._render_critical_message(item, ref))
        if proactive:
            lines.extend(str(item.get("text") or "") for item in proactive)
        metadata = {}
        thread_id = getattr(source, "thread_id", None)
        if thread_id:
            metadata["thread_id"] = thread_id
        await adapter.send(
            str(source.chat_id),
            "\n\n".join(lines),
            metadata=metadata or None,
        )
        for reminder in reminders:
            domain.update_reminder(str(reminder["id"]), "present")
        domain.mark_criticals_notified(
            [str(item["id"]) for item in criticals]
        )
        domain.mark_proactive_sent(
            [str(item["id"]) for item in proactive]
        )

    def handle_command(self, raw_args: str = "") -> str:
        """Handle canonical PLUR1BUS operations through the Python domain runtime."""
        try:
            tokens = shlex.split(raw_args)
        except ValueError:
            return "PLUR1BUS: invalid command syntax."
        command = tokens[0].lower() if tokens else "status"
        confirmation_nonce = None
        if "--confirm" in tokens:
            index = tokens.index("--confirm")
            if index + 1 >= len(tokens):
                return "PLUR1BUS: --confirm requires a nonce."
            confirmation_nonce = tokens[index + 1]
            del tokens[index:index + 2]
        if command not in CANONICAL_SUBCOMMANDS:
            return "PLUR1BUS commands: " + ", ".join(CANONICAL_SUBCOMMANDS)
        try:
            agent, arguments = self._agent_and_arguments(tokens[1:])
            identity = current_identity()
            runtime = (
                self._runtime(agent, identity)
                if identity is not None
                else self._runtime(agent)
            )
            domain = runtime._domain
            table, _ = runtime._table(create=False)
            controls_config = runtime.config.get("controls") or {}
            mutating_command = command in {
                "forget", "correct", "feedback", "share", "enable", "disable"
            }
            mutating_command = mutating_command or (
                command == "setup" and bool(arguments)
            )
            mutating_command = mutating_command or (
                command == "temperament" and bool(arguments)
            )
            mutating_command = mutating_command or (
                command in {"dreams", "obsidian", "jobs", "critical", "reminders", "speakers", "temperament", "code"}
                and bool(arguments)
                and arguments[0] in {"run", "rebuild", "sync", "maintain", "map", "accept", "reject", "edit", "acknowledge", "cancel"}
            )
            if mutating_command and not is_mutation_authorized(
                runtime.config, current_identity()
            ):
                return json.dumps({
                    "status": "denied",
                    "reason": "PLUR1BUS mutation authorization failed",
                    "remediation": (
                        "Use an allowed user in a private chat, configure "
                        "controls.allowedUserIds, or opt in for trusted local CLI."
                    ),
                }, ensure_ascii=False)
            confirmation_commands = {
                "forget",
                "correct",
                "share",
                "setup",
                "enable",
                "disable",
            }
            if (
                mutating_command
                and command in confirmation_commands
                and identity is not None
            ):
                if not confirmation_nonce or not self._confirmations.consume(
                    confirmation_nonce,
                    command,
                    arguments,
                    identity,
                ):
                    nonce = self._confirmations.issue(
                        command, arguments, identity
                    )
                    return json.dumps({
                        "status": "confirmation_required",
                        "nonce": nonce,
                        "confirmWith": (
                            f"/plur1bus {command} "
                            + " ".join(arguments)
                            + f" --confirm {nonce}"
                        ),
                        "expiresInSeconds": self._confirmations.ttl_seconds,
                    }, ensure_ascii=False)
            if command in {"setup", "enable", "disable"} and (
                runtime.config.get("security") or {}
            ).get("allowChatConfigCommands", True) is False:
                return json.dumps({
                    "status": "denied",
                    "reason": "security.allowChatConfigCommands is false",
                })
            if command == "setup":
                from plur1bus_hermes.feature_profiles import (
                    apply_profile,
                    profile_choices,
                )
                if not arguments:
                    return json.dumps(
                        {"profiles": profile_choices(), "mutated": False},
                        ensure_ascii=False,
                        indent=2,
                    )
                if len(arguments) != 1 or arguments[0] not in {"safe", "recommended"}:
                    return "Usage: /plur1bus setup [safe|recommended]"
                config = apply_profile(self._config_path(), arguments[0])
                return json.dumps({
                    "applied": arguments[0],
                    "featuresConfirmedAt": config["featuresConfirmedAt"],
                    "restartRequired": True,
                }, ensure_ascii=False, indent=2)
            if command in {"enable", "disable"}:
                from plur1bus_hermes.feature_profiles import set_feature
                if len(arguments) != 1:
                    return f"Usage: /plur1bus {command} vaultSync|kritischPush|dailyConsolidation"
                return json.dumps(
                    set_feature(
                        self._config_path(),
                        arguments[0],
                        command == "enable",
                    ),
                    ensure_ascii=False,
                    indent=2,
                )
            if command in {"start", "status", "features"}:
                return json.dumps({
                    "status": "ready",
                    "provider": Plur1busMemoryProvider(runtime.config).name,
                    "features": domain.status(),
                }, ensure_ascii=False, indent=2)
            if command == "memory":
                if not arguments:
                    return "Usage: /plur1bus memory [--agent ID] QUERY"
                explain = "--explain" in arguments
                query_parts = [
                    argument for argument in arguments if argument != "--explain"
                ]
                if not query_parts:
                    return "Usage: /plur1bus memory [--agent ID] QUERY [--explain]"
                return runtime.recall(
                    " ".join(query_parts), explain=explain
                ) or "No matching PLUR1BUS memories."
            if command == "forget":
                if not arguments:
                    return "Usage: /plur1bus forget [--agent ID] MEMORY_ID|TEXT"
                memory_id = runtime.resolve_memory_id(" ".join(arguments))
                if memory_id is None:
                    return json.dumps({"archived": False, "reason": "no-confident-match"})
                return json.dumps({"archived": runtime.forget(memory_id), "id": memory_id})
            if command == "correct":
                parsed = parse_correction(arguments)
                if parsed is None:
                    return "Usage: /plur1bus correct [--agent ID] OLD zu|→|-> NEW"
                reference, replacement = parsed
                memory_id = runtime.resolve_memory_id(reference)
                if memory_id is None:
                    return json.dumps({"corrected": False, "reason": "no-confident-match"})
                accepted = runtime.correct_async(memory_id, replacement, "plur1bus-command")
                runtime.flush()
                return json.dumps({"corrected": accepted, "archivedId": memory_id})
            if command == "feedback":
                if len(arguments) < 2:
                    return "Usage: /plur1bus feedback [--agent ID] MEMORY_ID useful|irrelevant|incorrect"
                return json.dumps(domain.record_feedback(arguments[0], arguments[1]), ensure_ascii=False)
            if command == "share":
                if table is None:
                    return json.dumps({"shared": False, "error": "memory table unavailable"})
                from plur1bus_hermes.shared_pools import SharedPrincipal
                identity = current_identity()
                user_scope = "--user" in arguments
                ids = [argument for argument in arguments if argument != "--user"]
                if user_scope and (
                    identity is None or not identity.platform or not identity.user_id
                ):
                    return json.dumps({
                        "shared": False,
                        "error": "user sharing requires platform and user identity",
                    }, ensure_ascii=False)
                principal = SharedPrincipal(
                    workspace=str(
                        (identity.workspace_id if identity else "")
                        or runtime.config.get("workspaceId")
                        or agent
                    ),
                    platform=identity.platform if identity else "",
                    account=identity.account if identity else "",
                    user=identity.user_id if identity else "",
                )
                return self._require_id(
                    ids,
                    lambda memory_id: domain.share_memory(
                        table,
                        memory_id,
                        principal=principal,
                        user_scope=user_scope,
                    ),
                )
            if command == "graph":
                return json.dumps({"graphEdges": domain.status()["graphEdges"], "path": str(domain.neo_dir / "memory-graph.jsonl")}, indent=2)
            if command == "code":
                if not arguments:
                    return "Usage: /plur1bus code [--agent ID] rebuild|QUERY"
                if arguments[0] == "rebuild":
                    return json.dumps(
                        domain.rebuild_code_index(),
                        ensure_ascii=False,
                        indent=2,
                    )
                return json.dumps(
                    {"results": domain.query_code(" ".join(arguments))},
                    ensure_ascii=False,
                    indent=2,
                )
            if command == "critical":
                if not arguments:
                    pending = domain.critical_items()
                    ref_map = domain.critical_reference_map()
                    items = [
                        {
                            "ref": ref_map.get(str(item["id"]), ""),
                            "id": str(item["id"]),
                            "type": translate_type(str(item.get("type") or ""), "de"),
                            "reason": translate_reason(str(item.get("reason") or ""), str(item.get("type") or ""), "de"),
                            "source": translate_source_role(str(item.get("sourceRole") or ""), "de"),
                            "contentSuppressed": bool(item.get("contentSuppressed")),
                            "status": item.get("status"),
                        }
                        for item in pending
                    ]
                    return json.dumps({"pending": items}, ensure_ascii=False, indent=2)
                if len(arguments) != 2 or arguments[0] not in {"accept", "reject", "edit"}:
                    return "Usage: /plur1bus critical [--agent ID] accept|reject|edit REFERENZ"
                decision = arguments[0]
                reference = arguments[1]
                if decision == "edit":
                    resolved = domain.resolve_critical_reference(reference)
                    if not resolved["ok"]:
                        return json.dumps(
                            {"updated": False, "reason": resolved["error"], "reference": reference},
                            ensure_ascii=False,
                        )
                    return json.dumps({
                        "editHint": (
                            f"✏️ Um diese Erinnerung zu korrigieren, verwende "
                            f"/plur1bus correct <Beschreibung> zu <korrigierter Text> "
                            f"(Referenz {reference} → {resolved['id']})."
                        ),
                    }, ensure_ascii=False, indent=2)
                return json.dumps(
                    domain.review_critical_by_reference(reference, decision),
                    ensure_ascii=False,
                    indent=2,
                )
            if command == "speakers":
                if not arguments:
                    return json.dumps(
                        {"mappings": domain.speaker_mappings()},
                        ensure_ascii=False,
                        indent=2,
                    )
                if len(arguments) < 3 or arguments[0] != "map":
                    return "Usage: /plur1bus speakers [--agent ID] map ALIAS PERSON"
                return json.dumps(
                    {
                        "mappings": domain.set_speaker_mapping(
                            arguments[1], " ".join(arguments[2:])
                        )
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            if command == "temperament":
                if not arguments:
                    return json.dumps(
                        domain.mood_state(), ensure_ascii=False, indent=2
                    )
                if len(arguments) != 1:
                    return "Usage: /plur1bus temperament [--agent ID] ausgewogen|warm|kühl|feurig|stoisch"
                return json.dumps(
                    domain.set_temperament(arguments[0]),
                    ensure_ascii=False,
                    indent=2,
                )
            if command == "dreams":
                if table is None:
                    return json.dumps({"error": "memory table unavailable"})
                result = domain.run_dreaming(table) if arguments and arguments[0] == "run" else {
                    "dreams": domain.status()["dreams"],
                    "path": str(domain.neo_dir / "dream-diary.jsonl"),
                }
                return json.dumps(result, ensure_ascii=False, indent=2)
            if command == "obsidian":
                result = {
                    "workspace": str(domain.workspace_dir),
                    "memoryMirror": domain.status()["obsidianMirror"],
                    "exists": domain.workspace_dir.is_dir(),
                }
                if arguments and arguments[0] == "sync":
                    candidates = domain.obsidian_candidates()
                    for candidate in candidates:
                        runtime.remember_async(
                            f"Obsidian note {candidate['path']}:\n{candidate['content']}",
                            "obsidian-sync",
                            source_role="obsidian",
                        )
                    runtime.flush(timeout_seconds=60)
                    domain.mark_obsidian_synced(candidates)
                    result["imported"] = len(candidates)
                if arguments and arguments[0] == "maintain":
                    result["maintenance"] = domain.maintain_obsidian()
                return json.dumps(result, indent=2)
            if command == "reminders":
                if arguments:
                    if len(arguments) != 2 or arguments[0] not in {"acknowledge", "cancel"}:
                        return "Usage: /plur1bus reminders [--agent ID] acknowledge|cancel MEMORY_ID"
                    return json.dumps(
                        domain.update_reminder(arguments[1], arguments[0]),
                        ensure_ascii=False,
                        indent=2,
                    )
                return json.dumps({"due": domain.due_reminders()}, ensure_ascii=False, indent=2)
            if command == "jobs":
                if table is None:
                    return json.dumps({"error": "memory table unavailable"})
                if arguments and arguments[0] == "run":
                    return json.dumps({
                        "consolidation": domain.run_consolidation(table),
                        "dreaming": domain.run_dreaming(table),
                        "indexes": domain.rebuild_indexes(table),
                    }, ensure_ascii=False, indent=2)
                return "Usage: /plur1bus jobs [--agent ID] run"
            if command == "doctor":
                return json.dumps(self._doctor(runtime, domain, table), ensure_ascii=False, indent=2)
            if command == "parity":
                from plur1bus_hermes.parity import parity_report
                return json.dumps(parity_report(), ensure_ascii=False, indent=2)
            if command == "migrate":
                return "Use plur1bus-hermes-workspace-migrate with a read-only snapshot; dry-run is the default."
            return f"PLUR1BUS `{command}` is not supported."
        except Exception as error:
            return json.dumps({"status": "error", "errorType": type(error).__name__, "error": str(error)})

    def bootstrap(self, ctx: Any) -> None:
        register_command = getattr(ctx, "register_command", None)
        if callable(register_command):
            register_command("plur1bus", handler=self.handle_command, description="PLUR1BUS persistent-memory controls")
        HookCollector(self._on_gateway_dispatch).register(ctx)
        PLUR1BUS_CONTROLS_CONTAINER.put("last_bootstrap_at", _utcnow())
        PLUR1BUS_CONTROLS_CONTAINER.put("commands", self.commands)

    def _runtime(self, agent: str, identity: RequestIdentity | None = None) -> Plur1busRuntime:
        hermes_home = Path(str(self.config.get("hermesHome") or Path.home() / ".hermes")).expanduser()
        config_path = self._config_path()
        try:
            provider_config = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            provider_config = {}
        data_dir = Path(str(provider_config.get("dataDir") or "plur1bus")).expanduser()
        if not data_dir.is_absolute():
            data_dir = hermes_home / data_dir
        scope = identity.as_scope() if identity is not None else {}
        if not scope and provider_config.get("scopeType"):
            scope = {"scopeType": provider_config["scopeType"]}
        return Plur1busRuntime(data_dir, provider_config, agent, scope)

    def _config_path(self) -> Path:
        """Return the one authoritative provider config path."""
        hermes_home = Path(
            str(self.config.get("hermesHome") or Path.home() / ".hermes")
        ).expanduser()
        return hermes_home / "plugins" / "plur1bus" / "config.json"

    def _agent_and_arguments(self, tokens: list[str]) -> tuple[str, list[str]]:
        arguments = list(tokens)
        agent = str(self.config.get("agentId") or "")
        if "--agent" in arguments:
            index = arguments.index("--agent")
            if index + 1 >= len(arguments):
                raise ValueError("--agent requires an identifier")
            agent = arguments[index + 1]
            del arguments[index:index + 2]
        if not agent:
            hermes_home = Path(str(self.config.get("hermesHome") or Path.home() / ".hermes")).expanduser()
            try:
                provider_config = json.loads((hermes_home / "plugins" / "plur1bus" / "config.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                provider_config = {}
            agent = str(provider_config.get("agentId") or "default")
        return agent, arguments

    @staticmethod
    def _require_id(arguments: list[str], operation) -> str:
        if not arguments:
            return "A memory UUID is required."
        return json.dumps(operation(arguments[0]), ensure_ascii=False, indent=2)

    @staticmethod
    def _doctor(runtime: Plur1busRuntime, domain: Plur1busDomain, table: Any) -> dict[str, Any]:
        return {
            "status": "healthy" if table is not None else "empty",
            "agentId": runtime.agent_id,
            "dataDir": str(runtime.data_dir),
            "memoryRows": table.count_rows() if table is not None else 0,
            "features": domain.status(),
            "embeddingProvider": runtime.config.get("embedding", {}).get("provider"),
            "rerankerProvider": runtime.config.get("reranker", {}).get("provider"),
        }


def register(ctx: Any) -> None:
    """Hermes general-plugin entrypoint."""
    Plur1busControlsPlugin().bootstrap(ctx)

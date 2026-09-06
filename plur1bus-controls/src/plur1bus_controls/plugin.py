"""Hermes general-plugin control surface for PLUR1BUS."""

from __future__ import annotations

import shlex
import asyncio
import json
import logging
import weakref
from pathlib import Path
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.skill_workshop import SkillWorkshop
from plur1bus_hermes.service import PLUR1BUS_SERVICE
from plur1bus_hermes.critical_review import (
    build_preview,
    translate_reason,
    translate_source_role,
    translate_type,
)
from plur1bus_hermes.critical_reply_intent import parse_critical_reply_intent

from .commands import CANONICAL_SUBCOMMANDS, build_command_table
from .hooks import HookCollector
from .service import PLUR1BUS_CONTROLS_CONTAINER
from .request_context import RequestIdentity, current_identity, is_mutation_authorized
from .command_parse import parse_correction
from .confirmations import ConfirmationStore
from .background_delivery import BackgroundDelivery

LOGGER = logging.getLogger(__name__)


def _utcnow() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


class Plur1busControlsPlugin:
    """Registers the single canonical ``/plur1bus`` command and passive hooks."""

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = dict(config or {})
        self.commands = build_command_table()
        self._delivery_tasks: set[str] = set()
        self._confirmations = ConfirmationStore()
        self._background = BackgroundDelivery()

    @staticmethod
    def _shutdown_runtime(runtime: Any) -> None:
        shutdown = getattr(runtime, "shutdown", None)
        if callable(shutdown):
            try:
                shutdown()
            except Exception as error:
                PLUR1BUS_CONTROLS_CONTAINER.put(
                    "last_delivery_error", f"{type(error).__name__}: {error}"
                )

    @staticmethod
    def _background_enabled(runtime: Any) -> bool:
        config = getattr(runtime, "config", {})
        delivery = config.get("proactiveDelivery") if isinstance(config, dict) else None
        background = delivery.get("background") if isinstance(delivery, dict) else None
        return isinstance(background, dict) and background.get("enabled") is True

    @staticmethod
    def _source_snapshot(source: Any) -> Any:
        """Retain only outbound routing fields, never the inbound message or text."""
        return SimpleNamespace(**{
            name: getattr(source, name, None)
            for name in (
                "platform", "chat_id", "thread_id", "profile", "scope_id",
                "guild_id", "parent_chat_id", "delivered_via_upstream_relay",
            )
        })

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

    @staticmethod
    def _host_platform(source: Any) -> str:
        value = getattr(source, "platform", "")
        return str(getattr(value, "value", value) or "")

    def _record_critical_delivery(
        self, domain: Any, runtime: Any, criticals: list[dict[str, Any]],
        source: Any, message_id: str,
    ) -> None:
        """Bind delivered critical IDs to one host-issued outgoing message ID."""
        if not message_id or not criticals:
            return
        scope_kwargs = self._scope_kwargs(runtime)
        selector = domain._scope_selector(**scope_kwargs)
        state_dir = domain._scope_state_dir(selector)
        append = getattr(domain, "_append_jsonl", None)
        if not callable(append):
            return
        try:
            entries = domain._read_jsonl(state_dir / "critical-push.jsonl")
        except Exception as error:
            LOGGER.warning("Cannot read critical delivery ledger: %s", type(error).__name__)
            return
        # Append-only ledgers must be folded before adding routing metadata: the
        # immediately preceding notification transition owns ``notifiedAt``.
        latest: dict[str, dict[str, Any]] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            memory_id = str(entry.get("id") or "")
            if (
                memory_id
                and str(entry.get("agentId") or "") == str(runtime.agent_id)
                and str(entry.get("scopeKey") or "") == str(runtime.scope_key)
            ):
                latest[memory_id] = entry
        route = {
            "deliveryMessageId": str(message_id),
            "deliveryPlatform": self._host_platform(source),
            "deliveryChatId": str(getattr(source, "chat_id", "") or ""),
            "deliveryThreadId": str(getattr(source, "thread_id", "") or ""),
            "deliveryAt": _utcnow(),
        }
        for item in criticals:
            memory_id = str(item.get("id") or "")
            if not memory_id:
                continue
            prior = latest.get(memory_id, item)
            if str(prior.get("status") or "pending_review") != "pending_review":
                continue
            append(state_dir / "critical-push.jsonl", {
                **prior, **route, "id": memory_id, "agentId": runtime.agent_id,
                "scopeKey": runtime.scope_key,
                "aclBindings": prior.get("aclBindings") or runtime.scope_binding.as_dict(),
                "status": "pending_review",
            })

    def _apply_trusted_critical_reply(self, event: Any, runtime: Any, identity: RequestIdentity) -> None:
        """Apply only an explicit reply tied to this scope's recorded host message ID."""
        reply_to = str(getattr(event, "reply_to_message_id", "") or "").strip()
        source = getattr(event, "source", None)
        if not reply_to or source is None or getattr(event, "reply_to_is_own_message", False) is not True:
            return
        if not is_mutation_authorized(getattr(runtime, "config", {}), identity):
            return
        # The source and the independently resolved identity must describe the
        # same host route; neither quoted text nor a caller-provided route is
        # authority for a critical transition.
        if (
            self._host_platform(source) != str(identity.platform)
            or str(getattr(source, "chat_id", "") or "") != str(identity.chat_id)
            or str(getattr(source, "thread_id", "") or "") != str(identity.thread_id or "")
        ):
            return
        intent = parse_critical_reply_intent(getattr(event, "text", ""))
        if intent is None:
            return
        domain = runtime._domain
        scope_kwargs = self._scope_kwargs(runtime)
        selector = domain._scope_selector(**scope_kwargs)
        state_dir = domain._scope_state_dir(selector)
        try:
            entries = domain._read_jsonl(state_dir / "critical-push.jsonl")
        except Exception as error:
            LOGGER.warning("Cannot read critical reply ledger: %s", type(error).__name__)
            return
        platform = self._host_platform(source)
        chat_id = str(getattr(source, "chat_id", "") or "")
        thread_id = str(getattr(source, "thread_id", "") or "")
        latest: dict[str, dict[str, Any]] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            memory_id = str(entry.get("id") or "")
            if (
                memory_id
                and str(entry.get("agentId") or "") == runtime.agent_id
                and str(entry.get("scopeKey") or "") == runtime.scope_key
            ):
                latest[memory_id] = entry
        matches: dict[str, dict[str, Any]] = {}
        for memory_id, entry in latest.items():
            if (
                entry.get("status") != "pending_review"
                or str(entry.get("deliveryMessageId") or "") != reply_to
                or str(entry.get("deliveryPlatform") or "") != platform
                or str(entry.get("deliveryChatId") or "") != chat_id
                or str(entry.get("deliveryThreadId") or "") != thread_id
            ):
                continue
            matches[memory_id] = entry
        if not matches or (len(matches) > 1 and intent.get("all") is not True):
            return
        feedback = "useful" if intent["action"] == "accept" else "incorrect"
        for memory_id in matches:
            try:
                result = domain.review_critical(
                    memory_id, intent["action"], **scope_kwargs
                )
            except Exception as error:
                LOGGER.warning("Critical reply review failed: %s", type(error).__name__)
                continue
            if result.get("updated") is True:
                # This is an authenticated explicit decision about the delivered
                # critical card—not a heuristic over unrelated assistant text.
                try:
                    domain.record_feedback(
                        memory_id, feedback,
                        query=f"trusted-critical-reply:{reply_to}",
                        **scope_kwargs,
                    )
                except Exception as error:
                    LOGGER.warning("Critical reply feedback write failed: %s", type(error).__name__)
                    continue

    def _on_gateway_dispatch(self, event: Any, gateway: Any, identity: Any) -> None:
        """Schedule one non-blocking proactive delivery pass for an authorized route."""
        if event is None or gateway is None or identity is None:
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
        route_key = f"{identity.platform}:{identity.chat_id}:{agent}"
        if not is_mutation_authorized(runtime.config, identity):
            self._background.unregister(route_key)
            self._shutdown_runtime(runtime)
            return
        self._apply_trusted_critical_reply(event, runtime, identity)
        if self._background_enabled(runtime):
            source = getattr(event, "source", None)
            if source is not None:
                source_snapshot = self._source_snapshot(source)
                try:
                    gateway_ref = weakref.ref(gateway)
                except TypeError:
                    # Some lightweight host test doubles cannot be weakly referenced.
                    # Do not retain a live gateway just to make background delivery work.
                    self._shutdown_runtime(runtime)
                    return

                async def tick() -> None:
                    live_gateway = gateway_ref()
                    if live_gateway is None:
                        self._background.unregister(route_key)
                        return
                    current = None
                    try:
                        current = self._runtime(agent, identity)
                        if (
                            not self._background_enabled(current)
                            or not is_mutation_authorized(current.config, identity)
                        ):
                            self._background.unregister(route_key)
                            return
                        if route_key in self._delivery_tasks:
                            return
                        self._delivery_tasks.add(route_key)
                        await self._deliver_proactive(
                            SimpleNamespace(source=source_snapshot), live_gateway, current
                        )
                        current = None  # delivery owns and closes it in its finally block
                    finally:
                        self._delivery_tasks.discard(route_key)
                        if current is not None:
                            self._shutdown_runtime(current)

                self._background.register(route_key, tick)
        else:
            self._background.unregister(route_key)
        if self._is_control_event(event):
            self._shutdown_runtime(runtime)
            return
        if route_key in self._delivery_tasks:
            self._shutdown_runtime(runtime)
            return
        self._delivery_tasks.add(route_key)
        try:
            task = asyncio.create_task(
                self._deliver_proactive(event, gateway, runtime)
            )
        except RuntimeError as error:
            self._delivery_tasks.discard(route_key)
            self._shutdown_runtime(runtime)
            PLUR1BUS_CONTROLS_CONTAINER.put(
                "last_delivery_error", f"{type(error).__name__}: {error}"
            )
            return

        def completed(future):
            self._delivery_tasks.discard(route_key)
            if future.cancelled():
                return
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
        timestamp = str(item.get("sourceTimestamp") or item.get("createdAt") or "").strip()[:64]
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
            f"Zeitpunkt: {timestamp or 'unbekannt'}",
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

    @staticmethod
    def _scope_kwargs(runtime: Any) -> dict[str, Any]:
        binding = getattr(runtime, "scope_binding", None)
        as_dict = getattr(binding, "as_dict", None)
        return {"acl_bindings": as_dict()} if callable(as_dict) else {}

    @staticmethod
    def _public_critical_item(item: dict[str, Any], ref: str) -> dict[str, Any]:
        """Render only scope-valid, safe card fields for the list command."""
        preview = build_preview(item, lang="de")
        return {
            "ref": ref,
            "type": translate_type(str(item.get("type") or ""), "de"),
            "reason": translate_reason(
                str(item.get("reason") or ""), str(item.get("type") or ""), "de"
            ),
            "source": translate_source_role(str(item.get("sourceRole") or ""), "de"),
            "time": str(item.get("sourceTimestamp") or item.get("createdAt") or "").strip()[:64] or "unbekannt",
            "preview": preview["text"] if not preview["suppressed"] else "",
            "previewSuppressed": bool(preview["suppressed"]),
            "previewNote": preview["reason"] if preview["suppressed"] else "",
            "actions": {
                "accept": f"/plur1bus critical accept {ref}",
                "reject": f"/plur1bus critical reject {ref}",
                "edit": f"/plur1bus critical edit {ref}",
            },
        }

    async def _deliver_proactive(self, event: Any, gateway: Any, runtime: Any) -> None:
        """Deliver due reminders and pending critical reviews through the live adapter."""
        try:
            source = getattr(event, "source", None)
            resolve_adapter = getattr(gateway, "_adapter_for_source", None)
            adapter = resolve_adapter(source) if callable(resolve_adapter) else None
            if adapter is None or source is None:
                return
            domain = runtime._domain
            scope_kwargs = self._scope_kwargs(runtime)
            reminders = domain.due_reminders(**scope_kwargs)
            pending_criticals = domain.critical_items("pending_review", **scope_kwargs)
            # ``critical_items`` intentionally projects cards, not delivery
            # metadata. Fold the scoped append-only ledger here so a successful
            # prior delivery is never re-notified merely because its card stays
            # pending for a human decision.
            notified_ids: set[str] = set()
            ledger_api = all(callable(getattr(domain, name, None)) for name in (
                "_scope_selector", "_scope_state_dir", "_read_jsonl",
            ))
            if ledger_api:
                try:
                    selector = domain._scope_selector(**scope_kwargs)
                    state_dir = domain._scope_state_dir(selector)
                    latest: dict[str, dict[str, Any]] = {}
                    for entry in domain._read_jsonl(state_dir / "critical-push.jsonl"):
                        if not isinstance(entry, dict):
                            continue
                        memory_id = str(entry.get("id") or "")
                        if (
                            memory_id
                            and str(entry.get("agentId") or "") == str(runtime.agent_id)
                            and str(entry.get("scopeKey") or "") == str(runtime.scope_key)
                        ):
                            latest[memory_id] = entry
                    notified_ids = {
                        memory_id for memory_id, entry in latest.items()
                        if entry.get("status") == "pending_review" and entry.get("notifiedAt")
                    }
                except Exception as error:
                    # The domain remains authoritative for pending cards; degrade to
                    # its legacy projection if its ledger cannot be read.
                    LOGGER.warning("Cannot read critical notification ledger: %s", type(error).__name__)
            criticals = [
                item for item in pending_criticals
                if str(item.get("id") or "") not in notified_ids
                and not item.get("notifiedAt")
            ]
            binding = getattr(runtime, "scope_binding", None)
            proactive = (
                domain.proactive_messages()
                if getattr(binding, "scope_type", "agent-private") == "agent-private"
                else []
            )
            if not reminders and not criticals and not proactive:
                return
            ref_map = domain.critical_reference_map(**scope_kwargs)
            lines = []
            if reminders:
                lines.append("PLUR1BUS reminders:")
                lines.extend(
                    f"- [{item['id']}] {str(item.get('text') or '')[:500]}"
                    for item in reminders
                )
            if criticals:
                for item in criticals:
                    ref = str(item.get("shortRef") or ref_map.get(str(item["id"]), ""))
                    lines.append(self._render_critical_message(item, ref))
            if proactive:
                lines.extend(str(item.get("text") or "") for item in proactive)
            metadata = {}
            thread_id = getattr(source, "thread_id", None)
            if thread_id:
                metadata["thread_id"] = thread_id
            result = await adapter.send(
                str(source.chat_id),
                "\n\n".join(lines),
                metadata=metadata or None,
            )
            result_success = bool(getattr(result, "success", False))
            result_id = str(getattr(result, "message_id", "") or "")
            if isinstance(result, dict):
                result_success = bool(result.get("success", False))
                result_id = str(result.get("message_id") or "")
            if result_success:
                for reminder in reminders:
                    domain.update_reminder(
                        str(reminder["id"]), "present", **scope_kwargs
                    )
                domain.mark_criticals_notified(
                    [str(item["id"]) for item in criticals], **scope_kwargs
                )
                if result_id:
                    self._record_critical_delivery(
                        domain, runtime, criticals, source, result_id
                    )
                domain.mark_proactive_sent(
                    [str(item["id"]) for item in proactive]
                )
        finally:
            self._shutdown_runtime(runtime)

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
            scope_kwargs = self._scope_kwargs(runtime)
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
                command in {"dreams", "obsidian", "jobs", "critical", "reminders", "speakers", "temperament", "code", "knowledge", "persona", "merge"}
                and bool(arguments)
                and arguments[0] in {"run", "rebuild", "sync", "maintain", "map", "accept", "reject", "edit", "acknowledge", "cancel", "create", "propose", "confirm", "seed", "evolve", "apply", "repair"}
            )
            mutating_command = mutating_command or (
                command == "skills" and bool(arguments)
                and arguments[0] in {"mine", "approve", "publish"}
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
            requires_confirmation = command in confirmation_commands or (
                command == "reminders" and bool(arguments) and arguments[0] == "create"
            )
            requires_confirmation = requires_confirmation or (
                command == "skills" and bool(arguments)
                and arguments[0] in {"approve", "publish"}
            )
            requires_confirmation = requires_confirmation or (
                command in {"knowledge", "persona", "merge"} and bool(arguments)
                and arguments[0] in {"confirm", "seed", "evolve", "apply", "repair"}
            ) or (
                command == "reminders" and bool(arguments) and arguments[0] == "confirm"
            ) or (
                command == "obsidian" and len(arguments) == 2 and arguments[0] == "sync"
            )
            if (
                mutating_command
                and requires_confirmation
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
                    confirmation = {
                        "status": "confirmation_required",
                        "nonce": nonce,
                        "confirmWith": (
                            f"/plur1bus {command} "
                            + " ".join(arguments)
                            + f" --confirm {nonce}"
                        ),
                        "expiresInSeconds": self._confirmations.ttl_seconds,
                    }
                    if command == "skills" and arguments and arguments[0] == "publish":
                        confirmation["warning"] = (
                            "Published Hermes skills are profile-global and accessible to "
                            "Hermes profile agents; they are not protected by a PLUR1BUS agent ACL."
                        )
                    return json.dumps(confirmation, ensure_ascii=False)
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
                    return (
                        f"Usage: /plur1bus {command} "
                        "vaultSync|kritischPush|dailyConsolidation|autoCapture|autoRecall|"
                        "conversationReactivationRecall|semanticLens|styleDirective|dreamEcho"
                    )
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
                from plur1bus_hermes.parity import parity_report
                parity = parity_report()
                return json.dumps({
                    "status": (
                        "operational"
                        if PLUR1BUS_SERVICE.state().provider_ready
                        else "degraded"
                    ),
                    "provider": Plur1busMemoryProvider(runtime.config).name,
                    "providerReady": PLUR1BUS_SERVICE.state().provider_ready,
                    "coverageStatus": parity["coverageStatus"],
                    "features": domain.status(**scope_kwargs),
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
                return json.dumps(
                    domain.record_feedback(
                        arguments[0], arguments[1], **scope_kwargs
                    ),
                    ensure_ascii=False,
                )
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
                        **scope_kwargs,
                    ),
                )
            if command == "graph":
                feature_status = domain.status(**scope_kwargs)
                return json.dumps({"graphEdges": feature_status["graphEdges"], "path": feature_status["graphPath"]}, indent=2)
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
                    pending = domain.critical_items(**scope_kwargs)
                    ref_map = domain.critical_reference_map(**scope_kwargs)
                    items = [
                        self._public_critical_item(
                            item,
                            str(item.get("shortRef") or ref_map.get(str(item["id"]), "")),
                        )
                        for item in pending
                    ]
                    return json.dumps({"pending": items}, ensure_ascii=False, indent=2)
                if not arguments or arguments[0] not in {"accept", "reject", "edit"}:
                    return "Usage: /plur1bus critical [--agent ID] accept|reject REFERENZ [REFERENZ ...]|all; edit REFERENZ"
                decision = arguments[0]
                references = arguments[1:]
                if not references:
                    return "Usage: /plur1bus critical [--agent ID] accept|reject REFERENZ [REFERENZ ...]|all; edit REFERENZ"
                if decision == "edit":
                    if len(references) != 1:
                        return "Usage: /plur1bus critical [--agent ID] edit REFERENZ"
                    reference = references[0]
                    resolved = domain.resolve_critical_reference(reference, **scope_kwargs)
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
                all_pending = len(references) == 1 and references[0].lower() == "all"
                return json.dumps(
                    domain.review_critical_batch(
                        None if all_pending else references,
                        decision,
                        all_pending=all_pending,
                        **scope_kwargs,
                    ),
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
                feature_status = domain.status(**scope_kwargs)
                result = domain.run_dreaming(table, **scope_kwargs) if arguments and arguments[0] == "run" else {
                    "dreams": feature_status["dreams"],
                    "path": feature_status["dreamPath"],
                }
                return json.dumps(result, ensure_ascii=False, indent=2)
            if command == "obsidian":
                feature_status = domain.status(**scope_kwargs)
                scoped_workspace = Path(feature_status["workspace"])
                result = {
                    "workspace": str(scoped_workspace),
                    "memoryMirror": feature_status["obsidianMirror"],
                    "exists": scoped_workspace.is_dir(),
                }
                if arguments and arguments[0] == "sync":
                    from plur1bus_hermes.obsidian_sync import plan_obsidian_sync, apply_obsidian_sync
                    if len(arguments) == 2:
                        result["sync"] = apply_obsidian_sync(runtime, approved_revision=arguments[1])
                    else:
                        result["sync"] = plan_obsidian_sync(runtime)
                        result["nextStep"] = "/plur1bus obsidian sync <reviewed revision>"
                if arguments and arguments[0] == "maintain":
                    result["maintenance"] = domain.maintain_obsidian(**scope_kwargs)
                return json.dumps(result, indent=2)
            if command == "reminders":
                if arguments:
                    if arguments[0] == "create":
                        if len(arguments) < 3:
                            return (
                                "Usage: /plur1bus reminders [--agent ID] create "
                                "MEMORY_ID ABSOLUTE_ISO_TIME [TEXT]"
                            )
                        return json.dumps(
                            domain.create_reminder(
                                arguments[1],
                                arguments[2],
                                text=" ".join(arguments[3:]) or None,
                                **scope_kwargs,
                            ),
                            ensure_ascii=False,
                            indent=2,
                        )
                    if arguments[0] == "confirm":
                        if len(arguments) != 3:
                            return (
                                "Usage: /plur1bus reminders [--agent ID] confirm "
                                "PROPOSAL_ID MEMORY_ID"
                            )
                        return json.dumps(
                            domain.confirm_reminder_proposal(
                                arguments[1], arguments[2], **scope_kwargs
                            ),
                            ensure_ascii=False,
                            indent=2,
                        )
                    if len(arguments) != 2 or arguments[0] not in {"acknowledge", "cancel"}:
                        return (
                            "Usage: /plur1bus reminders [--agent ID] "
                            "create MEMORY_ID ABSOLUTE_ISO_TIME [TEXT]|confirm PROPOSAL_ID MEMORY_ID|"
                            "acknowledge|cancel MEMORY_ID"
                        )
                    return json.dumps(
                        domain.update_reminder(
                            arguments[1], arguments[0], **scope_kwargs
                        ),
                        ensure_ascii=False,
                        indent=2,
                    )
                return json.dumps({"due": domain.due_reminders(**scope_kwargs)}, ensure_ascii=False, indent=2)
            if command == "knowledge":
                # A bare command must be observational. Proposal generation is
                # a persisted mutation and therefore requires the explicit
                # ``propose`` verb, which is authorization-gated above.
                if not arguments:
                    return "Usage: /plur1bus knowledge [--agent ID] propose|confirm PROPOSAL_ID"
                if arguments[0] == "propose":
                    if len(arguments) > 1:
                        return "Usage: /plur1bus knowledge [--agent ID] propose|confirm PROPOSAL_ID"
                    return json.dumps(
                        domain.propose_knowledge_promotions(**scope_kwargs),
                        ensure_ascii=False, indent=2,
                    )
                if arguments[0] == "confirm" and len(arguments) == 2:
                    return json.dumps(
                        domain.confirm_knowledge_promotion(arguments[1], **scope_kwargs),
                        ensure_ascii=False, indent=2,
                    )
                return "Usage: /plur1bus knowledge [--agent ID] propose|confirm PROPOSAL_ID"
            if command == "persona":
                if not arguments:
                    return "Usage: /plur1bus persona [--agent ID] seed|evolve"
                if arguments[0] == "seed" and len(arguments) == 1:
                    return json.dumps(
                        domain.ensure_persona_voice_seed(**scope_kwargs),
                        ensure_ascii=False, indent=2,
                    )
                if arguments[0] == "evolve" and len(arguments) == 1:
                    # The only accepted outcome source is the existing, scope-filtered
                    # feedback ledger; command arguments can never manufacture praise.
                    selector = domain._scope_selector(**scope_kwargs)
                    feedback = domain._scoped_jsonl(
                        domain.workspace_dir,
                        domain._scope_workspace_dir(selector),
                        ".adaptive-learning/feedback-log.jsonl",
                        selector,
                    )
                    return json.dumps(
                        domain.evolve_persona_voice(feedback, **scope_kwargs),
                        ensure_ascii=False, indent=2,
                    )
                return "Usage: /plur1bus persona [--agent ID] seed|evolve"
            if command == "merge":
                if not arguments or arguments[0] == "list":
                    if len(arguments) > 1:
                        return "Usage: /plur1bus merge [--agent ID] list|propose TEXT|repair PROPOSAL_ID REVISION|apply PROPOSAL_ID REVISION"
                    proposals = [
                        {
                            key: proposal.get(key)
                            for key in ("proposalId", "revision", "state", "candidateId", "replacementId")
                        }
                        for proposal in runtime.list_merge_proposals()
                    ]
                    return json.dumps({"proposals": proposals}, ensure_ascii=False, indent=2)
                if arguments[0] == "propose" and len(arguments) > 1:
                    proposal = runtime.create_merge_proposal(
                        " ".join(arguments[1:]), "plur1bus-merge-command"
                    )
                    if proposal is None:
                        return json.dumps({"proposed": False, "reason": "no-safe-scoped-candidate"})
                    return json.dumps({
                        "proposed": True,
                        "proposalId": proposal["proposalId"],
                        "revision": proposal["revision"],
                        "state": proposal["state"],
                    }, ensure_ascii=False, indent=2)
                if arguments[0] == "repair" and len(arguments) == 3:
                    return json.dumps({
                        "repaired": runtime.repair_merge_proposal(arguments[1], approved_revision=arguments[2]),
                        "sourceRetired": False,
                        "mirrorLinksRequireRebuild": True,
                    }, ensure_ascii=False, indent=2)
                if arguments[0] == "apply" and len(arguments) == 3:
                    applied = runtime.apply_merge_proposal(
                        arguments[1], approved_revision=arguments[2]
                    )
                    return json.dumps({
                        "applied": applied,
                        "proposalId": arguments[1],
                        "revision": arguments[2],
                    }, ensure_ascii=False, indent=2)
                return "Usage: /plur1bus merge [--agent ID] list|propose TEXT|repair PROPOSAL_ID REVISION|apply PROPOSAL_ID REVISION"
            if command == "skills":
                workshop = SkillWorkshop(runtime)
                if not arguments or arguments[0] == "list":
                    return json.dumps({"proposals": workshop.list()}, ensure_ascii=False, indent=2)
                action = arguments[0]
                if action == "mine" and len(arguments) == 1:
                    return json.dumps(workshop.mine(), ensure_ascii=False, indent=2)
                if action == "show" and len(arguments) == 2:
                    return json.dumps(workshop.inspect(arguments[1]), ensure_ascii=False, indent=2)
                if action == "approve" and len(arguments) == 3:
                    return json.dumps(
                        workshop.approve(arguments[1], arguments[2]),
                        ensure_ascii=False, indent=2,
                    )
                if action == "publish" and len(arguments) == 3:
                    return json.dumps(
                        workshop.publish(
                            arguments[1], arguments[2],
                            Path(str(self.config.get("hermesHome") or Path.home() / ".hermes")),
                        ),
                        ensure_ascii=False, indent=2,
                    )
                return (
                    "Usage: /plur1bus skills [--agent ID] list|mine|show PROPOSAL_ID|"
                    "approve PROPOSAL_ID REVISION|publish PROPOSAL_ID REVISION"
                )
            if command == "jobs":
                if table is None:
                    return json.dumps({"error": "memory table unavailable"})
                if arguments and arguments[0] == "run":
                    return json.dumps({
                        "consolidation": domain.run_consolidation(table, **scope_kwargs),
                        "dreaming": domain.run_dreaming(table, **scope_kwargs),
                        "indexes": domain.rebuild_indexes(table, **scope_kwargs),
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
            "features": domain.status(
                **Plur1busControlsPlugin._scope_kwargs(runtime)
            ),
            "embeddingProvider": runtime.config.get("embedding", {}).get("provider"),
            "rerankerProvider": runtime.config.get("reranker", {}).get("provider"),
        }


def register(ctx: Any) -> None:
    """Hermes general-plugin entrypoint."""
    Plur1busControlsPlugin().bootstrap(ctx)

"""Closed, profile-bound operator settings; saved does not mean activated."""
from __future__ import annotations

import copy
import json
import re

from .feature_models import PURPOSE_FEATURE, configured_routes
from .feature_profiles import PARITY_DEFAULT_FEATURES, parity_feature_enabled
from .generation import _atomic_json, _reject_symlink_components
from .jev_chunk_decider import credential_status as jev_credential_status
from .retrieval_admin import active_runtime_view, config_path, context_revision
from .validation import ValidationError
from .writer_lock import writer_lock

# Only paths with an actual native runtime consumer belong here.
BOOLEANS = {
    "autoCapture": True, "autoRecall": True, "merging.enabled": True,
    "gc.enabled": True, "obsidianBridge.watch": False, "obsidianBridge.autoApplyLowRisk": False,
    "skillWorkshop.enabled": True,
    "schicht15.enabled": True, "semanticLens.enabled": True,
    "conversationReactivationRecall.enabled": False, "dreamEcho.enabled": False,
    "personaVoice.enabled": True, "continuityEngine.enabled": True,
    "memoryDynamics.flashbulbEncoding": False,
    "emotion.t3.enabled": False, "recall.queryRefinement.enabled": True,
    "metaCognition.enabled": False, "contradictionDisclosure.enabled": True,
    "dreaming.narrative.diaryFromUserChats": False,
}
LABELS = {
    "dreaming.narrative.diaryFromUserChats": "Light-Träume aus Nutzer-Chats im Traumtagebuch",
    "autoCapture": "Automatisch speichern", "autoRecall": "Automatisch erinnern",
    "merging.enabled": "Ähnliche Erinnerungen zusammenführen", "gc.enabled": "Speicherbereinigung",
    "obsidianBridge.watch": "Obsidian-Änderungen beobachten", "skillWorkshop.enabled": "Skill Workshop",
    "obsidianBridge.autoApplyLowRisk": "Risikoarme Obsidian-Notizen automatisch importieren",
    "schicht15.enabled": "Schicht 15", "semanticLens.enabled": "Semantic Lens",
    "conversationReactivationRecall.enabled": "Gesprächsreaktivierung", "dreamEcho.enabled": "Dream Echo",
    "personaVoice.enabled": "Persona Voice", "continuityEngine.enabled": "Kontinuität",
    "memoryDynamics.flashbulbEncoding": "Flashbulb-Erinnerungen", "emotion.t3.enabled": "Emotionserkennung mit LLM (T3)",
    "recall.queryRefinement.enabled": "Suchanfragen verfeinern", "metaCognition.enabled": "Meta-Kognition",
    "contradictionDisclosure.enabled": "Widersprüche anzeigen", "capture.mode": "Speicherweise",
    "dailyConsolidation.decayMode": "Konsolidierung: Verfallsberechnung",
}
ENUMS = {"dailyConsolidation.decayMode": ("batch", "rows")}
INTEGERS = {"recall.candidateTopK": (40, 5, 100), "recall.maxPromptMemories": (12, 5, 100)}
LABELS.update({"recall.candidateTopK": "Suchkandidaten vor dem Ranking",
               "recall.maxPromptMemories": "Erinnerungen im Prompt"})
HELP = {
    "dreaming.narrative.diaryFromUserChats": "Light-Träume dürfen im isolierten Nutzer-Workspace ein Traumtagebuch schreiben. Gruppen und REM-Träume bleiben ausgeschlossen.",
    "recall.candidateTopK": "5 bis 100 Kandidaten je Suchpfad vor dem Ranking, Standard 40. Mehr Kandidaten können Ranking-Zeit kosten; sie landen nicht automatisch im Prompt.",
    "recall.maxPromptMemories": "Höchstens 5 bis 100 Erinnerungen im Prompt, Standard 12. Mehr Treffer können mehr Kontext-Tokens verbrauchen; das Zeichenbudget begrenzt zusätzlich.",
    "autoCapture": "Neue Gesprächsinhalte automatisch für das Langzeitgedächtnis verarbeiten. Manuelles Speichern bleibt davon unabhängig.",
    "autoRecall": "Passende Erinnerungen automatisch in den Gesprächskontext einfügen. Abschalten löscht keine gespeicherten Inhalte.",
    "merging.enabled": "Inhaltlich verwandte Erinnerungen auf eine Zusammenführung prüfen. Die bestehenden Sicherheits- und Freigaberegeln gelten weiter.",
    "gc.enabled": "Die konfigurierte Speicherbereinigung aktivieren. Ein globales Kartenlimit lässt sich in dieser Hermes-Version noch nicht über die Oberfläche festlegen.",
    "obsidianBridge.watch": "Änderungen im konfigurierten Obsidian-Workspace beobachten. Ohne eingerichteten Workspace gibt es nichts zu synchronisieren.",
    "obsidianBridge.autoApplyLowRisk": "Nur beim aktivierten Obsidian-Watch: kurze, risikoarme Notizen automatisch als unbestätigte Erinnerungen im privaten Profil speichern. Gemeinsame Speicher und KNOWLEDGE.md bleiben unangetastet.",
    "skillWorkshop.enabled": "Wiederkehrende Abläufe als Skill-Vorschläge aufbereiten. Prüfen und Veröffentlichen erfolgt im Bereich Erinnerungen.",
    "schicht15.enabled": "Zusätzliche kognitive Verarbeitung aktivieren. Verfügbarkeit und LLM-Nutzung hängen von den eingerichteten Funktionen ab.",
    "semanticLens.enabled": "Vorbereitete semantische Verbindungen als Ergänzung zum normalen Recall nutzen. Ersetzt weder die Suche noch ihren Trefferbestand.",
    "conversationReactivationRecall.enabled": "Nach Gesprächspausen passende Erinnerungen und offene Themen ergänzen, damit der Wiedereinstieg leichter fällt.",
    "dreamEcho.enabled": "Passende Ergebnisse der Hintergrundverarbeitung in den Recall einbeziehen. Dafür müssen entsprechende Ergebnisse vorhanden sein.",
    "personaVoice.enabled": "Die konfigurierte Persona bei dafür vorgesehenen internen Verarbeitungsschritten berücksichtigen. Ändert nicht das Chat-Modell.",
    "continuityEngine.enabled": "Zusammenhänge und offene Gesprächsfäden über einzelne Nachrichten hinweg berücksichtigen.",
    "memoryDynamics.flashbulbEncoding": "Besonders wichtige oder emotional intensive Erinnerungen bei der Verarbeitung hervorheben und länger gewichten.",
    "emotion.t3.enabled": "Ein LLM für die zusätzliche Emotionseinschätzung verwenden. Benötigt ein verfügbares Aufgabenmodell und kann zusätzliche Tokens verbrauchen.",
    "recall.queryRefinement.enabled": "Bei schwachen ersten Suchtreffern eine verfeinerte Anfrage versuchen. Kann zusätzliche Embedding-Arbeit auslösen.",
    "metaCognition.enabled": "Lokale Feedback-Metriken mit einem LLM reflektieren. Die Reflexion ändert keine Einstellungen automatisch und kann Tokens verbrauchen.",
    "contradictionDisclosure.enabled": "Erkannte Widersprüche beim Erinnern sichtbar machen. Gegensätzliche Aussagen werden dadurch nicht automatisch gelöscht.",
    "capture.mode": "Ganz speichert Volltext, geteilt Segmente, beides beide Varianten. Automatisch lässt Jev entscheiden und sendet den Text an api.typesafe.ai. Ohne TYPESAFE_API_KEY bleibt es bei beides. Gilt für neue Captures.",
    "dailyConsolidation.decayMode": "Batch berechnet die Verfallsverarbeitung gebündelt; Einzelzeilen verwendet den zeilenweisen Pfad. Die Einstellung gilt für die nächste Konsolidierung.",
}
MODEL_LABELS = {"*": "Standard für interne Aufgaben", "conversation-insights": "Gesprächserkenntnisse",
    "emotion-encoding": "Emotionale Einordnung", "emotionT3": "Emotionserkennung (T3)",
    "episode-extraction": "Episoden erkennen", "merging": "Erinnerungen zusammenführen",
    "persona-voice": "Persona-Stimme", "recall-query-summary": "Suchanfrage zusammenfassen",
    "rem-pattern-analysis": "Muster im Hintergrund analysieren", "skillMiner": "Skills ableiten"}
MODEL_TASKS = sorted(set(PURPOSE_FEATURE.values()) | {"episode-extraction", "persona-voice", "*"})
EN_LABELS = {
    "dreaming.narrative.diaryFromUserChats": "Dream diary from user chats",
    "autoCapture": "Automatically save", "autoRecall": "Automatically recall",
    "merging.enabled": "Review similar memories for merging", "gc.enabled": "Storage cleanup",
    "obsidianBridge.watch": "Watch Obsidian changes", "skillWorkshop.enabled": "Skill Workshop",
    "obsidianBridge.autoApplyLowRisk": "Automatically import low-risk Obsidian notes",
    "schicht15.enabled": "Layer 1.5", "semanticLens.enabled": "Semantic Lens",
    "conversationReactivationRecall.enabled": "Conversation reactivation", "dreamEcho.enabled": "Dream Echo",
    "personaVoice.enabled": "Persona Voice", "continuityEngine.enabled": "Continuity",
    "memoryDynamics.flashbulbEncoding": "Flashbulb memories", "emotion.t3.enabled": "LLM emotion assessment (T3)",
    "recall.queryRefinement.enabled": "Refine search queries", "metaCognition.enabled": "Metacognition",
    "contradictionDisclosure.enabled": "Show contradictions", "capture.mode": "Storage mode",
    "dailyConsolidation.decayMode": "Consolidation decay calculation",
    "recall.candidateTopK": "Search candidates before ranking", "recall.maxPromptMemories": "Memories in the prompt",
}
EN_HELP = {
    "dreaming.narrative.diaryFromUserChats": "Light dreams may write a diary in the isolated user workspace. Group chats and REM dreams are excluded.",
    "recall.candidateTopK": "Consider 5 to 100 candidates per search path before ranking. The default is 40. More candidates can increase ranking time.",
    "recall.maxPromptMemories": "Include 5 to 100 memories in the prompt, subject to the character budget. The default is 12.",
    "autoCapture": "Process new conversation content for long-term memory. Manual saving remains available.",
    "autoRecall": "Add matching memories to the conversation context. Stored records are retained when disabled.",
    "merging.enabled": "Review related memories for a possible merge. The existing approval rules apply.",
    "gc.enabled": "Run the configured memory cleanup. A global card limit is not editable here.",
    "obsidianBridge.watch": "Watch changes in the configured Obsidian workspace.",
    "obsidianBridge.autoApplyLowRisk": "With Obsidian watching enabled, save short low-risk notes as unverified private memories.",
    "skillWorkshop.enabled": "Turn recurring workflows into skill proposals. Review and publish proposals under Memories.",
    "schicht15.enabled": "Enable additional cognitive processing for the configured features and models.",
    "semanticLens.enabled": "Supplement normal recall with prepared semantic connections.",
    "conversationReactivationRecall.enabled": "Surface relevant memories and open topics when a conversation resumes.",
    "dreamEcho.enabled": "Include related results from background processing in recall when those results are available.",
    "personaVoice.enabled": "Use the configured persona for supported internal tasks. The chat model stays the same.",
    "continuityEngine.enabled": "Track relationships and open threads across messages.",
    "memoryDynamics.flashbulbEncoding": "Highlight important or emotionally intense memories and keep them weighted for longer.",
    "emotion.t3.enabled": "Use a task model for additional emotion assessment. This can use extra tokens.",
    "recall.queryRefinement.enabled": "Try a refined query when the initial search has weak results. This may run another embedding request.",
    "metaCognition.enabled": "Ask a task model to reflect on local feedback metrics. The reflection does not change settings.",
    "contradictionDisclosure.enabled": "Show contradictions during recall. Conflicting memories are retained.",
    "capture.mode": "Save full text, segments, or both. Automatic (Jev) sends eligible new capture text to api.typesafe.ai and falls back to both without a key.",
    "dailyConsolidation.decayMode": "Batch processes decay together. Per row uses the individual path. This applies to the next consolidation.",
}
EN_MODEL_LABELS = {
    "*": "Default for internal tasks", "conversation-insights": "Conversation insights",
    "emotion-encoding": "Emotion encoding", "emotionT3": "Emotion assessment (T3)",
    "episode-extraction": "Episode extraction", "merging": "Memory merging", "persona-voice": "Persona Voice",
    "recall-query-summary": "Summarize recall query", "rem-pattern-analysis": "Background pattern analysis",
    "skillMiner": "Skill mining",
}


def settings_rpc(params, *, session_id=None):
    """Apply a reviewed preference in the gateway's session-control profile."""
    from hermes_cli.config import load_config_readonly

    if session_id or set(params) not in ({"expectedProfile"}, {"expectedProfile", "identifier", "value", "revision"}):
        raise ValueError("Invalid PLUR1BUS settings request.")
    view = active_runtime_view()
    if params["expectedProfile"] != view.profile:
        raise ValueError("PLUR1BUS backend profile mismatch.")
    memory = load_config_readonly().get("memory") or {}
    if (not isinstance(memory, dict) or memory.get("provider") != "plur1bus"
            or memory.get("memory_enabled", True) is not True):
        raise ValueError("PLUR1BUS is not active in this profile.")
    if "identifier" not in params:
        return {"profile": view.profile, "writable": True}
    identifier, revision = params["identifier"], params["revision"]
    if not isinstance(identifier, str) or not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{64}", revision):
        raise ValueError("Invalid PLUR1BUS settings request.")
    try:
        return save_setting(view, identifier, params["value"], revision)
    except (ValueError, OSError):
        raise ValueError("PLUR1BUS could not save this setting.") from None


def _get(config, path, default=None):
    value = config
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            return default
        value = value[key]
    return value


def _put(config, path, value):
    node = config
    for key in path[:-1]:
        if not isinstance(node.get(key), dict):
            node[key] = {}
        node = node[key]
    node[path[-1]] = value


def _boolean_setting(config, key, default):
    section = key.removesuffix(".enabled")
    if section in PARITY_DEFAULT_FEATURES:
        return parity_feature_enabled(config, section)
    value = _get(config, key, default)
    return value if type(value) is bool else default


def public_settings(view, *, language="en"):
    """Expose known scalar values and model IDs, never routes or credentials."""
    settings = [{"id": key, "value": _boolean_setting(view.config, key, default), "choices": [True, False]}
                for key, default in BOOLEANS.items()]
    mode = ("ganz" if view.config.get("captureChunking") is False else
            view.config.get("captureChunkingMode") if view.config.get("captureChunkingMode") in {"geteilt", "automatisch"} else "beides")
    settings.append({"id": "capture.mode", "value": mode, "choices": ["ganz", "beides", "geteilt", "automatisch"]})
    for key, choices in ENUMS.items():
        value = _get(view.config, key, choices[0])
        settings.append({"id": key, "value": value if value in choices else choices[0], "choices": list(choices)})
    router = view.config.get("llmRouter") or {}
    for key, (default, minimum, maximum) in INTEGERS.items():
        value = _get(view.config, key, default)
        value = max(minimum, min(maximum, value)) if type(value) is int else default
        settings.append({"id": key, "value": value, "choices": list(range(minimum, maximum + 1)),
                         "minimum": minimum, "maximum": maximum})
    overrides = (router.get("agentModels") or {}).get(view.agent_id) or {}
    catalog = configured_routes(view.config)
    for task in MODEL_TASKS:
        selected = overrides.get(task, "")
        settings.append({"id": "model." + task, "value": selected if isinstance(selected, str) and selected in catalog else "",
                         "choices": ["", *catalog]})
    german = language == "de"
    labels, help_text, task_labels = (LABELS, HELP, MODEL_LABELS) if german else (EN_LABELS, EN_HELP, EN_MODEL_LABELS)
    capture_labels = ({"ganz": "Volltext", "geteilt": "Segmente", "beides": "Volltext und Segmente", "automatisch": "Automatisch (Jev)"}
        if german else {"ganz": "Full text", "geteilt": "Segments", "beides": "Full text and segments", "automatisch": "Automatic (Jev)"})
    decay_labels = {"batch": "Gebündelt (Batch)", "rows": "Einzelzeilen"} if german else {"batch": "Batch", "rows": "Per row"}
    for setting in settings:
        key = setting["id"]
        task = key.removeprefix("model.")
        setting["label"] = labels.get(key, task_labels.get(task, task))
        setting["description"] = help_text.get(key, (
            "Modell für diese interne Aufgabe im aktiven Profil. Der Standard erbt die bestehende Modellzuordnung."
            if german else "Model for this internal task in the active profile. The default inherits the current assignment."
        ))
        setting["choiceLabels"] = capture_labels if key == "capture.mode" else decay_labels if key in ENUMS else {}
        if key.startswith("model."):
            setting["group"] = "Aufgabenmodelle" if german else "Task models"
        elif key in {"capture.mode", "autoCapture", "merging.enabled", "gc.enabled", "dailyConsolidation.decayMode"}:
            setting["group"] = "Speicherung" if german else "Storage"
        else:
            setting["group"] = "Gedächtnisfunktionen" if german else "Memory features"
    return {"agentId": view.agent_id, "profile": view.profile,
            "jevCredentials": jev_credential_status(view.config, hermes_home=view.hermes_home),
            "revision": context_revision(view), "settings": settings,
            "activation": "unknown", "restartRequiredAfterSave": True,
            "notice": "Saved profile configuration. Running gateway activation is not inferred from this view."}


def validate_change(view, identifier, value):
    """Reject unknown fields, coerced booleans and models without owned routes."""
    if identifier in BOOLEANS and type(value) is bool:
        return
    if identifier in INTEGERS and type(value) is int:
        _, minimum, maximum = INTEGERS[identifier]
        if minimum <= value <= maximum:
            return
    if identifier == "capture.mode" and isinstance(value, str) and value in {"ganz", "beides", "geteilt", "automatisch"}:
        return
    if identifier in ENUMS and isinstance(value, str) and value in ENUMS[identifier]:
        return
    if isinstance(identifier, str) and identifier.startswith("model."):
        task = identifier[6:]
        if task in MODEL_TASKS and isinstance(value, str) and (value == "" or value in configured_routes(view.config)):
            return
    raise ValidationError("unsupported setting or value")


def save_setting(view, identifier, value, revision):
    """Atomically back up and save one reviewed setting for the active profile."""
    with writer_lock(view.data_dir):
        if context_revision(view) != revision:
            raise ValidationError("configuration changed; review again")
        validate_change(view, identifier, value)
        path = config_path(view)
        original = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(original, dict):
            raise ValidationError("invalid profile configuration")
        updated = copy.deepcopy(original)
        profiles = updated.setdefault("profileSettings", {})
        if not isinstance(profiles, dict) or not isinstance(profiles.get(view.profile, {}), dict):
            raise ValidationError("invalid profile settings")
        scoped = profiles.setdefault(view.profile, {})
        if identifier == "capture.mode":
            scoped["captureChunking"] = value != "ganz"
            if value != "ganz":
                scoped["captureChunkingMode"] = value
        elif identifier.startswith("model."):
            # Sparse overrides keep inherited routes/credential rotation live.
            _put(scoped, ["llmRouter", "agentModels", view.agent_id, identifier[6:]], value)
        else:
            parts = identifier.split(".")
            _put(scoped, parts, value)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            backup = path.with_name("config.before-settings-" + revision[:16] + ".json")
            _reject_symlink_components(view.hermes_home, backup, message="unsafe settings backup")
            if not backup.exists():
                _atomic_json(backup, original)
        _atomic_json(path, updated)
        return {"saved": True, "restartRequired": True, "activation": "unverified"}

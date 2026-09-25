"""Closed, profile-bound operator settings; saved does not mean activated."""
from __future__ import annotations

import copy
import json

from .feature_models import PURPOSE_FEATURE, configured_routes
from .generation import _atomic_json, _reject_symlink_components
from .retrieval_admin import config_path, context_revision
from .validation import ValidationError
from .writer_lock import writer_lock

# Only paths with an actual native runtime consumer belong here.
BOOLEANS = {
    "autoCapture": True, "autoRecall": True, "merging.enabled": False,
    "gc.enabled": False, "obsidianBridge.watch": False, "skillWorkshop.enabled": False,
    "schicht15.enabled": False, "semanticLens.enabled": False,
    "conversationReactivationRecall.enabled": False, "dreamEcho.enabled": False,
    "personaVoice.enabled": False, "continuityEngine.enabled": True,
    "memoryDynamics.flashbulbEncoding": False,
    "emotion.t3.enabled": False, "recall.queryRefinement.enabled": True,
    "metaCognition.enabled": False, "contradictionDisclosure.enabled": True,
}
LABELS = {
    "autoCapture": "Automatisch speichern", "autoRecall": "Automatisch erinnern",
    "merging.enabled": "Ähnliche Erinnerungen zusammenführen", "gc.enabled": "Speicherbereinigung",
    "obsidianBridge.watch": "Obsidian-Änderungen beobachten", "skillWorkshop.enabled": "Skill Workshop",
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
    "recall.candidateTopK": "5 bis 100 Kandidaten je Suchpfad vor dem Ranking, Standard 40. Mehr Kandidaten können Ranking-Zeit kosten; sie landen nicht automatisch im Prompt.",
    "recall.maxPromptMemories": "Höchstens 5 bis 100 Erinnerungen im Prompt, Standard 12. Mehr Treffer können mehr Kontext-Tokens verbrauchen; das Zeichenbudget begrenzt zusätzlich.",
    "autoCapture": "Neue Gesprächsinhalte automatisch für das Langzeitgedächtnis verarbeiten. Manuelles Speichern bleibt davon unabhängig.",
    "autoRecall": "Passende Erinnerungen automatisch in den Gesprächskontext einfügen. Abschalten löscht keine gespeicherten Inhalte.",
    "merging.enabled": "Inhaltlich verwandte Erinnerungen auf eine Zusammenführung prüfen. Die bestehenden Sicherheits- und Freigaberegeln gelten weiter.",
    "gc.enabled": "Die konfigurierte Speicherbereinigung aktivieren. Ein globales Kartenlimit lässt sich in dieser Hermes-Version noch nicht über die Oberfläche festlegen.",
    "obsidianBridge.watch": "Änderungen im konfigurierten Obsidian-Workspace beobachten. Ohne eingerichteten Workspace gibt es nichts zu synchronisieren.",
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
    "capture.mode": "Ganz speichert den vollständigen Text, geteilt speichert Segmente, beides behält Volltext und Segmente. Die Auswahl gilt für neue Captures, nicht rückwirkend.",
    "dailyConsolidation.decayMode": "Batch berechnet die Verfallsverarbeitung gebündelt; Einzelzeilen verwendet den zeilenweisen Pfad. Die Einstellung gilt für die nächste Konsolidierung.",
}
MODEL_LABELS = {"*": "Standard für interne Aufgaben", "conversation-insights": "Gesprächserkenntnisse",
    "emotion-encoding": "Emotionale Einordnung", "emotionT3": "Emotionserkennung (T3)",
    "episode-extraction": "Episoden erkennen", "merging": "Erinnerungen zusammenführen",
    "persona-voice": "Persona-Stimme", "recall-query-summary": "Suchanfrage zusammenfassen",
    "rem-pattern-analysis": "Muster im Hintergrund analysieren", "skillMiner": "Skills ableiten"}
MODEL_TASKS = sorted(set(PURPOSE_FEATURE.values()) | {"episode-extraction", "persona-voice", "*"})


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


def public_settings(view):
    """Expose known scalar values and model IDs, never routes or credentials."""
    settings = [{"id": key, "value": _get(view.config, key, default)
                 if type(_get(view.config, key, default)) is bool else default, "choices": [True, False]}
                for key, default in BOOLEANS.items()]
    mode = ("ganz" if view.config.get("captureChunking") is False else
            "geteilt" if view.config.get("captureChunkingMode") == "geteilt" else "beides")
    settings.append({"id": "capture.mode", "value": mode, "choices": ["ganz", "beides", "geteilt"]})
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
    for setting in settings:
        key = setting["id"]
        task = key.removeprefix("model.")
        setting["label"] = LABELS.get(key, MODEL_LABELS.get(task, task))
        setting["description"] = HELP.get(key, "Modell für diese interne Aufgabe im aktiven Profil. Standard erben verwendet die bestehende Modellzuordnung; das Chat-Modell bleibt unverändert.")
        setting["choiceLabels"] = ({"ganz": "Volltext", "geteilt": "Segmente", "beides": "Volltext und Segmente"} if key == "capture.mode"
            else {"batch": "Gebündelt (Batch)", "rows": "Einzelzeilen"} if key in ENUMS else {})
        setting["group"] = "Aufgabenmodelle" if key.startswith("model.") else "Speicherung" if key in {"capture.mode", "autoCapture", "merging.enabled", "gc.enabled", "dailyConsolidation.decayMode"} else "Gedächtnisfunktionen"
    return {"agentId": view.agent_id, "profile": view.profile,
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
    if identifier == "capture.mode" and isinstance(value, str) and value in {"ganz", "beides", "geteilt"}:
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

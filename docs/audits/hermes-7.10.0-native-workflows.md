# Hermes 7.10: erweiterte native Workflows

Stand 2026-09-05: lokaler Implementierungsstand, **noch kein vollständiges Release**.
Die maschinenlesbare Abdeckung in `parity.py` bleibt absichtlich `partial`.

## Neu erreichbar

- `/plur1bus skills mine|show|approve|publish`: opt-in LLM-Verfahrensvorschläge
  mit mindestens zwei aktiven Evidenzkarten, Inhalts-Hashes und exaktem Scope.
  Separate Nonce-Bestätigungen binden Approve und Publish an die Revision.
  Veränderte/gelöschte Evidenz und manuelle Dateikollisionen sperren Publish.
  **Native Skills gelten für das Hermes-Profil**, nicht nur den Quell-Agenten;
  die Publish-Bestätigung weist ausdrücklich auf diese Sichtbarkeit hin.
- `/plur1bus merge propose|list|apply`: explizite verlustfreie Textvereinigung,
  keine automatische LLM-Umschreibung. UUID, freigegebene Revision, Scope,
  Quellinhalt, Gültigkeitsfenster und Lineage werden erneut geprüft. Getrennte
  historische Fenster bleiben separate Karten. Stabile Ersatz-IDs und eine
  reentrante Prozess-/Thread-Schreibsperre verhindern kooperierende Doppelwrites.
  Bei ungeklärter Ersatzmaterialisierung bleibt die Quelle aktiv und der
  Vorschlag erhält `repair_required`; hierfür fehlt noch ein eigener Repair-UI.
- `/plur1bus knowledge propose|confirm`: private, bestätigte Übernahme in einen
  Managed Block von `KNOWLEDGE.md`, mit Erhalt manueller Abschnitte.
- `/plur1bus persona seed|evolve`: optionale, begrenzte Stilpräferenzen; keine
  Tool-/System-Anweisungen. Evolve nutzt das vorhandene Scoped-Feedback.
- `reminders.autoExtract:true`: Extraktion absolut datierter privater Vorschläge
  im Capture-Worker. Erst `reminders confirm PROPOSAL_ID MEMORY_ID` plant eine
  Erinnerung zu einer vorhandenen Scoped-Karte. Relative Daten werden nicht geraten.
- `proactiveDelivery.background.enabled:true`: pro autorisierter Gateway-Route
  ein nicht überlappender Timer, maximal 32 Routen, begrenzte Registrierungsdauer,
  frische Autorisierungs-/Opt-in-Prüfung je Tick. Kein neuer Eingang nötig,
  solange die registrierte Host-Instanz lebt. Kaltstartregistrierung bleibt offen.
- Critical-Antworten binden explizites Accept/Reject an die echte ausgehende
  Host-Message-ID und aktuelle Scoped-Ledger-Zustände. Fehlgeschlagene Sends
  gelten nicht als zugestellt; wiederholte Antworten erzeugen kein neues Feedback.
- Tagesjobs können `lightDream.enabled`, `metaCognition.enabled`,
  `schicht15.enabled`, `personaVoice.enabled` und `episodes.llmNarrative` nutzen.
  Episoden verwenden echte Hermes-Turn-IDs, Session-/Zeitgruppen (30 Minuten,
  maximal 50 Turns), LLM-Narrative erst ab fünf Turns, begrenzte Eingaben und
  exakt gebundene Evidenz. Narrative sind abgeleitete Datensätze, keine neuen
  Fakten oder automatischen Graph-Schreiboperationen; heuristische Episoden bleiben.
- Operator-CLI `source-sync --source DIR`: begrenzter Read-only-Plan; Import nur
  mit `--apply --approved-revision SHA256`. Append-only, stabile Chunk-IDs,
  untrusted Herkunft, keine versteckten Dateien/Symlinks/FIFOs und kein Löschen
  der Quellen. Der lokale Operator wählt das Zielprofil separat.
- Embedding-Cache: identische Einzelanfragen teilen Berechnungen; getrennte
  Zwecke/Scopes/Routen bleiben getrennt. Fehler/ungültige Vektoren werden nicht
  gecacht. Batchübergreifendes Coalescing bleibt ein offener Vertragsunterschied.

Alle neuen LLM-/Hintergrundfunktionen sind opt-in; bestehende Provider,
Dimensionen und Produktivdaten wurden durch diese Implementierung nicht verändert.

## Noch keine Vollständigkeitsfreigabe

Offen bleiben insbesondere aktiver Reembedding-Generation-Switch samt
Quieszenz/Backup/Recovery, vollständige Obsidian-Discovery-/Consent-/Web-Workflows,
automatisches Store-Time-Merging, vollständige Graph-/Entitätsverträge und
exakte Ressourcen-/Cache-Grenzen. Der lokale Jina-v3-Remote-Code-Pfad bleibt
bis zu einem eigenständigen Audit gesperrt. Hermes bietet zwar Adapter-Reactions,
aber keinen geprüften allgemeinen Plugin-Reaction-Hook; dieser Pfad wird nicht
durch einen erfundenen Hook ersetzt. Live-Gateway-Abnahme, Installation und
Veröffentlichung sind getrennte, weiterhin offene Schritte.

Upstream-macOS-Fixes werden unabhängig über PR #131 und #132 geführt; deren
Commits sind zusätzlich lokal auf den Hermes-Branch cherry-gepickt. `main`,
Upstream-Release und `latest` bleiben unverändert.

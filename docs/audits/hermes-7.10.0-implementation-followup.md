# Hermes 7.10.0: Implementierung nach dem Vollständigkeitsreview

Stand 2026-09-05. Lokaler Entwicklungsstand auf `codex/hermes-7.10.0-port`, ausgehend von `1428dc39`. Keine Live-Installation oder Veröffentlichung. Frühere Artefakte zu diesem Ausgangscommit enthalten diese Änderungen nicht.

## Neu implementiert und erreichbar

- Wirksame `autoCapture:false`-/`autoRecall:false`-Gates einschließlich Pre-compress und Prefetch-Cache. Explizite Tools bleiben nutzbar, aber interne/Subagent-Capture-Schutzgrenzen gelten weiter.
- Provider-Gesundheit erst nach erfolgreicher Initialisierung; Cleanup bei Fehler/Shutdown. Parität ist `partial`, Cutover verlangt vollständigen Status und Coverage. Audit-bedingte Herabstufung einzelner Feature-Einträge.
- `memory_store`: `validFrom`, `validUntil`, `expiresAt`. `memory_recall`: `validAt`, `limit`, `full_text`. Realwelt-Gültigkeit bleibt unabhängig von Erfassungszeit. Unbekannte Capture-Gültigkeit wird nicht geraten. Die Upstream-Kurzformen `ttl:session/short` sind nicht als wirkungslose Parameter exponiert; absolute Ablaufzeit ist implementiert.
- Idempotente additive LanceDB-Migration für die drei zeitlichen Spalten, Legacy-Zeilen mit Zero-Defaults. Echte temporäre LanceDB-Tests für Migration, erneutes Öffnen, historische Grenzen und erhaltene Vektoren; keine produktive Migration.
- Zeit-/Ablaufprädikate vor primären/verfeinerten ANN-Limits sowie in Shared Pools. Eng begrenzte Legacy-Fallbacks, erneuter Filter nach Recall-Boostern. Textduplikate mit nachweislich disjunkten Zeitfenstern bleiben getrennt. `full_text` hebt nicht das globale Inject-Budget auf.
- Korrektur verifiziert die dauerhafte Ersatzkarte vor Archivierung und prüft die Quelle erneut. Leere, tombstone-blockierte oder nicht zur Queue zugelassene Ersatz-Writes löschen die Quelle nicht. Zeitfelder bleiben erhalten. Shared-Pool-Updates migrieren vor dem Upsert; kein gefährliches Delete-vor-Add bei Schemawechsel.
- Live-LLM-Cache für erlaubte Zwecke; opt-in LLM-Query-Refinement als erreichbarer Consumer. Effektiver Payload, Agent, Endpoint, Modell und Credentials sind getrennt. Kritische Klassifikation, Träume, Emotion und Chat bleiben außerhalb der Allowlist. Synchrones Coalescing, async Fail-open, Abbruchisolation und Reparatur korrupter Cacheantworten getestet.
- Embedding-Cache default ohne Persistenz, Routing-/Revisions-/Präfixinvalidierung, Off-Schalter, DB/WAL-Byteaufnahmeprüfung, Metriken sowie sichere Lese-/Schreibfehler-Fallbacks. Identische Einzel- und Batchanfragen werden zusammengeführt; Byteprüfung mit Headroom ist keine harte Dateisystemquote.
- Capture-Admission mit begrenzter Queue und Wartefrist. Abgewiesene automatische Captures bleiben in der Retry-Queue ohne allein dadurch Backend-Versuche zu verbrauchen. Keine gewaltsame Beendigung laufender Python-I/O oder RSS-Garantie.
- Retry-Einträge bleiben bis zur erfolgreichen Verarbeitung auf Disk; Inflight-Deduplizierung verhindert paralleles erneutes Einreichen innerhalb der Runtime. Atomare/fsync-gesicherte Dateien mit Modus 0600; ausgeschöpfte Versuche bleiben im Dead-letter-Archiv erhalten. At-least-once, nicht Exactly-once: Ein Crash zwischen Memory-Write und Queue-Bestätigung kann einen Replay auslösen.
- Autorisierte, bestätigungsgebundene Remindererzeugung auf bestehenden Karten: feste absolute Zeit, gleiche ACL-Route, optionaler Text. Keine automatische Extraktion oder unabhängige Hintergrundzustellung.
- Semantic Lens/CRR unabhängig default-off; Lens mit Community-/Bridge-/Faded-Caps, CRR mit begrenztem Sessionzustand. Zeitprüfung bis zur Hydration verwirft verspätete Ergebnisse, kann aber keinen blockierten synchronen Datenbankaufruf nach exakt 50 ms präemptiv beenden. Nicht alle Upstream-Trigger sind vom Host verbunden.
- Native opt-in Style Directive/Dream Echo im Recall-Kontext. Echo scoped, zeitlich begrenzt, delimiter-escaped und ausdrücklich nicht vertrauenswürdige abgeleitete Hypothese, keine Diary-Rohinjektion.
- Lazy lokale Transformer-/Sentence-Transformer-T2-Adapter, keine automatischen Downloads oder Remote-Code-Freigabe. Ohne verfügbares konfiguriertes Modell sichtbarer T1-Fallback, kein falsches T2-Label. Live-Modellqualität wurde nicht gemessen.

## Konfiguration

Nur gewünschte Optionen in die bestehende Konfiguration übernehmen; kein automatisches Überschreiben eines Profils.

```json
{
  "autoCapture": true,
  "autoRecall": true,
  "runtime": {
    "maxQueueDepthCapturePerAgent": 10,
    "captureTimeoutMs": 60000,
    "embeddingCacheEnabled": true,
    "embeddingCachePersist": false,
    "llmResultCacheEnabled": true,
    "llmResultCachePersist": false
  },
  "recall": {
    "globalInjectMaxChars": 17000,
    "queryRefinement": {"enabled": true, "useLlm": false}
  },
  "semanticLens": {
    "enabled": false,
    "maxLensMemories": 3,
    "maxCommunities": 2,
    "maxBridgeMemories": 2,
    "maxFadedMemories": 1,
    "timeoutMs": 50
  },
  "conversationReactivationRecall": {
    "enabled": false,
    "maxReactivationMemories": 3,
    "timeoutMs": 50
  },
  "styleDirective": {"enabled": false},
  "dreamEcho": {"enabled": false}
}
```

Native `embedding.cache*`-/`llmResultCache`-Detailwerte haben Vorrang vor entsprechenden `runtime.*`-Aliases; `runtime.*CacheEnabled:false` schaltet aus. Persistenter LLM-Cache enthält Antworttext im Klartext, keine Prompts/Credentials: bewusstes Opt-in erforderlich.

T2 optional über `emotion.tier:"t2"` und `emotion.t2` mit `backend:"transformers"`, lokalem `model` und optionalem `labelMap`. Alternative `backend:"sentence-transformers"` benötigt ein `labels`-Objekt mit Emotionsnamen und Prototyptexten. Das Modell muss bereits lokal verfügbar sein.

Reminder (Zeitpunkt muss beim Aufruf in der Zukunft liegen):

```text
/plur1bus reminders create MEMORY_UUID 2026-12-01T09:00:00+01:00 Bericht prüfen
```

Bestehende Controls-Bestätigung erforderlich. CRR/Lens/Style/Echo und Auto-Capture/Recall haben entsprechende Controls-Toggles.

## Weiterhin keine Vollparität

- Automatische Store-Merges mit vollständiger Upstream-LLM-Kandidatenstrategie. Native explizite Merge-Vorschläge können fehlende Metadaten-, Mirror-, Kognitions- und Graph-Materialisierung reparieren; die Quelle wird vorher nicht retiret. Graph-Mirror-Links brauchen weiterhin einen separaten Rebuild.
- Vollständige Reaction-Integration: vertrauenswürdige Reply-Outcome-Bindung besteht, ein allgemeiner Hermes-Plugin-Reaction-Hook fehlt.
- Vollständige Graph-/Entitäts- und Meta-Cognition-Verträge.
- Unabhängige Proaktivzustellung, plattformübergreifender nativer Scheduler, RSS-/harte I/O-Abbruchkontrolle.
- Browser-Discovery-/Consent-/Operator-Oberflächen für Workspace-Quellen. Die lokale CLI bietet bereits explizite revisionsgebundene Consent-Planung/Anwendung.
- Named Namespaces oder nicht-kooperierende Prozesse beim Reembedding-Generation-Switch; nur der explizite private Writer mit kooperierenden Runtime-Leases ist unterstützt.
- Jina-v3-Remote-Code-Kette bleibt gesperrt; weitere Konfigurations-/Hostunterschiede bleiben in `parity.py` sichtbar.

Grüne Regressionen bedeuten Funktionsfähigkeit der getesteten Implementierung, nicht Vollständigkeit gegenüber jeder Upstream-Funktion. Der absichtlich fehlschlagende strikte Paritätscheck ist kein Regressionstestfehler. Test-/Buildnachweise stehen beim neuen lokalen Artefaktsatz, getrennt von den älteren Paketen.

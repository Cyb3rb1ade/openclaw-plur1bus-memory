# Ergänzung zum Feature-Audit: Funktionsqualität und Feature-Erhalt

**Repository:** `/root/openclaw-plur1bus-memory`  
**Commit:** `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`  
**Datum:** 2026-07-18  
**Leitlinie:** Bestehende Funktionen erhalten; Kontrollen, Datenflüsse und Tests ergänzen statt Features abzuschalten

## Zweck und Abgrenzung

Dieses Dokument ergänzt [feature_audit.md](feature_audit.md). Die dortigen Befunde FA-01 bis FA-10 und die bestätigte Additivität von Semantic Lens und Conversation Reactivation Recall bleiben unverändert. Das Addendum leitet aus den nachgelagerten File-Reviews zusätzliche Anforderungen an Funktionsqualität und migrationssicheren Feature-Erhalt ab. Security-Kandidaten werden nicht neu kalibriert; sie werden nur dort referenziert, wo eine feature-erhaltende Korrektur den öffentlichen Produktvertrag konkretisiert.

Quellen: [review-017](../artifacts/02_discovery/file_reviews/review-017.json), [review-018](../artifacts/02_discovery/file_reviews/review-018.json), [review-039](../artifacts/02_discovery/file_reviews/review-039.json), [review-044](../artifacts/02_discovery/file_reviews/review-044.json), [review-045](../artifacts/02_discovery/file_reviews/review-045.json), [review-046](../artifacts/02_discovery/file_reviews/review-046.json) und [review-047](../artifacts/02_discovery/file_reviews/review-047.json).

## Ergänzende Feature-Matrix

| Bereich | Ergänzter Status | Beleg | Feature-erhaltende Zielsetzung |
| --- | --- | --- | --- |
| Auto-Capture | Implementiert, aber nicht verlustsicher | `scripts/auto-capture-lancedb.mjs:550-560`, `:635-746` | Capture fortführen, Checkpoints jedoch erst nach durabler Persistenz bestätigen |
| Neo-Archiv/Recall | Teilweise; Scope, Store-Key und Embeddingzustand widersprechen dem Vertrag | `lib/neo-arch.js:186-189`, `:715-877`, `:985-1074`, `:1140-1187`, `:1647-1758` | Private und geteilte Records parallel erhalten, aber bei jedem Read korrekt autorisieren und wirklich embedden |
| Obsidian Safety Modes | Verdrahtet, aber Mutation Policy nicht durchgängig | `lib/obsidian-bridge.js:1746-1908`, `lib/obsidian-control-room.js:1756-1979` | Dashboard, Graph, Review und Sync behalten; alle Writes über eine einheitliche Policy führen |
| Wiki-Command | Vorhanden, aber Objekt-/Lifecycle-Kontrollen sind je Operation uneinheitlich | `lib/wiki-command.js:40-73`, `:157-186`, `:220-300`, `:343-361` | Add/Search/Delete vollständig behalten und vorhandene ACL-/Statusprimitiven wiederverwenden |
| Installer/Update | Nicht erhaltend für explizit deaktivierte oder ältere Memory-Backends | `scripts/install-memory-system.sh:1234`, `:1298`, `scripts/lib/installer-config.mjs:67-77` | Kein Backend/Feature ohne bestätigten Migrationsplan deaktivieren oder reaktivieren |
| Multi-Namespace | Bestehende FA-03/FA-06 werden um Pfad- und Read-only-Invarianten ergänzt | `lib/multi-namespace-pool.js:29-54`, `lib/namespace-config.js:1-26`, `index.js:2523-2549` | Namespace-Support erreichbar machen, aber IDs, Pfade und Schreibrollen vor Aktivierung validieren |
| Wartung/Reindex | Mehrere Tools sind Diagnose-Scaffolds oder verwenden falsche Standards | `scripts/reindex-provider.mjs:23-38`, `scripts/migrate-missing-columns.mjs:80-96`, `scripts/repair-installed-plugin.mjs:195-221` | Diagnose, Apply, Verifikation und Rollback als vollständige, ehrliche Betriebsabläufe anbieten |
| Provider-/Zeitkonfiguration | Fehlerhafte Eingaben werden als Deaktivierung oder stiller Fallback interpretiert | `scripts/provider-wizard.mjs:128-138`, `lib/time-window.js:39-66` | Ungültige Eingaben ablehnen oder erneut abfragen; keine implizite Feature-Abschaltung |

## Ergänzende Befunde und Erhaltungsanforderungen

### FE-ADD-01 — Installer und „preserve“-Modus erhalten den vorhandenen Funktionszustand nicht zuverlässig

Der Vollinstaller setzt `plugins.entries.memory-lancedb.enabled=false` ohne einen nachgewiesenen Daten-/Provider-Migrationspfad oder eine gesonderte Bestätigung (`scripts/install-memory-system.sh:1234`, `:1298`). Umgekehrt setzt `applyInstallerFeaturePolicy()` die aktuelle Plugin-Entry auch im Preserve-Modus auf `enabled=true`; `restoreExplicitDisabledFeatures()` stellt nur untergeordnete `config`-Flags wieder her (`scripts/lib/installer-config.mjs:67-77`). Damit kann ein Update ein altes Backend abschalten und zugleich ein bewusst deaktiviertes neues Plugin reaktivieren.

**Erhaltungsanforderung:** Vor jeder Zustandsänderung den Ist-Zustand beider Backends, Datenpfade, Dimensionen und expliziten Opt-outs erfassen. Migration additiv durchführen, Recall-/Write-Parität verifizieren und erst danach eine klar bestätigte Umschaltung anbieten. Preserve muss top-level `enabled:false` genauso respektieren wie untergeordnete Flags. Rollback und alte Daten bleiben verfügbar; kein Feature wird als Nebenwirkung eines Updates deaktiviert.

**Regressionstest:** Matrix aus fehlender, aktivierter und explizit deaktivierter Entry sowie aktivem Legacy-Backend. Nach „preserve“ müssen alle expliziten Zustände bytegenau erhalten bleiben; eine Migration darf erst nach bestätigtem Plan umschalten.

### FE-ADD-02 — Neo braucht gleichzeitig echte Privatheit, kollisionsfreie Workspaces und reale Embeddings

Neo versieht Assistant-Turns und Kandidaten mit `agent_private` und `agentId` (`lib/neo-arch.js:715-877`), partitioniert die Dateien aber nur nach einem verlustbehaftet bereinigten Workspace-Key (`:186-189`, `:1140-1187`). Read-/Recall-Helfer erhalten keine Requester-Agent-ID und filtern Scope/Eigentümer nicht (`:985-1074`). Die Bereinigung ist nicht injektiv; beispielsweise kollidieren Schlüssel wie `tenant/a` und `tenant_a`. Parallel markiert der Embedding-Drain Einträge als frisch/erledigt, ohne einen Vektor zu berechnen (`:1647-1758`). Ungesperrte Dateiupdates können außerdem Records oder Indexzustand verlieren (`:1416-1524`).

**Erhaltungsanforderung:** Workspace-Sharing beibehalten, aber `agent_private` bei jedem Read an die Requester-Agent-ID binden; bewusst geteilte Scopes bleiben sichtbar. Store-Verzeichnisse aus einer validierten kanonischen ID plus stabilem Hash ableiten und vorhandene Verzeichnisse migrationssicher zuordnen. Embeddingstatus nur atomar mit einem echten Vektor fortschreiben. Alle Writer eines Workspace verwenden dieselbe Queue/Lock-Grenze.

**Regressionstest:** Zwei Agents in einem geteilten Workspace mit je privatem und gemeinsamem Record; zwei kollidierende Rohschlüssel; semantisch ähnlicher, lexikalisch abweichender Recall; paralleler Append/Cap. Erwartet werden getrennte Privatdaten, erhaltene Shared-Daten, kollisionsfreie Pfade, echte Vektoren und null verlorene Rows.

### FE-ADD-03 — Obsidian-Modi benötigen eine einzige, überall wirksame Mutation Policy

Der Bridge-Code normalisiert `mode`, `dryRun`, `allowWrite` und Vault-Bestätigung, wendet diese Kontrollen aber nicht auf alle Hintergrundpfade an. `rebuildDashboards()` kann beim Start und periodisch Bundle-Zustand, Memory-Mirrors, Commands, Dashboards und Graph-Link-Blöcke schreiben, obwohl Dry-run, Augment/Read-only oder unbestätigter Vault konfiguriert sind (`lib/obsidian-bridge.js:1746-1908`). Approval-/Review-Zustand liegt im als untrusted behandelten Vault; Shared-Vault-Bundles besitzen minute-genaue, nicht agent-namespaced IDs und werden ohne konsistente Agent-/Workspace-Prüfung ausgewählt und angewendet (`lib/obsidian-control-room.js:896-902`, `:1324-1340`, `:1727-1979`, `:2553-2583`).

**Erhaltungsanforderung:** Bridge, Dashboard, Graph, Review, Rotation und Sync bleiben verfügbar, erhalten aber einen gemeinsamen unveränderlichen `MutationPolicy`-Kontext. Dry-run erzeugt ausschließlich einen Plan; Read-only/Augment mutiert keine Vault- oder Review-Datei. Bestätigungs-/Approval-Receipts werden außerhalb des untrusted Vault oder authentisiert gespeichert. Bundle-ID und Storage werden nach validierter Agent-/Workspace-ID namespaced, und Ownership wird bei Create, Latest, Statusupdate und Apply geprüft.

**Regressionstest:** Dieselbe temporäre Vault-Fixture in `dryRun`, `allowWrite=false`, unbestätigt und Apply-Modus ausführen; in den ersten drei Fällen müssen Inhalt und mtime sämtlicher Dateien unverändert bleiben. Zwei Agents in einem Shared Vault dürfen nur eigene Bundles auswählen/anwenden, während gemeinsame Dashboards und Graph-Links weiter funktionieren.

### FE-ADD-04 — Wiki-Funktionen sollen vollständig erhalten bleiben, aber dieselbe ACL- und Lifecycle-Semantik teilen

Die vier in review-039 reproduzierten Operationspfade zeigen keine Notwendigkeit, `/wiki` zu deaktivieren:

- Die Duplikatprüfung von Add sucht unscoped über alle Memory-Arten und rendert fremde Summary-/Textvorschauen (`lib/wiki-command.js:157-186`).
- Delete per UUID prüft globale Befehlsberechtigung und Memory-Art, aber nicht die bereits aufgebaute Record-ACL (`:220-255`).
- Delete per Query filtert weder Auswahl noch Mehrdeutigkeitsausgabe per Record-ACL (`:258-300`).
- Der Legacy-/Error-Fallback der Suche wiederholt den `active`-Statusfilter des Primärpfads nicht (`:40-73`).

**Erhaltungsanforderung:** Add, Search und beide Delete-Varianten bleiben bestehen. Vor Duplikatantwort, Mehrdeutigkeitsanzeige, Archiv und Delete stets `checkAccess()` mit demselben Request-Kontext anwenden; Add zusätzlich auf `memoryKind=wiki` begrenzen. Den Lifecycle-Filter aus dem sicheren `vectorSearchActive`-Muster auch im Fallback verwenden. Archive-first und UUID-/Kind-Prüfung bleiben erhalten; destruktive Aktionen ergänzen das vorhandene Audit-Log.

**Regressionstest:** Owner-/Workspace-/User-Scope-Matrix für Add, Search, UUID-Delete und Query-Delete; aktive versus superseded/archived Rows; erlaubte Operationen müssen weiterhin erfolgreich sein, fremde Rows dürfen weder erscheinen noch mutiert werden.

### FE-ADD-05 — Multi-Namespace braucht vor Freischaltung vollständige Pfad- und Rollen-Invarianten

FA-03 und FA-06 dokumentieren bereits den fehlerhaften Result-Merge und das fehlende Manifestfeld. Die nachgelagerte Vollsicht ergänzt: Namespace-Namen werden unverändert an `join(baseDir, namespace)` gegeben, `activeWriteNamespace` kann zugleich in `legacyReadOnly` stehen, und `isLegacyReadOnly()` wird im produktiven Routing nicht erzwungen (`lib/multi-namespace-pool.js:29-54`, `lib/namespace-config.js:1-26`). Der Runtime-Pfad kann angeforderte Namespace-Routen außerdem still auf `.` reduzieren, wenn `baseDbPath` nicht bereits mit dem aktiven Namespace endet (`index.js:2531-2547`). Das strikte Manifest verhindert aktuell gewöhnliche Aktivierung; diese Nicht-Erreichbarkeit ist aber kein Ersatz für sichere Invarianten.

**Erhaltungsanforderung:** `namespaces` schema-valide und explizit opt-in machen. Namespace-IDs mit einer festen Syntax validieren, jeden DB-Pfad kanonisch unter einem Basispfad auflösen und aktive Schreibrolle disjunkt zu Read-only-Rollen erzwingen. Ungültige oder kollabierende Pfadformen müssen fail-closed diagnostiziert werden. Der bereits empfohlene korrekte Merge aus FA-03 bleibt Bestandteil derselben End-to-End-Abnahme.

**Regressionstest:** Traversal-Namen, absolute Namen, aktive/read-only Überschneidung, unterschiedliche Basis-Pfadformen und zwei echte Read-Namespaces mit mehreren Treffern. Kein Test darf die Funktion durch pauschales Abschalten „lösen“; gültige Namespaces müssen weiterhin parallel lesbar sein.

### FE-ADD-06 — Betriebswerkzeuge müssen ihren tatsächlichen Funktionsumfang ehrlich und verifizierbar abbilden

`scripts/reindex-provider.mjs` ist ausdrücklich report-only und lehnt `--apply` immer ab (`:23-38`); Re-Embedding und Config-Switch sind somit weiterhin ein Scaffold. `scripts/migrate-missing-columns.mjs` sucht standardmäßig direkt im Namespace-Basispfad statt in den per-Agent-Verzeichnissen (`:80-96`). `scripts/repair-installed-plugin.mjs` ignoriert den Exitstatus der optionalen Wartung und prüft den Endzustand nicht erneut (`:195-221`). `scripts/protect-plur1bus-deploy.sh` hängt von einem hart kodierten Root-Checker ab (`:111-132`). `scripts/repair-dreaming-cron.mjs` implementiert keinen konsistenten Hilfezweig; `scripts/run-graph-links-once.mjs` ist ein explizit schreibender lokaler One-shot ohne eigenen Dry-run-/Bestätigungsmodus.

**Erhaltungsanforderung:** Für jedes Tool klar zwischen `doctor/report`, `plan/dry-run`, `apply` und `verify` unterscheiden. Reindex erst als Apply-Funktion anbieten, wenn Schema, Quelltextfeld, Zielprovider, Dimensionen, per-Agent-Pfade, Resume und Rollback verifiziert sind. Migration/Repair müssen alle Agenten sicher enumerieren und pro Ziel einen nachprüfbaren Endstatus liefern. Graph-Link-One-shot soll den konfliktgeschützten Writer behalten, aber einen Plan-/Dry-run-Modus anbieten.

**Regressionstest:** CLI-Vertragstests für `--help`, ungültige Flags, Dry-run ohne mtime-Änderung, fehlgeschlagenen Kindprozess, mehrere Agents, Reindex-Resume und Rollback. Erfolg darf erst nach erneuter Zustandsprüfung gemeldet werden.

### FE-ADD-07 — Fehlkonfiguration darf keine stillschweigende Feature-Abschaltung oder Semantikänderung sein

Der Provider-Wizard interpretiert jede ungültige erweiterte Reranker-Auswahl als `disabled` (`scripts/provider-wizard.mjs:128-138`). `lib/time-window.js` fällt bei ungültiger Zeitzone still auf Serverlokalzeit zurück und akzeptiert Stunden außerhalb `0..23` (`:39-66`). Das fehlerhafte `recall.decisionTrace`-Schema ist bereits als FA-09 erfasst; die neuen Belege bestätigen das übergreifende Muster, dass Konfiguration und beobachtbare Runtime-Semantik zu wenig gemeinsam validiert werden.

**Erhaltungsanforderung:** Interaktive Tippfehler erneut abfragen; Deaktivierung braucht eine explizite Auswahl. Ungültige Zeitzone/Stunden beim Laden ablehnen und den exakten Config-Pfad nennen. Manifest, Wizard und Runtime müssen denselben Validator beziehungsweise dieselben zulässigen Werte verwenden.

## Erhaltungsprinzipien für die Umsetzung

1. **Additive Migration:** Neue Speicher-, Namespace- oder Providerpfade neben dem vorhandenen Zustand aufbauen, verifizieren und erst nach Bestätigung umschalten.
2. **Explizite Zustandsänderung:** `disabled`, Delete, Apply und Backend-Switch nie aus Tippfehlern, fehlenden Werten oder einem „preserve“-Pfad ableiten.
3. **Eine Kontrollwahrheit:** ACL, Scope, Lifecycle, Dry-run und Confirmation einmal normalisieren und denselben unveränderlichen Kontext bis zum Sink weiterreichen.
4. **Durable-before-ack:** Capture-, Embedding-, Merge- und Wartungsstatus erst bestätigen, wenn die zugehörigen Daten durabel und verifiziert sind.
5. **Feature-positive Tests:** Regressionstests müssen sowohl den blockierten Fremd-/Fehlerfall als auch den weiterhin erfolgreichen legitimen Use Case beweisen.
6. **Kein Abschalten als Fix:** Semantic Lens, CRR, Neo, Obsidian, Wiki, Graph-Links, Multi-Namespace, Reranking und Wartung bleiben verfügbar; korrigiert werden Routing, Validierung, Ownership, Atomizität und Diagnose.

## Ergänzende priorisierte Testmatrix

### P0

1. Auto-Capture End-to-End mit Embed-/Insert-Fehler, Rotation und Neustart; keine verlorenen oder doppelt bestätigten Session-Einträge.
2. Installer-Preserve-Matrix inklusive explizit deaktivierter Entry und aktivem Legacy-Backend; keine implizite De-/Reaktivierung.
3. Neo Cross-Agent-/Cross-Workspace-Test mit privaten und geteilten Records, kollidierenden Schlüsseln und echten Vektoren.
4. Obsidian-Modusmatrix mit Dateibaum-/mtime-Vergleich und Shared-Vault-Bundle-Ownership.
5. Wiki-Operationsmatrix mit ACL und Lifecycle für Add, Search und beide Delete-Varianten.

### P1

6. Multi-Namespace: Schema, sichere Pfade, Read-only-Rollen und korrekter Mehrtreffer-Merge in einem Runtime-Test.
7. Wartung: negative `--keep`-Werte, Kindprozessfehler, per-Agent-Migration und verifizierter Endstatus.
8. Reindex: zunächst prüfbarer Plan; später resumable Apply mit Backup, Dimensions-/Schema-Gate und Rollback.

### P2

9. Provider-/Zeitkonfiguration: ungültige Eingaben ändern keine aktive Featurekonfiguration und liefern einen präzisen Fehler.
10. CLI-Ergonomie: konsistente `--help`, unbekannte Optionen fail-closed und Dry-run für schreibende One-shots.

## Verifikationsstand der zugrunde liegenden Receipts

- review-017: acht gezielte Metrics-/Mood-/Namespace-/Neo-Testdateien bestanden; Offline-Probes bestätigten Scope-, Workspace-Key- und Namespace-Kontrolllücken.
- review-018: acht gezielte Worker-/Obsidian-Testdateien bestanden; direkte Probes bestätigten die abweichende Dry-run-/Autorisierungssemantik.
- review-039: sechs gezielte Tests bestanden; Handler-Mocks reproduzierten die vier Wiki-Operationspfade, und ein Timeout-Probe beobachtete den verspäteten Seiteneffekt.
- review-044: Auto-Capture-Import-/Batchtests bestanden, deckten den vollständigen Checkpoint-/Persistenzpfad aber nicht ab.
- review-046: fünf gezielte Script-/Provider-Tests sowie Syntaxprüfungen bestanden; die beschriebenen Grenzfälle fehlen in diesen Tests.
- review-047: Snapshot- und Repair-Script-Tests sowie JS-/Shell-Syntaxprüfungen bestanden; Reindex bleibt bewusst report-only, und eine Live-Cron-Prüfung war ohne lokale OpenClaw-CLI nicht möglich.

Diese Testlage spricht nicht gegen die Befunde: Die vorhandenen Suiten sichern überwiegend normale Helper-/Happy-Paths, während die Addenda genau die fehlenden End-to-End-, Fehler-, Ownership- und Grenzwertfälle benennen.


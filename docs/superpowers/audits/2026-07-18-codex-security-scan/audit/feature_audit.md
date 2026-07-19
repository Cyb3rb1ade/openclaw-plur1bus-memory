# Feature-Audit: PLUR1BUS Memory Plugin

**Untersuchtes Repository:** `/root/openclaw-plur1bus-memory`  
**Untersuchter Commit:** `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`  
**Audit-Datum:** 2026-07-18  
**Vorgehen:** Read-only-Abgleich von README, Konfigurationsdokumentation, Manifest/Schema, Paketinhalt, Runtime-Hooks, Commands, Jobs, Recall-Pipeline, ACL/Namespaces, Obsidian-Bridge und Tests. Produktcode und Tests wurden nicht verändert.

## Kurzfazit

Die Kernfunktionen – per-Agent-LanceDB, Store-/Recall-Tools, Auto-Capture/Auto-Recall, der produktive Memory-Graph sowie die beiden additiven Recall-Booster Semantic Lens und Conversation Reactivation Recall (CRR) – sind tatsächlich verdrahtet. Für die ausdrücklich geforderte additive Invariante wurde **keine Verletzung** gefunden: Beide Booster laufen nach dem Basis-Recall, hängen Ergebnisse beziehungsweise einen separaten Kontextblock an und fallen bei Timeout/Fehler auf den unveränderten Basis-Recall zurück.

Das öffentliche Feature-Versprechen ist dennoch in mehreren wichtigen Bereichen nicht konsistent mit der Runtime. Bestätigt wurden **4 hohe** und **6 mittlere** Befunde. Am gravierendsten sind die implizite „Full Experience“-Umschreibung fehlender Konfigurationswerte, das fehlerhafte Safe-Profil, ein Argumentfehler, der Multi-Namespace-Recall auf genau einen Treffer begrenzt, und eine nicht end-to-end funktionsfähige Collaborative-Memory-/`/share`-Kette.

## Feature-Matrix

| Feature/Vertrag | Status | Implementierungsbeleg | Audit-Ergebnis |
| --- | --- | --- | --- |
| Version und Paket-Metadaten | Implementiert | `README.md:5`, `package.json:2-6`, `openclaw.plugin.json:2-5` | Alle drei Quellen nennen 7.0.0. |
| Per-Agent-LanceDB und Provider-Verträge | Implementiert | `index.js:2123-2136`, `lib/providers/openclaw-memory-embedding-adapters.js:13-17`, `lib/providers/openclaw-memory-embedding-adapters.js:236-318` | Plugin-ID, Speicherpfad und registrierte Provider sind konsistent. |
| Öffentliche Memory-Tools | Implementiert | `index.js:4864-5031`, `index.js:5205-5463`; Test `tests/tool-registration-metadata.test.js:8-55` | Store/Recall/Search sind registriert und besitzen Metadaten. |
| Auto-Capture, Auto-Recall und Lifecycle-Hooks | Implementiert | `index.js:4255-4269`, `index.js:4839-4857`, `index.js:5510-5535`, `index.js:5537-6160`, `index.js:6356-6445` | Produktive Hook-Pfade vorhanden. |
| Memory-Graph | Implementiert | Edge-Aufbau `lib/memory-graph.js:370-485`; Recall `lib/recall-pipeline.js:887-931` | Semantische, zeitliche, Entity-, Emotions- und Episode-Edges sind live; Traversal wird pro Recall aus dem Graph aufgebaut. |
| Semantic Lens | Implementiert | `lib/semantic-lens-index.js:5-13`, `lib/semantic-lens-index.js:71-118`, `lib/semantic-lens-index.js:146-241`, `index.js:5816-5839`, `lib/relevant-memory-context.js:217-225` | Default aus, harte Caps, vorab berechneter Index, Deduplizierung, 50-ms-Fallback und separater Append-Block entsprechen dem Vertrag. |
| Conversation Reactivation Recall | Implementiert | `lib/conversation-reactivation-recall.js:674-771`, `index.js:6031-6071`, `index.js:6256`; Test `tests/conversation-reactivation-recall.test.js` | Default aus, In-Memory-State, begrenzte Auswahl, 50-ms-Runtime-Grenze und separater `<memory-reactivation>`-Block. |
| Feature-Profile/Bestätigung | Defekt | `lib/setup/feature-profiles.js:20-50`, `lib/setup/feature-profiles.js:118-223`, `index.js:2129-2163` | Fehlende Werte werden zur Laufzeit als „Full Experience“ aktiviert; dokumentierte Defaults und Bestätigungsgates werden umgangen. Siehe FA-01. |
| Safe-Profil | Defekt | `lib/setup/feature-profiles.js:232-250`, `lib/setup/feature-profiles.js:281-303` | Aktiviert weiterhin Schreib-/LLM-intensive Features; bei neuer Plugin-Entry sogar alle Core-Features. Ungültiger Mode-Wert. Siehe FA-02. |
| Multi-Namespace-Recall | Defekt | `lib/multi-namespace-pool.js:29-39`, `index.js:4955-4970`, `index.js:5750-5765` | Laufzeitpfad vorhanden, aber Merge wird wegen falscher `dedupResults`-Signatur auf einen Treffer gekappt; Schema akzeptiert `namespaces` nicht. Siehe FA-03. |
| Collaborative Memory/`/share`/User-Scope | Defekt | `lib/shared-memory.js:54-133`, `lib/acl-middleware.js:47-99`, `index.js:3738-3781`, `index.js:4193-4227` | Helper existieren, Command und gemeinsame Recall-Kette fehlen; ACL verwirft `workspace_shared`. Siehe FA-04. |
| Graph-Link `semanticDiscovery` | Nicht erreichbar | `index.js:387-405`, `index.js:3085-3102`, `index.js:3192-3222`, `lib/obsidian/semantic-link-discoverer.js:73-78` | Der Runtime-Caller kann das zwingende `confirm: true` nicht liefern; der Link-Index wird deshalb nie geschrieben. Siehe FA-05. |
| Manifest/Runtime-Konfigurationsvertrag | Teilweise/defekt | Striktes Schema `openclaw.plugin.json:20-23`; Runtime-Leser u. a. `index.js:2217-2277`, `index.js:2385-2390`, `index.js:2523-2549` | Mehrere produktive Optionen sind im strikten Schema nicht zulässig, andere Schemafelder werden nicht ausgewertet oder liegen am falschen Pfad. Siehe FA-06 und FA-09. |
| Recall-Hardening aus README | Teilweise | `lib/recall-pipeline.js:433-466`, `lib/recall-budget.js:17-47`, `lib/graph-index.js:7-78`, `lib/text-utils.js:122` | Grundpipeline ist live; Query-Refinement, dynamischer Budget-Resolver, `GraphIndex` und der beworbene Prompt-Kompressor sind nicht produktiv verdrahtet. Siehe FA-07. |
| Hintergrundjobs | Teilweise | Handler `index.js:2985-3252`; Provisionierung `lib/setup/feature-cron-plan.js:23-58` | Viele Handler sind manuell erreichbar, der Standard-Cron-Plan provisioniert aber nur Persona-Evolve und Afterthought. Siehe FA-08. |
| Commands | Teilweise | `index.js:3758-3781`, `index.js:3888-3916`, `index.js:4193-4227` | Umfangreiche Multi-Channel-Registrierung vorhanden; dokumentiertes `/share` fehlt. |

## Bestätigte Befunde

### FA-01 – Hoch: Die Runtime aktiviert fehlende „Full Experience“-Werte entgegen Manifest, README und Bestätigungsmodell

**Beleg.** Beim Registrieren wird jede eingehende Konfiguration ohne vorherige Nutzeraktion durch `applyFullExperiencePolicy()` geschickt (`index.js:2129-2136`). Diese Policy definiert Reranker, Emotion T3, Merge inklusive Auto-Apply, Schicht 1.5, Skill Miner, Daily Consolidation, Obsidian Bridge sowie Morning/Evening Reviews als Core-Features mit `true` (`lib/setup/feature-profiles.js:20-50`). Sie ergänzt alle fehlenden Werte (`lib/setup/feature-profiles.js:203-223`) und setzt zusätzlich unter anderem Reranker-Timeout 2500 ms, Obsidian-Mode `apply`, `requireVaultPathConfirmation: false`, `autoApplyLowRisk: true`, `dryRun: false` und `semanticGraph.proposalOnly: false` (`lib/setup/feature-profiles.js:118-190`). Auswahlhistorie und `featuresConfirmedAt` werden explizit entfernt (`lib/setup/feature-profiles.js:98-102`). Explizite `false`-Opt-outs bleiben zwar erhalten; **nicht gesetzte** Optionen werden jedoch effektiv aktiviert.

Das widerspricht den Manifest-Defaults: Reranker `false` und 5000 ms (`openclaw.plugin.json:403-437`), Merge/Auto-Apply `false` (`openclaw.plugin.json:464-493`), Skill Miner `false` (`openclaw.plugin.json:556-570`), Daily Consolidation `false` (`openclaw.plugin.json:1603-1610`), Reviews `false` (`openclaw.plugin.json:1752-1794`), Emotion T3 `false` (`openclaw.plugin.json:1842-1849`) und Obsidian Bridge `false`/`augment` (`openclaw.plugin.json:950-965`). Es widerspricht außerdem den Aussagen „advanced features require explicit confirmation“, „never auto-applies“ und „vault path confirmation required“ (`README.md:121-128`) sowie dem dokumentierten Setup-Vertrag (`README.md:173-185`, `README.md:367-376`).

Der Auto-Apply-Pfad ist nicht nur Konfiguration: Wenn Merge-Provider und Kandidat vorhanden sind, kann Store/Capture das alte Objekt archivieren, löschen und das gemergte Objekt schreiben (`index.js:2687-2729`, zweiter analoger Pfad `index.js:5101-5130`). Daily Consolidation selbst bleibt proposal-only, weil sein Handler kein Auto-Apply-Flag übergibt (`index.js:2996-3011`); das öffentliche „never auto-applies“ ist damit mindestens für den Inline-Merge-Pfad falsch.

**Dynamischer Nachweis.** Bei einer bestehenden leeren Plugin-Konfiguration blieben im Probe-Lauf Reranker und Merge nur wegen des expliziten Safe-Profils aus, während `merging.autoApply`, Skill Miner, Daily Consolidation und Emotion T3 auf `true` ergänzt wurden. Ein komplett neuer Eintrag wurde mit `forceFullExperience` vollständig aktiviert. Ein programmatischer Vergleich von Schema-Defaults und `fullExperienceDefaults()` zeigte unter anderem die Paare `false/true` für Reranker, Merge, Merge-Auto-Apply, Skill Miner, Daily Consolidation, Obsidian und Reviews sowie `5000/2500` für den Reranker-Timeout.

**Auswirkung.** Betreiber können aus Manifest und README nicht ableiten, welche teuren oder schreibenden Features effektiv laufen. Besonders kritisch sind implizites Merge-Auto-Apply und das Abschalten der Vault-Pfad-Bestätigung. Provider-Gates lassen einzelne LLM-Pfade fail-soft ausfallen, stellen aber den Konfigurations- und Sicherheitsvertrag nicht wieder her.

**Testlücke.** `tests/smoke-feature-profiles.test.js:25-47` und `tests/smoke-feature-profiles.test.js:149-178` schreiben das Full-Experience-Verhalten fest, prüfen aber nicht gegen Manifest-Defaults oder die README-Sicherheitszusagen.

### FA-02 – Hoch: Das „Safe“-Profil ist weder safe noch schema-valide

**Beleg.** `safeProfile()` deaktiviert nur Reviews, Reranker, Merge und Schicht 1.5, lässt Obsidian aktiviert und setzt `mode: "dry-run"` (`lib/setup/feature-profiles.js:232-250`). Anschließend ruft `applyFeatureProfile()` wieder die Full-Experience-Policy auf; bei fehlender Plugin-Entry sogar mit `forceFullExperience: true` (`lib/setup/feature-profiles.js:281-303`). Dadurch werden bei einer neuen Entry auch die zuvor auf `false` gesetzten Core-Features wieder aktiviert. Bei einer vorhandenen leeren Entry bleiben die explizit deaktivierten Features aus, aber nicht erwähnte fortgeschrittene Features wie Skill Miner, Daily Consolidation und Emotion T3 werden eingeschaltet; `merging.autoApply: true` bleibt als latenter Wert zurück.

Zusätzlich ist `"dry-run"` kein zulässiger Manifest-Wert; das strikte Schema erlaubt nur `augment` und `apply` (`openclaw.plugin.json:950-965`). Der Chat-Command schreibt dieses Ergebnis atomar in `openclaw.json` (`index.js:3380-3455`). Ein späterer strikter Reload kann die Konfiguration deshalb ablehnen.

**Auswirkung.** Ein als risikoarm beworbenes Setup kann Features aktivieren, die es gerade ausschließen soll, und eine nicht schema-konforme Konfigurationsdatei erzeugen.

**Testlücke.** `tests/smoke-feature-profiles.test.js:49-55` und `tests/smoke-feature-profiles.test.js:120-123` prüfen nur das rohe Profil und kodieren den ungültigen Mode; sie testen weder das resultierende `applyFeatureProfile()`-Objekt noch eine Validierung gegen das Manifest.

### FA-03 – Hoch: Multi-Namespace-Recall wird auf genau einen Memory-Treffer reduziert

**Beleg.** Der produktive Mehrfach-Namespace-Pfad führt pro Datenbank die Recall-Pipeline aus und merged anschließend (`index.js:4955-4970`, Auto-Recall analog `index.js:5750-5765`). Dabei wird `dedupResults(flattenedResults, dedupJaccard)` aufgerufen. Die tatsächliche Signatur lautet jedoch `dedupResults(results, maxOut, jaccardThreshold = 0.78)` (`lib/recall-pipeline.js:72-92`). Mit dem Standardwert 0,78 wird somit `maxOut=0.78`; nach dem ersten behaltenen Element ist `out.length === 1 >= 0.78`, und die Schleife endet. Der dynamische Probe-Lauf ergab entsprechend einen Treffer für den fehlerhaften Aufruf und drei Treffer für `dedupResults(results, 12, 0.78)`.

Zusätzlich werden die Canonical-Hits jeder Namespace-Pipeline ungefiltert zusammengeführt (`index.js:4962-4970`, `index.js:5757-5765`). Da jede Pipeline denselben Workspace-`KNOWLEDGE.md`-Suchpfad ausführt (`lib/recall-pipeline.js:95-190`, `lib/recall-pipeline.js:788-818`), entstehen doppelte Canonical-Hits. Nur der Trace des ersten Namespace wird behalten. `MultiNamespacePool.getReadDbs(agentId)` liest außerdem in allen Namespaces immer denselben Agenten (`lib/multi-namespace-pool.js:29-39`), obwohl die README den Bereich als opt-in Cross-Agent-Recall beschreibt (`README.md:64-70`).

Schließlich ist `cfg.namespaces` zwar live (`index.js:2523-2549`), aber im Top-Level des strikten Schemas nicht deklariert (`openclaw.plugin.json:20-23`). Eine normale validierte Konfiguration kann den Pfad daher nicht einschalten.

**Auswirkung.** Sobald mehr als ein Read-Namespace aktiv ist, verliert der Recall fast alle Vektor-/Graph-Treffer und kann Canonical-Kontext duplizieren. Das ist ein direkter Funktionsfehler im beworbenen Multi-Namespace-Modus.

**Testlücke.** `tests/namespace-config.test.js` und `tests/multi-namespace-pool.test.js` prüfen Resolver und Pool isoliert, nicht den produktiven Merge in `index.js`.

### FA-04 – Hoch: Collaborative Memory, `/share` und User-Scope sind nicht end-to-end erreichbar

**Beleg.** Die README verspricht `/share` und einen ACL-geschützten Workspace-Pool (`README.md:104-110`, `README.md:173-185`). Der Helper `shareCard()` existiert (`lib/telegram-commands/memory-edit.js:269-344`), wird in `index.js` aber weder importiert noch geroutet. Weder die `/plur1bus`-Routerzweige noch die registrierten Commands enthalten `share` (`index.js:3738-3781`, `index.js:3888-3916`, `index.js:4193-4227`). Ein dynamischer Registrierungsprobe-Lauf bestätigte die fehlende Command-ID.

Auch der Datenpfad ist nicht gemeinsam: `storeSharedMemory()` schreibt in `dbPool.getDb(agentId)`, setzt Scope `workspace_shared` und verwendet ohne gelieferten Vektor einen Nullvektor (`lib/shared-memory.js:54-83`). `MultiNamespacePool` bleibt pro Agent (`lib/multi-namespace-pool.js:29-39`). Die zentrale ACL kennt nur `agent-private`, `workspace` und `user`; unbekannte Scopes werden fail-closed abgewiesen (`lib/acl-middleware.js:55-99`). Der normale Recall ruft sie ohne Sonderbehandlung auf (`lib/recall-pipeline.js:1035-1063`), sodass `workspace_shared` als `acl.unknown_scope` verworfen wird. Dies wurde dynamisch bestätigt.

Der separate `querySharedMemories()`-Helper ist nirgends produktiv aufgerufen. Sein Vektorpfad filtert zudem auf `r.scope`, obwohl DB-Suchergebnisse in der übrigen Pipeline als `{ entry, score }` behandelt werden (`lib/shared-memory.js:96-133`); selbst bei Verdrahtung würde er die üblichen Treffer daher verwerfen.

Ein verwandtes Problem betrifft `scope: "user"`: Die ACL verlangt `ctx.userId` (`lib/acl-middleware.js:82-95`), die automatische und modellinitiierte Recall-Pipeline erhält aber nur Agent-/Workspace-Kontext (`lib/recall-pipeline.js:1037-1041`; Aufrufer `index.js:4914-4954`, `index.js:5705-5749`). Der manuelle `/memory`-Pfad führt Nutzeridentität separat mit, wodurch die Sichtbarkeit je nach Recall-Einstieg variiert.

**Auswirkung.** Der dokumentierte Share-Command ist nicht aufrufbar; gespeicherte Shared Cards sind weder workspace-übergreifend abgelegt noch über den normalen Recall sichtbar. Nutzergebundene Memories verschwinden aus Auto-/Model-Recall.

**Testlücke.** `tests/forget-correct-confirm.test.js:136-159` prüft nur den isolierten Share-Helper. `tests/user-scope-acl.test.js:6-52` prüft nur die reine ACL, und `tests/shared-memory-store-guard.test.js:21-62` nur den Store-Guard – kein Test läuft vom Command beziehungsweise Hook bis zum Recall eines zweiten Agenten.

### FA-05 – Mittel: Semantic Discovery besitzt ein Gate, aber keinen bestätigbaren Runtime-Pfad

**Beleg.** Die Dokumentation verspricht, `.plur1bus/link-index.json` hinter einem Bestätigungsgate zu erzeugen (`README.md:153-159`, `docs/configuration.md:207-217`). Der Helper setzt korrekt zwingend `options.confirm === true` voraus (`lib/obsidian/semantic-link-discoverer.js:64-78`) und schreibt den Index nur dann (`lib/obsidian/semantic-link-discoverer.js:135-155`; weitere Apply-/Batch-Gates `lib/obsidian/semantic-link-discoverer.js:700-735`, `lib/obsidian/semantic-link-discoverer.js:791-803`, `lib/obsidian/semantic-link-discoverer.js:947-967`).

Der einzige Runtime-Wrapper ruft `discoverSemanticLinks()` jedoch ohne `confirm` auf (`index.js:387-405`). Sowohl der REM-Trigger (`index.js:3085-3102`) als auch `/plur1bus internal discover-semantic-links` (`index.js:3192-3222`) verwenden genau diesen Wrapper. Im Manifest existiert unter `semanticDiscovery` ebenfalls kein Confirm-Feld oder Nonce-Flow (`openclaw.plugin.json:1496-1521`). Der Index-Write endet deshalb stets mit `blocked: true, reason: "confirm_required"`.

Vor dem blockierten Discovery-Aufruf schreibt der Wrapper allerdings bereits Memory-Mirror-Notes (`index.js:397-405`). Der Command ist daher nicht wirkungsfrei, obwohl sein eigentliches Ergebnis nicht angewandt werden kann.

**Auswirkung.** Das beworbene Feature kann über die Plugin-Runtime keinen Link-Index erzeugen. Zugleich kann ein vermeintlich blockierter Lauf Vault-Mirror-Dateien verändern.

**Testlücke.** Die Helper-Tests beweisen das Gate korrekt (`tests/smoke-semantic-link-discoverer.test.js:210-249`), testen aber nicht den Runtime-Wrapper mit einem bestätigten Command/Callback.

### FA-06 – Mittel: Das strikte Manifest beschreibt nicht die tatsächlich auswertbare Konfiguration

**Beleg.** Das Top-Level-Schema verbietet unbekannte Eigenschaften (`openclaw.plugin.json:20-23`). Trotzdem liest die Runtime mehrere dort nicht deklarierte Top-Level-Optionen, unter anderem:

- `replyOutcomeTracking` (`index.js:2217-2225`, produktive Hooks `index.js:4839-4857` und `index.js:5510-5535`),
- `retroactiveInterference` (`index.js:2237`, Nutzung `index.js:2758-2766`),
- `dreaming.narrative` (`index.js:2267-2277`),
- `namespaces` (`index.js:2523-2549`),
- `reminders` (`index.js:3155-3167`),
- `embeddingBatchSize` (`index.js:4461`) sowie einzelne Top-Level-Varianten von `language`/`timezone` (`index.js:4695`, `index.js:6143-6154`).

Umgekehrt deklariert das Schema Optionen, die der Produktpfad nicht oder am falschen Ort auswertet. Die Runtime liest `metaCognition.sessionThreshold` und `intervalDays` (`index.js:2385-2390`), das Objekt erlaubt aber nur `enabled`, `llmReport`, `llmReportMode` und `fallbackOnError` (`openclaw.plugin.json:1796-1816`). Mehrere Merge-Sicherheitsfelder aus dem Manifest (`autoApplyRisk`, `backupBeforeApply`, `auditLog`, `maxAutoApplyPerRun`, `mode`; `openclaw.plugin.json:495-520`) werden bei der Runtime-Konfiguration nicht eingelesen (`index.js:2248-2261`).

Morning/Evening Review sind doppelt modelliert: einmal top-level (`openclaw.plugin.json:1752-1794`) und einmal innerhalb des Obsidian-Bridge-Objekts (`openclaw.plugin.json:1058-1145`). Profile und Toggle-Logik setzen den Top-Level-Pfad (`lib/setup/feature-profiles.js:40-41`, `lib/setup/feature-profiles.js:180-187`), der Bridge wird aber ausschließlich `cfg.obsidianBridge` übergeben (`index.js:2166-2167`, `index.js:2780-2799`), und sie liest die verschachtelten Review-Werte (`lib/obsidian-bridge.js:297-312`). Somit steuern die Profile nicht zuverlässig die realen Reviews.

Auch `hooks` ist im Config-Objekt deklariert (`openclaw.plugin.json:93-112`), während der Doctor/Installer die OpenClaw-Plugin-Entry-Eigenschaft neben `config` erwartet (`index.js:1460-1466`, `scripts/install-memory-system.sh:1226-1229`).

**Auswirkung.** Valide Konfiguration kann Live-Features nicht steuern; dokumentierte oder schema-validierte Werte können wirkungslos sein. Reload, Setup-Profile und Runtime sehen unterschiedliche Wahrheiten.

**Testlücke.** `tests/config-audit.test.js` prüft vorwiegend Defaults über einen eigenen Property-Walker, aber keine vollständige Reachability-Matrix „Schema-Pfad → Runtime-Leser → beobachtbarer Effekt“.

### FA-07 – Mittel: Mehrere beworbene Recall-Hardening-Komponenten sind nur teilweise oder nur in Tests verdrahtet

**Beleg.** Die README bewirbt Query Refinement (`README.md:104-110`) sowie „semantic recall compression, adaptive recall tiers, graph-index traversal“ (`README.md:112-117`). Der Abgleich ergibt:

- **Query Refinement:** Der Algorithmus existiert und ist standardmäßig deaktiviert (`lib/recall-pipeline.js:433-466`, Ausführung `lib/recall-pipeline.js:638-730`). Keiner der produktiven Pipeline-Aufrufer übergibt die Option (`index.js:4914-4954`, `index.js:5705-5749`), und es gibt kein Schemafeld. Das Feature ist damit nicht erreichbar.
- **Semantic Compression:** `compressMemoriesForPrompt()` existiert (`lib/text-utils.js:122`) und wird in `tests/recall-compression.test.js:86-246` getestet, aber nicht aus Produktcode importiert. Der Runtime-Pfad nutzt stattdessen vorhandene Summarys oder eine Einzel-Summary und formatiert anschließend normal (`index.js:5781-5813`, `index.js:6119-6130`). Basissummarization ist live, der beworbene Tokenbudget-Kompressor nicht.
- **Adaptive Budget:** `resolveRecallBudget()` passt das Budget nach Promptlänge an (`lib/recall-budget.js:17-47`), wird aber nur in Tests verwendet; die Runtime reicht stets `maxPromptMemories` weiter (`index.js:5711-5713`). Der Tier-Allocator selbst ist produktiv (`lib/recall-budget.js:124-151`, `lib/recall-pipeline.js:936-960`), also nur teilweise implementiert.
- **GraphIndex:** Die Klasse in `lib/graph-index.js:7-78` wird außerhalb von Tests/Perf-Smoke nicht importiert. Graph-Recall an sich ist live, baut aber pro Recall eine Adjazenz-Map (`lib/recall-pipeline.js:887-906`). Die konkrete Aussage „graph-index traversal“ beschreibt deshalb nicht den Produktpfad.
- **Pattern Surfacing:** Die Runtime ruft `findBestPattern()` mit festem `patternRecords: []` auf (`index.js:5856-5862`); ein aktivierter Schalter kann daher nie einen Treffer erzeugen.
- **`candidateTopK`:** Manifest und Doku nennen 40 initiale Kandidaten (`openclaw.plugin.json:643-646`, `docs/configuration.md:14-16`), die Runtime verwendet den Wert jedoch primär als Reranker-Kandidatenzahl (`index.js:2589-2593`). Ohne Reranker sucht die Pipeline nur `topN` statt `candidateTopK` (`lib/recall-pipeline.js:561-568`).

**Auswirkung.** Die grundlegende Recall-Pipeline funktioniert, aber die dokumentierten Qualitäts-/Performance-Eigenschaften sind je nach Konfiguration nicht erreichbar oder anders implementiert. Betreiber können diese Features nicht gezielt aktivieren oder dimensionieren.

**Testlücke.** Die vorhandenen Tests beweisen isolierte Helper, nicht deren Erreichbarkeit über Tool- und Hook-Pfade.

### FA-08 – Mittel: Die Job-Handler sind breit, die Standard-Cron-Provisionierung dagegen auf zwei Jobs begrenzt

**Beleg.** Runtime-Handler existieren unter anderem für Daily Consolidation, Critical Classification, REM Dreaming, Skill Miner, Feedback, Semantic Discovery, Afterthought, Persona Evolution, Reminders und Wartung (`index.js:2985-3252`). README und Architektur beschreiben Consolidator/Klassifikator als cron-driven (`README.md:3-9`) und behaupten, Neuinstallationen provisionierten `rem-dream` (`README.md:26-29`).

Der tatsächlich vom Standard-Postinstall und Gateway-Bootstrap verwendete Plan enthält jedoch ausschließlich `persona-evolve` und `afterthought` (`lib/setup/feature-cron-plan.js:23-58`; festgeschrieben durch `tests/feature-cron-plan.test.js:12-29`). `package.json:37-49` ruft nur `scripts/setup-feature-crons.mjs` auf; derselbe Scope wird beim Gateway-Bootstrap verwendet (`index.js:2802-2827`). REM-/Semantic-Crons erscheinen nur im Legacy-Vollinstaller (`scripts/install-memory-system.sh:1662-1768`), nicht im dokumentierten normalen Git-/npm-Installationspfad (`README.md:228-246`). Für Daily Consolidation, Classifier und Skill Miner gibt es im Standardplan keine Scheduler-Spezifikation.

**Auswirkung.** Die internen Commands sind manuell oder durch extern konfigurierte Crons nutzbar, aber eine Standardinstallation startet den Großteil der beworbenen Background-Jobs nicht automatisch. Besonders die Aussage zur REM-Neuinstallation ist für den primären Installationsweg falsch.

**Testlücke.** Der Plan-Test beweist genau die Zweierliste, gleicht sie aber nicht gegen README oder die Menge der als automatisch beworbenen Handler ab.

### FA-09 – Mittel: `recall.decisionTrace` ist im JSON-Schema strukturell falsch und teilweise wirkungslos

**Beleg.** Unter `recall.decisionTrace` fehlen `type: "object"`, `properties` und `additionalProperties`; `enabled`, `includeInPrompt` usw. stehen als unbekannte Schema-Keywords direkt im Objekt (`openclaw.plugin.json:681-706`). Ein standardkonformer Validator validiert die inneren Felder deshalb nicht wie beabsichtigt. Die Runtime erwartet dagegen ein Objekt (`index.js:2231-2235`). `enabled`, `includeInPrompt`, `maxCandidates` und `maxTextPreviewChars` werden verwendet; `persist` wird nur in eine lokale Variable gelesen und danach nicht benutzt, `visibleHints` wird in diesem Decision-Trace-Pfad nicht ausgewertet.

**Auswirkung.** Ungültige Typen/Keys können die Manifestprüfung passieren, während zwei öffentlich angebotene Optionen keinen Effekt haben.

**Testlücke.** Der eigene Rekursions-Helper in `tests/config-audit.test.js:20-33` behandelt die direkt eingetragenen Schlüssel wie Properties und verdeckt so die fehlerhafte JSON-Schema-Struktur; die Default-Tests `tests/config-audit.test.js:102-115` bleiben grün.

### FA-10 – Mittel: Öffentliche Konfiguration und Setup-Kommandos sind in zentralen Beispielen nicht ausführbar wie beschrieben

**Beleg.** `docs/configuration.md:5-6` sagt, Recall-Optionen lägen unter `config.recall`, zeigt sie im großen Beispiel aber top-level (`docs/configuration.md:104-139`). Wegen `additionalProperties: false` (`openclaw.plugin.json:20-23`) ist dieses Beispiel in der gezeigten Form ungültig.

Die README beschreibt `/plur1bus setup` als Bestätigung des Recommended-Profils (`README.md:173-185`) und `/plur1bus start` als Onboarding-Walkthrough (`README.md:64-70`). Tatsächlich listet `/plur1bus setup` ohne Argument nur Profile und verlangt explizit `recommended` oder `safe` (`index.js:3420-3426`); `/plur1bus start` gibt im Wesentlichen Status/Setup-Hinweise aus (`index.js:3254-3275`). Zugleich entfernt die Profil-Policy `featuresConfirmedAt` (`lib/setup/feature-profiles.js:98-102`), obwohl die Dokumentation die Bestätigung als persistente Voraussetzung darstellt.

Die Recall-Architektur ist ebenfalls veraltet: Sie beschreibt eine andere Pipeline-Reihenfolge und Tier-Taxonomie (`docs/recall-architecture.md:29-67`, `docs/recall-architecture.md:110-132`). Im Code läuft Canonical Search vor Scoring, Graph, Budget, Rerank, Dedup und ACL (`lib/recall-pipeline.js:788-1066`); „canonical“ bedeutet konkret `KNOWLEDGE.md`-Abschnittssuche (`lib/recall-pipeline.js:95-190`), nicht die in der Doku beschriebene Clusterklasse.

**Auswirkung.** Copy-and-paste-Konfiguration wird abgelehnt, und die wichtigsten Setup-Kommandos verhalten sich nicht wie angekündigt. Das erschwert sichere Aktivierung und Fehlersuche.

## Additive Recall-Invariante

### Semantic Lens – bestätigt

- Default und Caps entsprechen der Vorgabe (`lib/semantic-lens-index.js:5-13`, `lib/semantic-lens-index.js:81-90`).
- Es wird ausschließlich `.plur1bus/semantic-lens-index.json` gelesen; fehlt oder scheitert der Index, bleibt der Basis-Recall unverändert (`lib/semantic-lens-index.js:71-118`, `lib/semantic-lens-index.js:207-241`).
- Basis-IDs werden dedupliziert und Kandidaten hart begrenzt (`lib/semantic-lens-index.js:146-196`).
- Der Booster wird erst nach dem normalen Recall angewandt (`index.js:5816-5839`) und als eigener `<memory-semantic-lens>`-Block angehängt (`lib/relevant-memory-context.js:217-225`).
- Die gezielten Tests decken disabled/missing index, Additivität, Deduplizierung, Caps, Timeout und fehlende Writes ab (`tests/semantic-lens-index.test.js`).

### Conversation Reactivation Recall – bestätigt

- Der Orchestrator ist standardmäßig aus, verwendet nur Modul-State, führt Trigger/Selektion begrenzt aus und fällt bei Fehler auf leeren Zusatzkontext zurück (`lib/conversation-reactivation-recall.js:674-771`).
- Die Runtime startet ihn erst nach Basis-Recall und Semantic Lens mit einem 50-ms-`Promise.race` (`index.js:6031-6071`).
- Der Kontext wird separat als `<memory-reactivation>` angehängt (`lib/conversation-reactivation-recall.js:645-668`, `index.js:6256`).
- Die gezielte Testsuite `tests/conversation-reactivation-recall.test.js` bestand vollständig.

**Ergebnis:** Keine Ersetzung des primären Recalls, kein zweiter schreibender Recall-Pfad und keine Memory-/Graph-Persistenz durch die Booster gefunden.

## Beobachtungen (keine bestätigten Feature-Defekte im engeren Sinn)

1. `reactivationAdditions` wird in `index.js:6032-6064` befüllt, aber nicht in die Reply-Outcome-ID-Liste aufgenommen (`index.js:6076-6088`). CRR-Erinnerungen erhalten damit anders als Basis-/Lens-Treffer kein Feedbacksignal. Das verletzt die additive Invariante nicht, kann aber Lernmetriken verzerren.
2. Die 50-ms-`Promise.race`-Grenzen brechen zugrunde liegende Promises nicht ab. Bei Semantic Lens läuft höchstens ein read-only Hydration-Task weiter; CRR kann nach dem Fallback noch Modul-State aktualisieren. Es wurde kein persistenter Memory-Write daraus gefunden.
3. Das getrackte Legacy-Unterverzeichnis `plur1bus/` wird weder aus dem Runtime-Einstieg importiert noch über `package.json:21-35` gepackt; seine Tests liegen nicht im `npm test`-Glob. Es sollte als Legacy klar markiert oder entfernt werden, damit es nicht als zweite Implementierung missverstanden wird.
4. Der vollständige Testlauf zeigte genau einen transienten Fehler in `tests/setup-feature-crons-symlink.test.js`; der isolierte Wiederholungslauf bestand. Das ist kein bestätigter Produktdefekt, deutet aber auf Parallelitäts-/Umgebungsabhängigkeit dieses Tests hin.

## Durchgeführte Verifikation

### Gezielte Tests

Folgende 17 Testdateien bestanden vollständig:

```text
tests/config-audit.test.js
tests/smoke-feature-profiles.test.js
tests/tool-registration-metadata.test.js
tests/semantic-lens-index.test.js
tests/conversation-reactivation-recall.test.js
tests/feature-cron-plan.test.js
tests/feature-cron-bootstrap.test.js
tests/recall-compression.test.js
tests/graph-index.test.js
tests/recall-budget.test.js
tests/telegram-command-smoke.test.js
tests/smoke-semantic-link-discoverer.test.js
tests/forget-correct-confirm.test.js
tests/plur1bus-start-flow.test.js
tests/smoke-recommended-mode.test.js
tests/recall-e2e.test.js
tests/plur1bus-internal-auth.test.js
```

### Vollständiger Lauf

`npm test` endete mit 258 von 259 bestandenen Testdateien. Einziger Fehler war `tests/setup-feature-crons-symlink.test.js` ohne ausgegebene Assertion-Details; `node --test tests/setup-feature-crons-symlink.test.js` bestand direkt danach (1/1). Das Ergebnis wird daher als Verifikationshinweis, nicht als bestätigter Finding, geführt.

### Zusätzliche read-only Probes

- Effektive Full-/Safe-Profile gegen Manifest-Defaults verglichen.
- Multi-Namespace-Dedup-Aufruf mit drei künstlichen Resultaten reproduziert: fehlerhafter Aufruf liefert 1, korrekter Aufruf 3.
- Registrierte Command-Namen dynamisch erfasst: `share` fehlt.
- ACL mit `scope: "workspace_shared"` dynamisch geprüft: `{ allowed: false, reason: "acl.unknown_scope" }`.
- Commit und Worktree vor und nach den Tests geprüft: `HEAD` blieb `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`, `git status --short` blieb leer.

## Empfohlene gezielte Regressionstests

### P0

1. **Profile-vs-Schema-Vertrag:** Für leere, partielle und explizit deaktivierte Configs das effektive Runtime-Objekt gegen das Manifest validieren; sicherstellen, dass fehlende optionale Features nicht implizit aktiviert und Bestätigungsgates nicht entfernt werden.
2. **Safe-Profil end-to-end:** `/plur1bus setup safe` auf vorhandener und fehlender Plugin-Entry ausführen, Datei neu laden/validieren und alle schreib-/LLM-intensiven effektiven Flags verifizieren.
3. **Multi-Namespace-Integration:** Zwei Read-DBs mit mindestens drei verschiedenen Treffern und doppelten Canonical-Hits durch den echten `index.js`-Merge schicken; Ausgabegröße, `maxPromptMemories`, Deduplizierung und Trace-Zusammenführung prüfen.
4. **Shared-Memory-Integration:** `/share` registrieren/aufrufen, mit echtem Embedding in einem gemeinsamen Workspace speichern und aus einem zweiten Agenten unter korrekter ACL wieder abrufen; `workspace_shared` explizit erlauben oder auf den kanonischen Workspace-Scope migrieren.
5. **User-Scope Auto-Recall:** Owner-/Nicht-Owner-Kontexte von Hook bis ACL testen und `userId` durch alle Pipeline-Aufrufer propagieren.

### P1

6. **Semantic-Discovery-Confirmation:** Gebundene Nutzer-/Chat-/Nonce-Bestätigung vom Command bis `confirm: true` testen; vor Bestätigung keinerlei Vault-Write zulassen oder Mirror-Sync klar separat ausweisen.
7. **Schema-Reachability:** Automatisch jeden Manifest-Pfad einem Runtime-Leser und jeden produktiv gelesenen Config-Pfad einem Schemafeld zuordnen; besonders Reviews, Hooks, Meta-Cognition, Merge-Sicherheitsoptionen und Namespaces.
8. **Scheduler-Vertrag:** Testmatrix „README behauptet automatisch → Standard-Installationsplan enthält Job“ für REM, Consolidation, Classifier und Skill Miner.
9. **DecisionTrace mit echtem JSON-Schema-Validator:** Objektstruktur, unknown keys, Typen und beobachtbare Wirkung von `persist`/`visibleHints` prüfen.

### P2

10. **Recall-Feature-Reachability:** Query Refinement, dynamisches Budget, Prompt-Kompression, Pattern Surfacing und `candidateTopK` jeweils über den öffentlichen Tool- und Hook-Pfad aktivieren und einen beobachtbaren Effekt verlangen.
11. **Additive Booster beibehalten:** Vorhandene Lens-/CRR-Tests um Reply-Outcome-Zuordnung und um die Zusicherung ergänzen, dass verspätet fertig werdende Timeout-Tasks keine Persistenz auslösen.

## Priorisierte Behebung

1. FA-01/FA-02 gemeinsam beheben: eine einzige, schema-valide Default-Wahrheit; explizite Bestätigung für schreibende/LLM-intensive Features; Safe-Profil nach Merge validieren.
2. FA-03 korrigieren (`dedupResults(flat, maxPromptMemories, dedupJaccard)` plus Canonical-/Trace-Merge) und mit Runtime-Integrationstest absichern.
3. Für FA-04 eine eindeutige Architekturentscheidung treffen: echter Workspace-Store oder kanonischer `workspace`-Scope, anschließend `/share`, Embedding, ACL und Cross-Agent-Recall end-to-end verdrahten.
4. FA-05 durch einen autorisierten Confirmation-Flow erreichbar machen oder das Feature aus Runtime/README entfernen.
5. Manifest, Runtime-Reader, Setup-Profile, Job-Provisionierung und Dokumentation aus einer überprüfbaren Konfigurations-/Feature-Matrix ableiten.

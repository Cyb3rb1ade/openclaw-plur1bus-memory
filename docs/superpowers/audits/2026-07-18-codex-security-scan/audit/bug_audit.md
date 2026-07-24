# Bug- und Zuverlässigkeitsaudit

**Repository:** `/root/openclaw-plur1bus-memory`  
**Commit:** `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`  
**Datum:** 2026-07-18  
**Modus:** Read-only; keine Produkt- oder Testdatei verändert

## Kurzfazit

Der Audit bestätigt **3 hohe, 9 mittlere und 1 niedrige** Zuverlässigkeitsbefunde. Die gravierendsten Fehler sind zwei vollständig ausgefallene Benutzerkommandos (`/forget`, `/correct`), ein Delete-before-Store-Datenverlustpfad beim Memory-Merge und eine Capture-Timeout-Race, die die konfigurierte Serialisierung pro Agent real verletzt.

Der Ziel-Commit führt zusätzlich eine fehlerhafte beziehungsweise unvollständige Cron-Delivery-Ableitung ein: Bei peer-spezifischen Telegram-Gruppenbindungen kann der private `allowFrom`-Absender statt des gebundenen Gruppen-Peers als Ziel gewählt werden; außerdem liest der Loader mehrere gültige OpenClaw-Konfigurationsformen nicht.

| ID | Schwere | Kurzbeschreibung |
|---|---|---|
| BUG-01 | Hoch | `/forget` und `/correct` brechen bei jeder Initiierung mit `summarizer is not defined` ab |
| BUG-02 | Hoch | Merge löscht das Original vor dem Schreiben des Ersatzes |
| BUG-03 | Hoch | Capture-Timeout gibt den Agent-Slot frei, obwohl die Arbeit weiterläuft |
| BUG-04 | Mittel | Cron-Fallback kann bei Gruppenbindung an den privaten `allowFrom`-User liefern |
| BUG-05 | Mittel | Cron-Konfigurationsloader/-resolver ignoriert gültige OpenClaw-Shapes und akzeptiert `*` als Ziel |
| BUG-06 | Mittel | Embedding-Byte-Limit wird überschritten; Cleanup leert die DB und explizite Nullwerte gehen verloren |
| BUG-07 | Mittel | Recall-Cache ist trotz TTL unbeschränkt und räumt fremde abgelaufene Keys nie auf |
| BUG-08 | Mittel | Transiente DB-/Persistenz-Initialisierungsfehler bleiben in derselben Instanz dauerhaft gecacht |
| BUG-09 | Mittel | Bridge-/Control-Room-Merge wird durch undefiniertes `agentId` still übersprungen |
| BUG-10 | Mittel | Persistenter Embedding-Hit startet die TTL neu und reaktiviert fast abgelaufene Einträge |
| BUG-11 | Mittel | `MemoryDB.update()` kann bei doppeltem Add-Fehler die Row verlieren und verschluckt den Restore-Fehler |
| BUG-12 | Mittel | LRU-Pool kann eine noch verwendete Agent-DB schließen |
| BUG-13 | Niedrig | Persistente Embedding-SQLite-Handles werden beim Gateway-Stop nicht geschlossen |

## Verifikation und Checks

- `node --test tests/*.test.js`: Runner-Endsumme **246**, davon **245 bestanden** und **1 fehlgeschlagen**. Der einzige Fehler war `tests/setup-feature-crons-symlink.test.js`; im Sandbox-Prozess schlug dessen verschachteltes `spawnSync` mit `EPERM` fehl. Derselbe Test lief außerhalb dieser Sandbox isoliert mit **1/1 bestanden**. Das ist ein Harness-/Sandbox-Fehlalarm, kein Produktfehler.
- `npm run lint`: bestanden.
- Der Commit-Diff wurde vollständig geprüft (`lib/setup/feature-cron-plan.js`, `scripts/setup-feature-crons.mjs` und zugehörige Tests).
- Relevante lokale OpenClaw-Dokumentation und installierte Runtime-Implementierung wurden als Gegenprüfung für Binding-, `allowFrom`-, Ziel- und Config-Pfad-Semantik herangezogen.
- Für BUG-01, BUG-03 bis BUG-08 und BUG-10 wurden eigenständige Offline-PoCs unter `/tmp` ausgeführt. Sie verändern das Repository nicht.
- Die vier ergänzenden Embedding-Cache-/Init-Repros sind als ausführbares Audit-Artefakt erhalten. `node /tmp/codex-security-scans/openclaw-plur1bus-memory/6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z/audit/repro-embedding-cache-gaps.mjs` endete mit Exitcode 0; die Einzelmesswerte stehen bei BUG-06 und BUG-08.

## Findings

### BUG-01 — Hoch — `/forget` und `/correct` sind bei der Initiierung vollständig defekt

**Fundstellen:**

- `index.js:3978` — `summarizer` wird nur lokal in `runMemoryCommand` deklariert.
- `index.js:4036` — `runForgetCommand` referenziert den dort nicht sichtbaren Namen.
- `index.js:4136-4137` — `runCorrectCommand` referenziert denselben nicht sichtbaren Namen zweimal.

**Auswirkung:** Jeder normale Start von `/forget <query>` und `/correct <alt> -> <neu>` endet vor Kandidatensuche und Confirmation-Erzeugung. Damit sind beide dokumentierten Benutzerfunktionen faktisch nicht nutzbar. Nur der Confirm-Zweig wäre prinzipiell erreichbar, aber der aktuelle Prozess kann keinen passenden Pending-Eintrag erzeugen.

**Reproduktion:** Ein Mock der tatsächlich registrierten Command-Handler in einem autorisierten privaten Chat ergab:

```json
{
  "forget": { "text": "❌ /forget failed: summarizer is not defined" },
  "correct": { "text": "❌ /correct failed: summarizer is not defined" }
}
```

**Gegenprüfung:** `/memory` funktioniert an dieser Stelle, weil es den Summarizer in seinem eigenen Scope erzeugt. Bestehende Tests prüfen Helper und Registrierung, nicht die Initiierung der echten Handler.

**Feature-erhaltende Behebung:** In beiden Handlern nach Auflösung von `agentId` jeweils `makeQuerySummarizer(mergingLlmCfg, api.logger, agentId)` erzeugen oder einen gemeinsamen agent-scoped Normalisierungshelper verwenden. Handler-Level-Regressionstests müssen Kandidatensuche, Pending-Erzeugung und Confirmation für beide Kommandos ausführen.

### BUG-02 — Hoch — Merge löscht die aktive Memory vor dem dauerhaften Ersatz

**Fundstellen:**

- Bridge-/Control-Room-Pfad: `index.js:2716-2734`, insbesondere Delete `index.js:2727` vor Store `index.js:2730`.
- Agent-Tool-Pfad: `index.js:5131-5158`, insbesondere Delete `index.js:5152` vor Store `index.js:5155`.
- Bestehende Gegenimplementierung: `lib/safe-update.js:332-341` schreibt bewusst zuerst die neue Version.

**Auswirkung:** Wenn das Schreiben der vorbereiteten Merge-Row fehlschlägt oder der Prozess zwischen Delete und Store stirbt, existiert weder die alte aktive Memory noch der Ersatz in LanceDB. Ein JSON-Archiv wird zwar vorher angelegt, aber es gibt keinen automatischen Rollback; Recall und Benutzer sehen die Memory als verloren. Parallel ausgeführte Merges können zusätzlich denselben Kandidaten auswählen und divergente Ersatz-Rows erzeugen.

**Reproduktion/Gegenbeweis:** `tests/memory-store-merge-archive-first.test.js:148-192` injiziert genau einen Store-Fehler. Der Test fordert in `:177-180` ausdrücklich, dass das Original danach nicht mehr in der DB liegt. Der Fehler ist damit nicht hypothetisch, sondern als aktuelles Verhalten testkodifiziert.

**Feature-erhaltende Behebung:** Ersatz-Row zuerst durabel schreiben, erst danach das Original superseden/löschen. Schlägt Schritt zwei fehl, bleibt ein sichtbarer, reparierbarer Doppelstand statt Datenverlust. Den Ablauf pro Agent/Kandidaten-ID serialisieren oder mit einer DB-Transaktion beziehungsweise einem idempotenten Compare-and-Swap absichern. Archiv und Destructive-Op-Log beibehalten.

### BUG-03 — Hoch — Capture-Timeout verletzt `maxConcurrentCapturePerAgent`

**Fundstellen:** `lib/runtime-scheduler.js:443-475`.

**Ursache:** `Promise.race([fnPromise, timeout.promise])` wird beim Timeout abgeschlossen; `finally` reduziert sofort `state.active` und startet `drainCapture(key)`. `AbortController.abort()` beendet die Callback-Promise aber nicht zwangsweise. Der laufende Capture setzt seine DB-, Datei- und LLM-Arbeit fort, während der nächste Capture desselben Agents bereits startet.

**Auswirkung:** Die zentrale Serialisierungsgarantie wird nach einem Timeout aufgehoben. Zwei Captures können gleichzeitig Deduplizierungschecks durchführen, beide dieselbe neue Information als fehlend sehen, doppelte Rows schreiben oder High-Watermarks/Neo-Hook-Dateien in anderer Reihenfolge überschreiben. Der reale Auto-Capture-Callback reicht das Signal nur an einen Teilpfad weiter (`index.js:4269-4314`); der Großteil der späteren Arbeit prüft es nicht.

**Reproduktion:** Mit `maxConcurrentCapturePerAgent: 1`, 20-ms-Timeout und zwei 100-ms-Callbacks, die das Signal absichtlich nicht beachten:

```text
publicResults [{"ok":false,"timedOut":true,...},{"ok":false,"timedOut":true,...}]
maxActive 2
events ["first:start:1","second:start:2","first:end:2","second:end:1"]
```

**Feature-erhaltende Behebung:** Den öffentlichen Aufrufer beim Timeout weiter früh beantworten, aber Slot/FIFO erst freigeben, wenn `fnPromise` tatsächlich settled ist. Zusätzlich Abort-Prüfungen zwischen Capture-Phasen und idempotente Schreibschlüssel verwenden. Ein Regressionstest muss belegen, dass `maxActive` auch bei ignoriertem Abort nie über 1 steigt.

### BUG-04 — Mittel — Peer-spezifische Gruppenbindung kann auf einen privaten User umgebogen werden

**Fundstelle:** `lib/setup/feature-cron-plan.js:241-256`, besonders `:245-255`.

**Ursache:** `deriveDeliveryFromChannelConfig()` filtert nur nach Agent, Channel und Account. Ein vorhandenes `match.peer` wird ignoriert. Danach wird der einzige `account.allowFrom`-Wert als Outbound-Chat-Ziel verwendet.

**Auswirkung:** Bei einer Bindung wie `peer: {kind: "group", id: "-100123"}` und einem einzigen autorisierten Admin `allowFrom: [55736530]` wird der Afterthought-Cron aktiviert und an die private User-ID `55736530` statt an den gebundenen Gruppen-Peer geplant. Das kann gruppenbezogenen Workspace-Inhalt falsch zustellen. OpenClaw dokumentiert `allowFrom` primär als menschliche Sender-ID; eine explizite Telegram-Gruppenzustellung verwendet die negative Gruppen-Chat-ID.

**Reproduktion:** Der Pure-Function-PoC ergab für genau diese Config:

```text
groupPeerMisdelivery {"channel":"telegram","to":"55736530","accountId":"main"}
```

**Gegenprüfung:** Für eine reine Account-/DM-Bindung kann ein einzelner `allowFrom`-Owner ein sinnvoller Proaktiv-DM-Empfänger sein. Der Fehler ist das ungeprüfte Gleichsetzen auch bei einer engeren Peer-Bindung.

**Feature-erhaltende Behebung:** Peer-Bindungen separat behandeln. Bei genau einer konkreten direkten Peer-Bindung darf deren Peer-ID verwendet werden; bei Gruppe/Channel nur die konkrete Peer-ID oder ein explizites `defaultTo`. Sobald Bindungen unterschiedliche Peers oder Zieltypen enthalten, fail-closed als disabled planen. `allowFrom` nur für eindeutig DM-weite Account-Bindungen verwenden.

### BUG-05 — Mittel — Der neue Config-Fallback versteht mehrere gültige OpenClaw-Konfigurationen nicht

**Fundstellen:**

- Loader: `scripts/setup-feature-crons.mjs:118-124`.
- Resolver: `lib/setup/feature-cron-plan.js:245-256`.

**Mehrere reproduzierbare Teilursachen:**

1. Der Loader nutzt `JSON.parse`, obwohl `openclaw.json` gültiges JSON5 mit Kommentaren und trailing commas sein darf. Der Catch in `scripts/setup-feature-crons.mjs:122-123` macht daraus still `null`.
2. `OPENCLAW_CONFIG_PATH` und `OPENCLAW_STATE_DIR` werden ignoriert. `OPENCLAW_HOME` wird direkt als State-Dir behandelt, obwohl OpenClaw es als Ersatz des Benutzer-Home interpretiert und explizite Pfadvariablen Vorrang haben.
3. `match.accountId` ist laut OpenClaw optional (omitted = Default-Account), wird hier aber zwingend als String verlangt (`:245-247`).
4. Benannte Telegram-Accounts dürfen top-level `channels.telegram.allowFrom` erben; der Resolver liest ausschließlich `account.allowFrom` (`:251-254`).
5. Ein gültiger offener DM-ACL-Wert `allowFrom: ["*"]` wird zu einem expliziten Cron-Ziel `to: "*"`, obwohl Telegram-Outbound-Ziele konkrete Chat-IDs/Handles sein müssen.

**PoC-Ergebnis:**

```text
omittedDefaultAccount null
wildcardSender {"channel":"telegram","to":"*","accountId":"main"}
```

**Auswirkung:** Auf frischen Installationen bleibt der delivery-pflichtige Cron trotz eindeutig gültiger Konfiguration disabled, oder er wird mit einem ungültigen Ziel aktiviert. Da Loaderfehler vollständig verschluckt werden, fehlt eine Diagnose.

**Feature-erhaltende Behebung:** Den aktiven Config-Pfad und Parser über OpenClaws eigene Config-Auflösung/CLI beziehen oder dieselbe JSON5- und Env-Priorität implementieren. Danach effektive Account-Vererbung und Default-Account-Semantik auflösen. Nur konkrete, provider-validierte Ziele akzeptieren; `*` muss als mehrdeutig/ungeeignet zu `null` führen. Loaderfehler im Nicht-JSON-Modus warnen und im JSON-Ergebnis strukturiert ausweisen.

### BUG-06 — Mittel — Embedding-Byte-Limit, Cleanup und explizite Nullwerte sind fehlerhaft

**Fundstellen:**

- `lib/embedding-cache.js:173-178` — Größe ist die Summe aus DB, WAL und SHM.
- `lib/embedding-cache.js:291-301` — Hard-Limit prüft nur die aktuelle Größe vor dem Insert; die Größe des eingehenden Vektors wird nicht berücksichtigt.
- `lib/embedding-cache.js:266-280` — Löschschleife misst physische DB+WAL+SHM-Größe nach jeder Row-Löschung.
- `lib/embedding-cache.js:343-346` — Soft-Cleanup nach dem Write.
- `lib/providers/embedding-openai.js:41-43` und `lib/providers/embedding-local-transformers.js:49-51` — `cacheMaxEntries` und `cacheTtlMs` werden mit `||` statt Nullish-Coalescing weitergereicht.
- `openclaw.plugin.json:304-311` akzeptiert für beide Optionen jede Zahl ohne positive Untergrenze; `createEmbeddingCache()` selbst respektiert `0`.

**Drei getrennt reproduzierbare Teilfehler:**

1. **Pre-Insert-Überschreitung:** `_persistSet()` vergleicht nur `currentDbSize >= limit`. Ist die DB noch knapp unter dem Limit, wird auch ein Vektor geschrieben, der das Limit um ein Vielfaches überschreitet. Der Write wird als erfolgreich gezählt.
2. **Soft-Cleanup-Poisoning:** SQLite-Deletes verkleinern DB/WAL-Dateien nicht unmittelbar. `_cleanupDb()` führt weder WAL-Checkpoint noch Incremental-Vacuum aus. Die Dateisumme bleibt gleich oder wächst durch WAL-Deletes; deshalb löscht die Schleife bis zur leeren Tabelle. Danach liegt sie weiter über dem Hard-Limit, sodass alle folgenden Persist-Writes übersprungen werden.
3. **Explizite Nullwerte gehen verloren:** Beide Provider ersetzen `cacheMaxEntries: 0` und `cacheTtlMs: 0` durch 128 beziehungsweise 300000. Das unterscheidet sich vom direkt verwendeten Cache-Primitive und macht schema-gültige Konfigurationen zum Deaktivieren des Memory-Layers beziehungsweise für sofortigen Ablauf unwirksam.

**Reproduktion:** Der oben genannte Audit-Befehl erzeugte drei unabhängige Fälle:

```json
{
  "preInsertOvershoot": {
    "beforeBytes": 82216,
    "maxBytes": 182216,
    "afterBytes": 1029816,
    "overLimitBytes": 847600,
    "persistWrites": 2,
    "persistWriteSkipped": 0
  },
  "softCleanupPoisoning": {
    "beforeBytes": 82216,
    "maxBytes": 182216,
    "bytesAfterCleanup": 1029816,
    "rowsAfterCleanup": 0,
    "persistWrites": 2,
    "persistWriteSkipped": 1
  },
  "explicitZeroReplacement": {
    "directMaxEntriesZeroSize": 0,
    "directTtlZeroComputes": 2,
    "providerZeroComputes": 1,
    "providerZeroCacheSize": 1
  }
}
```

`persistWrites: 2` umfasst Seed plus übergroßen Write; `persistWriteSkipped: 0` belegt, dass der übergroße Write nicht am Hard-Limit abgewiesen wurde. Beim zweiten Fall sind danach alle Rows weg und der unmittelbar folgende Write wird bereits übersprungen. Im Nullwertfall berechnet das Primitive bei TTL 0 zweimal, der Provider trotz derselben Config nur einmal.

**Auswirkung:** Schon ein einzelner großer Eintrag kann die deklarierte Hard-Grenze deutlich verletzen. Das anschließende Cleanup verliert den gesamten persistenten Embedding-Cache und kann Persistenz bis zu externer Kompaktierung/Neuanlage dauerhaft deaktivieren. Primäre Memories bleiben erhalten, aber Embedding-Kosten und Latenz steigen stark. Explizite `0`-Konfigurationen verhalten sich zusätzlich entgegen Schema und Cache-Primitive.

**Feature-erhaltende Behebung:** Die serialisierte Eingangsgröße vor dem Insert berücksichtigen oder nach einem atomaren Write die Grenze zuverlässig herstellen und den Write andernfalls zurückrollen. In begrenzten Transaktionen nach LRU in Batches löschen, WAL checkpointen (`TRUNCATE`) und `incremental_vacuum` ausführen, danach neu messen. Nie die gerade geschriebene/neuste Row löschen. Das Vorgehen in `lib/llm-result-cache.js` bietet eine passende Referenz. Metrics erst nach tatsächlich erhaltenem Write zählen. In beiden Providern `??` statt `||` verwenden und die beabsichtigte `0`-Semantik explizit testen.

### BUG-07 — Mittel — Recall-Cache wächst trotz TTL unbegrenzt

**Fundstellen:** `lib/runtime-scheduler.js:219`, `:309-310`, `:326-334`; realer High-Cardinality-Key in `index.js:5541-5543`.

**Ursache:** Jeder erfolgreiche Recall legt einen Eintrag in einer unbeschränkten `Map` ab. Ablauf wird nur geprüft, wenn exakt derselbe Key später gelesen wird. Es gibt weder Max-Entries noch Sweep beim Insert/Status noch periodische Bereinigung. Der Key enthält bis zu 500 Prompt-Zeichen und ist bei normalen Gesprächen fast immer neu.

**Reproduktion:** Nach 200 eindeutigen Keys mit 1-ms-TTL, Ablaufwartezeit und einem weiteren Recall meldete `status()` weiterhin:

```json
{"completed":201,"cacheSize":201}
```

**Auswirkung:** Ein langlebiger Gateway-Prozess hält abgelaufene Prompt-Keys und komplette Recall-Ergebnisse (`prependContext`) dauerhaft im Heap. Speicherverbrauch wächst mit der Zahl unterschiedlicher Prompts.

**Feature-erhaltende Behebung:** Bounded LRU+absolute TTL verwenden, beim Setzen opportunistisch abgelaufene Einträge sweepen und eine konfigurierbare Maximalzahl/-größe einführen. Timeout-Fallback-Verhalten bleibt unverändert.

### BUG-08 — Mittel — Transiente Initialisierungsfehler vergiften DB-/Persistenzinstanzen dauerhaft

**Fundstellen:**

- `index.js:624` und `:736-876` — `MemoryDB.initPromise` wird einmal gesetzt und bei Rejection nie auf `null` zurückgesetzt. Alle späteren `init()`-Aufrufe geben dieselbe bereits abgelehnte Promise zurück; der `AgentDbPool` cached die Instanz weiter.
- `lib/embedding-cache.js:125`, `:183` und `:216-218` — ein fehlgeschlagener SQLite-Pfad landet in `failedDbPaths`; jeder spätere `_ensureDb()`-Aufruf derselben Cache-Instanz kehrt für diesen Pfad sofort mit `null` zurück.

**Reproduktion MemoryDB:** Eine DB wurde zunächst unter einem absichtlich ungültigen Parent-Pfad initialisiert; danach wurde der Pfad repariert:

```text
first failed ... Not a directory
second failed ... Not a directory
fresh ok
```

Eine neue `MemoryDB` am selben nun gültigen Pfad funktioniert, die ursprüngliche Instanz erholt sich nicht.

**Reproduktion Embedding-Persistenz:** Der Audit-Befehl blockierte zunächst `embedding-cache-v2` durch eine Datei, reparierte den Pfad und versuchte denselben Cache erneut; anschließend wurde eine frische Cache-Instanz am identischen Pfad verwendet:

```json
{
  "failedPathPoisoning": {
    "sameRecovered": false,
    "freshRecovered": true,
    "samePersistWrites": 0,
    "freshPersistWrites": 1
  }
}
```

**Auswirkung:** Ein kurzzeitiger Mount-, Berechtigungs-, Connect- oder Migrationsfehler legt sämtliche Memory-Funktionen des betroffenen Agents bis Prozessneustart beziehungsweise zufälliger LRU-Eviction lahm. Beim Embedding-Cache funktioniert der volatile Layer weiter, aber Persistenz bleibt in derselben Provider-/Cache-Instanz auch nach Reparatur des Dateisystems vollständig abgeschaltet.

**Feature-erhaltende Behebung:** Concurrent Init weiterhin coalescen, aber bei Fehler `initPromise` atomar zurücksetzen, teilgeöffnete Handles schließen/nullen und den Fehler weiterreichen. `failedDbPaths` nicht permanent als Circuit Breaker verwenden: Fehler mit begrenztem Backoff erneut versuchen oder einen zeitgestempelten Retry-Zustand führen und ihn bei Erfolg/`close()` löschen. Regressionstests für beide Komponenten: erster Connect/SQLite-Open fehlschlägt, zweiter Versuch auf derselben Instanz gelingt.

### BUG-09 — Mittel — Bridge-/Control-Room-Merge wird still übersprungen

**Fundstellen:** `index.js:2623-2625` und `:2697-2704`.

**Ursache:** Der Helper definiert die Agent-ID als `storeAgentId`, ruft `callMergeCheck(...)` in `index.js:2699` aber mit dem nicht deklarierten Bezeichner `agentId` auf. Der entstehende `ReferenceError` wird vom Merge-Catch abgefangen und nur als „merge check skipped“ protokolliert.

**Trigger:** Obsidian-Bridge-/Control-Room-Store mit aktiviertem Auto-Merge, vorhandenem Merge-Kandidaten und ohne „meaningful difference“. Der normale `memory_store`-Toolpfad nutzt dagegen die korrekte lokale `agentId`-Variable.

**Auswirkung:** Diese Eingabepfade führen den versprochenen Merge nie aus und speichern semantisch zusammengehörige Memories separat. Der Fehler wirkt wie ein legitimer LLM-Fallback und bleibt deshalb leicht unbemerkt.

**Feature-erhaltende Behebung:** In `index.js:2699` `storeAgentId` übergeben. Einen Bridge-Level-Test mit Merge-Kandidat hinzufügen und prüfen, dass der agent-scoped LLM-Cache-Kontext ebenfalls die Bridge-Agent-ID erhält.

### BUG-10 — Mittel — Persistenter Embedding-Hit verlängert die absolute TTL

**Fundstellen:** `lib/embedding-cache.js:247-263` und `:434-440`.

**Ursache:** `_getDb()` liest zwar `expires_at`, gibt aber nur den Vektor zurück. Beim Promote in den Memory-Layer setzt `getMany()` die Ablaufzeit auf `now + ttlMs` statt auf die persistierte absolute Ablaufzeit.

**Reproduktion:** Bei 200-ms-TTL wurde nach 140 ms aus einer zweiten Cache-Instanz persistent geladen. Nach weiteren 100 ms, also 240 ms nach Erstellung, lieferte diese Instanz den Vektor weiter als Memory-Hit:

```text
persistHits 1
memoryHits 1
value [42]
```

**Auswirkung:** Ein Eintrag kann je Prozess-/Instanzladung fast bis zur doppelten konfigurierten TTL leben. Die TTL taugt dadurch nicht zuverlässig als Invalidierungsgrenze. Modell, Provider, Dimension und Cache-Version im Key begrenzen die fachliche Gefahr, beseitigen den Vertragsbruch aber nicht.

**Feature-erhaltende Behebung:** `_getDb()` soll `{vector, expiresAt}` zurückgeben und genau `expiresAt` in den Memory-Layer übernehmen. `lib/llm-result-cache.js:456-484` und `:572-576` implementiert dieses Verhalten bereits korrekt.

### BUG-11 — Mittel — `MemoryDB.update()` kann die Original-Row verlieren und verschluckt den Rollback-Fehler

**Fundstelle:** `index.js:1101-1121`.

**Ursache:** Die Methode löscht die vorhandene Row (`:1111`) vor dem Add der aktualisierten Row. Scheitert das Add, versucht sie dasselbe Schreibprimitive für einen Restore. Scheitert auch dieses — typisch etwa bei Disk-/Handle-/DB-Ausfall — wird der Restore-Fehler in `:1120` vollständig verschluckt und nur der erste Add-Fehler geworfen.

**Auswirkung:** Die Row ist dann gelöscht, der Aufrufer erfährt aber nicht, dass auch die Wiederherstellung fehlgeschlagen ist. Dieser primitive Updatepfad wird unter anderem von Metadaten-/Reinforcement-Updates und dem Supersede-Schritt sicherer Versionierungslogik benutzt.

**Feature-erhaltende Behebung:** Für unterstützte Patches LanceDBs in-place `table.update()` einsetzen. Wo Replace nötig ist, Write-ahead-Archiv/Transaktion verwenden. Bei fehlgeschlagenem Restore mindestens beide Fehler als `AggregateError` melden und einen Audit-/Recovery-Eintrag schreiben; ein Restore-Fehler darf nie still bleiben.

### BUG-12 — Mittel — Der LRU-Pool schützt Agent-DBs nicht über die Operationsdauer

**Fundstellen:** `index.js:1204-1229`, besonders `:1220-1229`; Eviction in `lib/bounded-cache.js:58-78`.

**Ursache:** `getDb()` erhöht den Refcount nur während Cache-Lookup und Objekt-Rückgabe und gibt ihn im `finally` sofort wieder frei. Der eigentliche asynchrone DB-Aufruf des Callers beginnt erst danach. Beim 51. Agent kann die LRU-Eviction deshalb eine DB mit laufender Query/Write als „unbenutzt“ auswählen und `db.shutdown()` starten (`index.js:1209-1212`). Shutdown-/Evictionfehler werden zudem verschluckt.

**Trigger:** Mehr als 50 aktive Agent-DBs; der älteste Agent führt noch eine Operation aus, während ein neuer Agent in den Pool kommt.

**Auswirkung:** In-Flight-LanceDB-Operationen können durch gleichzeitig geschlossene Table-/DB-Handles fehlschlagen. Fehler zeigen sich lastabhängig und agentübergreifend, obwohl der Pool gerade Isolation und Lifecycle-Sicherheit herstellen soll.

**Feature-erhaltende Behebung:** Eine Lease-API (`withDb(agentId, fn)` oder `{db, release}`) einführen und Refcount bis zum Settlement der Operation halten. Alternativ Operationen im `MemoryDB` selbst zählen und Eviction erst nach Idle durchführen. Evictionfehler mit Agent-ID loggen und beim Gateway-Stop sichtbar sammeln.

### BUG-13 — Niedrig — Persistente Embedding-Cache-Handles fehlen im Shutdown

**Fundstellen:**

- `lib/embedding-cache.js:610-622` stellt ein explizites `close()` bereit.
- `lib/runtime-shutdown.js:11-24` und Registrierung `index.js:3964-3969` schließen Adapter, Pool, Metrics und LLM-Cache, aber nicht den Embedding-Provider/-Cache.
- Die Provider in `lib/providers/embedding-openai.js` und `lib/providers/embedding-local-transformers.js` exponieren keinen delegierenden Lifecycle-Hook.

**Auswirkung:** Bei aktivierter Persistenz bleiben SQLite-/WAL-Handles bis zum Prozessende offen. Hot reload/re-register kann Handles und Locks akkumulieren; ein sauberer WAL-Checkpoint beim Gateway-Stop findet nicht statt.

**Feature-erhaltende Behebung:** Beide Provider um idempotentes `close()` ergänzen, das `this._cache?.close()` delegiert, und den Provider in `registerGatewayShutdown()` aufnehmen. Fehler wie bei den anderen Ressourcen isoliert loggen, aber den Shutdown weiterführen.

## Nicht als Produktfehler gewertete Beobachtung

Der Symlink-Testfehler des vollständigen Laufs ist reproduzierbar auf die Ausführungs-Sandbox begrenzt: ein minimales verschachteltes `spawnSync` liefert dort `EPERM`; außerhalb der Sandbox läuft der unveränderte Repository-Test durch. Er ist deshalb nicht in der Finding-Tabelle enthalten.

## Empfohlene Behebungsreihenfolge

1. BUG-01, BUG-02 und BUG-03 wegen vollständigem Feature-Ausfall beziehungsweise Datenintegrität.
2. BUG-04 und BUG-05 vor Ausrollen des neuen Cron-Fallbacks.
3. BUG-06 bis BUG-10 wegen Cache-, Recovery- und stiller Funktionsfehler.
4. BUG-11 bis BUG-13 als Lifecycle-/Fehlertransparenz-Härtung ohne Features abzuschalten.

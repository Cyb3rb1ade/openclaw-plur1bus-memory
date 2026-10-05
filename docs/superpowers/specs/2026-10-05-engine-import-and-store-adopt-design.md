# Engine-Import-Pfad und Store-Übernahme (Contract 1.11.0, Vorschlag)

**Status:** Analyse und API-Vorschlag, nicht implementiert.
**Stand:** Contract 1.10.0 (`types/engine.d.ts`), geprüft gegen `origin/main` `73a6f94b`.
**Auftrag:** M7-Importer im Harness (agy, [Harness PR #91](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/91)) braucht einen Engine-Weg für Hermes-Karten mit Provenienz `imported` und für die Übernahme kopierter OpenClaw-LanceDB-Stores. Direktes Schreiben in LanceDB ist nach D28/T7 verboten.
**Dieser PR:** nur dieses Dokument. Kein Code, kein Contract-Bump, kein Tag, keine Implementierung.

---

## 1. Gibt es schon einen Ingest- oder Import-Weg für fertige Karten?

Nein. Contract 1.10.0 hat keinen Member, der eine fertige Karte (Text plus Metadaten, Provenienz, Zeitstempel, Principal) so anlegt, dass Dedup, Embedding-Identität und Manifest wie beim Live-Store behandelt werden.

### Was die öffentliche Engine-Fläche kann

`Engine.memory` (`types/engine.d.ts`, `MemoryOps`, ab 1.5.0, erweitert 1.6.0) hat:

`list`, `show`, `forget`, `correct`, `share`, `state`, `propose`, `proposals.{list,accept,reject}`.

Kein `store`, kein `import`, kein `ingest`. `correct` ändert nur eine schon vorhandene Karte (neue Version, alte superseded). `share` kopiert eine vorhandene Karte in einen anderen Scope und bettet neu ein. Beides setzt eine existierende `id` voraus.

Dokumentiert in `docs/engine-api.md` unter „Typed MemoryOps“. Die Tabelle dort listet dieselben Member.

`Engine.capture(t: TurnRecord)` (`engine/create-engine.js`, `engine/capture/capture-turn.js`) ist die Turn-Pipeline: Messages, Incognito fail-closed, Replay-Guard (`duplicate-turn`). Sie zerlegt Turns in Karten. Sie nimmt keine fertige Karte mit Provenienz und Quell-Zeitstempel entgegen.

`Engine.open(agentId)` initialisiert die `MemoryDB` für den Agenten (`pool.withDb` → `db.init()`) und gibt `{ agentId, close }` zurück. Das ist kein Lock und kein Import.

### Was intern speichert, aber kein Import ist

`storeMemoryFromToolParams` in `engine/create-engine.js` (ab Zeile 2442) ist der Live-Store-Pfad von `memory_store`:

1. Text validieren, Scope/ACL aus dem Request-Kontext.
2. Embedden mit dem aktiven Provider.
3. Kategorie (Aufrufer oder `categorizeMemoryWithReason`).
4. `origin` nur aus `MEMORY_ORIGINS` (`dm`, `group`, `cron`, `internal`; `lib/categorize.js`). Alles andere wird `dm`.
5. Tombstone-Block (`findBlockingTombstoneForCapture`).
6. Dedup über Vektorähnlichkeit (`findSimilar` + `findSafeDuplicateForValidity`).
7. Optional LLM-Merge (`callMergeCheck`, Auto-Apply).
8. `storeDb.store(entry)` mit `createdAt: Date.now()` und `sourceTimestamp: Date.now()`.

Derselbe Semantik-Satz liegt noch einmal inline in `engine/tools/memory-tools.js` (`memory_store`).

Das ist kein Import-API:

- Es hängt nicht an `Engine.memory`.
- Provenienz `imported` gibt es nicht. `sourceUrl` ist ein optionaler URL-String (Tool-Schema: „Optional URL this memory is derived from (provenance)“), kein Enum.
- Zeitstempel der Quelle werden nicht übernommen.
- Dedup ist Ähnlichkeit plus optionales LLM-Merge, kein idempotenter Schlüssel.
- Rückgabe enthält Kartentext (`Similar memory already exists: "…"`, `Memory stored […]: "…"`). Für den M7-Report (ohne Inhalte) unbrauchbar.

`MEMORY_ORIGINS` enthält kein `"imported"`. `memoryKind` auf der LanceDB-Zeile defaultet auf `"memory"` (`engine/store/memory-db.js`). `shareProvenance` / `shareIdempotencyKey` gelten nur für `/share` (`lib/shared-memory.js`).

### Embedding-Identität und Manifest beim Live-Store

Der Live-Store nutzt den aktiven Embedder der laufenden Engine (`internals.embeddings`, Fingerprint über `embeddingFingerprintId` in `lib/reembedding/fingerprint.js`). `Engine.embedding.identities()` liefert `{ fingerprintId, provider, model, dimensions }`. Es gibt keine getrennte „Import-Identität“. Ein Writer, der an der Engine vorbei Vektoren schreibt, kann eine andere Identität in dieselbe Tabelle legen. Genau das verbietet T7.

Schema-Marker: `{baseDbPath}/_schema.json` (`engine/store/schema-version.js`). Generation-Manifest (wenn Generationen aktiv sind): `{stateRoot}/generations/<generation>/generation.json` mit `schemaVersion`, `generation`, `fingerprintId`, `dimensions`, `tables` (`lib/reembedding/generation-layout.js`). Der Live-Store schreibt beides nicht als Import-Registrierung; `admin.migrate` schreibt nur den Schema-Marker.

### Folge für M7

Hermes `MEMORY.md` / `USER.md` → Karten muss über ein neues Engine-Member laufen. OpenClaw-Store-Übernahme darf die LanceDB-Dateien kopieren (Host, copy-never-move), aber nicht selbst Tabellen beschreiben. Harness PR #91 nennt das als Blocker und skizziert `memory.import`; der Sketch dort weicht in einigen Punkten vom Auftrag hier ab (siehe Abschnitt 5).

---

## 2. API-Vorschlag: `memory.import` (additiv, 1.11.0)

Neues optionales Member auf `MemoryOps`. Bestehende Member bleiben unverändert. `ContractVersion` wird bei der späteren Implementierung auf `"1.11.0"` gesetzt (nicht in diesem PR).

### Signatur

```ts
type MemoryImportProvenance = "imported";
type MemoryImportOutcome = "created" | "matched-existing" | "rejected";

interface MemoryImportCardInput {
  /** Idempotenter Schlüssel, vom Aufrufer stabil gehalten (zweiter Lauf, Resume). */
  idempotencyKey: string;
  text: string;
  /** Siehe „Felder, die der Contract heute anders nennt“. */
  kind?: string;
  createdAt?: number;
  provenance: MemoryImportProvenance;
  sourceRef?: string;
  scope?: MemoryScope;
}

interface MemoryImportRequest {
  agentId: AgentId;
  principal: Principal;
  cards: MemoryImportCardInput[];
  dryRun?: boolean;
  signal?: AbortSignal;
}

interface MemoryImportCardResult {
  idempotencyKey: string;
  outcome: MemoryImportOutcome;
  /** Nur bei created / matched-existing. */
  id?: string;
  /** Stabiler Maschinengrund, nie Kartentext. */
  reason?: MemoryImportRejectReason | "already-imported";
}

type MemoryImportRejectReason =
  | "invalid-input"
  | "tombstone-blocked"
  | "principal-unresolved"
  | "empty-text"
  | "provenance-not-imported"
  | "aborted";

interface MemoryImportResult {
  agentId: AgentId;
  dryRun: boolean;
  created: number;
  matchedExisting: number;
  rejected: number;
  cards: MemoryImportCardResult[];
}

interface MemoryOps {
  // 1.5.0 / 1.6.0 unverändert …
  import(req: MemoryImportRequest, p: Principal, a: AgentContext): Promise<MemoryImportResult>;
}
```

`p.agentId` und `req.agentId` müssen übereinstimmen, sonst `invalid-input`. `req.principal` ist die Bindung der Karten (Scope `user` / Workspace); `p` ist der Aufrufer (Importer-Operator). Wenn der Auftrag nur ein Principal-Objekt meint, reicht `p` und `req.principal` entfällt — das ist eine offene Entscheidung (A1).

### Verhalten

- Jede Karte mit `provenance !== "imported"` wird `rejected` / `provenance-not-imported`. Kein stilles Umschreiben auf `dm`.
- `createdAt` der Quelle wird übernommen, wenn es eine endliche Epoch-ms-Zahl ist. Sonst `clock()`. `updatedAt` / `sourceTimestamp` der neuen Zeile bleiben Import-Zeit (`clock()`). `validFrom` / `validUntil` werden nicht aus `createdAt` abgeleitet (Invariante in `AGENTS.md`).
- Embedding: aktiver Engine-Provider, Passage-Embed, dieselbe Identität wie `embedding.identities()[0]`. Kein mitgelieferter Vektor.
- Tombstone-Block wie im Live-Store (`findBlockingTombstoneForCapture`). Treffer → `rejected` / `tombstone-blocked`, nicht reaktiviert.
- Idempotenz vor Ähnlichkeits-Dedup: existiert schon eine Zeile mit demselben `idempotencyKey` für diesen Agenten → `matched-existing`, `reason: "already-imported"`, vorhandene `id`. Kein zweites Embed, kein zweites `store`.
- Ähnlichkeits-Dedup des Live-Stores (LLM-Merge) läuft beim Import **nicht**. Importierte Karten werden nicht still mit Live-Karten verschmolzen. Eine zweite, inhaltlich ähnliche Hermes-Zeile ohne denselben Schlüssel ist eine neue Karte. (A2, falls der Owner Ähnlichkeits-Skip will: extra `outcome` oder `rejected` / `similar-existing`, weiterhin ohne Text in der Antwort.)
- `dryRun: true`: keine Writes (kein `store`, kein Ledger, kein Archive). Ergebnisform gleich, Zähler wie nach Apply. `id` bei `created` fehlt oder ist weggelassen.
- Antwort und Logs enthalten keinen Kartentext, kein `sourceRef`-Payload jenseits des Schlüssels, keine Embeddings. `MemoryOpError.message` bleibt log-safe (bestehende Regel in `engine/memory-ops/errors.js`).
- Batch: eine Karte `rejected` bricht den Batch nicht ab. `signal` abgebrochen → restliche Karten `rejected` / `aborted`; schon geschriebene bleiben (Resume über denselben Schlüssel).
- `AgentContext`: Import ist Operator-Arbeit, kein Chat-`forget`. Die Destructive-Guard in `engine/memory-ops/context.js` (`origin !== "user"` → `denied`) gilt für `forget`/`correct`/`share`. `import` nutzt sie nicht. Vorschlag: `a.origin === "system"` und `a.background === false` (A3). `inferred` Principal schreibt nur `agent-private` (bestehende ACL).

### Wohin Provenienz und Schlüssel auf der Platte

LanceDB hat keine Spalte `provenance` und keine Spalte `importIdempotencyKey`. Ein neues Tabellenfeld wäre ein Store-Schema-Schritt `1→2` (`admin.migrate`).

Vorschlag ohne Schema-Bump in 1.11.0:

- Sidecar analog zu Proposals: `{baseDbPath}/_imports/<agentId>.jsonl`, eine Zeile `{ v: 1, idempotencyKey, cardId, importedAt }` nach erfolgreichem `store`. Lookup vor dem Write. Datei wie Job-Ledger ohne Cross-Process-Lock (Single-Writer, Abschnitt 4).
- Auf der Karte: `origin: "internal"` (einziger `MEMORY_ORIGINS`-Wert, der kein Chat-Ursprung ist), `sourceUrl: sourceRef` (schon vorhanden, max. 500 Zeichen), `memoryKind` unverändert `"memory"`.
- `MemoryCard` (list/show) bekommt optional `provenance?: "imported"` und `sourceRef?: string`, abgeleitet aus Ledger bzw. `sourceUrl`, additiv für Adapter.

Alternative, die der Owner wählen kann (A4): `MEMORY_ORIGINS` um `"imported"` erweitern und/oder Spalte `importIdempotencyKey`. Das ist ein Schema-Schritt und gehört in denselben Implementierungs-PR nur, wenn der Owner den Marker auf `"2"` heben will.

`kind` aus dem Auftrag hat im 1.10.0-Contract kein Gegenstück. Vorhanden sind `origin` (vier Werte), `category` (`MEMORY_CATEGORIES`, u. a. `"knowledge"` für MEMORY.md-Migration in `lib/categorize.js`) und `memoryKind`. Mapping: `kind` → `category`, fehlend → `categorizeMemoryWithReason(text)` wie Live-Store. Wenn `kind` etwas anderes meint (wiki, daily-note), das in A5 festhalten, nicht raten.

### Was `import` nicht tut

- Kein LLM-Merge, kein Knowledge-Pending, kein Retroactive Interference (Live-Store-Nebenwirkungen).
- Kein Store-Copy, kein Re-Embedding einer übernommenen Tabelle (das ist `stores.adopt` plus ggf. `admin.reembedding`).
- Kein Schreiben in Obsidian/Vault; der Bridge-Watcher läuft erst, wenn der Host die Engine danach normal betreibt.

---

## 3. Store-Übernahme: gibt es Prüfung oder Registrierung?

Nein. Es gibt kein `stores.adopt`, kein `admin.adopt`, keine Registrierung eines kopierten Store-Verzeichnisses.

Vorhanden:

| Mechanismus | Datei | Was er tut | Was er nicht tut |
|---|---|---|---|
| `admin.migrate(from, to)` | `engine/store/schema-version.js`, Contract 1.6.0 | Schritte zwischen Marker-Versionen, schreibt `_schema.json` `{ schemaVersion, writtenAt, engineVersion }` | Öffnet kein fremdes Verzeichnis, prüft keine Embedding-Identität |
| `Engine.status().storeSchema` | `types/engine.d.ts`, `engine/status/status-reporter.js` | `{ current, expected }` für den **schon geöffneten** Store | Verdict über einen Pfad vor dem Open |
| `embedding.identities()` / `embedding.probe()` | `engine/create-engine.js`, `engine/providers/embedding-service.js` | Identität und Bereitschaft des **laufenden** Providers | Liest nicht `generation.json` eines kopierten Baums |
| `resolveEmbeddingGenerationLayout` | `lib/reembedding/generation-layout.js` | Liest `generations/<id>/generation.json`, prüft `fingerprintId` und `dimensions` gegen die Selection | Kein öffentliches Engine-Member |
| `compareEmbeddingFingerprints` | `lib/reembedding/fingerprint.js` | `equal` / `requiresMigration` über kanonischen Fingerprint | Wird von keinem Adopt-API aufgerufen |
| `admin.reembedding.{plan,apply,resume,status,rollback,switch}` | Contract 1.6.0+ | Geführte Migration bei Identitätswechsel | Entscheidet nicht, ob ein Copy übernommen werden darf |

`STORE_SCHEMA_VERSION` ist `"1"`. Fehlt `_schema.json` in einem nicht-leeren Verzeichnis, gilt `"0"` (Legacy). Frischer leerer Pfad startet bei `"1"`. Unlesbarer Marker → `current === null` (migrate: `storage`).

Generation-Layout: ohne `activeGeneration` ist der Store „legacy“ (`mode: "legacy"`), Manifest `null`. Viele OpenClaw-Stores aus dem Plugin sind genau das: `baseDbPath` plus Agent-Unterordner, kein `generations/`. Adopt muss beide Formen kennen.

Kopieren bleibt Host-Sache (copy-never-move, Quelle unangetastet). Die Engine bekommt den Zielpfad nach dem Copy.

### API-Vorschlag: `stores.adopt`

Neues Namespace-Objekt auf `Engine` (additiv). `admin.migrate` bleibt der In-Place-Schema-Schritt.

```ts
interface StoreAdoptRequest {
  path: string;
  expectedIdentity: EmbeddingIdentity;
  dryRun?: boolean;
}

type StoreAdoptIncompatibleReason =
  | "path-unreadable"
  | "not-a-store"
  | "schema-unreadable"
  | "schema-mismatch"
  | "identity-unreadable"
  | "identity-mismatch"
  | "dimension-mismatch"
  | "target-running";

interface StoreAdoptResult {
  verdict: "ok" | "incompatible";
  dryRun: boolean;
  reason?: StoreAdoptIncompatibleReason;
  storeSchema?: { current: SchemaVersion | null; expected: SchemaVersion };
  identity?: EmbeddingIdentity | null;
}

interface StoreOps {
  adopt(req: StoreAdoptRequest): Promise<StoreAdoptResult>;
}

interface Engine {
  // 1.10.0 unverändert …
  stores: StoreOps;
}
```

`path` ist das Store-Root (das, was die Engine als `baseDbPath` öffnen würde), absolut, durch `resolveInside` / Host-Path-Guards, keine Symlink-Escape.

Prüfschritte, in dieser Reihenfolge, erster Fehler gewinnt:

1. Verzeichnis existiert, ist kein Symlink-Trick, lesbar. Sonst `path-unreadable`.
2. Erkennt eine Store-Form: `_schema.json` und/oder Agent-Unterordner mit LanceDB-Tabelle und/oder `generations/<id>/generation.json`. Sonst `not-a-store`.
3. Schema: `readStoreSchemaVersion(path)` gegen `STORE_SCHEMA_VERSION` dieser Engine. `null` → `schema-unreadable`. `current !== expected` und kein registrierter `admin.migrate`-Schritt, den Adopt selbst nicht anstößt → `schema-mismatch`. (A6: darf Adopt bei `0→1` intern `migrate` aufrufen? Vorschlag: nein, nur berichten; der Host ruft `admin.migrate` nach `ok` oder nach einem eigenen Plan.)
4. Identität: wenn `generation.json` da ist, `manifest.fingerprintId` und `manifest.dimensions` gegen `expectedIdentity`. Sonst Legacy: Dimension der Tabelle gegen `expectedIdentity.dimensions`; `fingerprintId` fehlt → `identity-unreadable` (nie als Treffer werten, analog `docs/import.md` §2.3.1). Ungleich → `identity-mismatch` oder `dimension-mismatch`.
5. Optionaler Probe-Vergleich (Auftrag §6.2 / import.md): festes Probe-Set embedden und gegen gespeicherte Referenzvektoren halten. Nur wenn Referenzvektoren im Store liegen. Fehlen sie, gilt Schritt 4. (A7: ob 1.11.0 den Probe schon vorschreibt.)

`verdict: "ok"` heißt: diese Engine darf den Pfad als `baseDbPath` öffnen, Vektorraum und Schema passen. Adopt schreibt bei `dryRun: true` nichts. Bei Apply: keine LanceDB-Mutation, höchstens ein Registrierungs-Marker unter dem Engine-State, dass dieser Pfad geprüft wurde (A8: ob das nötig ist oder der Host den Pfad einfach in der Config behält). Manifeste nicht von Hand fälschen.

`incompatible` ist kein Throw. `MemoryOpError` nur bei geschlossenem Engine (`storage`), unsicherem Pfad (`invalid-input`), oder wenn ein zweiter Writer den Store hält (`conflict` oder `reason: "target-running"`, A9).

Mismatch ist nicht Adopt-plus-Re-Embed in einem Rutsch. Der Host ruft `admin.reembedding.plan/apply/switch` auf dem **Ziel**, nachdem Adopt `identity-mismatch` gemeldet hat. Adopt mischt keine Vektorräume.

---

## 4. Single-Writer: Engine offline im selben Prozess

### Was die Engine heute sperrt

Die Engine hat **kein** Cross-Process-Store-Lock.

- `engine/jobs/job-ledger.js`: „exactly one resident engine process is expected per installation. `ledger.jsonl` and `running/*.started` are plain files with no cross-process locking.“
- `AgentDbPool.withDb` / `withWriteDb`: Lease **in diesem Prozess** (Cache-Refcount), kein `flock`.
- `Engine.open`: `db.init()`, kein Lock.
- `fragment-compactor.js`: process-wide Optimize-Lock pro Tabellenpfad, nur innerhalb des Prozesses.
- Proposal-Store: atomare Datei mit `"wx"`, kein Store-Lock.

T7 (ein Engine-Owner pro Store) ist eine Prozess-Annahme (ADR-001), keine durchgesetzte Dateisperre in `engine/**`.

### Was der Harness schon sperrt (Host, nicht Engine)

Der Core hält `state/core.lock`: SQLite `PRAGMA locking_mode=EXCLUSIVE` + `BEGIN EXCLUSIVE` (`packages/core/src/lock.ts`, ADR-012 §5). Zweiter Core → `E_LOCKED`. OS gibt frei bei Prozessende inklusive SIGKILL. `run/core.pid` ist Anzeige, nicht die Sperre.

Das ist Harness-Code. Die Engine kennt `core.lock` nicht.

### Wie der Importer öffnen darf

1. Core ist gestoppt (Lock frei, kein zweites `createEngine` auf demselben Home).
2. Der Importer-Prozess nimmt **dieselbe** `state/core.lock` (Harness `acquireCoreLock(l.coreLock, …)`). Hält ein Restprozess sie, Abbruch `target-running`, kein Store-Touch.
3. Im selben Prozess: `createEngine(host, config)` mit `HostServices.stateDir` / Store-Pfad auf das **Ziel**-Home. Das ist der eine Engine-Owner.
4. `stores.adopt` und/oder `memory.import`, dann `engine.close({ budgetMs })`, dann Lock freigeben.

Kein zweites LanceDB-Handle in einem anderen Prozess. Kein `@lancedb/lancedb` im Importer. `detect` (Harness, read-only, ohne Engine) bleibt von Apply getrennt.

`memory.import` intern: `pool.withWriteDb(agentId, …)` wie der Live-Store.

### Engine-seitiger Lock in 1.11.0?

Nicht vorschreiben, solange der einzige Produktiv-Host der Harness mit `core.lock` ist. Ein zweites Lockfile unter `{baseDbPath}/_engine.lock` würde T7 in der Engine erzwingen, verdoppelt aber die Sperre und ist ein neues On-Disk-Artefakt.

A9: Owner wählt

- (a) Host-Pflicht dokumentieren (`core.lock` + Core weg), Engine prüft nicht, oder
- (b) optionales `stores.adopt` / `createEngine` nimmt `{baseDbPath}/_engine.lock` nach demselben SQLite-EXCLUSIVE-Muster, `target-running` wenn belegt.

Empfehlung: (a) in 1.11.0, (b) nur wenn ein Host ohne `core.lock` dieselbe Engine laden soll.

---

## 5. Abweichungen vom Sketch in Harness PR #91

Der Sketch in PR #91 ist der Anlass, nicht die Spezifikation. Unterschiede zum Auftrag und zu 1.10.0:

| Sketch in #91 | Dieser Vorschlag |
|---|---|
| `provenance` einmal am Request | `provenance: "imported"` an jeder Karte |
| `status: created \| duplicate \| skipped` | `created \| matched-existing \| rejected` (M7-Akzeptanz: zweiter Lauf `matched-existing`) |
| kein `dryRun` am Import | `dryRun` am Request |
| kein idempotenter Schlüssel | Pflichtfeld `idempotencyKey` |
| Ergebnis kann `id` ohne Grund bei Skip | `reason` maschinenlesbar, kein Text |
| `target-running` als `MemoryOpError` auf `import` | Host-Lock vor `createEngine`; optional A9 |
| kein `stores.adopt` | eigenes Member für Copy-Übernahme |
| `origin` frei (`import:hermes:MEMORY.md`) | `origin` bleibt `MEMORY_ORIGINS`; Pfad in `sourceRef` / `sourceUrl` |
| `packages/core/node_modules/…/types/engine.d.ts` | Quelle ist dieses Plugin-Repo, `types/engine.d.ts` |

Batch 3 (Hermes-Karten) und Store-Formatprüfung in #91 warten auf die Implementierung nach Review dieses Dokuments.

---

## 6. Offene Punkte (nicht geraten)

| Id | Thema | Vorschlag zum Review |
|---|---|---|
| A1 | Ein Principal oder Aufrufer plus Karten-Principal | `p` = Operator, `req.principal` = Bindung; bei uneindeutiger User-Bindung Karte `rejected` / `principal-unresolved` (import.md §2.4 fail-closed) |
| A2 | Ähnliche Live-Karte ohne denselben Schlüssel | immer anlegen; kein LLM-Merge |
| A3 | `AgentContext.origin` für Import | `"system"`, `background: false` |
| A4 | Idempotenz-Ledger vs. Schema `1→2` | Sidecar `_imports/` in 1.11.0, Spalte später |
| A5 | Bedeutung von `kind` | auf `category` mappen |
| A6 | Adopt bei Schema `"0"` | nur `schema-mismatch` melden, Host ruft `admin.migrate("0","1")` |
| A7 | Probe-Set in Adopt | 1.11.0: Fingerprint/Dimension/Manifest; Probe als Folge, wenn Referenzvektoren spezifiziert sind |
| A8 | Registrierung nach `ok` | Host trägt den Pfad in seiner Config; Engine schreibt kein zweites Manifest |
| A9 | Engine-eigenes Lockfile | nein in 1.11.0; Importer hält `state/core.lock` |

---

## 7. Testplan (nach Review, eigener Implementierungs-PR)

Keine Tests in diesem PR. Zielort später: `tests/engine-memory-import.test.js`, `tests/engine-stores-adopt.test.js`, DB-frei wo der Ledger und die Guards reichen, mit Temp-Store wo LanceDB nötig ist (Muster `tests/engine-memory-share-unsupported.test.js`, Schema-Tests an `engine/store/schema-version.js`).

### `memory.import`

- Leerer Batch / fehlender Schlüssel / `provenance` nicht `imported` / `agentId` ≠ `p.agentId` → `invalid-input` oder per-card `rejected`, kein Write.
- Eine Karte: `created`, `id` gesetzt, `list`/`show` finden sie, `createdAt` der Quelle steht, `origin` intern, Ledger-Zeile existiert.
- Zweiter Aufruf derselben `idempotencyKey` → `matched-existing`, gleiche `id`, keine zweite Zeile, Zähler `created: 0`.
- `dryRun: true` → Zähler wie Apply, Store und Ledger unverändert.
- Tombstone desselben Texts/Scopes → `rejected` / `tombstone-blocked`.
- `a.origin === "user"` ist erlaubt oder nicht je nach A3; `forget`-Guard bleibt für `forget` bei `origin: "system"` auf `denied`.
- Antwort-JSON und Logger-Mocks enthalten den Kartentext nicht (Grep-Fixture-Token wie M7-Akzeptanz 7).
- `signal` abort nach der ersten Karte: erste `created`, Rest `aborted`; Resume legt die restlichen an, erste `matched-existing`.
- `inferred` Principal + `scope: "user"` → `rejected` / `principal-unresolved` oder Write nur `agent-private` (A1).
- Embedder der Engine wird aufgerufen (Passage), nicht ein mitgelieferter Vektor; `identities()[0]` unverändert.

### `stores.adopt`

- Temp-Store von `createEngine` geschrieben, Pfad + `identities()[0]` → `ok`.
- Falsches `fingerprintId` oder andere Dimension → `incompatible` / `identity-mismatch` oder `dimension-mismatch`, kein Write.
- Verzeichnis ohne Marker und ohne Tabellen → `not-a-store`.
- `_schema.json` unlesbar → `schema-unreadable`.
- Marker `"0"` gegen Engine `"1"` → `schema-mismatch` (A6).
- `generation.json` mit passendem Fingerprint → `ok`; abweichend → mismatch.
- Fehlendes Fingerprint-Artefakt im Legacy-Store → `identity-unreadable`, nie `ok`.
- `dryRun` ändert nichts am Pfad (byte-identisch).
- Symlink/Escape-Pfad → `invalid-input`, analog bestehende Path-Guards.

### Single-Writer (ohne Harness-Code in `engine/**`)

- Zwei `createEngine` in einem Testprozess auf denselben `baseDbPath` bleiben 1.10.0-Verhalten (kein Engine-Lock), dokumentiert.
- Host-Test (Harness, nicht dieses Repo): Core läuft → Importer `target-running`; Core weg, Lock gehalten, `createEngine` + `import`/`adopt` ok.
- Nach `engine.close` lehnt `import`/`adopt` mit `storage` / „engine is closed“ ab.

### Conformance

Bei der Implementierung, nicht hier: `types/engine.d.ts` Changelog 1.11.0, `ContractVersion`, `types/engine.conformance.ts` (Member-Existenz, Outcome-Union), `docs/engine-api.md` Abschnitt, `engine/create-engine.js` `contract: "1.11.0"`. Ein PR, Adapter und Contract zusammen (Amendment Policy im `.d.ts`-Header). OpenClaw-Adapter muss die neuen Member nicht aufrufen.

---

## 8. Dateien, die die Implementierung später anfassen würde

Nur zur Orientierung, in diesem PR unverändert:

- `types/engine.d.ts`, `types/engine.conformance.ts`
- `docs/engine-api.md`
- `engine/create-engine.js` (Engine-Objekt, kein Reuse von `storeMemoryFromToolParams` ohne die oben genannten Abweichungen)
- `engine/memory-ops/` (neues Modul `import.js`, Guard in `context.js` nicht auf Import anwenden)
- `engine/store/schema-version.js` (lesen von Adopt, schreiben nur wenn A6/A4 es verlangen)
- `lib/reembedding/generation-layout.js`, `lib/reembedding/fingerprint.js` (lesen)
- `lib/tombstone.js` (Tombstone-Block)

Kein `adapter/openclaw/**`, kein Harness-Code, keine Versionsfelder in `package.json`.

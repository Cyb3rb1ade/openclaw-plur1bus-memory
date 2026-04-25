# Changelog

## [1.8.0] — 2026-04-25

### Memory-Hygiene-Release — Canonical-First Recall, Provenance, Doctor-CLI

Inspiriert von einer GBrain-vs-Plur1bus-Analyse (Vergleichs-Stack auf
github.com/garrytan/gbrain) wurden drei zentrale Schwächen adressiert:
unkuratierter Memory-Haufen, fehlende Provenance, und keine messbaren
Health-/Recall-Metriken.

#### 🟢 Bündel A — Recall-Qualität (Quick Wins)

**`extensions/memory-lancedb-namespaced/index.js` — Recall-Pipeline**

- **Inter-Result-Dedup vor Injection** — Nach Cohere-Rerank wird die Top-N
  noch durch eine Jaccard-Token-Similarity-Schleife geschickt. Wenn zwei
  Summaries ≥ `recall.dedupJaccard` (Default 0.6) ähnlich sind, wird die
  schwächer-rankende verworfen und die nächste rückt nach. Verhindert dass
  fünf Varianten desselben Sachverhalts den Kontext fluten.
  Konfigurierbar: `recall.dedup` (default true), `recall.dedupJaccard`.
- **Importance-Boost im Recall** — Score wird angepasst zu
  `score * (1 + importance * boost)`. High-importance Memories rutschen
  nach oben. Konfigurierbar: `recall.importanceBoost` (Default 0.3).
  Wirkt sowohl in Auto-Recall als auch in `memory_recall`.

**`scripts/memory-doctor.mjs` — neues CLI**

- `stats [agent]` — pro Agent: Anzahl, Speicher, ≥0.85, TTL, Decision-Count,
  storedBy-Lücken (Legacy-Erkennung)
- `dupes [agent] [thresh]` — Cluster fast-identischer Memories via Jaccard
- `stale [days]` — Memories älter X Tage mit importance < 0.5
- `orphans [agent]` — Memories ohne `storedBy` oder `origin`
- `pending [agent]` — High-importance Memories nicht in `KNOWLEDGE.md`
- `eval [agent]` — Recall-Eval gegen `recall-eval.json` Testbatterie
- `all` — alle Checks kompakt

**`scripts/recall-eval.json` — Recall-Test-Batterie**

JSON-Schema pro Agent mit Test-Queries und einem von:
`expectedMemoryId`, `expectedTextContains[]`, `expectedCategory`, `minScore`.
Pass-Rate-Berechnung — macht Threshold-Tuning messbar statt subjektiv.

#### 🟡 Bündel B — Architektur

**B1: Provenance-Felder im Schema**

Sechs neue LanceDB-Spalten (alle auto-migriert beim ersten DB-Zugriff):

| Feld | Typ | Bedeutung |
|---|---|---|
| `sourceTurnId` | string | Turn-ID die diesen Memory erzeugt hat |
| `sourceMessageRole` | string | `user` / `assistant` / `tool` / `system` |
| `sourceTimestamp` | int64 (ms) | Wann wurde die Quell-Nachricht gesendet |
| `sourceUrl` | string | URL aus User-Nachricht (Auto-Capture) |
| `evidenceQuote` | string | Original-Zitat (≤200 Zeichen) das den Memory backt |
| `scope` | string | `agent-private` (default) \| `workspace` \| `user` |

`memory_store` akzeptiert die Felder als optionale Parameter.
Auto-Capture befüllt sie automatisch aus der Turn-Struktur.

**B2: Canonical-First Recall**

Bevor LanceDB durchsucht wird, scannt der Hook semantisch
`{workspaceDir}/memory/KNOWLEDGE.md`:

1. KNOWLEDGE.md wird per H1/H2/H3-Header in Sections gechunked
2. Jede Section bekommt einen Embedding-Vektor (`text-embedding-3-large`)
3. Cache liegt in `.adaptive-learning/knowledge-cache.json`,
   invalidiert per `mtime`
4. Bei Recall: Cosine-Similarity gegen Query-Vektor, Top-N mit Score
   ≥ `recall.canonicalMinScore` (Default 0.30) werden injiziert
5. Format: `[canonical|knowledge] <heading> — <snippet>`
6. Kanonische Treffer kommen ZUERST im `<relevant-memories>`-Block,
   raw memories füllen die verbleibenden Slots

Konfigurierbar: `recall.canonicalFirst` (default true),
`recall.canonicalMinScore`, `recall.canonicalMaxItems` (default 2).

**B3: Markdown-Frontmatter in KNOWLEDGE.md**

`updateKnowledgeMd` und `knowledge_update` schreiben jetzt YAML-Frontmatter:

```yaml
---
type: knowledge
agent: bernhardine
last_verified: 2026-04-25
source_memories:
  - uuid-1
  - uuid-2
---
```

LLM-Prompts wurden angepasst, **nur den Body** zu manipulieren — Frontmatter
wird programmatisch generiert/aktualisiert. Bestehende `source_memories`
werden mit neuen Pending-IDs gemerged (max. 50 jüngste).
`last_verified` wird bei jedem Update aktualisiert — nutzbar von
`memory-doctor stale` für KNOWLEDGE.md-Frische-Checks.

#### Neue Plugin-Config (komplett optional, alle mit sicheren Defaults)

```json
"recall": {
  "importanceBoost":   0.3,
  "dedup":             true,
  "dedupJaccard":      0.6,
  "canonicalFirst":    true,
  "canonicalMinScore": 0.30,
  "canonicalMaxItems": 2
}
```

#### Migration

Voll-automatisch beim nächsten Gateway-Start. Sechs neue Spalten werden
zu allen LanceDB-Agent-Tabellen hinzugefügt mit sicheren Defaults
(`expiresAt = 0`, `storedBy = ""`, `scope = "agent-private"`). Bestehende
Memories behalten alle alten Werte unverändert.

#### Bekannte Einschränkung (außerhalb dieses Releases)

Auto-Capture-Hook (`agent_end`) wird seit OpenClaw 4.x mit Warnung
`typed hook "agent_end" blocked because non-bundled plugins must set
plugins.entries.memory-lancedb-namespaced.hooks.allowConversationAccess=true`
geblockt. Der Konfig-Schlüssel `allowConversationAccess` ist im
OpenClaw-Runtime-Schema (`runtime-schema-Dgzy-2rz.js`) **nicht** gewhitelisted,
obwohl die Manifest-Registry ihn erwartet — das ist ein Schema-Mismatch
in OpenClaw selbst, kein Plugin-Bug. Workaround steht aus, bis OpenClaw
das Feld in `plugins.entries.*.hooks.properties` ergänzt. Auto-Recall,
Memory-Tools und Schicht 1.5 sind nicht betroffen.

#### Verifikation

```bash
# Stats:
node scripts/memory-doctor.mjs stats
# Eval-Batterie:
node scripts/memory-doctor.mjs eval
# Live: prüfe Gateway-Log auf 'injecting N memories + M canonical':
journalctl --user -u openclaw-gateway --since "5 minutes ago" | grep canonical
```

## [1.7.1] — 2026-04-22

### Fix — Path-Mismatch zwischen Dreaming und Embedder

**`scripts/embed-promoted-memories.mjs`**

- **Bug:** Script las seit jeher aus `{workspace}/memory/MEMORY.md`, Dreaming
  schreibt Promotions aber nach `{workspace}/MEMORY.md` (Workspace-Root).
  Symptom: Seit 2026-04-17 keine neuen Dreaming-Promotions mehr in LanceDB,
  obwohl Dreaming selbst weiter lief — alle Pushes landeten im Legacy-Pfad,
  der seit Anfang April nicht mehr gepflegt wurde.
- **Fix:** Script liest jetzt primär `{workspace}/MEMORY.md`, fällt auf
  `{workspace}/memory/MEMORY.md` nur zurück, wenn das Root-File fehlt.
- **Impact:** Embedder läuft für `main`, `heisenberg`, `cron` wieder produktiv
  (11 Promotions aus Backlog seit 17.04 eingebettet). Bernhardine hat die
  MEMORY.md aktuell, aber ohne `openclaw-memory-promotion`-Marker — separate
  Untersuchung warum Dreaming dort keine Promotionen mehr markiert.
- `migrate-memory-md-to-lancedb.mjs` hatte den korrekten Pfad bereits — keine
  Änderung nötig.

## [1.7.0] — 2026-04-22

### Scripts — Dynamisches Agent-Discovery + Migrations-Backup

**`scripts/embed-promoted-memories.mjs` & `scripts/migrate-memory-md-to-lancedb.mjs`**

- **Dynamisches Agent-Discovery:** Statt hardcoded `main/bernhardine/heisenberg`
  werden Agents aus `openclaw.json` → `agents.list[]` gelesen. Deduplizierung nach
  Workspace-Pfad (mehrere Subagents teilen sich oft einen Workspace → nur ein
  Migrations-Durchlauf pro Workspace). Pro Workspace wird der „Owner"-Agent
  bevorzugt: IDs ohne Bindestrich (`main`, `bernhardine`, `heisenberg`, `cron`)
  gewinnen über Subagents (`heisenberg-complex-researcher`, `bernhardine-writer`, …).
  Tie-Break: kürzere ID
- **Fallback:** Bei fehlender/defekter `openclaw.json` weiterhin die drei
  klassischen Haupt-Agenten
- **CLI-Filter** erweitert: `node script.mjs main bernhardine` verarbeitet nur
  diese Teilmenge der discovered Agents (vorher: nur ein Agent via `argv[2]`)

**`scripts/migrate-memory-md-to-lancedb.mjs` — Backup vor Überschreibung**

- **Automatisches Backup** der originalen `MEMORY.md` nach `MEMORY.md.bak-YYYYMMDD`
  **bevor** die Datei mit der kompakten Migrationsnotiz überschrieben wird.
  Wenn `copyFileSync` fehlschlägt (Disk full, Permissions), **bricht die Migration
  ab** und lässt die Originaldatei unangetastet. Vorher: Die neue MEMORY.md
  referenzierte zwar ein Backup — erstellt wurde es aber nie. Bei einem Crash
  während `writeFileSync` wäre die Originaldatei verloren gewesen

### Dokumentation — Troubleshooting Auto-Recall

Neue Sektion in `how-to-memory-perfect.md`: **Auto-Recall feuert nicht — Fehlerbilder & Checks**.
Konsolidiert drei aus der Produktion bekannte Fallen:

1. **System-Nachrichten vs. Agent-Turns** — Gateway-Broadcasts (Model-Switch-Alerts,
   Restart-Notifications) senden `telegram sendMessage` direkt, ohne durch die
   Turn-Pipeline zu gehen. Dadurch feuert kein `before_agent_start`-Hook, Auto-Recall
   läuft korrekt nicht. Fehldiagnose-Risiko hoch, weil Log-seitig "Activity ohne Recall"
   sichtbar ist.
2. **Externe Model-Switcher überschreiben Config** — Quota-Monitor- oder
   Failover-Scripts mit hardcoded Modellnamen revertieren `agents.defaults.model.primary`
   periodisch. Symptom: Nach jedem Cron-Tick steht wieder das alte Modell in `openclaw.json`.
3. **Legacy-Hook-Warning unter OpenClaw ≥ 4.20** — Plugin nutzt `before_agent_start`,
   in 4.20 als "legacy" markiert (Warnung bei `openclaw plugins inspect`). Funktional
   weiter unterstützt; Migration auf `before_prompt_build` ist zukünftiger Umbau.

### Plugin (`memory-lancedb-namespaced`)

**Klarstellung in README + how-to:**
- Merging/Schicht15-Modell: Empfehlung **`kimi-for-coding`** (offizieller API-Alias).
  Lokale Aliase wie `k2p5`/`k2p6` routen gateway-intern auf dasselbe Modell, bieten aber
  keinen Mehrwert und können bei Re-Benennungen brechen
- ActiveMemory-Plugin-Konfig: `kimi-coding/kimi-for-coding` als Standard-Modell für den
  Summary-LLM dokumentiert (qwen3-next-80b zwar direkt schnell, aber im embedded-runner
  Tool-Calling-Framework unzuverlässig — `status=empty` nach 20+s)

---

## [1.4.0] — 2026-04-13

### Plugin (`memory-lancedb-namespaced`)

**Features**
- LLM-Summarization: überlange Nachrichten (>captureMaxChars) werden via LLM zusammengefasst
  statt verworfen. Nutzt den Merging-LLM (kimi-for-coding). Fallback: Truncation bei LLM-Fehler
- Default `captureMaxChars`: 5000 → 15000 (text-embedding-3-large unterstützt bis ~32K chars)

**Fixes**
- Auto-Capture: Nachrichten über dem Limit wurden bisher **still verworfen** (`content.length <= maxChars`
  als Drop-Filter). Jetzt werden alle Nachrichten erfasst — kurze direkt, lange via Summarization

### Dokumentation

- `README.md`: Architektur-Diagramm (Memory + Dreaming), LLM-Summarization, Embedding-Fallback,
  natives Dreaming, 38 Agents in Produktion (DE + EN)
- `how-to-memory-perfect.md`: Dreaming-Sektion korrigiert — natives `memory-core` statt
  Bridge-Scripts, Namespace-Isolation-Tabelle, Verifikationsanleitung
- `CHANGELOG.md`: 1.2.0 korrigiert (Bridge nie implementiert, nur Plugin-Kind geändert)

---

## [1.3.1] — 2026-04-11

### `install-memory-system.sh`

- Merging: Default-Modell und Base-URL werden bei Update-Installationen aus der vorhandenen
  `openclaw.json` gelesen und als Vorschlag angezeigt — kein hardcoded Modellname mehr
- Merging: leeres Modellfeld bei Erstinstallation (User muss explizit eingeben)

---

## [1.3.0] — 2026-04-11

### Plugin (`memory-lancedb-namespaced`)

**Features**
- Embedding-Fallback: zweiter Embedding-Endpunkt bei Primary-Ausfall (gleiche Dimension Pflicht)
- ActiveMemory-Unterstützung: Plugin liefert Memory-Tools für den neuen OpenClaw-4.10-Sub-Agenten

**Fixes**
- `openclaw.plugin.json`: trailing comma entfernt (ungültiges JSON)

### `install-memory-system.sh`

- Embedding-Fallback optional konfigurierbar (API Key, Base-URL, Modell)
- ActiveMemory-Plugin optional in Schritt 4b konfigurieren (OpenClaw ≥ 4.10)
- Merging: Kimi-spezifische Optionen (`disableThinking`, `User-Agent`-Header) sind jetzt
  opt-in statt default — Script funktioniert unverändert mit OpenAI, Claude, GLM, ChatGPT u.a.
- Default-Modell für Merging: `gpt-4o-mini` (statt `kimi-for-coding`)
- Default-Base-URL für Merging: leer = Standard-OpenAI-Endpunkt (statt Kimi-URL)

### `how-to-memory-perfect.md`

- Neues Kapitel: §ActiveMemory — Konzept, Per-Agent-Isolation, Konfigurationsparameter,
  Zusammenspiel mit Auto-Recall (Flussdiagramm)
- Neues Kapitel: §Embedding-Fallback — Resilienz, Dimensions-Constraint, Konfiguration,
  Graceful Degradation ohne Fallback
- Upgrade-Anleitung 2026-04-11: k2p5 contextWindow=262144/maxTokens=32768-Fix, YAAWC
  Cohere Reranker, contentUtils tool_call-Fix, kimiOpenAI maxTokens-Default

---

## [1.2.0] — 2026-04-06

### Plugin (`memory-lancedb-namespaced`)

**Features**
- Plugin-Kind auf `extension` geändert — ermöglicht Koexistenz mit nativem `memory-core`
  Dreaming (light → REM → deep Phasen pro Workspace), während LanceDB weiterhin
  Auto-Capture/Recall per Agent liefert
- ~~Dreaming-Bridge~~: externe Python-Skripte (`dreaming-bridge.py`, `dreaming-promote.py`)
  wurden erstellt, aber nie via Cron aktiviert — das native `memory-core` Dreaming
  übernahm die Funktion. Scripts bleiben als Referenz im Branch `dreaming-bridge/v1.0.0`

**Security-Fixes**
- Pfad-Traversal-Schutz: `agentId` wird gegen `[a-zA-Z0-9_-]` validiert
- LanceDB-Verbindungen werden nach Operationen geschlossen (kein Connection-Leak)
- Fehlerbehandlung in Plugin-Hooks verhindert unkontrollierten Absturz

---

## [1.1.0] — 2026-04-03

### Plugin (`memory-lancedb-namespaced`)

**Security-Fixes** (nach internem Audit)
- `memory_store`: Path-Traversal via `agentId` geschlossen
- `memory_forget`: UUID-Validierung vor `DELETE` verschärft
- Lock-File: Race-Condition bei gleichzeitigem Store behoben

---

## [1.0.0] — 2026-04-03

Erste öffentliche Version. Konsolidiert alle Entwicklungen aus dem produktiven OpenClaw-Deployment.

### Plugin (`memory-lancedb-namespaced`)

**Features**
- Per-Agent-Isolation: jeder Agent bekommt seine eigene LanceDB unter `{baseDbPath}/{agentId}/`
- Auto-Capture nach jedem Turn mit URL- und Attachment-Priorisierung
- Auto-Recall vor jedem Turn (Top-5, optional mit Cohere Re-Ranker)
- Dreistufige Store-Pipeline: Duplikat-Check → LLM-Merge → Neu
- TTL-System: `session` (24h), `short` (14 Tage), permanent
- Schicht 1.5: `KNOWLEDGE.md` mit automatischer Kompaktierung bei >200 Zeilen
- Conflict-Log für `decision`-Memories zwischen Agenten (schemaVersion: 1)
- `storedBy`-Feld für Traceability
- Relative Pfade via `import.meta.url` — installationspfad-unabhängig

**Security**
- SQL-Injection-Schutz: UUID-Format-Validierung vor allen `table.delete()`-Aufrufen
- Atomares Lock-File via `openSync('wx')` — verhindert TOCTOU-Race-Condition
- Staleness-Check: Lock-Dateien >5 Minuten werden automatisch entfernt (Crash-Recovery)
- JSON-Parse-Fehlerbehandlung in `callMergeCheck` — ungültiges LLM-JSON führt zu No-Merge
- Embedding-Retry mit exponentiellem Backoff (3 Versuche, Rate-Limit-aware)
- Promise-Queue pro Agent für Auto-Capture — verhindert Race Conditions bei parallelen Events
- `pendingCount` gedeckelt bei 1000

### `memory-gc.mjs`

- Pfade relativ via `import.meta.url` — kein hardcoded `/root/`
- Agent-Liste wird aus `openclaw.json` gelesen (Fallback: `main`, `bernhardine`, `heisenberg`)

### `install-memory-system.sh`

- Auto-Erkennung lokaler OpenClaw-Installationen (sucht nach `openclaw.json` in Standard-Pfaden)
- Auswahlmenü bei mehreren Installationen mit Versions-Anzeige
- `--update-plugin-only`: nur Plugin-Dateien aktualisieren, keine Config-Änderungen
- `--rollback`: stellt letzten LanceDB-Snapshot + `openclaw.json.bak` wieder her
- `--dry-run`: Vorschau ohne Änderungen
- Automatischer LanceDB-Snapshot vor jeder Installation (max. 5, älteste werden gelöscht)

---

## [1.5.0] — 2026-04-17

### Dreaming ↔ LanceDB Harmonisierung (neu)

**Features**
- Neues Script `scripts/embed-promoted-memories.mjs`: Liest Promotionen aus `MEMORY.md`
  (erkennbar am `<!-- openclaw-memory-promotion:... -->` Marker) und embedded sie in die
  per-Agent LanceDB
- State-Tracking per Agent (`~/.openclaw/.embed-promotions-state/`): jede Promotion wird
  nur einmal eingebettet (idempotent, Duplikat-Check via Cosine-Distance)
- `importance: 0.9`, `category: "curated"`: höher gewichtet als normale Auto-Captures
- Cron: alle 30 Minuten — deckt auch manuelle Tages-Promotionen ab

**Wirkung:** Promotete Dreaming-Fakten erscheinen jetzt im Real-Time Active-Memory Recall,
nicht nur beim Session-Bootstrap via MEMORY.md. Dreaming und LanceDB sind harmonisiert.

### Kompatibilität

- OpenClaw 2026.4.15+: `dreaming.storage.mode: "separate"` unterstützt
- Active-Memory empfohlen: `moonshot/kimi-k2.5-instant`, timeoutMs: 15000 (statt k2p5 mit 60s)
- k2p6: contextWindow=262144, maxTokens=32768 (identisch mit k2p5)

---

## [1.6.0] — 2026-04-21

### MEMORY.md → LanceDB Migration (neu)

**Features**
- Neues Script `scripts/migrate-memory-md-to-lancedb.mjs`: Migriert alle Einträge aus
  `MEMORY.md` (Abschnitte + `<!-- openclaw-memory-promotion:... -->` Einträge) in LanceDB
- Idempotent via Cosine-Similarity Duplikat-Check (threshold: 0.97)
- `importance: 0.95`, `category: "knowledge"/"curated"` — höchste Priorität
- `MEMORY.md` wird auf kompakten Header + Archivhinweis reduziert (~700 chars)
- Backup: `MEMORY.md.bak-YYYYMMDD` bleibt erhalten
- Unterstützt `--dry-run` für Vorschau ohne Änderungen

**Ergebnis im Produktionseinsatz:**
- Bernd: 408.9k → 0.7k (189 neue Embeddings, 451 Duplikate übersprungen)
- Bernhardine: 582.9k → 0.7k (230 neue, 454 Dupes)
- Heisenberg: 57.1k → 0.6k (27 neue, 71 Dupes)

### OpenClaw 2026.4.20

- `moonshot/kimi-k2.6` verfügbar und in Modellauswahl eingetragen
- Hauptagenten (main, bernhardine, heisenberg) auf `kimi-coding/k2p6` als Default
- Patches #5 und #14 retired (upstream gefixt)

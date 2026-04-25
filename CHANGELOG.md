# Changelog

## [1.8.5] — 2026-04-25

### Distance→Score-Formel überall konsistent

Plugin-Code und drei Cron-Scripts schrieben in dieselbe LanceDB, nutzten
für Duplicate-Detection aber unterschiedliche Distance-zu-Score-Formeln:

| Stelle | Formel | Verhalten |
|---|---|---|
| Plugin (4 Stellen in MemoryDB) | `1 / (1 + d)` | korrekt (begrenzt auf [0, 1]) |
| `auto-capture-lancedb.mjs:302` | `1 - d` | falsch — bei d>1 negativ |
| `embed-promoted-memories.mjs:185` | `1 - d` | selbiges |
| `migrate-memory-md-to-lancedb.mjs:186` | `1 - d` | selbiges |
| `memory-doctor.mjs:297` | `1 / (1 + d)` | korrekt |

Bei LanceDB-L2-Distanzen >1 (typisch bei nicht-normalisierten Embeddings
oder weit auseinander liegenden Vektoren) gab `1 - d` negative Scores —
der `> threshold`-Vergleich wurde silent inkonsistent.

**Fix:** Alle drei Cron-Scripts nutzen jetzt `1 / (1 + d)` mit
expliziter Kommentar-Notiz:
```
// Score-Formel spiegelgleich zu Plugin: 1 / (1+d)
```

Verhaltensänderung: Bei normalisierten cosine-Distanzen (Range [0, 2])
werden jetzt mehr Texte als Duplikate erkannt — was die Plugin-Semantik
widerspiegelt. Bestehende Memories sind nicht betroffen, nur künftige
Captures.

In v1.9.0 wird `distanceToScore()` als Helper in `recall-pipeline.mjs`
extrahiert — damit Plugin und alle Scripts denselben Code aus einer
Quelle importieren statt 4× das Gleiche zu duplizieren.

## [1.8.4] — 2026-04-25

### 🔴 Security: recall-eval mit Live-Daten aus Repo entfernt

`scripts/recall-eval.json` enthielt echte personenbezogene Daten und Key-
Suffixe — wurde versehentlich mit v1.8.0 öffentlich committed. Heutiger
HEAD ist sanitisiert; **History bleibt vorerst unverändert** (siehe unten).

| Wert | Sensitivität |
|---|---|
| Eva Telegram Chat-ID `[REDACTED_CHAT_ID]` | hoch — direkt missbrauchbar für Spam |
| Erik Telegram Chat-ID `[REDACTED_CHAT_ID]` | hoch — selbiges |
| Bernd Kimi-Key-Suffix `[REDACTED_KEY_SUFFIX]` | mittel — letzte 5 Zeichen |
| `@h3isenbot` Bot-Handle | niedrig — öffentlich |
| Personennamen Eva/Erik/Christian | mittel |

**Aktionen umgesetzt:**

1. `scripts/recall-eval.json` aus Repo entfernt (`git rm`)
2. `scripts/recall-eval.sample.json` als Vorlage committed — nur Platzhalter
3. `.gitignore` ergänzt: `scripts/recall-eval.json`
4. `memory-doctor eval` fällt jetzt auf `recall-eval.sample.json` zurück
   wenn keine echte recall-eval.json vorhanden — mit Warning, dass die
   Sample-Datei keine produktiven Tests enthält

**Ausstehend (nutzer-Entscheidung erforderlich):**

- Git-History-Rewrite mit `git filter-repo` oder BFG zum Scrubben des
  Commits `a611ea7` (v1.8.0). Erfordert force-push auf `main` und alle
  Tags. Nicht automatisch ausgeführt — destruktiv.
- Token-Rotation für `[REDACTED_KEY_SUFFIX]`-Suffix (vollständigen Key). Da nur die
  letzten 5 Zeichen exposed sind, ist Brute-Force unrealistisch — aber
  bei Hochsicherheits-Anforderungen wäre Rotation sauber.

### Category-Taxonomie vereinheitlicht

Plugin und Cron-Script schrieben unterschiedliche Kategorien in dieselben
LanceDB-Tabellen:

| Quelle | Kategorien |
|---|---|
| Plugin (`MEMORY_CATEGORIES`) | preference, fact, decision, entity, other |
| Cron `categorizeMemory()` | reference, debug, config, conversation |
| `embed-promoted-memories.mjs` | curated |
| `migrate-memory-md-to-lancedb.mjs` | curated, knowledge |

Resultat: 11 verschiedene Kategorien in der Praxis, aber nur 5 vom Plugin
für `memory_store` validiert. Doctor/Recall/UI würden bei späterer
Filterung ungleichmäßig matchen.

**Fix:** Eine zentrale Taxonomie:

```
preference, fact, decision, entity, reference,
debug, config, conversation, knowledge, curated, other
```

- `MEMORY_CATEGORIES` im Plugin auf alle 11 erweitert (memory_store-enum)
- `categorizeMemory()` im Plugin überarbeitet — erkennt jetzt zusätzlich
  debug/config/reference, Default ist `conversation` statt `other`
- `categorizeMemory()` im Cron-Script spiegelgleich auf dieselbe Heuristik
  (mit Kommentar, dass die beiden Funktionen synchron bleiben müssen)

Bestehende Memories behalten ihre Kategorie — keine Migration nötig.

### Bug: `memory-doctor dupes` ignorierte den threshold-Parameter

CLI nahm den Threshold zwar entgegen und zeigte ihn im Header an, der
eigentliche Cluster-Check verwendete aber hardcoded `if (sim >= 0.85)`.
Außerdem stand in der Ausgabe "cosine" obwohl Jaccard auf Text/Summary
genutzt wird.

**Fix:** `if (sim >= threshold)` (verwendet jetzt den User-Wert).
Beschriftung korrigiert auf "Jaccard". Default 0.85 (war versehentlich
0.95 dokumentiert — Code hat schon immer 0.85 verwendet, jetzt
konsistent).

### Doku: Header-Kommentar in `index.js` überarbeitet

Statt der knappen v1.8.3-Version jetzt umfangreicher: erklärt
Auto-Capture-Setup (Hook + Cron-Fallback inkl. OpenClaw-4.x-Schema-Issue),
Recall-Pipeline-Reihenfolge, Provenance-Felder. Zukünftige Maintainer
sollen aus dem Header heraus die Architektur verstehen können.

## [1.8.3] — 2026-04-25

### Manifest-Sync, fallback-Schema, Header-Comment, Bump-Helper

Drei stille Korrektheits-Bugs die kein Feature-Verhalten ändern, aber
zukünftige Diagnose & Wartung sauber halten:

#### Versions-Drift

`extensions/memory-lancedb-namespaced/openclaw.plugin.json` und
`package.json` standen seit dem Initial-Release auf `"version": "1.0.0"`,
während das Repo + CHANGELOG bereits auf v1.8.2 waren. Wenn OpenClaw,
Installer oder Debug-Ausgaben diese Version lesen, führt das zu falscher
Diagnose ("Plugin-Version 1.0.0" trotz aktiver v1.8.x-Features).

**Fix:** Beide Manifeste auf `"version": "1.8.3"`. Neuer Helper:

```bash
./scripts/bump-version.sh check        # Drift-Detection
./scripts/bump-version.sh patch        # 1.8.2 → 1.8.3 (aus CHANGELOG)
./scripts/bump-version.sh minor        # 1.8.2 → 1.9.0
./scripts/bump-version.sh 1.8.5        # explizite Version
```

CHANGELOG-Section bleibt manuell (Bump-Grund schreiben), aber Manifest +
package.json werden synchron gehalten.

#### embedding.fallback im Manifest gewhitelisted

Der Code (`Embeddings`-Klasse) wertet seit langem `embeddingCfg.fallback`
aus für sekundäre Embedding-Endpunkte (zweiter OpenAI-Key, Azure-Backup,
LiteLLM-Proxy). Im `openclaw.plugin.json` war `embedding` aber mit
`additionalProperties: false` gesperrt und erlaubte nur `apiKey/model/baseUrl/dimensions`
— eine Konfiguration mit `embedding.fallback: {…}` wäre vom Gateway-Schema-
Validator als ungültig markiert worden.

**Fix:** `fallback`-Sub-Schema im Manifest ergänzt:

```json
"fallback": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "apiKey":  { "type": "string" },
    "model":   { "type": "string" },
    "baseUrl": { "type": "string" }
  }
}
```

#### Header-Kommentar in `index.js` veraltet

Stand seit Initial-Release: *"Auto-Capture ist deaktiviert, da OpenClaw
keinen agent_end Hook unterstützt."* Das stimmt seit OpenClaw 4.x nicht
mehr (Hook existiert, ist nur durch Schema-Bug geblockt) und seit v1.8.x
gar nicht mehr (Plugin-Hook + Cron-Fallback). Ein Entwickler liest das und
denkt: "Auto-Capture ist aus" — und sucht den Bug an der falschen Stelle.

**Fix:** Header-Kommentar überarbeitet — beschreibt jetzt korrekt:
- Primary: agent_end-Hook (mit aktuellem Schema-Issue)
- Fallback: scripts/auto-capture-lancedb.mjs (5-Min-Cron, v1.8.2-fixes)
- Recall-Pipeline-Übersicht
- Provenance-Felder

Keine Code-Änderungen, nur Dokumentation im Modul-Header.

## [1.8.2] — 2026-04-25

### Cron-Optimierung — drei strukturelle Bugs in `auto-capture-lancedb.mjs` gefixt

Forensische Analyse der Cron-Drop-Rate (50%) ergab nicht primär das Cap-Limit
(in v1.8.1 von 5 auf 50 angehoben), sondern drei strukturelle Defekte im
File-Discovery- und State-Tracking-Code:

#### 🔴 Bug 1: Cron parsed `.trajectory.jsonl`-Reasoning-Logs

`readdirSync().filter(f => f.endsWith(".jsonl"))` filterte die Trajectory-
Variante nicht aus. Diese sind interne Reasoning-Logs ohne `role: user|assistant`
und damit für Auto-Capture wertlos. Beweis: State-Files zeigten
`lastFile: "...trajectory.jsonl"` statt der echten Sessions. Bei den meisten
Cron-Runs wurden Reasoning-Internals geparst (5–10 candidates pro Run) statt
echte Conversations (oft 50+ candidates).

**Fix:** Neue Filter-Funktion `isSessionFile(name)` filtert jetzt
`.trajectory.`, `.checkpoint.`, `.deleted.` raus.

#### 🔴 Bug 2: Subagents komplett ignoriert

`AGENTS = ["main", "bernhardine", "heisenberg"]` war hardcoded. **10+
Subagenten** mit echten Sessions (developer: 5, budget-researcher: 10,
complex-researcher: 3, deep-diver: 8 etc.) wurden nie erfasst.

**Fix:** Neue `discoverAgents()`-Funktion liest `agents.list[]` aus
`openclaw.json` (gleiches Pattern wie `embed-promoted-memories.mjs`, aber
**nicht** workspace-dedupliziert da jeder Agent eigene Sessions hat).
CLI: `node auto-capture-lancedb.mjs [agentId...]` filtert auf Subset.

#### 🔴 Bug 3: State-Tracking war Byte→Line-Approximation

State speicherte `lastSize` (Bytes), beim nächsten Run wurde die Line-Position
geschätzt via `slice(0, lastSize).split("\\n").length - 1`. Bei JSONL mit
langen Lines (Tool-Calls, Base64) verschob sich das — Lines wurden doppelt
oder gar nicht gelesen.

**Fix:** Neues State-Schema `{ files: { "<filename>": <byteOffset> } }`.
Tracking exakt per Byte-Offset, kein Line-Counting mehr. Multi-File-Sweep:
ALLE gewachsenen Sessions werden in einem Cron-Run verarbeitet (nicht nur
"newest"). State auto-migriert von altem `{ lastFile, lastSize }`-Format.

#### Bonus: Min-Char-Filter senken

`MIN_TEXT_LEN: 20 → 10`. Wichtige kurze Bestätigungen (z.B. "Ja, mach das.",
"Genau so.") wurden vorher gedroppt.

#### Verifikation

Nach State-Reset für alle drei primären Agenten:

| Agent | Session-Files | Candidates | Stored | Kommentar |
|---|---|---|---|---|
| heisenberg | 6 | 84 | 12 | vorher: 1 trajectory-File mit ~5 candidates |
| bernhardine | 133 | 3126 | 22 | Rest = Duplikate (Plugin-store hat schon erfasst) |
| main | 121 | 2195 | 0 | alle bereits in DB durch direkte memory_store-Calls |

Provenance-Felder werden jetzt **garantiert** in alle neuen Cron-Captures
geschrieben (sourceMessageRole, sourceTurnId, sourceTimestamp, sourceUrl,
evidenceQuote — alle live verifiziert in `bernhardine.memories`).

#### Migration

Beim nächsten Cron-Lauf wird das State-File automatisch konvertiert:
- altes Format `{ lastFile: "X", lastSize: N }` → wird gelesen und in
  `{ files: { "X": N } }` migriert
- alte trajectory-Tracking-Einträge werden harmlos im State stehen gelassen
  (filter überspringt sie ohnehin)

Keine manuelle Aktion nötig. Wer den Catch-up-Effekt erzwingen will:
`rm /root/.openclaw/.auto-capture-state/<agent>.json` löschen — der
Duplicate-Check verhindert dann zuverlässig Re-Storage.

#### Nicht in diesem Release (v1.8.3 oder später)

- Inotify/systemd.path-basierter Live-Watcher (statt 5-Min-Cron)
- Multi-File-Tracking pro Session-File-Status (heute alle gleichberechtigt)
- OpenClaw-Schema-Patch für `allowConversationAccess` → würde Cron komplett
  obsolet machen, aber riskant bei `openclaw update`

## [1.8.1] — 2026-04-25

### Follow-up zu v1.8.0 — Forgetting-Pfade entschärft, Scripts ergänzen Provenance

Im Anschluss an v1.8.0 wurde das System auf Forgetting-Pfade analysiert. Die
meisten Mechanismen sind in der Praxis nicht aktiv (TTL: 0.06% der Memories,
echte Merges: 0). Die einzige relevante Lücke war das Auto-Capture-Cron-Script.

**`scripts/auto-capture-lancedb.mjs` (neu im Repo, war bisher nur lokal)**

- **Cap erhöht von 5 → 50 pro Cron-Run.** Vorher: 48.5% Drop-Rate aus dem
  bereits gefilterten Pool, plus implizite Verluste vor dem Slicing in
  langen Bursts (Bernhardine-Session vom 09.04. mit 2158 Messages → ein
  großer Teil never captured).
- **User-URL-Priorisierung:** zuerst bis zu 10 User-URLs, dann letzte 50
  Texte, gesamt-Cap 50. Spiegelt die Plugin-eigene Capture-Logik.
- **Provenance-Felder werden jetzt geschrieben:** `sourceTurnId` aus
  JSONL-`id`, `sourceMessageRole` aus `msg.role`, `sourceTimestamp` aus
  JSONL-`timestamp`, `sourceUrl` aus URL-Match in User-Texten,
  `evidenceQuote` = erste 200 Zeichen des Originaltextes, `scope` =
  `agent-private`.
- **Schema-Migration on-the-fly:** Wenn `getOrCreateTable` eine bestehende
  DB öffnet, werden fehlende v1.8.0-Spalten via `addColumns()` ergänzt
  (idempotent). Frische DBs werden mit allen Spalten erstellt.

**`scripts/embed-promoted-memories.mjs`**

Schreibt v1.8.0-Felder beim Embedding von Dreaming-Promotions:
`sourceMessageRole = "internal"`, `evidenceQuote` = Promotion-Text,
`scope = "agent-private"`.

**`scripts/migrate-memory-md-to-lancedb.mjs`**

Schreibt v1.8.0-Felder bei MEMORY.md-Migrationen:
`sourceMessageRole = "internal"`, `evidenceQuote` = Original-Chunk,
`scope = "agent-private"`.

**`scripts/install-memory-system.sh`**

- Fresh-Install-Plugin-Config enthält jetzt den `recall`-Block:
  ```json
  "recall": {
    "importanceBoost": 0.3, "dedup": true, "dedupJaccard": 0.6,
    "canonicalFirst": true, "canonicalMinScore": 0.30, "canonicalMaxItems": 2
  }
  ```
- `captureMaxChars` Default angehoben von 5000 → 15000 (Alignment mit
  Production-Config seit v1.4.0).

### Forgetting-Analyse — komplette Übersicht

Geprüfte Pfade (Risiko in der Praxis):

| Pfad | Aktiv? | Risiko |
|---|---|---|
| TTL-Purge (`memory-gc.mjs`) | 6/9307 = 0.06% | minimal |
| Merge in `memory_store` | 0 echte Merges | OK (per Design) |
| `memory_forget`-Tool | sehr selten | gering |
| KNOWLEDGE.md-Compaction (>200 Zeilen) | rar | gering — Raw-Memories bleiben in DB |
| Duplicate-Rejection (≥0.95) | 19 events historisch | gering |
| **Auto-Capture-Cron-Cap (5/Run)** | 48.5% Drop-Rate | **JETZT GEFIXT (Cap 50)** |
| Auto-Capture-Truncation (>15000) | LLM-Summary | mittel — controlled |
| Recall-Threshold (0.20) | by design | mittel — soft forgetting |
| Subagent-Isolation | by design | OK |
| Kein periodischer LanceDB-Backup | nur install-snapshot | mittel (separater Punkt) |

Mit dem Cap-Fix ist der einzige echte Datenverlust-Pfad geschlossen.
Soft forgetting (Threshold-basierte Recall-Limits) bleibt by design — Daten
sind in der DB, nur nicht immer surfaced.

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

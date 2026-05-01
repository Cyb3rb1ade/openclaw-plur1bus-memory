## [2.1.12] - 2026-05-01

### Fixed
- Isolated ActiveMemory embedded recall on its own global command lane (`active-memory`) instead of OpenClaw's default `main` lane, preventing timed-out memory recalls from blocking Bernd/main while preserving plur1bus and ActiveMemory.
- Added persistent Silent-Reply policy repair to the plur1bus user hotfix: direct `NO_REPLY` replies are now allowed to stay silent instead of being rewritten into visible filler such as "No extra reply needed here."
- Kept per-agent LanceDB routing unchanged: `main`, `bernhardine`, `heisenberg`, and their subagents continue to use `{baseDbPath}/{agentId}/`.
- Fixed `scripts/install-memory-system.sh --help` so help exits before target detection instead of accidentally running install preflight with an invalid path.

## [2.1.11] - 2026-05-01

### Fixed
- Fixed Kimi coding request parameters for OpenClaw 2026.4.29's current `createKimiThinkingWrapper`: `thinking=enabled` now sends `temperature=1.0` plus `budget_tokens=16384`, while `thinking=disabled` sends Kimi instant-mode `temperature=0.6` and `top_p=0.95`.
- Kept ActiveMemory enabled for `main`, `bernhardine`, and `heisenberg`, but safe in instant mode (`thinking=off`) so memory recall does not consume visible reasoning budget or trigger Kimi temperature errors.
- Tightened ActiveMemory prompt-hook blocking to 3000ms for already-patched installs as well as fresh hotfix runs.

## [2.1.10] - 2026-05-01

### Fixed
- Added `patches/apply-plur1bus-user-hotfix.sh` for OpenClaw `2026.4.29` latency regressions reported in openclaw/openclaw#75329, #75330, #75290 and #74860.
- The new hotfix preserves plur1bus and active-memory for `main`, `bernhardine` and `heisenberg`; it reuses the active Gateway plugin registry and applies `toolsAllow` before plugin tool factories run instead of bypassing the memory plugin.
- Heavy built-in OpenClaw media/web tools (`image`, `pdf`, `image_generate`, `video_generate`, `music_generate`, `web_search`) are now exposed as lazy descriptors, so prompt preparation no longer initializes provider stacks unless the tool is actually called.
- Capped active-memory prompt-hook blocking, removed the extra setup-grace wait, made `boot-md` startup work non-blocking, and replaced the empty hidden pre-compaction flush prompt.
- Retired the older direct active-memory fast-path patch as a no-op because it could bypass the plur1bus plugin path on newer OpenClaw builds.
- Installer remote mode now transfers the user hotfix script together with `apply-memory-patches.sh`.
- Installer now refreshes the OpenClaw plugin registry after direct plugin copies so `openclaw plugins list` reports the current package version.
- `memory-doctor.mjs` now falls back to the installed `~/.openclaw/extensions/memory-lancedb-stock/node_modules` dependencies when the Git checkout has no local `node_modules`.

## [2.1.9] - 2026-05-01

### Fixed
- Aligned README and plugin README displayed release version with the manifest after the OpenClaw `>=2026.4.29` minimum-version clarification.

## [2.1.8] - 2026-05-01

### Fixed
- Made the minimum required OpenClaw version explicit in GitHub-visible docs: README and plugin README now state OpenClaw `>=2026.4.29`.
- Added installer preflight detection via `openclaw --version`; detected versions below `2026.4.29` now abort before touching config or files.
- Updated Requirements language to avoid implying OpenAI-only embeddings.

## [2.1.7] - 2026-05-01

### Fixed
- Made `install-memory-system.sh` explicitly user-driven for both existing installations and fresh installs.
- Existing installations now default to `keep`: preserve the full `memory-lancedb-namespaced` provider/model config and only ensure required install wiring such as `hooks.allowConversationAccess`.
- Added explicit choices for `memory-lancedb-namespaced` config (`keep` or `reconfigure`) and `active-memory` config (`keep`, `reconfigure`, or `disable`).
- Fresh installs now derive defaults from the target OpenClaw config where possible, including `agents.defaults.memorySearch` and `agents.defaults.model.primary`, instead of hardcoding Kimi/Moonshot for chat-model features.
- Embedding setup now asks for provider endpoint, model and vector dimensions when not preserving existing config, so non-OpenAI embedding providers can be configured safely.

## [2.1.6] - 2026-05-01

### Fixed
- Fixed `install-memory-system.sh` full dry-run for non-interactive execution: defaults now follow the selected prompt default instead of enabling every optional feature.
- Masked existing API-key defaults in dry-run output.
- Updated installer config patching for modern OpenClaw 2026.4.x layouts: keep `plugins.slots.memory = "memory-core"`, preserve `hooks.allowConversationAccess`, and do not disable `memory-core`.
- Fixed agent discovery for `agents.list[]` array configs instead of reading only top-level `agents` keys (`defaults`, `list`).
- Updated optional ActiveMemory install config away from deprecated `modelFallbackPolicy`.

## [2.1.5] - 2026-05-01

### Changed
- **OpenClaw 2026.4.29 compatibility**: `update-openclaw.sh` now treats `~/.openclaw/plugins/installs.json` as the primary plugin install-record store and only falls back to legacy `openclaw.json.plugins.installs`.
- **Message policy guards**: Updated 4.29 checks to write schema-valid values: `messages.visibleReplies = "message_tool"` and `messages.queue.mode = "steer"`.
- **Patch runner hardening**: Retired or missing OpenClaw dist anchors no longer block Gateway startup when the relevant upstream code has moved or been removed.
- **Runtime dependency repair**: Documented and validated the 2026.4.29 bundled-channel dependency fix using the version-scoped runtime-deps cache.
- **Memory health checks**: Plugin verification now accepts `openclaw plugins list` and Gateway journal evidence, avoiding false failures when fast `openclaw status` omits custom plugin registration lines.

### Fixed
- Fixed Python `except:` checks in `update-openclaw.sh` that could catch `SystemExit` and produce false `stream error` warnings.
- Fixed `set -o pipefail`/`grep -q` false negatives in large journal scans by using here-strings for Memory health detection.
- Bumped `memory-lancedb-namespaced` manifest/package version to keep README, CHANGELOG and plugin metadata aligned.

## [2.1.4] - 2026-04-28

### Fixed
- **Active-Memory Fast-Path**: Fixed config mismatch (use `params.api.config` instead of `params.config`)
- **Active-Memory Fast-Path**: Removed `ensureProviderInitialized()` to avoid model filter mismatch (1536→3072 dims)
- **Kimi-for-Coding**: Temperature now always 1.0 (not just when thinking enabled)
- **SQLite Embeddings**: Migrated main/bernhardine/heisenberg from text-embedding-3-small (1536) to text-embedding-3-large (3072)

### Changed
- **OpenClaw**: Updated to 4.26 (fixes Telegram polling bug #73115 + memory-core improvements)
- **Fast-Path Patch**: Updated for 4.26 module name changes (`memory-BRQCcYLp.js`)

### Performance
- Fast-path search now uses FTS-only mode (no provider init) → sub-second response
- Eliminated 54-second blocking on warmSession/embedding batch

# Changelog

## [2.1.2] — 2026-04-26

### Yield-sicherer Memory-Flush und Session-History Cleanup

- Neues Script `scripts/cleanup-session-history.mjs` ergänzt.
- Zweck: physische Bereinigung bereits aufgeblähter OpenClaw-Session-Transcripts
  nach append-only Branch-Rewrites.
- Verhalten: Dry-Run per Default, `--write` für Rewrite, Backups unter
  `.history-cleanup-backups/`, aktive Branch per `parentId`, führende
  Session-Metadaten bleiben erhalten.
- SOUL-/Doku-Regel ergänzt: Memory- und Learning-Toolcalls müssen vor `sessions_yield` abgeschlossen sein.
- Beispiel:
  `node scripts/cleanup-session-history.mjs --agent main --agent bernhardine --agent heisenberg --write`

## [2.1.1] — 2026-04-25

### v2.1.0-Hardening — 5 Polish-Fixes gebündelt

Nach v2.1.0-Release fielen fünf Lücken auf, die alle als ein Release adressiert werden:

#### 1. Header-Kommentar generisch (statt versions-spezifisch)

`index.js` Header sagte "v1.8.x" — verwirrend nach v2.1.0. Jetzt:
> "Version: siehe openclaw.plugin.json (Single Source of Truth, gepflegt via scripts/bump-version.sh)."

#### 2. Hard-Fail bei Provider-Modell ohne `dimensions`

Bisher: Plugin nutzte stillschweigend default 1536 dim für unbekannte Modelle. Bei OpenRouter-Modellen (z.B. `nvidia/llama-nemotron-...:free` mit 2048 dim) → Vektoren wurden in 1536-dim DB-Schema geschrieben → silent corruption.

**Fix:** Plugin wirft beim Register mit klarer Fehlermeldung:
```
memory-lancedb-namespaced: Modell 'baai/bge-m3' (Provider: https://openrouter.ai/api/v1)
hat keine konfigurierten 'dimensions'. Setze plugins.entries.memory-lancedb-namespaced.config.embedding.dimensions
explizit (z.B. 1024 für BAAI/Mistral, 2048 für NVIDIA-Nemotron, 3072 für Gemini).
Test-Call: curl ... → data[0].embedding.length lesen.
```

OpenAI-Modelle bleiben tolerant (Default-Map fallback mit Warnung).

#### 3. Runtime-Dim-Validation in `Embeddings.embed()`

Neue Methode `_validateDim(vec)` — wirft Fehler wenn API einen Vektor mit unerwartetes Dim liefert (z.B. weil Provider plötzlich anderes Modell zurückgibt). Schützt vor silent Korruption mitten im Live-Betrieb.

#### 4. `memory-doctor provider-check` — neuer Subcommand

Validiert das gesamte Embedding-Setup:
- API-Endpoint erreichbar?
- Modell antwortet, wie viele dims?
- Config-Dim matcht API-Dim?
- ALLE bestehenden Agent-DBs haben gleiche Dim wie API?

Output:
```
=== Embedding-Provider-Check ===
Endpoint:      https://api.openai.com/v1 (default)
Modell:        text-embedding-3-large
Config-Dim:    (nicht gesetzt — wird aus EMBEDDING_DIMENSIONS-Map default)
API-Key:       sk-proj-[REDACTED]

[1/3] Test-Embedding-Call …  ✓ 3072-dim Vektoren
[2/3] Config-Dim Konsistenz … ⚠ Config-Dim leer, ergänze 'dimensions: 3072'
[3/3] Bestehende Agent-DBs vs. API-Dim 3072 …
     ✓ bernhardine: 3072 = 3072
     ✓ main: 3072 = 3072
     … (14 Agenten)
✓ Provider-Check bestanden
```

#### 5. Installer Pre-Flight-Check vor Provider-Wechsel

Vor dem Schreiben der neuen Plugin-Config liest der Installer alle bestehenden LanceDB-Schemas und vergleicht sie mit der neuen Dimension. Bei Mismatch:

```
⚠ 14 Agent-DB(s) haben andere Dimension als die neue Config.
   Speichern wird brechen, Recall wird brechen.

   Optionen:
   1. Wechsel rückgängig (auf altes Modell zurück)
   2. Fresh DBs: rm -r .../lancedb-namespaced/<agent>/  → Dreaming/Migrate füllen sie wieder
```

User muss explizit bestätigen, sonst Abbruch.

#### Bonus: README für v2.1+ aktualisiert

- OpenRouter-Sektion mit Verweis auf 20+ Modelle
- Provider-Wechsel-Warnung mit den 3 Optionen
- `recall-eval.json` → `recall-eval.sample.json`
- `provider-check` in der Subcommand-Liste
- `bump-version.sh` als Helper aufgeführt
- Beide Sprachen (DE + EN) konsistent

## [2.1.0] — 2026-04-25

### OpenRouter-Support für Embeddings — 20+ Modelle als Alternative zu OpenAI

Bisher waren Embeddings effektiv an OpenAI gebunden (text-embedding-3-large/
small, ada-002). v2.1 öffnet das System für [OpenRouter](https://openrouter.ai)
— eine Aggregator-API mit 20+ Embedding-Modellen verschiedener Anbieter
(BAAI/BGE, Mistral, Google Gemini, NVIDIA, Qwen, Perplexity, …) inkl. einem
**kostenlosen Modell** (NVIDIA Llama Nemotron Embed VL 1B V2, 2048-dim).

#### Was ist neu

**Installer-Flow (`install-memory-system.sh`):**

```
┌─────────────────────────────────────────────────────────────┐
│ Embedding-Provider-Auswahl:                                  │
│  → OpenAI (Standard, default n) — text-embedding-3-large/... │
│  → OpenRouter (v2.1+, opt-in) — 20+ Modelle (BAAI, Mistral,│
│                                  Gemini, Qwen, NVIDIA-free…) │
│ Hinweis: Reranker (Cohere) wird unten separat gefragt.       │
│                                                              │
│ OpenRouter statt OpenAI für Embeddings nutzen? [y/n, n]: y   │
│   → OpenRouter API Key: sk-or-v1-...                         │
│   → Lade verfügbare Embedding-Modelle…                       │
│      1. google/gemini-embedding-2-preview    8192 ctx  …     │
│      2. baai/bge-m3                          8192 ctx  …     │
│      3. nvidia/llama-nemotron-...-:free    131072 ctx  …     │
│      ... (20+ Modelle gelistet)                              │
│   → OpenRouter-Modell-ID: baai/bge-m3                        │
│   → Test-Embedding-Call → ermittle Vektor-Dimension…         │
│      ✓ Modell 'baai/bge-m3' liefert 1024-dim Vektoren.       │
└─────────────────────────────────────────────────────────────┘
```

**Wesentliche Punkte:**

- **Auto-Discovery:** Live-Query an `https://openrouter.ai/api/v1/embeddings/models`
  zeigt aktuelle Modelle mit Context-Window und Preis pro Token.
- **Dimension auto-detect:** Statt eine Hardcoded-Map zu pflegen wird ein
  Test-Embedding-Call gemacht und die echte Dimension aus der Response
  gelesen (foolproof — funktioniert mit jedem zukünftigen Modell).
- **Fallback-Hierarchie:** OR=nein → OpenAI; Cohere=leer → kein Reranker.
  Komplett orthogonal: jeder Block ist einzeln entscheidbar.

| Wahl | Embeddings | Reranker | Recall-Pipeline |
|---|---|---|---|
| OR=n, Cohere=leer | OpenAI | – | Vector-only |
| OR=n, Cohere=ja | OpenAI | Cohere | Full Pipeline |
| OR=ja, Cohere=leer | OpenRouter | – | Vector-only |
| OR=ja, Cohere=ja | OpenRouter | Cohere | Full Pipeline |

**Kein OpenRouter-Reranker:** OpenRouter listet aktuell keinen dedizierten
Rerank-Endpoint. Cohere bleibt der einzige Reranker (was für die meisten
Setups OK ist — Cohere hat freie Tier).

#### Plugin-Code-Änderungen

**`Embeddings._buildEmbeddingRequest()`** — neue private Helper-Methode:

```js
_buildEmbeddingRequest(model, text) {
  const isOpenAi = !model.includes("/") || model.startsWith("openai/")
                || model.startsWith("text-embedding-");
  const req = { model, input: text, encoding_format: "float" };
  if (isOpenAi && this.dimensions) req.dimensions = this.dimensions;
  return req;
}
```

Zwei wichtige Anpassungen:
1. **`encoding_format: "float"` immer explizit** — OpenAI-SDK setzt sonst
   default `"base64"`, was viele OpenRouter-Provider (v.a. NVIDIA) mit 400
   ablehnen ("Nvidia embeddings do not support base64 encoding_format").
2. **`dimensions` nur für OpenAI-Modelle** — andere Provider (BAAI, Mistral,
   …) werfen sonst "unknown parameter". Heuristisch erkannt via Modell-ID-
   Prefix.

Beide Anpassungen auch in **allen 4 Cron-Scripts** angewendet
(auto-capture-lancedb, embed-promoted-memories, migrate-memory-md, memory-doctor).

#### `memory-doctor eval` lernt baseUrl

Eval nutzt jetzt die `embedding.baseUrl` aus `openclaw.json` — funktioniert
also automatisch mit OpenRouter, Azure-OpenAI, LiteLLM, oder jedem anderen
OpenAI-kompatiblen Endpunkt. Im Output: `(Eval nutzt baseUrl: https://...)`.

#### Migration

**Bestehende Installationen:** keine Aktion nötig. Plugin-Verhalten bei
OpenAI-Embeddings unverändert. `encoding_format: "float"` ist von OpenAI
vollständig unterstützt — keine Verhaltensänderung dort.

**Wechsel zwischen Providern:** WICHTIG — Embedding-Dimensionen sind in
LanceDB fest. Wechsel von OpenAI (3072) zu BAAI (1024) erfordert eine
**fresh DB**, sonst Dimension-Mismatch (sauber erkannt, no silent failure).

```bash
# Snapshot vor Provider-Wechsel:
./scripts/install-memory-system.sh --rollback /pfad/zu/.openclaw  # falls Plan B
# oder eine neue baseDbPath setzen (z.B. lancedb-namespaced-openrouter)
```

#### Verifikation

- ✓ OpenRouter-API erreichbar (curl ohne Auth listet 355 Modelle, 20+ Embed)
- ✓ NVIDIA-free liefert 2048-dim Vektoren mit gültigem API-Key
- ✓ Plugin's Embeddings-Klasse mit `baseURL: "https://openrouter.ai/api/v1"` läuft
- ✓ Doctor erkennt baseUrl und nutzt sie im eval
- ✓ 81/81 Tests grün (existierende Test-Suite gegen Refactor abgesichert)
- ✓ Gateway-Restart-Test sauber

## [1.9.0] — 2026-04-25

### Refactor: Shared `lib/` Module + Pipeline-Eval — Konsolidierung der v1.8.x-Duplikation

Über v1.8.0–v1.8.6 hatte sich Code-Duplikation aufgebaut: `distanceToScore`
in 5 Dateien, UUID-Validierung mehrfach, `safeTimestamp` als Inline-Kopie,
`categorizeMemory` doppelt, ganze Recall-Pipeline als 70-Zeilen-Blob in zwei
Tools (`memory_recall` + `before_agent_start`-Hook). Plus: kein automatisches
Test-Setup für die fragilen Bits.

**v1.9.0 räumt das auf, ohne Verhalten zu ändern** (außer eval-pipeline =
neues Feature).

#### Neue Struktur

```
extensions/memory-lancedb-namespaced/
├── index.js              ← Plugin-Definition (von 1454 → 1376 Zeilen)
├── lib/
│   ├── score.js          ← distanceToScore — eine Quelle für Plugin + 4 Cron-Scripts
│   ├── sql-safety.js     ← safeUuid, safeUuidList, safeTimestamp, appendDestructiveOpLog
│   ├── text-utils.js     ← tokenize, jaccardSimilarity, cosineSimilarityVec, generateSummary
│   ├── categorize.js     ← MEMORY_CATEGORIES/ORIGINS/SCOPES + categorizeMemory
│   ├── frontmatter.js    ← stripFrontmatter, buildFrontmatter, withFrontmatter, parseSourceMemoryIds
│   └── recall-pipeline.js ← applyImportanceBoost, dedupResults, parseKnowledgeMd, getKnowledgeChunks, searchCanonical, runRecallPipeline
└── __tests__/
    ├── score.test.js          (6 tests)
    ├── sql-safety.test.js     (19 tests)
    ├── text-utils.test.js     (16 tests)
    ├── categorize.test.js     (13 tests)
    ├── frontmatter.test.js    (11 tests)
    └── recall-pipeline.test.js (16 tests)
```

**81 Tests, 81 grün** via `node --test __tests__/*.test.js` — keine externe
Test-Library-Dependency. Tests fokussiert auf die historisch fragilen
Stellen (Schema-Migration, Frontmatter, Distance-Score, Dedup, SQL-Safety).

#### `runRecallPipeline()` — der Pipeline-Orchestrator

Alle Recall-Komponenten aus dem 70-Zeilen-Inline-Blob im `before_agent_start`-
Hook und im `memory_recall`-Tool sind jetzt eine einzige Funktion in
`lib/recall-pipeline.js`:

```js
const { canonical, memories, queryVector } = await runRecallPipeline({
  query, dbTable, embeddings, workspaceDir,
  topN, recallMinScore, importanceBoost, dedupEnabled, dedupJaccard,
  canonicalEnabled, canonicalMinScore, canonicalMaxItems,
  reranker, rerankCandidates, summaryMaxWords, logger,
});
```

Plugin nutzt sie an 2 Stellen, Doctor nutzt sie für eval-pipeline. Eine
Pipeline, drei Konsumenten, garantiert identisches Verhalten.

#### `memory-doctor eval` bekommt `raw|pipeline`-Modi

Das war einer der Hauptgründe für den Refactor:

```bash
node memory-doctor.mjs eval bernhardine raw       # nur LanceDB-Vektorsuche (Backward-kompatibel)
node memory-doctor.mjs eval bernhardine pipeline  # volle Live-Pipeline mit Canonical+Boost+Rerank+Dedup
```

**Sofortiger Mehrwert messbar:** Bernhardines Eval-Pass-Rate stieg von
**75 % (raw) auf 100 % (pipeline)**. Der Beispiel-Gesundheits-Test (`monitoring-system`)
fand das Wort nur über den Canonical-Hit aus KNOWLEDGE.md "Person B — Gesundheit".
Rohe Vektorsuche allein hatte es nicht in den Top-10.

#### Bug-Fix nebenbei: `dedupResults` mit `maxOut=0`

Die ausgelagerten Tests fanden sofort einen echten Bug: `dedupResults(items, 0, ...)`
gab 1 Item zurück statt 0, weil der Push vor dem Cap-Check passierte. Fix:
Early-Return bei `maxOut <= 0`. Hatte praktisch nie zugeschlagen (canonical
fast nie 5+ items), aber jetzt korrekt.

#### Bug-Fix nebenbei: `categorizeMemory` Reihenfolge

Test "Wir nehmen Redis als Cache" → "fact" statt "decision" weil die
Decision-Heuristik nur "nehmen wir" (mit umgekehrter Wortreihenfolge)
kannte. Erweitert um "wir nehmen", "wir wählen", "wir entscheiden".

#### Cron-Scripts importieren auch aus lib/

| Script | Importiert |
|---|---|
| `auto-capture-lancedb.mjs` | `distanceToScore`, `categorizeMemory` |
| `embed-promoted-memories.mjs` | `distanceToScore` |
| `migrate-memory-md-to-lancedb.mjs` | `distanceToScore` |
| `memory-gc.mjs` | `safeTimestamp` |
| `memory-doctor.mjs` | `runRecallPipeline` (für eval pipeline-Mode) |

Inline-Kopien sind alle entfernt. Eine Quelle der Wahrheit pro Funktion.

#### Migration

Keine Daten-Migration. Plugin-Loader-Verhalten ändert sich nicht — Plugin
ist weiterhin "single-entry" via `index.js` (das jetzt aus `lib/` importiert).
Funktional identisch, nur intern aufgeräumt.

#### Verifikation

- 81/81 Tests grün
- Gateway-Restart läuft sauber
- Live-Recall-Test (Bernhardine "Wer ist Person A?") liefert "+ 2 canonical" wie vor v1.9.0
- `memory-doctor eval bernhardine pipeline` zeigt 100 % Pass-Rate (vs 75 % raw)

## [1.8.6] — 2026-04-25

### 🔴 Security: SQL-Hardening — Defense-in-Depth an allen 4 Sites

LanceDB akzeptiert keine prepared statements (`.where(predicate)` nimmt nur
Strings). Bisherige UUID-Validierung war an 4 Stellen verstreut, jede mit
eigenem Regex und unterschiedlicher Fehlerbehandlung. Ein Audit-Bericht
flaggte besonders das `id IN (...)` in `knowledge_update` als verwundbar
gegen Injection-Versuche bei zukünftigen Code-Änderungen.

**Drei zentrale Helper** im Plugin-Header definiert:

```js
function safeUuid(id) → string | throws
function safeUuidList(ids, maxItems = 100) → string | null
function safeTimestamp(n) → number | throws
```

Alle wirft auf invalid input (statt silent skip). Mit anchored Regex
(`^...$`), expliziter Length-Check (36 Zeichen für UUID), Type-Check und
Range-Check für Timestamps (`0 < n < 1e15`).

**4 Sites refactored:**

| Site | Vorher | Nachher |
|---|---|---|
| `MemoryDB.delete(id)` | inline UUID-Regex | `safeUuid(id)` |
| `MemoryDB.purgeExpired()` | inline `Number.isFinite` | `safeTimestamp(Date.now())` |
| `knowledge_update` IN-Clause | inline filter, nur 16 Stellen escape | `safeUuidList(ids, 100)` mit Cap |
| `memory-gc.mjs` | inline `Number.isFinite` | Inline-Kopie von `safeTimestamp` |

**Audit-Log für destruktive Operationen** — neue Datei
`{workspaceDir}/.adaptive-learning/destructive-ops.jsonl`. Jeder
`memory_forget`-Call und jede Merge-Replacement (im memory_store) loggt:

```json
{"event":"memory.deleted","source":"memory_forget|memory_store_merge",
 "agentId":"main","memoryId":"uuid","via":"id|query|merge",
 "timestamp":"2026-04-25T..."}
```

Macht versehentliche oder maliziöse Memory-Löschungen nachvollziehbar.

**Bonus: leere catch in Schema-Migration**

Der `catch (_e) {}`-Block bei der LanceDB-Schema-Migration (auto-runs auf
jeder DB beim ersten Init) schluckte alle Errors silent — Schema-Drifts
wären unsichtbar gewesen. Jetzt: `console.warn` mit DB-Pfad und Error-
Message. Bricht weiterhin nicht (graceful degradation für ältere LanceDB-
Versionen ohne `addColumns`-Support).

**16/16 Helper-Tests grün** (inline-Tests für alle Helper-Edge-Cases —
SQL-Injection-Versuch, NaN, Infinity, leere Listen, Cap, etc.).

**Sync-Hinweis:** `safeTimestamp` musste in `memory-gc.mjs` inline kopiert
werden (Standalone-Script, kein Plugin-Import). Wird in v1.9.0 in shared
module wandern (gleiches Argument wie für distance→score in v1.8.5).

### History-Rewrite — Commit a611ea7 sanitisiert

Komplementär zu v1.8.4 (HEAD-Sanitization von `recall-eval.json`) wurde
die Git-History via `git filter-repo` gescrubbt:

1. `--invert-paths --path scripts/recall-eval.json` — Datei aus aller
   History entfernt
2. `--replace-text` — sensitive Strings (Chat-IDs, Key-Suffix) durch
   `[REDACTED_*]`-Placeholder ersetzt (auch in CHANGELOG-Erwähnungen)
3. `--message-callback` — gleiches in Commit-Messages (v1.8.4-Commit
   beschrieb den Leak und enthielt selbst die Strings)
4. Force-push `main` + alle Tags

**Verifikation:** Fresh clone, `git log --all -p | grep -E "REDACTED_CHAT_ID|REDACTED_KEY_SUFFIX"` → **0 matches**. Alle Tags v1.0.0..v1.8.5 vorhanden, mit neuen Commit-Hashes.

**Bekannte Akzeptanz:** Bestehende Forks und Clones haben weiterhin die
ursprünglichen Daten. `git pull` für Bestandsclones bricht — Anwender
brauchen `git fetch --all --tags --force && git reset --hard origin/main`.

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
| Person A Telegram Chat-ID `[REDACTED_CHAT_ID]` | hoch — direkt missbrauchbar für Spam |
| Person B Telegram Chat-ID `[REDACTED_CHAT_ID]` | hoch — selbiges |
| Bernd Kimi-Key-Suffix `[REDACTED_KEY_SUFFIX]` | mittel — letzte 5 Zeichen |
| `[REDACTED_BOT_HANDLE]` Bot-Handle | niedrig — öffentlich |
| Personenbezogene Namen | mittel |

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

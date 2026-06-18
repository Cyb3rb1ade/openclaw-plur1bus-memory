# Provider Wizard & Plugin-eigene Credential-Auflösung

**Datum:** 2026-06-18 (rev 2)
**Status:** Design approved (rev 2), implementation pending  
**Scope:** PLUR1BUS memory-lancedb-namespaced Plugin

---

## Problem

`auto-capture-lancedb.mjs` liest `OPENAI_API_KEY` hart aus `process.env`. Wenn das Script
per Cron ohne `export` / `set -a` aufgerufen wird, sieht Node den Key nicht. Das Plugin
kann keinen System-Crontab manipulieren (keine Root-Rechte vorausgesetzt). Die Lösung muss
plugin-eigenständig sein.

Gleichzeitig fehlt dem Install-Wizard eine echte Auswahl für Embedding- und Reranker-Provider
inkl. lokalem Fallback.

---

## Architektur-Übersicht

### Config-Ziel in `openclaw.json`

Credential-Schema: `apiKeyEnv` (bevorzugt, Key bleibt in .env) oder `apiKey` (Literal, nur
nach expliziter Warnung). Beide Felder werden von `normalizeEmbeddingConfig` und
`normalizeRerankerConfig` unterstützt.

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "embedding": {
          "provider": "openai",
          "apiKeyEnv": "OPENAI_API_KEY",
          "model": "text-embedding-3-large",
          "dimensions": 3072
        },
        "reranker": {
          "provider": "cohere",
          "apiKeyEnv": "COHERE_API_KEY",
          "model": "rerank-v3.5",
          "candidates": 20,
          "timeoutMs": 5000,
          "fallbackOnError": true,
          "fallbackProvider": "disabled"
        }
      }
    }
  }
}
```

### Neue / geänderte Dateien

| Datei | Art | Zweck |
|-------|-----|-------|
| `lib/providers/factory.js` | NEU | Einheitliche Provider-Factory für index.js + auto-capture |
| `lib/providers/dimension-guard.js` | NEU | Liest bestehende LanceDB-Vektordimension als Status-Objekt |
| `lib/providers/config-normalize.js` | ÄNDERN | `apiKeyEnv`-Unterstützung in beiden Normalize-Funktionen |
| `lib/providers/dimensions.js` | ÄNDERN | `DEFAULT_LOCAL_RERANKER_MODEL` → `BAAI/bge-reranker-v2-m3` |
| `lib/i18n-dictionary.js` | ÄNDERN | Neue `setup.reranker.*`-Keys (de + en) |
| `scripts/install-memory-system.sh` | ÄNDERN | Wizard-Erweiterung Embedding + Reranker |
| `.openclaw/scripts/auto-capture-lancedb.mjs` | ÄNDERN | Liest Plugin-Config, importiert factory.js aus installierter Extension |
| `tests/provider-wizard.test.js` | NEU | Wizard-UX + Config-Output-Tests |
| `tests/dimension-guard.test.js` | NEU | Dimension-Guard Status-Objekt-Tests |

---

## Abschnitt 1: Gemeinsame Provider-Factory

### `lib/providers/factory.js`

```js
import { normalizeEmbeddingConfig, normalizeRerankerConfig } from "./config-normalize.js";
import { OpenAIEmbeddingProvider } from "./embedding-openai.js";
import { LocalTransformersEmbeddingProvider } from "./embedding-local-transformers.js";
import { CohereRerankerProvider } from "./reranker-cohere.js";
import { LocalTransformersRerankerProvider } from "./reranker-local-transformers.js";
import { ChainedRerankerProvider } from "./reranker-chained.js";
import { resolveApiKey } from "./env.js";

export function createEmbeddingProvider(normalizedCfg) {
  if (normalizedCfg.provider === "local-transformers") {
    return new LocalTransformersEmbeddingProvider({
      ...normalizedCfg.local,
      dimensions: normalizedCfg.dimensions,
    });
  }
  const apiKey = resolveApiKey(normalizedCfg);
  return new OpenAIEmbeddingProvider({ ...normalizedCfg, apiKey });
}

export function createRerankerProvider(normalizedCfg, logger) {
  if (!normalizedCfg || normalizedCfg.provider === "disabled" || !normalizedCfg.enabled) {
    return null;
  }
  if (normalizedCfg.provider === "cohere") {
    const primary = new CohereRerankerProvider(normalizedCfg);
    // Fallback nur wenn User explizit zugestimmt hat (fallbackProvider="local-transformers")
    const fallbackProvider = normalizedCfg.fallbackProvider ?? "disabled";
    if (fallbackProvider === "local-transformers") {
      const fallback = new LocalTransformersRerankerProvider({
        model: normalizedCfg.fallbackModel || "BAAI/bge-reranker-v2-m3",
      });
      return new ChainedRerankerProvider(primary, fallback, logger);
    }
    // Default: kein lokaler Fallback — graceful degradation ohne Reranker
    return new ChainedRerankerProvider(primary, null, logger);
  }
  if (normalizedCfg.provider === "local-transformers") {
    return new LocalTransformersRerankerProvider(normalizedCfg.local || normalizedCfg);
  }
  return null;
}
```

`index.js` und `auto-capture-lancedb.mjs` nutzen ausschließlich diese Factory.
Keine doppelte Provider-Logik. `resolveApiKey(cfg)` löst sowohl `cfg.apiKeyEnv` (bevorzugt)
als auch `cfg.apiKey` (Literal) auf.

### Credential-Auflösung (`lib/providers/env.js` — Erweiterung)

```js
// Bevorzugt: apiKeyEnv → aus process.env lesen
// Fallback: apiKey → Literal oder ${VAR}-Syntax
export function resolveApiKey(cfg) {
  if (cfg.apiKeyEnv) {
    const val = process.env[cfg.apiKeyEnv];
    if (!val) throw new Error(`Env var ${cfg.apiKeyEnv} not set`);
    return val;
  }
  if (cfg.apiKey) return resolveOptionalEnvVars(cfg.apiKey);
  return resolveOptionalEnvVars("${OPENAI_API_KEY}");
}
```

`normalizeEmbeddingConfig` und `normalizeRerankerConfig` übernehmen `apiKeyEnv`
unverändert durch und resolvieren es nicht — Auflösung passiert nur zur Laufzeit in
`createEmbeddingProvider` / `createRerankerProvider`.

---

## Abschnitt 2: Dimension-Guard

### `lib/providers/dimension-guard.js`

Gibt ein Status-Objekt zurück — niemals stillen `null`. Fehler beim Lesen sind `unknown`,
nicht `no-table`. Ein `unknown`-Status blockiert Provider-Wechsel.

```js
export async function readExistingTableDimension(dbPath) {
  let lancedb;
  try {
    lancedb = await import("@lancedb/lancedb");
  } catch (e) {
    return { status: "unknown", error: `LanceDB import failed: ${e.message}` };
  }
  try {
    const db = await lancedb.connect(dbPath);
    const tables = await db.tableNames();
    if (!tables.includes("memories")) {
      return { status: "no-table" };
    }
    const table = await db.openTable("memories");
    const schema = await table.schema();
    const vectorField = schema.fields.find(f => f.name === "vector");
    const dim = vectorField?.type?.listSize;
    if (!dim) {
      return { status: "unknown", error: "vector field missing or no listSize" };
    }
    return { status: "ok", dimension: dim };
  } catch (e) {
    return { status: "unknown", error: e.message };
  }
}

// Aufruf-Ergebnis für Wizard / Plugin-Init:
// { status: "no-table" }    → sicher, kein Konflikt
// { status: "ok", dimension: 3072 } → prüfen ob dim === targetDim
// { status: "unknown", error: "..." } → Provider-Wechsel BLOCKIERT
```

**Invariante:** Ein Provider-Wechsel ist nur erlaubt wenn:
- `status === "no-table"` (keine bestehende DB), ODER
- `status === "ok"` und `dimension === targetDimension`, ODER
- User hat explizit Option B (neuer Namespace) oder Option C (Reindex mit Rollback) gewählt

Bei `status === "unknown"` wird der Wizard mit einem Fehler abgebrochen:
> "Konnte bestehende LanceDB-Tabelle nicht prüfen: \<error>. Bitte manuell sichern bevor du den Provider wechselst."

---

## Abschnitt 3: Dimension-Mismatch-Flow

Bei Mismatch (`status=ok`, `existingDim != targetDim`) bietet der Wizard drei Optionen:

### Option A — Bestehenden Provider behalten
```
→ keine Config-Änderung, kein Datenverlust
→ Wizard bricht die Provider-Wahl ab, bestehende Config bleibt
```

### Option B — Neuer Namespace (parallel)

Definitionen:

```
primaryNamespace:        "lancedb"          (aktiver Namespace, wird gelesen + geschrieben)
activeWriteNamespace:    "lancedb-local"    (neuer Namespace für neues Modell)
activeRecallNamespaces:  ["lancedb-local"]  (nach Umschaltung; nur neuer Namespace)
legacyReadOnlyNamespaces: ["lancedb"]       (alter Namespace, nur Lesezugriff, Rollback)
```

Ablauf:
1. Wizard legt `lancedb-local/` neben `lancedb/` an
2. Konfiguriert `activeWriteNamespace: "lancedb-local"` — neue Memories gehen in 384-dim DB
3. `legacyReadOnlyNamespaces: ["lancedb"]` — Recall liest zusätzlich die alte 3072-dim DB
4. Cross-Namespace-Recall: Aktiviert (`crossNamespaceRecall: true`). Scores werden normalisiert
   bevor Merge — jeder Namespace sucht unabhängig, dann Union, dann Reranker
5. Rollback: `activeWriteNamespace` auf `"lancedb"` zurücksetzen, `legacyReadOnlyNamespaces`
   leeren — alte DB war nie verändert

Config-Block den der Wizard schreibt:
```json
{
  "namespaces": {
    "primaryNamespace": "lancedb",
    "activeWriteNamespace": "lancedb-local",
    "activeRecallNamespaces": ["lancedb-local"],
    "legacyReadOnlyNamespaces": ["lancedb"],
    "crossNamespaceRecall": true
  }
}
```

### Option C — Kontrollierter Reindex (mit Rollback-Pflicht)

**Niemals: alte Vektoren zuerst löschen.** Sicherer Ablauf:

1. **Snapshot** — `cp -a lancedb/ lancedb.backup-$(date +%Y%m%d%H%M%S)/`
2. **Neuer Namespace** — `lancedb-reindex/` mit Zieldimensionen anlegen
3. **Alle Memories neu einbetten** — Quelltext aus `lancedb/` lesen, in `lancedb-reindex/`
   schreiben; Original unberührt
4. **Validierung** (muss bestehen, sonst Abbruch):
   - row count: `new >= original * 0.99` (max. 1% Verlust toleriert)
   - schema: Dimension korrekt
   - sample recall: 5 Zufalls-Queries, mindestens 1 Ergebnis pro Query
   - integrity: kein corrupt entry
5. **Atomarer Config-Switch** — `primaryNamespace` auf `"lancedb-reindex"`, `legacyReadOnlyNamespaces`
   auf `["lancedb"]` (Rollback-DB)
6. **Alte DB bleibt erhalten** — kein Löschen im Wizard. Manuelle Bereinigung durch User später.

Wizard-Text vor Beginn:
> "Option C erstellt eine neue DB mit dem neuen Modell und schaltet nur nach erfolgreicher
> Validierung um. Die alte DB bleibt als Rollback erhalten. Bei ≥10.000 Einträgen dauert
> dies mehrere Minuten. Fortfahren? [y/n]"

---

## Abschnitt 4: Wizard — Embedding-Provider

### Schritt 1/2: Embedding

```
──────────────────────────────────────────────────────────
Schritt 1/2: Embedding-Provider

OpenAI API Key vorhanden? (für text-embedding-3-large, 3072 dims)

  [y] Key eingeben
      Speichern als:
        [1] Env-Var-Referenz OPENAI_API_KEY (bevorzugt — Key bleibt in .env)
        [2] Literal in openclaw.json (Key in Config-Datei sichtbar — weniger sicher)
      → provider="openai", apiKeyEnv="OPENAI_API_KEY", dimensions=3072

  [n] Lokales Modell nutzen
      intfloat/multilingual-e5-small
      CPU-tauglich, gut für Deutsch/Mehrsprachig, 384 dims
      Erster Start: Download ~135 MB, dann gecacht.
      → provider="local-transformers", dimensions=384

──────────────────────────────────────────────────────────
```

Nach Eingabe: Dimension-Guard-Check. Bei `unknown` → Abbruch mit Fehlermeldung.
Bei `mismatch` → Optionen A/B/C präsentieren (Abschnitt 3).

---

## Abschnitt 5: Wizard — Reranker-Provider

Der Reranker verbessert Recall-Qualität durch Neuordnung der Kandidaten.
Er wird bewusst gewählt. Kein Auto-Fallback auf lokale Modelle ohne explizite Zustimmung.

### Schritt 2/2: Reranker

```
──────────────────────────────────────────────────────────
Schritt 2/2: Reranker

Reranker verbessert die Recall-Qualität, kostet aber zusätzliche
Laufzeit. Welche Reranker-Option möchtest du nutzen?

[1] Cohere rerank-v3.5  (kostenpflichtig, empfohlen für beste Qualität)
    - benötigt COHERE_API_KEY
    - keine lokale CPU-/RAM-Last
    - Bei Fehler: Recall läuft ohne Reranker weiter (kein lokaler Fallback)

[2] Lokal: BAAI/bge-reranker-v2-m3  (mehrsprachig, kein API-Key)
    - empfohlen für Deutsch/Mehrsprachig ohne externen Dienst
    - lazy load beim ersten Recall (~570 MB, CPU/RAM-Last)
    - kostet CPU/RAM pro Recall-Anfrage

[3] Kein Reranker  (schnellste und stabilste Basis)
    - Recall bleibt voll funktional
    - keine Zusatzkosten, keine lokale Modelllast

[4] Advanced-Optionen
    - Alibaba-NLP/gte-reranker-modernbert-base (Englisch/Long-Context/Code)
    - jinaai/jina-reranker-v2-base-multilingual (multilingual/API, Lizenz prüfen)
    - mixedbread-ai/mxbai-rerank-base-v2 (starkes Multilingual/Code-Profil)

──────────────────────────────────────────────────────────
```

### Optionaler lokaler Fallback (nur bei Option 1)

Nach Cohere-Wahl, zusätzliche Frage:

```
Bei Cohere-Fehler (Timeout, API-Ausfall):
  [1] Recall ohne Reranker fortsetzen (default — keine CPU-Last)
  [2] Lokalen BGE-Reranker als Fallback laden (BAAI/bge-reranker-v2-m3)
      Hinweis: Lädt ~570 MB beim ersten Fallback-Einsatz.
```

### Config-Output je Wahl

**Option 1 — Cohere, kein lokaler Fallback (default):**
```json
{
  "reranker": {
    "provider": "cohere",
    "apiKeyEnv": "COHERE_API_KEY",
    "model": "rerank-v3.5",
    "candidates": 20,
    "timeoutMs": 5000,
    "fallbackOnError": true,
    "fallbackProvider": "disabled"
  }
}
```

**Option 1 — Cohere, mit lokalem Fallback (explizit gewählt):**
```json
{
  "reranker": {
    "provider": "cohere",
    "apiKeyEnv": "COHERE_API_KEY",
    "model": "rerank-v3.5",
    "candidates": 20,
    "timeoutMs": 5000,
    "fallbackOnError": true,
    "fallbackProvider": "local-transformers",
    "fallbackModel": "BAAI/bge-reranker-v2-m3"
  }
}
```

**Option 2 — Lokal BGE:**
```json
{
  "reranker": {
    "provider": "local-transformers",
    "model": "BAAI/bge-reranker-v2-m3",
    "candidates": 20,
    "timeoutMs": 5000,
    "fallbackOnError": true,
    "local": {
      "model": "BAAI/bge-reranker-v2-m3",
      "cacheDir": "${OPENCLAW_HOME}/models/plur1bus"
    }
  }
}
```

**Option 3 — Disabled:**
```json
{
  "reranker": {
    "provider": "disabled",
    "enabled": false,
    "candidates": 20
  }
}
```

### Runtime-Regeln (unveränderlich)

- Reranker: lazy load, kein Download beim Wizard
- `fallbackOnError: true` — Reranker-Fehler crasht nie den Recall
- `fallbackProvider: "disabled"` (default) — kein Auto-Laden lokaler Modelle
- `timeoutMs: 5000`, `candidates: 20` defaults
- Reranker erzeugt keine LanceDB-Vektoren → kein Dimension-Guard

---

## Abschnitt 6: `auto-capture-lancedb.mjs` — Umbau

### Import-Pfad (explizit, nicht relativ)

`auto-capture-lancedb.mjs` liegt in `.openclaw/scripts/` — außerhalb des Plugin-Roots.
Es importiert die Provider-Factory aus der **installierten Extension**, nicht aus einem
Repo-Pfad. Import-Auflösung:

```js
const PLUGIN_DIR = process.env.PLUR1BUS_PLUGIN_DIR
  || join(homedir(), ".openclaw", "extensions", "memory-lancedb-namespaced");

const FACTORY_PATH = join(PLUGIN_DIR, "lib/providers/factory.js");
const CONFIG_NORMALIZE_PATH = join(PLUGIN_DIR, "lib/providers/config-normalize.js");

// Dynamischer Import — schlägt fehl mit klarer Meldung wenn Extension nicht installiert
const { createEmbeddingProvider } = await import(FACTORY_PATH).catch(e => {
  throw new Error(
    `[auto-capture] Provider-Factory nicht gefunden unter ${FACTORY_PATH}. ` +
    `Ist memory-lancedb-namespaced installiert? (${e.message})`
  );
});
const { normalizeEmbeddingConfig } = await import(CONFIG_NORMALIZE_PATH);
```

`PLUR1BUS_PLUGIN_DIR` kann in `.openclaw/.env` gesetzt werden — dann wird das automatisch
via `set -a` aufgelöst wenn der User den Cron-Fix gemacht hat, oder hart in der Extension
konfiguriert.

### Vorher → Nachher

```js
// Vorher (Problem):
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) { console.error("OPENAI_API_KEY not set"); process.exit(1); }
const embeddings = createEmbeddings(apiKey, EMBEDDING_MODEL); // eigene Logik

// Nachher (Plugin-Config-getrieben):
const pluginConfig = readPluginConfig(CONFIG_PATH); // openclaw.json lesen
const embCfg = normalizeEmbeddingConfig(pluginConfig?.embedding || {});
const embeddings = createEmbeddingProvider(embCfg);
// Bei local-transformers: kein API-Key nötig → kein .env-Export-Problem
// Bei openai: Key via apiKeyEnv aus process.env (muss gesetzt sein)
if (!embeddings) {
  console.error("[auto-capture] Embedding-Provider konnte nicht initialisiert werden");
  process.exit(1);
}
```

`createEmbeddings()` (eigene Duplikat-Impl.) wird vollständig entfernt.

---

## Abschnitt 7: i18n

### Neue Dictionary-Keys (`lib/i18n-dictionary.js`)

Alle Keys folgen dem Schema `setup.reranker.*` und haben mindestens `en.default`.
Cohere-Help-Text enthält **keine** Aussage über automatischen lokalen Fallback.

```js
"setup.reranker.title": {
  de: { default: "Schritt 2/2: Reranker" },
  en: { default: "Step 2/2: Reranker" },
},
"setup.reranker.description": {
  de: { default: "Reranker verbessert die Recall-Qualität, kostet aber zusätzliche Laufzeit. Welche Option möchtest du nutzen?" },
  en: { default: "A reranker improves recall quality but adds latency. Which option do you want to use?" },
},
"setup.reranker.option.cohere": {
  de: { default: "Cohere rerank-v3.5 (kostenpflichtig, empfohlen für beste Qualität)" },
  en: { default: "Cohere rerank-v3.5 (paid, recommended for best quality)" },
},
"setup.reranker.option.cohere_help": {
  de: { default: "Benötigt COHERE_API_KEY. Keine lokale CPU-/RAM-Last. Bei Fehler: Recall läuft ohne Reranker weiter." },
  en: { default: "Requires COHERE_API_KEY. No local CPU/RAM load. On error: recall continues without reranker." },
},
"setup.reranker.option.local_bge": {
  de: { default: "Lokal: BAAI/bge-reranker-v2-m3 (mehrsprachig, kein API-Key)" },
  en: { default: "Local: BAAI/bge-reranker-v2-m3 (multilingual, no API key)" },
},
"setup.reranker.option.local_bge_help": {
  de: { default: "Empfohlen für Deutsch/Mehrsprachig. Lazy load beim ersten Recall. Kostet CPU/RAM." },
  en: { default: "Recommended for German/multilingual. Lazy loads on first recall. Uses CPU/RAM." },
},
"setup.reranker.option.disabled": {
  de: { default: "Kein Reranker (schnellste und stabilste Basis)" },
  en: { default: "No reranker (fastest and most stable baseline)" },
},
"setup.reranker.option.disabled_help": {
  de: { default: "Recall bleibt voll funktional. Keine Zusatzkosten, keine lokale Modelllast." },
  en: { default: "Recall remains fully functional. No extra cost, no local model load." },
},
"setup.reranker.option.advanced": {
  de: { default: "Advanced-Optionen (weitere lokale Modelle)" },
  en: { default: "Advanced options (additional local models)" },
},
"setup.reranker.option.advanced_help": {
  de: { default: "Alibaba-NLP/gte-reranker-modernbert-base (Englisch/Long-Context/Code), jinaai/jina-reranker-v2-base-multilingual, mixedbread-ai/mxbai-rerank-base-v2" },
  en: { default: "Alibaba-NLP/gte-reranker-modernbert-base (English/long-context/code), jinaai/jina-reranker-v2-base-multilingual, mixedbread-ai/mxbai-rerank-base-v2" },
},
"setup.reranker.cost_paid": {
  de: { default: "kostenpflichtig" },
  en: { default: "paid" },
},
"setup.reranker.needs_api_key": {
  de: { default: "benötigt {{keyName}}" },
  en: { default: "requires {{keyName}}" },
},
"setup.reranker.local_cpu_warning": {
  de: { default: "Hinweis: Lokaler Reranker ist CPU-intensiv. Empfohlen bei ≥8 GB RAM." },
  en: { default: "Note: Local reranker is CPU-intensive. Recommended with ≥8 GB RAM." },
},
"setup.reranker.lazy_load_notice": {
  de: { default: "Modell wird beim ersten Recall geladen (~{{sizeMb}} MB). Kein Download jetzt." },
  en: { default: "Model downloads on first recall (~{{sizeMb}} MB). No download now." },
},
"setup.reranker.selected": {
  de: { default: "✓ Reranker konfiguriert: {{provider}}" },
  en: { default: "✓ Reranker configured: {{provider}}" },
},
"setup.reranker.invalid_choice": {
  de: { default: "Ungültige Auswahl. Bitte 1, 2, 3 oder 4 eingeben." },
  en: { default: "Invalid choice. Please enter 1, 2, 3, or 4." },
},
"setup.reranker.cohere_fallback_ask": {
  de: { default: "Bei Cohere-Fehler: Recall ohne Reranker fortsetzen [1] oder lokalen BGE laden [2]?" },
  en: { default: "On Cohere error: continue without reranker [1] or load local BGE [2]?" },
},
"setup.reranker.dimension_unknown": {
  de: { default: "Konnte bestehende LanceDB-Tabelle nicht prüfen: {{error}}. Bitte manuell sichern bevor du den Provider wechselst." },
  en: { default: "Could not read existing LanceDB table: {{error}}. Please back up manually before switching provider." },
},
"setup.reranker.reindex_confirm": {
  de: { default: "Option C erstellt eine neue DB und schaltet nach Validierung um. Alte DB bleibt als Rollback. Fortfahren? [y/n]" },
  en: { default: "Option C creates a new DB and switches after validation. Old DB remains for rollback. Proceed? [y/n]" },
},
```

**Fallback-Kette:** `lang+tone` → `lang+default` → `en.default` → key (mit Warning).
Fehlende Übersetzung fällt immer auf `en.default` zurück — nie hard failure.

---

## Abschnitt 8: `lib/providers/dimensions.js` — Default ändern

```js
// Vorher:
export const DEFAULT_LOCAL_RERANKER_MODEL = "Alibaba-NLP/gte-reranker-modernbert-base";

// Nachher:
export const DEFAULT_LOCAL_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3";
```

Alibaba bleibt als Advanced-Option im Wizard verfügbar, ist aber nicht mehr Default.

---

## Abschnitt 9: Tests

### `tests/dimension-guard.test.js`

```
- Kein LanceDB-Pfad → { status: "no-table" }
- Tabelle existiert, vector dim=3072 → { status: "ok", dimension: 3072 }
- Tabelle existiert, vector dim=384 → { status: "ok", dimension: 384 }
- LanceDB import schlägt fehl → { status: "unknown", error: "..." }
- vector-Feld fehlt → { status: "unknown", error: "..." }
- status="unknown" darf Provider-Wechsel nicht erlauben
```

### `tests/provider-wizard.test.js`

```
- Wizard-Ausgabe enthält "Cohere" als Option 1
- Cohere-Label enthält "kostenpflichtig" (de) / "paid" (en)
- Cohere-Help enthält NICHT "automatischer Fallback auf lokales Modell"
- Option 2 referenziert BAAI/bge-reranker-v2-m3
- Option 3 = "Kein Reranker" / "No reranker"
- Ungültige Eingabe triggert setup.reranker.invalid_choice
- Cohere ohne Fallback → fallbackProvider="disabled" in Config
- Cohere mit explizitem Fallback → fallbackProvider="local-transformers" + fallbackModel
- Disabled produziert { provider: "disabled", enabled: false }
- Local BGE produziert korrekten local.cacheDir-Block mit ${OPENCLAW_HOME}
- Embedding: apiKeyEnv="OPENAI_API_KEY" in Config (nicht apiKey: "${OPENAI_API_KEY}")
- Literal-Speicherung erscheint nur nach expliziter Wahl [2] mit Sicherheitswarnung
```

### `tests/i18n.test.js` (Ergänzungen)

```
- Alle neuen setup.reranker.*-Keys existieren in dictionary
- Jeder Key hat en.default
- Fehlende de-Übersetzung fällt auf en.default zurück
- t() mit unbekanntem Key gibt key zurück + loggt warning
- {{vars}}-Interpolation für setup.reranker.needs_api_key (keyName)
- setup.reranker.lazy_load_notice interpoliert {{sizeMb}} korrekt
- setup.reranker.dimension_unknown interpoliert {{error}} korrekt
```

### `tests/provider-factory.test.js` (Ergänzungen)

```
- createEmbeddingProvider mit local-transformers → LocalTransformersEmbeddingProvider
- createEmbeddingProvider mit openai + apiKeyEnv="OPENAI_API_KEY" → löst process.env auf
- createRerankerProvider mit disabled → null
- createRerankerProvider mit cohere + fallbackProvider="disabled" → ChainedRerankerProvider ohne lokalen Fallback
- createRerankerProvider mit cohere + fallbackProvider="local-transformers" → ChainedRerankerProvider mit lokalem BGE
- createRerankerProvider mit local-transformers → LocalTransformersRerankerProvider
- DEFAULT_LOCAL_RERANKER_MODEL ist BAAI/bge-reranker-v2-m3
- Alibaba-Modell ist NICHT DEFAULT_LOCAL_RERANKER_MODEL
```

### `tests/auto-capture-import.test.js` (NEU)

```
- PLUR1BUS_PLUGIN_DIR=<custom> → Import aus custom path
- Kein PLUR1BUS_PLUGIN_DIR → Import aus ~/.openclaw/extensions/memory-lancedb-namespaced/
- Factory nicht vorhanden → klare Fehlermeldung mit Pfadangabe
- normalizeEmbeddingConfig aus Extension importiert, nicht inline
```

---

## Nicht im Scope

- Automatischer Crontab-Eintrag durch Plugin (Root-Rechte-Problem bewusst ausgeschlossen)
- LanceDB-Namespace für Reranker (nicht nötig — keine Vektoren)
- Download-Fortschrittsanzeige für Modelle (HuggingFace handled intern)
- Dreaming / Forgetting-Curve (unberührt)
- Löschen alter Datenbanken im Wizard (immer Sache des Users nach manuellem Review)

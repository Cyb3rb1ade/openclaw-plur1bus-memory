# Provider Wizard & Plugin-eigene Credential-Auflösung

**Datum:** 2026-06-18  
**Status:** Design approved, implementation pending  
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

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "embedding": {
          "provider": "openai",
          "apiKey": "${OPENAI_API_KEY}",
          "model": "text-embedding-3-large",
          "dimensions": 3072
        },
        "reranker": {
          "provider": "cohere",
          "apiKeyEnv": "COHERE_API_KEY",
          "model": "rerank-v3.5",
          "candidates": 20,
          "timeoutMs": 5000,
          "fallbackOnError": true
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
| `lib/providers/dimension-guard.js` | NEU | Liest bestehende LanceDB-Vektordimension, prüft Kompatibilität |
| `lib/providers/dimensions.js` | ÄNDERN | `DEFAULT_LOCAL_RERANKER_MODEL` → `BAAI/bge-reranker-v2-m3` |
| `lib/i18n-dictionary.js` | ÄNDERN | Neue `setup.reranker.*`-Keys (de + en) |
| `scripts/install-memory-system.sh` | ÄNDERN | Wizard-Erweiterung Embedding + Reranker |
| `.openclaw/scripts/auto-capture-lancedb.mjs` | ÄNDERN | Liest Plugin-Config, nutzt factory.js |
| `tests/provider-wizard.test.js` | NEU | Wizard-UX + Config-Output-Tests |
| `tests/dimension-guard.test.js` | NEU | Dimension-Mismatch-Erkennung |

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
import { resolveEnvVars, resolveOptionalEnvVars } from "./env.js";

export function createEmbeddingProvider(normalizedCfg) {
  if (normalizedCfg.provider === "local-transformers") {
    return new LocalTransformersEmbeddingProvider({
      ...normalizedCfg.local,
      dimensions: normalizedCfg.dimensions,
    });
  }
  // Resolve apiKey-Referenz (Literal oder ${VAR})
  const apiKey = normalizedCfg.apiKey
    ? resolveEnvVars(normalizedCfg.apiKey)
    : resolveOptionalEnvVars("${OPENAI_API_KEY}");
  return new OpenAIEmbeddingProvider({ ...normalizedCfg, apiKey });
}

export function createRerankerProvider(normalizedCfg, logger) {
  if (!normalizedCfg || normalizedCfg.provider === "disabled" || !normalizedCfg.enabled) {
    return null;
  }
  if (normalizedCfg.provider === "cohere") {
    const primary = new CohereRerankerProvider(normalizedCfg);
    const fallback = new LocalTransformersRerankerProvider({
      model: "BAAI/bge-reranker-v2-m3",
    });
    return new ChainedRerankerProvider(primary, fallback, logger);
  }
  if (normalizedCfg.provider === "local-transformers") {
    return new LocalTransformersRerankerProvider(normalizedCfg.local || normalizedCfg);
  }
  return null;
}
```

`index.js` und `auto-capture-lancedb.mjs` nutzen ausschließlich diese Factory.
Keine doppelte Provider-Logik.

---

## Abschnitt 2: Dimension-Guard

### `lib/providers/dimension-guard.js`

Zweck: Bestehende LanceDB-Tabelle öffnen, `vector`-Feld aus Arrow-Schema lesen,
mit Ziel-Dimension vergleichen.

```js
export async function readExistingTableDimension(dbPath) {
  // dynamisch importieren (LanceDB ist optional-dependency)
  try {
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(dbPath);
    const tables = await db.tableNames();
    if (!tables.includes("memories")) return null;
    const table = await db.openTable("memories");
    const schema = await table.schema();
    const vectorField = schema.fields.find(f => f.name === "vector");
    // Arrow FixedSizeList hat listSize
    return vectorField?.type?.listSize ?? null;
  } catch (_) {
    return null;
  }
}

export function checkDimensionCompatibility(existingDim, targetDim) {
  if (existingDim === null) return "no-existing-table";
  if (existingDim === targetDim) return "ok";
  return "mismatch";
}
```

**Invariante:** Ein Provider-Wechsel ist nur erlaubt wenn:
- (a) keine bestehende Tabelle existiert, ODER
- (b) Dimensionen stimmen überein, ODER
- (c) der User explizit Option B (neuer Namespace) oder C (Re-Index) gewählt hat

Der Wizard ruft `readExistingTableDimension` auf, bevor er die Config schreibt.

### Dimension-Mismatch-Flow

```
Bestehende Tabelle erkannt, Dimension != Ziel-Dimension?

  A) Bestehenden Provider behalten
     → keine Config-Änderung, kein Datenverlust
  
  B) Neuen LanceDB-Namespace anlegen
     → baseDbPath: ".openclaw/lancedb-local/" (neben ".openclaw/lancedb/")
     → beide laufen parallel, alter Provider bleibt aktiv
     → Wizard schreibt zweiten Namespace-Config-Block
  
  C) Kontrollierter Re-Index
     → alle bestehenden Vektoren löschen
     → neues Modell + neue Dimensionen
     → alle Memories neu einbetten (Zeitaufwand je nach DB-Größe)
     → Wizard warnt und verlangt explizite Bestätigung
```

Keine Dimension-Guard für Reranker nötig — Reranker erzeugt keine LanceDB-Vektoren.

---

## Abschnitt 3: Wizard — Embedding-Provider

### Schritt 1/2: Embedding

```
──────────────────────────────────────────────────────────
Schritt 1/2: Embedding-Provider

OpenAI API Key vorhanden? (für text-embedding-3-large, 3072 dims)

  [y] Key eingeben
      Speichern als:
        [1] Literal in openclaw.json (einfach, Key in Config-Datei)
        [2] Env-Var-Referenz ${OPENAI_API_KEY} (Key bleibt in .env)
      → provider="openai", model="text-embedding-3-large", dimensions=3072

  [n] Lokales Modell nutzen
      intfloat/multilingual-e5-small
      CPU-tauglich, gut für Deutsch/Mehrsprachig, 384 dims
      Erster Start: Download ~135 MB, dann gecacht.
      → provider="local-transformers", dimensions=384

──────────────────────────────────────────────────────────
```

Nach Eingabe: Dimension-Guard-Check (automatisch, kein User-Schritt wenn ok).

---

## Abschnitt 4: Wizard — Reranker-Provider

Der Reranker verbessert Recall-Qualität durch Neuordnung der Kandidaten.
Er wird bewusst gewählt — kein Auto-Fallback auf lokal ohne Zustimmung.

### Schritt 2/2: Reranker

```
──────────────────────────────────────────────────────────
Schritt 2/2: Reranker

Reranker verbessert die Recall-Qualität, kostet aber zusätzliche
Laufzeit. Welche Reranker-Option möchtest du nutzen?

[1] Cohere rerank-v3.5  (kostenpflichtig, empfohlen für beste Qualität)
    - benötigt COHERE_API_KEY
    - keine lokale CPU-/RAM-Last
    - Bei Fehler: automatischer Fallback auf BAAI/bge-reranker-v2-m3

[2] Lokal: BAAI/bge-reranker-v2-m3  (mehrsprachig, kein API-Key)
    - empfohlen für Deutsch/Mehrsprachig ohne externen Dienst
    - lazy load beim ersten Recall (Download ~570 MB)
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

### Config-Output je Wahl

**Option 1 — Cohere:**
```json
{
  "reranker": {
    "provider": "cohere",
    "model": "rerank-v3.5",
    "apiKeyEnv": "COHERE_API_KEY",
    "candidates": 20,
    "timeoutMs": 5000,
    "fallbackOnError": true
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

### Cohere-Key-Eingabe (nur Option 1)

```
COHERE_API_KEY eingeben:
Speichern als:
  [1] Literal in openclaw.json
  [2] Env-Var-Referenz ${COHERE_API_KEY}
```

### Runtime-Regeln (unveränderlich)

- Reranker: lazy load, kein Download beim Wizard
- `fallbackOnError: true` — Reranker-Fehler crasht nie den Recall
- `timeoutMs: 5000` default
- `candidates: 20` default
- Reranker erzeugt keine LanceDB-Vektoren → kein Dimension-Guard nötig

---

## Abschnitt 5: `auto-capture-lancedb.mjs` — Umbau

### Vorher (Problem)
```js
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) { console.error("OPENAI_API_KEY not set"); process.exit(1); }
const embeddings = createEmbeddings(apiKey, EMBEDDING_MODEL); // eigene Logik
```

### Nachher (Plugin-Config-getrieben)
```js
// Lese Plugin-Config aus openclaw.json
const pluginCfg = readPluginConfig(CONFIG_PATH);
const embCfg = normalizeEmbeddingConfig(pluginCfg?.embedding || {});
// Nutze gemeinsame Factory — kein process.env.OPENAI_API_KEY hart
const embeddings = createEmbeddingProvider(embCfg);

// Bei local-transformers: kein API-Key nötig → kein .env-Problem
// Bei openai: Key aus Config (Literal oder ${VAR}-Ref, via resolveOptionalEnvVars)
if (!embeddings) {
  console.error("[auto-capture] Embedding-Provider konnte nicht initialisiert werden");
  process.exit(1);
}
```

`createEmbeddings()` (eigene Impl. im Script) wird entfernt.
`normalizeEmbeddingConfig` + `createEmbeddingProvider` aus `lib/providers/` werden
dynamisch importiert (gleicher Pfad wie LanceDB/OpenAI bereits).

---

## Abschnitt 6: i18n

### Neue Dictionary-Keys (`lib/i18n-dictionary.js`)

Alle neuen Keys folgen dem Schema `setup.reranker.*` und brauchen mindestens `en.default`.

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
  de: { default: "Benötigt COHERE_API_KEY. Keine lokale CPU-/RAM-Last. Bei Fehler: automatischer Fallback." },
  en: { default: "Requires COHERE_API_KEY. No local CPU/RAM load. Automatic fallback on error." },
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
```

**Fallback-Kette:** `lang+tone` → `lang+default` → `en.default` → key (mit Warning).
Fehlende Übersetzung für eine Sprache fällt immer auf `en.default` zurück — nie hard failure.

### Verwendung im Wizard

```js
const lang = resolveLocale({ fallback: "en" }); // aus Shell-Env oder default
const tone = "default";
console.log(t("setup.reranker.title", { lang, tone }));
console.log(t("setup.reranker.description", { lang, tone }));
console.log(`[1] ${t("setup.reranker.option.cohere", { lang, tone })}`);
```

---

## Abschnitt 7: `lib/providers/dimensions.js` — Default ändern

```js
// Vorher:
export const DEFAULT_LOCAL_RERANKER_MODEL = "Alibaba-NLP/gte-reranker-modernbert-base";

// Nachher:
export const DEFAULT_LOCAL_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3";
```

Alibaba bleibt als Advanced-Option im Wizard verfügbar, ist aber nicht mehr Default.

---

## Abschnitt 8: Tests

### `tests/provider-wizard.test.js`

```
- Wizard-Ausgabe enthält "Cohere" als Option 1
- Cohere-Label enthält "kostenpflichtig" (de) / "paid" (en)
- Option 2 referenziert BAAI/bge-reranker-v2-m3
- Option 3 = "Kein Reranker" / "No reranker"
- Ungültige Eingabe triggert setup.reranker.invalid_choice
- Cohere mit apiKeyEnv erzeugt korrekten Config-Block
- Disabled produziert { provider: "disabled", enabled: false }
- Local BGE produziert korrekten local.cacheDir-Block
```

### `tests/dimension-guard.test.js`

```
- Keine bestehende Tabelle → "no-existing-table"
- Gleiche Dimension → "ok"
- 3072 vs 384 → "mismatch"
- readExistingTableDimension wirft nicht bei nicht-existentem Pfad
```

### `tests/i18n.test.js` (Ergänzungen)

```
- Alle neuen setup.reranker.*-Keys existieren in dictionary
- Jeder Key hat en.default
- Fehlende de-Übersetzung fällt auf en.default zurück
- t() mit unbekanntem Key gibt key zurück + loggt warning
- {{vars}}-Interpolation funktioniert für setup.reranker.needs_api_key
- setup.reranker.lazy_load_notice interpoliert {{sizeMb}} korrekt
```

### `tests/provider-factory.test.js` (Ergänzungen)

```
- createEmbeddingProvider mit local-transformers gibt LocalTransformersEmbeddingProvider
- createEmbeddingProvider mit openai + apiKey="${OPENAI_API_KEY}" löst Env auf
- createRerankerProvider mit disabled gibt null
- createRerankerProvider mit cohere gibt ChainedRerankerProvider
- createRerankerProvider mit local-transformers gibt LocalTransformersRerankerProvider
- DEFAULT_LOCAL_RERANKER_MODEL ist BAAI/bge-reranker-v2-m3
- Alibaba-Modell ist NICHT DEFAULT_LOCAL_RERANKER_MODEL
```

---

## Nicht im Scope

- Automatischer Crontab-Eintrag durch Plugin (Root-Rechte-Problem bewusst ausgeschlossen)
- LanceDB-Namespace-Konfiguration für Reranker (nicht nötig — keine Vektoren)
- Download-Fortschrittsanzeige für Modelle (HuggingFace handled intern)
- Änderung an Dreaming / Forgetting-Curve (unberührt)

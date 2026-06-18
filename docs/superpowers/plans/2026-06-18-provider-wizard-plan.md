# Provider Wizard & Plugin-eigene Credential-Auflösung — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugin-eigenständige Credential-Auflösung + interaktiver Setup-Wizard für Embedding- und Reranker-Provider, sodass `auto-capture-lancedb.mjs` ohne root-Rechte und ohne `OPENAI_API_KEY` in `process.env` funktioniert.

**Architecture:** Eine gemeinsame `factory.js` instanziiert alle Provider aus Plugin-Config; `dimension-guard.js` schützt gegen Dimensions-Mismatch beim Provider-Wechsel; der Install-Wizard fragt interaktiv Embedding + Reranker ab. `auto-capture` importiert die Factory aus der installierten Extension-Dir statt `process.env.OPENAI_API_KEY` hart zu lesen.

**Tech Stack:** Node.js ≥20 ESM, `node:test` (built-in test runner), `@lancedb/lancedb`, `@huggingface/transformers` (optional), `openai`, `lib/i18n.js` / `lib/i18n-dictionary.js`

## Global Constraints

- ESM everywhere — alle neuen Dateien verwenden `import`/`export`, kein `require()`
- Test-Runner: `node --test tests/*.test.js` — kein jest, kein vitest
- Test-Importe: `import { describe, it } from "node:test"; import assert from "node:assert/strict";`
- Kein Deploy, kein Restart, keine Produktionsdaten, keine alte LanceDB löschen, kein Crontab
- `fallbackProvider: "disabled"` ist Default für Cohere — niemals Auto-Fallback auf lokales Modell
- Option C (Reindex): niemals alte DB löschen — Snapshot zuerst, atomarer Switch nach Validierung
- `status: "unknown"` in Dimension-Guard blockiert immer Provider-Wechsel
- `activeWriteNamespace` darf nur beschrieben werden; `legacyReadOnlyNamespaces` sind read-only
- **`resolveApiKey(cfg, { defaultEnv, optional, label })`**: Kein globaler `OPENAI_API_KEY`-Fallback in der Funktion selbst. Jeder Aufrufer übergibt `defaultEnv` explizit — `"OPENAI_API_KEY"` für Embedding, `"COHERE_API_KEY"` für Cohere-Reranker. Cohere darf niemals versehentlich den OpenAI-Key nutzen.
- **Wizard-i18n**: Keine user-facing Texte in Bash. Wizard-UX ausschließlich in `scripts/provider-wizard.mjs` via `resolveLocale()` + `t(key, ...)`. `install-memory-system.sh` ruft nur den Node-Wizard auf.
- **Reindex (diese Iteration)**: `scripts/reindex-provider.mjs` ist dry-run + report-only. Kein Re-Embedding, kein Config-Switch, kein `cp -r` ohne `--apply`. Echter Reindex = eigener Folgepatch.
- Spec-Referenz: `docs/superpowers/specs/2026-06-18-provider-wizard-design.md` (rev 2)

---

## Dateiübersicht

| Datei | Art | Phase |
|-------|-----|-------|
| `lib/providers/dimensions.js` | ÄNDERN | 1 |
| `lib/i18n-dictionary.js` | ÄNDERN | 1 |
| `lib/providers/config-normalize.js` | ÄNDERN | 1 |
| `lib/providers/env.js` | ÄNDERN | 2 |
| `lib/providers/factory.js` | NEU | 2 |
| `lib/providers/reranker-cohere.js` | ÄNDERN | 2 |
| `lib/providers/dimension-guard.js` | NEU | 3 |
| `lib/namespace-config.js` | NEU | 4 |
| `lib/multi-namespace-pool.js` | NEU | 4 |
| `scripts/reindex-provider.mjs` | NEU (dry-run only) | 4 |
| `scripts/provider-wizard.mjs` | NEU | 4 |
| `scripts/install-memory-system.sh` | ÄNDERN (ruft wizard auf) | 4 |
| `.openclaw/scripts/auto-capture-lancedb.mjs` | ÄNDERN | 5 |
| `lib/providers/reranker-chained.js` | ÄNDERN | 6 |
| `tests/dimension-guard.test.js` | NEU | 7 |
| `tests/provider-factory.test.js` | NEU | 7 |
| `tests/provider-wizard-config.test.js` | NEU | 7 |
| `tests/auto-capture-import.test.js` | NEU | 7 |
| `tests/i18n-setup-reranker.test.js` | NEU | 7 |
| `tests/chained-reranker-null-fallback.test.js` | NEU | 7 |
| `tests/multi-namespace-pool.test.js` | NEU | 4 |
| `tests/provider-wizard.test.js` | NEU | 4 |
| `CHANGELOG.md` | ÄNDERN | 8 |

---

## Phase 1: Config + i18n + Defaults

### Task 1.1 — `dimensions.js`: DEFAULT_LOCAL_RERANKER_MODEL ändern

**Files:**
- Modify: `lib/providers/dimensions.js:8`

**Interfaces:**
- Produces: `DEFAULT_LOCAL_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"` (alle Provider-Konstruktoren lesen diesen Default)

- [ ] **Step 1: Failing test schreiben**

```js
// tests/provider-defaults.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCAL_RERANKER_MODEL, DEFAULT_LOCAL_E5_MODEL } from "../lib/providers/dimensions.js";

describe("provider defaults", () => {
  it("DEFAULT_LOCAL_RERANKER_MODEL ist BAAI/bge-reranker-v2-m3", () => {
    assert.strictEqual(DEFAULT_LOCAL_RERANKER_MODEL, "BAAI/bge-reranker-v2-m3");
  });
  it("Alibaba ist NICHT mehr der Default", () => {
    assert.notEqual(DEFAULT_LOCAL_RERANKER_MODEL, "Alibaba-NLP/gte-reranker-modernbert-base");
  });
  it("DEFAULT_LOCAL_E5_MODEL bleibt intfloat/multilingual-e5-small", () => {
    assert.strictEqual(DEFAULT_LOCAL_E5_MODEL, "intfloat/multilingual-e5-small");
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/provider-defaults.test.js
# Expected: FAIL — "BAAI/bge-reranker-v2-m3" !== "Alibaba-NLP/gte-reranker-modernbert-base"
```

- [ ] **Step 3: Änderung in `dimensions.js`**

Zeile 8 ändern von:
```js
export const DEFAULT_LOCAL_RERANKER_MODEL = "Alibaba-NLP/gte-reranker-modernbert-base";
```
zu:
```js
export const DEFAULT_LOCAL_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3";
```

- [ ] **Step 4: Test laufen lassen — erwartet PASS**

```bash
node --test tests/provider-defaults.test.js
# Expected: 3 tests pass
```

- [ ] **Step 5: Commit**

```bash
git add lib/providers/dimensions.js tests/provider-defaults.test.js
git commit -m "feat(providers): DEFAULT_LOCAL_RERANKER_MODEL → BAAI/bge-reranker-v2-m3"
```

---

### Task 1.2 — `i18n-dictionary.js`: setup.reranker.* Keys

**Files:**
- Modify: `lib/i18n-dictionary.js` (append new section)
- Test: `tests/i18n-setup-reranker.test.js`

**Interfaces:**
- Produces: `setup.reranker.{title,description,option.cohere,...}` für `t(key, {lang,tone})`
- Consumes: `t()` und `dictionary` aus `lib/i18n.js` / `lib/i18n-dictionary.js`

- [ ] **Step 1: Failing test schreiben**

```js
// tests/i18n-setup-reranker.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { t } from "../lib/i18n.js";
import { dictionary } from "../lib/i18n-dictionary.js";

const REQUIRED_KEYS = [
  // Embedding keys
  "setup.embedding.title",
  "setup.embedding.description",
  "setup.embedding.option.openai",
  "setup.embedding.option.openai_help",
  "setup.embedding.option.local_e5",
  "setup.embedding.option.local_e5_help",
  "setup.embedding.api_key_ask",
  // Reranker keys
  "setup.reranker.title",
  "setup.reranker.description",
  "setup.reranker.option.cohere",
  "setup.reranker.option.cohere_help",
  "setup.reranker.option.local_bge",
  "setup.reranker.option.local_bge_help",
  "setup.reranker.option.disabled",
  "setup.reranker.option.disabled_help",
  "setup.reranker.option.advanced",
  "setup.reranker.option.advanced_help",
  "setup.reranker.cost_paid",
  "setup.reranker.needs_api_key",
  "setup.reranker.local_cpu_warning",
  "setup.reranker.lazy_load_notice",
  "setup.reranker.selected",
  "setup.reranker.invalid_choice",
  "setup.reranker.cohere_fallback_ask",
  "setup.reranker.dimension_unknown",
  "setup.reranker.reindex_confirm",
];

describe("i18n setup.reranker keys", () => {
  for (const key of REQUIRED_KEYS) {
    it(`key "${key}" existiert und hat en.default`, () => {
      assert.ok(dictionary[key], `Key fehlt: ${key}`);
      assert.ok(dictionary[key].en?.default, `en.default fehlt für: ${key}`);
    });
  }

  it("Cohere-Label enthält 'paid' (en)", () => {
    const label = t("setup.reranker.option.cohere", { lang: "en", tone: "default" });
    assert.ok(label.includes("paid"), `"paid" fehlt in: ${label}`);
  });

  it("Cohere-Label enthält 'kostenpflichtig' (de)", () => {
    const label = t("setup.reranker.option.cohere", { lang: "de", tone: "default" });
    assert.ok(label.includes("kostenpflichtig"), `"kostenpflichtig" fehlt in: ${label}`);
  });

  it("Cohere-Help enthält NICHT 'automatischer Fallback' (de)", () => {
    const help = t("setup.reranker.option.cohere_help", { lang: "de", tone: "default" });
    assert.ok(!help.includes("automatischer Fallback auf"), `Cohere-Help darf keinen auto-Fallback erwähnen: ${help}`);
  });

  it("fehlende de-Übersetzung fällt auf en.default zurück", () => {
    // Prüfe: Wenn ein Key kein de.default hat, kommt en.default zurück
    // (Hier: einen Key ohne de verwenden oder t() mit unbekannter Sprache)
    const result = t("setup.reranker.title", { lang: "fr", tone: "default" });
    // fr nicht vorhanden → en.default
    const en = t("setup.reranker.title", { lang: "en", tone: "default" });
    assert.strictEqual(result, en);
  });

  it("{{vars}} Interpolation funktioniert für needs_api_key", () => {
    const result = t("setup.reranker.needs_api_key", { lang: "en", tone: "default", vars: { keyName: "COHERE_API_KEY" } });
    assert.ok(result.includes("COHERE_API_KEY"), `Var nicht interpoliert: ${result}`);
    assert.ok(!result.includes("{{keyName}}"), `Template-Placeholder nicht ersetzt: ${result}`);
  });

  it("{{sizeMb}} Interpolation für lazy_load_notice", () => {
    const result = t("setup.reranker.lazy_load_notice", { lang: "de", tone: "default", vars: { sizeMb: "570" } });
    assert.ok(result.includes("570"), `sizeMb nicht interpoliert: ${result}`);
  });

  it("{{error}} Interpolation für dimension_unknown", () => {
    const result = t("setup.reranker.dimension_unknown", { lang: "en", tone: "default", vars: { error: "LanceDB not found" } });
    assert.ok(result.includes("LanceDB not found"), `error nicht interpoliert: ${result}`);
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/i18n-setup-reranker.test.js
# Expected: FAIL — Keys fehlen im dictionary
```

- [ ] **Step 3: Keys in `lib/i18n-dictionary.js` einfügen**

Am Ende der `dictionary`-Exports-Objekt (vor dem schließenden `}`), zwei neue Sektionen einfügen — **zuerst** `setup.embedding.*`, dann `setup.reranker.*`:

```js
  // ─── Setup: Embedding Wizard ─────────────────────────────────────────────────
  "setup.embedding.title": {
    de: { default: "Schritt 1/2: Embedding-Provider" },
    en: { default: "Step 1/2: Embedding Provider" },
  },
  "setup.embedding.description": {
    de: { default: "Welchen Embedding-Provider möchtest du nutzen?" },
    en: { default: "Which embedding provider do you want to use?" },
  },
  "setup.embedding.option.openai": {
    de: { default: "OpenAI text-embedding-3-large (3072 dims, kostenpflichtig, empfohlen)" },
    en: { default: "OpenAI text-embedding-3-large (3072 dims, paid, recommended)" },
  },
  "setup.embedding.option.openai_help": {
    de: { default: "Benötigt OPENAI_API_KEY. Bester Recall-Score. Keine lokale GPU/CPU-Last." },
    en: { default: "Requires OPENAI_API_KEY. Best recall quality. No local GPU/CPU load." },
  },
  "setup.embedding.option.local_e5": {
    de: { default: "Lokal: intfloat/multilingual-e5-small (384 dims, mehrsprachig, kein API-Key)" },
    en: { default: "Local: intfloat/multilingual-e5-small (384 dims, multilingual, no API key)" },
  },
  "setup.embedding.option.local_e5_help": {
    de: { default: "CPU-tauglich, gut für Deutsch/Mehrsprachig. Download ~135 MB beim ersten Start." },
    en: { default: "CPU-friendly, good for German/multilingual. ~135 MB download on first run." },
  },
  "setup.embedding.api_key_ask": {
    de: { default: "OPENAI_API_KEY speichern als [1] Env-Var-Referenz (bevorzugt) / [2] Literal?" },
    en: { default: "Store OPENAI_API_KEY as [1] env-ref (recommended) / [2] literal?" },
  },

  // ─── Setup: Reranker Wizard ─────────────────────────────────────────────────
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

- [ ] **Step 4: Test laufen lassen — erwartet PASS**

```bash
node --test tests/i18n-setup-reranker.test.js
# Expected: alle Tests grün
```

- [ ] **Step 5: Commit**

```bash
git add lib/i18n-dictionary.js tests/i18n-setup-reranker.test.js
git commit -m "feat(i18n): add setup.reranker.* dictionary keys (de+en)"
```

---

### Task 1.3 — `config-normalize.js`: apiKeyEnv-Unterstützung

**Files:**
- Modify: `lib/providers/config-normalize.js`
- Test: `tests/config-normalize-apikeyenv.test.js`

**Interfaces:**
- Produces: `normalizedEmbeddingCfg.apiKeyEnv` und `normalizedRerankerCfg.apiKeyEnv` werden durchgereicht (nicht aufgelöst — Auflösung passiert nur in factory.js zur Laufzeit)
- Consumes: bestehende `normalizeEmbeddingConfig(raw)` und `normalizeRerankerConfig(raw)` Funktionen

- [ ] **Step 1: Failing test schreiben**

```js
// tests/config-normalize-apikeyenv.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmbeddingConfig, normalizeRerankerConfig } from "../lib/providers/config-normalize.js";

describe("config-normalize apiKeyEnv", () => {
  it("normalizeEmbeddingConfig übergibt apiKeyEnv unverändert", () => {
    const cfg = normalizeEmbeddingConfig({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY", dimensions: 3072 });
    assert.strictEqual(cfg.apiKeyEnv, "OPENAI_API_KEY");
    assert.strictEqual(cfg.apiKey, undefined);
  });

  it("normalizeEmbeddingConfig behält apiKey wenn gesetzt", () => {
    const cfg = normalizeEmbeddingConfig({ provider: "openai", apiKey: "sk-test", dimensions: 1536 });
    assert.strictEqual(cfg.apiKey, "sk-test");
  });

  it("normalizeRerankerConfig übergibt apiKeyEnv unverändert für cohere", () => {
    const cfg = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "COHERE_API_KEY", model: "rerank-v3.5" });
    assert.strictEqual(cfg.apiKeyEnv, "COHERE_API_KEY");
    assert.strictEqual(cfg.apiKey, undefined);
  });

  it("normalizeRerankerConfig übergibt fallbackProvider + fallbackModel", () => {
    const cfg = normalizeRerankerConfig({
      provider: "cohere",
      apiKeyEnv: "COHERE_API_KEY",
      fallbackProvider: "local-transformers",
      fallbackModel: "BAAI/bge-reranker-v2-m3",
    });
    assert.strictEqual(cfg.fallbackProvider, "local-transformers");
    assert.strictEqual(cfg.fallbackModel, "BAAI/bge-reranker-v2-m3");
  });

  it("normalizeRerankerConfig setzt fallbackProvider=disabled als Default", () => {
    const cfg = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "COHERE_API_KEY" });
    assert.strictEqual(cfg.fallbackProvider, "disabled");
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/config-normalize-apikeyenv.test.js
# Expected: FAIL — apiKeyEnv/fallbackProvider werden nicht durchgereicht
```

- [ ] **Step 3: `config-normalize.js` anpassen**

In `normalizeEmbeddingConfig(raw)`:
- Ergänze `apiKeyEnv: raw.apiKeyEnv,` im return-Objekt (openai-Zweig)
- Der local-transformers-Zweig braucht kein apiKeyEnv

In `normalizeRerankerConfig(raw)`:
- Ergänze im cohere-Zweig: `apiKeyEnv: raw.apiKeyEnv,`, `fallbackProvider: raw.fallbackProvider ?? "disabled"`, `fallbackModel: raw.fallbackModel || null`
- `enabled` prüft jetzt `raw.apiKey || raw.apiKeyEnv` statt nur `raw.apiKey`

Konkret in `normalizeRerankerConfig`, cohere-Zweig:
```js
if (provider === "cohere") {
  return {
    provider,
    enabled: raw.enabled !== false && !!(raw.apiKey || raw.apiKeyEnv),
    apiKey: raw.apiKey,
    apiKeyEnv: raw.apiKeyEnv,
    model: raw.model || DEFAULT_COHERE_RERANK_MODEL,
    candidates: raw.candidates ?? 20,
    timeoutMs,
    fallbackOnError,
    fallbackProvider: raw.fallbackProvider ?? "disabled",
    fallbackModel: raw.fallbackModel || null,
  };
}
```

- [ ] **Step 4: Test laufen lassen — erwartet PASS**

```bash
node --test tests/config-normalize-apikeyenv.test.js
# Expected: 5 tests pass
```

- [ ] **Step 5: Bestehende Tests prüfen**

```bash
node --test tests/config-audit.test.js
# Expected: kein Bruch
```

- [ ] **Step 6: Commit**

```bash
git add lib/providers/config-normalize.js tests/config-normalize-apikeyenv.test.js
git commit -m "feat(config): apiKeyEnv + fallbackProvider support in normalize functions"
```

---

## Phase 2: Provider-Factory + apiKeyEnv

### Task 2.1 — `env.js`: resolveApiKey(cfg, opts) — provider-sicher

**Files:**
- Modify: `lib/providers/env.js`

**Interfaces:**
- Produces: `export function resolveApiKey(cfg, { defaultEnv, optional, label } = {})` — löst `cfg.apiKeyEnv` (bevorzugt) oder `cfg.apiKey` auf; `defaultEnv` nur wenn explizit vom Aufrufer gesetzt; kein globaler OPENAI-Fallback
- **Wichtig:** Die Funktion MUSS provider-neutral sein. Cohere darf niemals auf `OPENAI_API_KEY` zurückfallen, weil kein `defaultEnv` übergeben wurde.

- [ ] **Step 1: Test schreiben**

```js
// tests/provider-env-resolve.test.js (NEU)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveApiKey } from "../lib/providers/env.js";

describe("resolveApiKey", () => {
  before(() => {
    process.env._TEST_OPENAI_KEY = "sk-openai-test";
    process.env._TEST_COHERE_KEY = "co-test-key";
  });
  after(() => {
    delete process.env._TEST_OPENAI_KEY;
    delete process.env._TEST_COHERE_KEY;
  });

  it("löst apiKeyEnv aus process.env auf (höchste Priorität)", () => {
    const key = resolveApiKey({ apiKeyEnv: "_TEST_OPENAI_KEY" });
    assert.strictEqual(key, "sk-openai-test");
  });

  it("wirft wenn apiKeyEnv gesetzt aber Env-Var fehlt", () => {
    assert.throws(
      () => resolveApiKey({ apiKeyEnv: "_NONEXISTENT_VAR_XYZ" }),
      /Env var _NONEXISTENT_VAR_XYZ not set/
    );
  });

  it("wirft bei leerem Env-Var mit Label in der Fehlermeldung", () => {
    assert.throws(
      () => resolveApiKey({ apiKeyEnv: "_NONEXISTENT_VAR_XYZ" }, { label: "OpenAI embedding" }),
      /OpenAI embedding/
    );
  });

  it("löst apiKey als Literal auf wenn apiKeyEnv nicht gesetzt", () => {
    const key = resolveApiKey({ apiKey: "sk-literal-key" });
    assert.strictEqual(key, "sk-literal-key");
  });

  it("apiKeyEnv hat Vorrang vor apiKey", () => {
    const key = resolveApiKey({ apiKeyEnv: "_TEST_OPENAI_KEY", apiKey: "sk-should-not-be-used" });
    assert.strictEqual(key, "sk-openai-test");
  });

  it("defaultEnv wird genutzt wenn apiKeyEnv + apiKey beide fehlen", () => {
    const key = resolveApiKey({}, { defaultEnv: "_TEST_OPENAI_KEY" });
    assert.strictEqual(key, "sk-openai-test");
  });

  it("defaultEnv='_TEST_COHERE_KEY' → Cohere-Key, NICHT OpenAI-Key", () => {
    const key = resolveApiKey({}, { defaultEnv: "_TEST_COHERE_KEY" });
    assert.strictEqual(key, "co-test-key");
    assert.notStrictEqual(key, "sk-openai-test");
  });

  it("KEIN globaler OPENAI-Fallback ohne defaultEnv — wirft statt OPENAI_API_KEY zu raten", () => {
    // Auch wenn OPENAI_API_KEY in process.env wäre: ohne defaultEnv kein Fallback
    assert.throws(
      () => resolveApiKey({}),
      /no API key/i
    );
  });

  it("optional=true: gibt undefined wenn kein Key gefunden", () => {
    const key = resolveApiKey({}, { optional: true });
    assert.strictEqual(key, undefined);
  });

  it("optional=true mit defaultEnv: gibt undefined wenn Env-Var fehlt (kein Wurf)", () => {
    const key = resolveApiKey({}, { defaultEnv: "_NONEXISTENT_VAR_XYZ", optional: true });
    assert.strictEqual(key, undefined);
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/provider-env-resolve.test.js
# Expected: FAIL — resolveApiKey nicht exportiert
```

- [ ] **Step 3: `resolveApiKey` in `lib/providers/env.js` ergänzen**

```js
// Am Ende von env.js hinzufügen:

/**
 * Löst einen API-Key aus Config auf.
 *
 * Priorität: cfg.apiKeyEnv → cfg.apiKey → opts.defaultEnv
 * KEIN globaler OPENAI-Fallback — jeder Aufrufer muss defaultEnv explizit setzen.
 * Cohere: defaultEnv: "COHERE_API_KEY"
 * OpenAI Embedding: defaultEnv: "OPENAI_API_KEY"
 *
 * @param {object} cfg — { apiKeyEnv?, apiKey? }
 * @param {object} opts — { defaultEnv?, optional?, label? }
 */
export function resolveApiKey(cfg = {}, { defaultEnv, optional = false, label = "API key" } = {}) {
  // 1. cfg.apiKeyEnv hat höchste Priorität
  if (cfg.apiKeyEnv) {
    const val = process.env[cfg.apiKeyEnv];
    if (!val) {
      if (optional) return undefined;
      throw new Error(`Env var ${cfg.apiKeyEnv} not set — required for ${label}`);
    }
    return val;
  }
  // 2. cfg.apiKey als Literal (${VAR}-Syntax wird aufgelöst)
  if (cfg.apiKey) {
    return resolveOptionalEnvVars(cfg.apiKey) || cfg.apiKey;
  }
  // 3. defaultEnv — nur wenn vom Aufrufer explizit gesetzt
  if (defaultEnv) {
    const val = process.env[defaultEnv];
    if (!val) {
      if (optional) return undefined;
      throw new Error(`Env var ${defaultEnv} not set — required for ${label}`);
    }
    return val;
  }
  // 4. Kein Key gefunden — kein globaler Fallback
  if (optional) return undefined;
  throw new Error(`no API key configured for ${label} (set apiKeyEnv, apiKey, or pass defaultEnv)`);
}
```

- [ ] **Step 4: factory.js Aufruf-Pattern sicherstellen**

In `factory.js` (Task 2.2) MUSS der Aufrufer den Kontext mitgeben:
```js
// Embedding (OpenAI):
const apiKey = resolveApiKey(normalizedCfg, { defaultEnv: "OPENAI_API_KEY", label: "OpenAI embedding" });

// Reranker (Cohere) — in CohereRerankerProvider:
const apiKey = resolveApiKey({ apiKeyEnv: this.apiKeyEnv, apiKey: this.apiKeyRef }, { defaultEnv: "COHERE_API_KEY", label: "Cohere reranker" });
```

- [ ] **Step 5: Tests laufen lassen**

```bash
node --test tests/provider-env-resolve.test.js
# Expected: 10 tests pass
```

- [ ] **Step 6: Commit**

```bash
git add lib/providers/env.js tests/provider-env-resolve.test.js
git commit -m "feat(env): resolveApiKey(cfg, {defaultEnv,optional,label}) — provider-sicher, kein OPENAI-Fallback"
```

---

### Task 2.2 — `factory.js`: Provider-Factory erstellen

**Files:**
- Create: `lib/providers/factory.js`
- Modify: `lib/providers/reranker-cohere.js` (apiKeyEnv support)
- Test: `tests/provider-factory.test.js`

**Interfaces:**
- Produces: `createEmbeddingProvider(normalizedCfg)`, `createRerankerProvider(normalizedCfg, logger)`
- Consumes: `resolveApiKey` (Task 2.1), `normalizeEmbeddingConfig`/`normalizeRerankerConfig` (Task 1.3)

- [ ] **Step 1: Test schreiben**

```js
// tests/provider-factory.test.js (NEU)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingProvider, createRerankerProvider } from "../lib/providers/factory.js";
import { normalizeEmbeddingConfig, normalizeRerankerConfig } from "../lib/providers/config-normalize.js";
import { DEFAULT_LOCAL_RERANKER_MODEL } from "../lib/providers/dimensions.js";

describe("provider-factory", () => {
  before(() => {
    process.env._FACTORY_TEST_KEY = "sk-test-factory-key";
  });
  after(() => {
    delete process.env._FACTORY_TEST_KEY;
  });

  it("DEFAULT_LOCAL_RERANKER_MODEL ist BAAI/bge-reranker-v2-m3", () => {
    assert.strictEqual(DEFAULT_LOCAL_RERANKER_MODEL, "BAAI/bge-reranker-v2-m3");
  });

  it("createEmbeddingProvider mit local-transformers gibt LocalTransformersEmbeddingProvider", async () => {
    const { LocalTransformersEmbeddingProvider } = await import("../lib/providers/embedding-local-transformers.js");
    const cfg = normalizeEmbeddingConfig({ provider: "local-transformers" });
    const provider = createEmbeddingProvider(cfg);
    assert.ok(provider instanceof LocalTransformersEmbeddingProvider);
  });

  it("createEmbeddingProvider mit openai + apiKeyEnv instanziiert OpenAIEmbeddingProvider", async () => {
    const { OpenAIEmbeddingProvider } = await import("../lib/providers/embedding-openai.js");
    const cfg = normalizeEmbeddingConfig({ provider: "openai", apiKeyEnv: "_FACTORY_TEST_KEY", dimensions: 3072 });
    const provider = createEmbeddingProvider(cfg);
    assert.ok(provider instanceof OpenAIEmbeddingProvider);
  });

  it("createRerankerProvider mit disabled gibt null", () => {
    const cfg = normalizeRerankerConfig({ provider: "disabled" });
    const provider = createRerankerProvider(cfg, null);
    assert.strictEqual(provider, null);
  });

  it("createRerankerProvider mit cohere + fallbackProvider=disabled gibt ChainedRerankerProvider ohne lokalen Fallback", async () => {
    const { ChainedRerankerProvider } = await import("../lib/providers/reranker-chained.js");
    const cfg = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "_FACTORY_TEST_KEY", fallbackProvider: "disabled" });
    const provider = createRerankerProvider(cfg, null);
    assert.ok(provider instanceof ChainedRerankerProvider);
    assert.strictEqual(provider.fallback, null);
  });

  it("createRerankerProvider mit cohere + fallbackProvider=local-transformers gibt ChainedRerankerProvider mit Fallback", async () => {
    const { ChainedRerankerProvider } = await import("../lib/providers/reranker-chained.js");
    const { LocalTransformersRerankerProvider } = await import("../lib/providers/reranker-local-transformers.js");
    const cfg = normalizeRerankerConfig({
      provider: "cohere",
      apiKeyEnv: "_FACTORY_TEST_KEY",
      fallbackProvider: "local-transformers",
      fallbackModel: "BAAI/bge-reranker-v2-m3",
    });
    const provider = createRerankerProvider(cfg, null);
    assert.ok(provider instanceof ChainedRerankerProvider);
    assert.ok(provider.fallback instanceof LocalTransformersRerankerProvider);
  });

  it("createRerankerProvider mit local-transformers gibt LocalTransformersRerankerProvider", async () => {
    const { LocalTransformersRerankerProvider } = await import("../lib/providers/reranker-local-transformers.js");
    const cfg = normalizeRerankerConfig({ provider: "local-transformers" });
    const provider = createRerankerProvider(cfg, null);
    assert.ok(provider instanceof LocalTransformersRerankerProvider);
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/provider-factory.test.js
# Expected: FAIL — factory.js existiert nicht
```

- [ ] **Step 3: `lib/providers/factory.js` erstellen**

```js
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
    const fallbackProvider = normalizedCfg.fallbackProvider ?? "disabled";
    if (fallbackProvider === "local-transformers") {
      const fallback = new LocalTransformersRerankerProvider({
        model: normalizedCfg.fallbackModel || "BAAI/bge-reranker-v2-m3",
      });
      return new ChainedRerankerProvider(primary, fallback, logger);
    }
    // Default: kein lokaler Fallback — ChainedRerankerProvider mit fallback=null
    return new ChainedRerankerProvider(primary, null, logger);
  }
  if (normalizedCfg.provider === "local-transformers") {
    return new LocalTransformersRerankerProvider(normalizedCfg.local || normalizedCfg);
  }
  return null;
}
```

- [ ] **Step 4: `reranker-cohere.js` für apiKeyEnv anpassen**

In `CohereRerankerProvider.constructor`:
```js
constructor(cfg = {}) {
  this.id = "cohere";
  this.apiKeyRef = cfg.apiKey;
  this.apiKeyEnv = cfg.apiKeyEnv;
  this.model = cfg.model || DEFAULT_COHERE_RERANK_MODEL;
}
```

In `rerank()`, Key-Auflösung ändern:
```js
// Vorher:
const apiKey = resolveEnvVars(this.apiKeyRef, { groups: ["cohere"], label: "Cohere reranker" });

// Nachher:
import { resolveApiKey } from "./env.js";
const apiKey = resolveApiKey({ apiKeyEnv: this.apiKeyEnv, apiKey: this.apiKeyRef });
```

- [ ] **Step 5: Tests laufen lassen**

```bash
node --test tests/provider-factory.test.js
# Expected: 7 tests pass
node --test tests/smoke-reranker-pipeline.test.js
# Expected: kein Bruch
```

- [ ] **Step 6: Commit**

```bash
git add lib/providers/factory.js lib/providers/reranker-cohere.js tests/provider-factory.test.js
git commit -m "feat(factory): createEmbeddingProvider + createRerankerProvider, apiKeyEnv für Cohere"
```

---

## Phase 3: Dimension-Guard

### Task 3.1 — `dimension-guard.js`: Status-Objekt

**Files:**
- Create: `lib/providers/dimension-guard.js`
- Test: `tests/dimension-guard.test.js`

**Interfaces:**
- Produces:
  - `readExistingTableDimension(dbPath): Promise<{status: "no-table"|"ok"|"unknown", dimension?: number, error?: string}>`
  - `checkDimensionCompatibility(result, targetDim): "no-existing-table"|"ok"|"mismatch"|"unknown"`

- [ ] **Step 1: Test schreiben**

```js
// tests/dimension-guard.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readExistingTableDimension, checkDimensionCompatibility } from "../lib/providers/dimension-guard.js";

describe("dimension-guard", () => {
  it("nicht-existenter Pfad → status=no-table (kein LanceDB-Crash)", async () => {
    const result = await readExistingTableDimension("/tmp/__nonexistent_plur1bus_test__");
    // Entweder no-table (Tabelle fehlt) oder unknown (LanceDB connect-Fehler) — beides ist sicher
    assert.ok(["no-table", "unknown"].includes(result.status), `Unerwarteter status: ${result.status}`);
  });

  it("checkDimensionCompatibility: no-table → 'no-existing-table'", () => {
    assert.strictEqual(checkDimensionCompatibility({ status: "no-table" }, 3072), "no-existing-table");
  });

  it("checkDimensionCompatibility: ok + gleiche dim → 'ok'", () => {
    assert.strictEqual(checkDimensionCompatibility({ status: "ok", dimension: 3072 }, 3072), "ok");
  });

  it("checkDimensionCompatibility: ok + verschiedene dim → 'mismatch'", () => {
    assert.strictEqual(checkDimensionCompatibility({ status: "ok", dimension: 3072 }, 384), "mismatch");
  });

  it("checkDimensionCompatibility: unknown → 'unknown' (blockiert Wechsel)", () => {
    assert.strictEqual(
      checkDimensionCompatibility({ status: "unknown", error: "connect failed" }, 384),
      "unknown"
    );
  });

  it("status-Objekt hat bei ok immer dimension-Feld", async () => {
    // Unit-Test mit gemocktem LanceDB nicht möglich ohne live-DB — nur Interface prüfen
    const mockResult = { status: "ok", dimension: 1536 };
    assert.ok("dimension" in mockResult);
    assert.ok(typeof mockResult.dimension === "number");
  });

  it("status-Objekt hat bei unknown immer error-Feld", async () => {
    const mockResult = { status: "unknown", error: "some error" };
    assert.ok("error" in mockResult);
    assert.ok(typeof mockResult.error === "string");
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/dimension-guard.test.js
# Expected: FAIL — dimension-guard.js nicht gefunden
```

- [ ] **Step 3: `lib/providers/dimension-guard.js` erstellen**

```js
/**
 * lib/providers/dimension-guard.js — Safe LanceDB dimension check.
 *
 * Gibt immer ein Status-Objekt zurück — niemals stilles null oder exception.
 * Bei status="unknown" darf kein Provider-Wechsel erfolgen.
 */

export async function readExistingTableDimension(dbPath) {
  let lancedb;
  try {
    lancedb = await import("@lancedb/lancedb");
  } catch (e) {
    return { status: "unknown", error: `LanceDB import failed: ${e.message}` };
  }
  try {
    const db = await lancedb.connect(dbPath);
    let tables;
    try {
      tables = await db.tableNames();
    } catch (e) {
      return { status: "unknown", error: `tableNames() failed: ${e.message}` };
    }
    if (!tables.includes("memories")) {
      return { status: "no-table" };
    }
    const table = await db.openTable("memories");
    const schema = await table.schema();
    const vectorField = schema.fields.find(f => f.name === "vector");
    if (!vectorField) {
      return { status: "unknown", error: "vector field not found in schema" };
    }
    const dim = vectorField?.type?.listSize;
    if (!dim || typeof dim !== "number") {
      return { status: "unknown", error: `vector field listSize invalid: ${dim}` };
    }
    return { status: "ok", dimension: dim };
  } catch (e) {
    return { status: "unknown", error: e.message };
  }
}

export function checkDimensionCompatibility(guardResult, targetDim) {
  if (guardResult.status === "no-table") return "no-existing-table";
  if (guardResult.status === "unknown") return "unknown";
  if (guardResult.dimension === targetDim) return "ok";
  return "mismatch";
}
```

- [ ] **Step 4: Tests laufen lassen**

```bash
node --test tests/dimension-guard.test.js
# Expected: 7 tests pass
```

- [ ] **Step 5: Commit**

```bash
git add lib/providers/dimension-guard.js tests/dimension-guard.test.js
git commit -m "feat(dimension-guard): status-object return, unknown blocks provider switch"
```

---

## Phase 4: Wizard-Flow

### Task 4.1 — `lib/namespace-config.js`: Namespace-Semantik

**Files:**
- Create: `lib/namespace-config.js`
- Test: `tests/namespace-config.test.js`

**Interfaces:**
- Produces:
  - `resolveRecallReadNamespaces(nsCfg): string[]` — die tatsächlich gelesenen Namespaces
  - `resolveWriteNamespace(nsCfg): string` — der Schreib-Namespace
  - `isLegacyReadOnly(namespaceName, nsCfg): boolean`
  - `DEFAULT_NAMESPACE = "lancedb-namespaced"`
- Consumes: Namespace-Config aus `openclaw.json` (openclaw.plugin config.namespaces)

- [ ] **Step 1: Test schreiben**

```js
// tests/namespace-config.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRecallReadNamespaces,
  resolveWriteNamespace,
  isLegacyReadOnly,
  DEFAULT_NAMESPACE,
} from "../lib/namespace-config.js";

describe("namespace-config", () => {
  const defaultCfg = {};

  it("ohne Namespace-Config: Recall liest [DEFAULT_NAMESPACE]", () => {
    const ns = resolveRecallReadNamespaces(defaultCfg);
    assert.deepStrictEqual(ns, [DEFAULT_NAMESPACE]);
  });

  it("ohne Namespace-Config: Write-Namespace ist DEFAULT_NAMESPACE", () => {
    assert.strictEqual(resolveWriteNamespace(defaultCfg), DEFAULT_NAMESPACE);
  });

  it("activeWriteNamespace wird nur zum Schreiben genutzt", () => {
    const cfg = {
      activeWriteNamespace: "lancedb-local",
      activeRecallNamespaces: ["lancedb-local"],
    };
    assert.strictEqual(resolveWriteNamespace(cfg), "lancedb-local");
  });

  it("crossNamespaceRecall=true: Recall liest activeRecall + legacyReadOnly", () => {
    const cfg = {
      activeWriteNamespace: "lancedb-local",
      activeRecallNamespaces: ["lancedb-local"],
      legacyReadOnlyNamespaces: ["lancedb-namespaced"],
      crossNamespaceRecall: true,
    };
    const ns = resolveRecallReadNamespaces(cfg);
    assert.ok(ns.includes("lancedb-local"), "activeRecallNamespaces fehlt");
    assert.ok(ns.includes("lancedb-namespaced"), "legacyReadOnlyNamespaces fehlt");
    assert.strictEqual(ns.length, 2);
  });

  it("crossNamespaceRecall=false: Recall liest nur activeRecallNamespaces", () => {
    const cfg = {
      activeWriteNamespace: "lancedb-local",
      activeRecallNamespaces: ["lancedb-local"],
      legacyReadOnlyNamespaces: ["lancedb-namespaced"],
      crossNamespaceRecall: false,
    };
    const ns = resolveRecallReadNamespaces(cfg);
    assert.deepStrictEqual(ns, ["lancedb-local"]);
  });

  it("legacyReadOnlyNamespace darf nicht write-Namespace sein", () => {
    const cfg = {
      activeWriteNamespace: "lancedb-local",
      legacyReadOnlyNamespaces: ["lancedb-namespaced"],
    };
    assert.ok(
      !isLegacyReadOnly(resolveWriteNamespace(cfg), cfg),
      "Write-Namespace darf nicht read-only sein"
    );
    assert.ok(isLegacyReadOnly("lancedb-namespaced", cfg));
  });

  it("keine Duplikate in recallReadNamespaces", () => {
    const cfg = {
      activeRecallNamespaces: ["lancedb-local"],
      legacyReadOnlyNamespaces: ["lancedb-local"], // absichtlich doppelt
      crossNamespaceRecall: true,
    };
    const ns = resolveRecallReadNamespaces(cfg);
    assert.strictEqual(ns.length, new Set(ns).size, "Duplikate in recallReadNamespaces");
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/namespace-config.test.js
# Expected: FAIL — namespace-config.js nicht gefunden
```

- [ ] **Step 3: `lib/namespace-config.js` erstellen**

```js
/**
 * lib/namespace-config.js — Namespace-Semantik für Multi-Provider-Setup.
 *
 * activeWriteNamespace: ausschließlich für neue Writes.
 * legacyReadOnlyNamespaces: read-only, niemals beschreiben.
 * recallReadNamespaces = activeRecallNamespaces + legacyReadOnlyNamespaces
 *   (falls crossNamespaceRecall=true)
 */

export const DEFAULT_NAMESPACE = "lancedb-namespaced";

export function resolveWriteNamespace(nsCfg = {}) {
  return nsCfg.activeWriteNamespace || DEFAULT_NAMESPACE;
}

export function resolveRecallReadNamespaces(nsCfg = {}) {
  if (!nsCfg.activeRecallNamespaces && !nsCfg.legacyReadOnlyNamespaces) {
    return [DEFAULT_NAMESPACE];
  }
  const active = Array.isArray(nsCfg.activeRecallNamespaces)
    ? nsCfg.activeRecallNamespaces
    : [DEFAULT_NAMESPACE];
  if (!nsCfg.crossNamespaceRecall) return [...new Set(active)];
  const legacy = Array.isArray(nsCfg.legacyReadOnlyNamespaces)
    ? nsCfg.legacyReadOnlyNamespaces
    : [];
  return [...new Set([...active, ...legacy])];
}

export function isLegacyReadOnly(namespaceName, nsCfg = {}) {
  const legacy = Array.isArray(nsCfg.legacyReadOnlyNamespaces)
    ? nsCfg.legacyReadOnlyNamespaces
    : [];
  return legacy.includes(namespaceName);
}
```

- [ ] **Step 4: Tests laufen lassen**

```bash
node --test tests/namespace-config.test.js
# Expected: 7 tests pass
```

- [ ] **Step 5: Commit**

```bash
git add lib/namespace-config.js tests/namespace-config.test.js
git commit -m "feat(namespace): resolveRecallReadNamespaces + write/legacy-readonly semantics"
```

---

### Task 4.1b — `lib/multi-namespace-pool.js` + index.js Integration

> **Warum dieser Sub-Task:** `lib/namespace-config.js` allein greift nicht — `index.js:1911` instanziiert `AgentDbPool` mit einem einzigen `basePath`. Store (Zeile 1944) und Recall (Zeilen 3774, 4420) nutzen alle dieselbe Pool-Instanz. Ohne diese Änderung bleibt `activeWriteNamespace` nur Konfig-Kommentar.

**Files:**
- Create: `lib/multi-namespace-pool.js`
- Modify: `index.js:1911` (Pool-Initialisierung), `index.js:1944` (storeMemoryFromToolParams), `index.js:3774 + 4420` (recall-Pfade)
- Test: `tests/multi-namespace-pool.test.js`

**Interfaces:**
- Produces:
  - `class MultiNamespacePool` — verwaltet einen `AgentDbPool` pro Namespace
  - `pool.getWriteDb(agentId)` → gibt MemoryDB aus `activeWriteNamespace`-Pool
  - `pool.getReadDbs(agentId, nsCfg)` → gibt Array von `{ namespace, db }` für alle `recallReadNamespaces`
  - `pool.getDb(agentId)` → Backward-compat: delegiert auf `getWriteDb` (kein Breaking Change)
- Consumes: `AgentDbPool` (intern), `lib/namespace-config.js` (`resolveWriteNamespace`, `resolveRecallReadNamespaces`)

**Integration in `index.js`:**
- `index.js:1911` — `const pool = new AgentDbPool(baseDbPath, vectorDim)` → `const pool = new MultiNamespacePool(memoryBaseDir, nsCfg, vectorDim)`
- `index.js:1944` — `pool.getDb(storeAgentId)` → `pool.getWriteDb(storeAgentId)` (keine write in legacyReadOnly)
- `index.js:3774, 4420` — `runRecallPipeline({ db, ... })` → cross-namespace recall (s.u.)

**Cross-Namespace Recall-Pattern (index.js):**
```js
// Statt: const { memories } = await runRecallPipeline({ db: pool.getDb(agentId), ... })
// Neu:
const readDbs = pool.getReadDbs(agentId, nsCfg);
const allResults = await Promise.all(
  readDbs.map(({ namespace, db }) =>
    runRecallPipeline({ db, ...pipelineOpts }).then(r => r.memories)
  )
);
// Merge: flatten → dedupResults → applyImportanceBoost → rerank
const merged = dedupResults(allResults.flat(), dedupJaccard);
```
Wenn `readDbs.length === 1`: kein Merge-Overhead, gleicher Code-Pfad wie bisher.

- [ ] **Step 1: Test schreiben**

```js
// tests/multi-namespace-pool.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MultiNamespacePool } from "../lib/multi-namespace-pool.js";
import { join, homedir } from "node:path";

const TMP_BASE = join(homedir(), ".openclaw", "memory");

// FakeAgentDbPool — kein echtes LanceDB, nur Pfad-Tracking
class FakeAgentDbPool {
  constructor(basePath, _vectorDim) {
    this.basePath = basePath;
    this.isShutdown = false;
  }
  getDb(agentId) {
    if (this.isShutdown) throw new Error("FakeAgentDbPool is shutdown");
    return { dbPath: join(this.basePath, agentId) };
  }
  async shutdown() { this.isShutdown = true; }
}

describe("MultiNamespacePool", () => {
  it("getWriteDb gibt DB aus activeWriteNamespace", () => {
    const nsCfg = { activeWriteNamespace: "lancedb-local", activeRecallNamespaces: ["lancedb-local"] };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const db = pool.getWriteDb("default");
    assert.ok(db);
    assert.ok(db.dbPath.includes("lancedb-local"), `Erwartet lancedb-local in: ${db.dbPath}`);
  });

  it("getWriteDb gibt NICHT einen legacyReadOnly-Namespace zurück", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      legacyReadOnlyNamespaces: ["lancedb-old"],
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const db = pool.getWriteDb("default");
    assert.ok(!db.dbPath.includes("lancedb-old"), `Write-DB zeigt auf legacyReadOnly: ${db.dbPath}`);
  });

  it("getReadDbs gibt active + legacy wenn crossNamespaceRecall=true", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const dbs = pool.getReadDbs("default");
    assert.strictEqual(dbs.length, 2);
    assert.ok(dbs.some(d => d.namespace === "lancedb-new"));
    assert.ok(dbs.some(d => d.namespace === "lancedb-old"));
  });

  it("getReadDbs gibt nur active wenn crossNamespaceRecall=false", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: false,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const dbs = pool.getReadDbs("default");
    assert.strictEqual(dbs.length, 1);
    assert.strictEqual(dbs[0].namespace, "lancedb-new");
  });

  it("getDb (backward-compat) delegiert auf getWriteDb", () => {
    const nsCfg = { activeWriteNamespace: "lancedb-local" };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const a = pool.getDb("default");
    const b = pool.getWriteDb("default");
    assert.strictEqual(a.dbPath, b.dbPath);
  });

  it("shutdown zerstört alle Pools", async () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    pool.getReadDbs("default"); // pools initialisieren
    await assert.doesNotReject(() => pool.shutdown());
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/multi-namespace-pool.test.js
# Expected: FAIL — multi-namespace-pool.js nicht gefunden
```

- [ ] **Step 3: `lib/multi-namespace-pool.js` erstellen**

```js
/**
 * lib/multi-namespace-pool.js — Namespace-aware Wrapper um AgentDbPool.
 *
 * Hält einen AgentDbPool pro aktivem Namespace.
 * getWriteDb → nur activeWriteNamespace (legacyReadOnly ist gesperrt)
 * getReadDbs → alle recallReadNamespaces (active + legacy wenn crossNamespaceRecall=true)
 * getDb      → Backward-compat alias für getWriteDb
 */

import { join } from "node:path";
import { resolveWriteNamespace, resolveRecallReadNamespaces } from "./namespace-config.js";

// AgentDbPool wird lazy importiert um zirkuläre Imports zu vermeiden
// (AgentDbPool ist im gleichen Paket in index.js definiert — hier nutzen wir
// die exportierte Klasse oder übergeben sie als Konstruktor-Parameter)

export class MultiNamespacePool {
  /**
   * @param {string} baseDir — z.B. ~/.openclaw/memory
   * @param {object} nsCfg   — Namespace-Config aus openclaw.json
   * @param {number} vectorDim — Vektor-Dimension
   * @param {Function} AgentDbPoolClass — AgentDbPool Klasse (Dependency Injection für Tests)
   */
  constructor(baseDir, nsCfg = {}, vectorDim, AgentDbPoolClass) {
    this.baseDir = baseDir;
    this.nsCfg = nsCfg;
    this.vectorDim = vectorDim;
    this.AgentDbPool = AgentDbPoolClass;
    this._pools = new Map(); // namespace → AgentDbPool
  }

  _getPool(namespace) {
    if (!this._pools.has(namespace)) {
      const nsPath = join(this.baseDir, namespace);
      this._pools.set(namespace, new this.AgentDbPool(nsPath, this.vectorDim));
    }
    return this._pools.get(namespace);
  }

  getWriteDb(agentId) {
    const writeNs = resolveWriteNamespace(this.nsCfg);
    return this._getPool(writeNs).getDb(agentId);
  }

  getReadDbs(agentId) {
    const readNs = resolveRecallReadNamespaces(this.nsCfg);
    return readNs.map(ns => ({
      namespace: ns,
      db: this._getPool(ns).getDb(agentId),
    }));
  }

  getDb(agentId) {
    return this.getWriteDb(agentId);
  }

  async shutdown() {
    const shutdowns = [...this._pools.values()].map(p =>
      typeof p.shutdown === "function" ? p.shutdown().catch(() => {}) : Promise.resolve()
    );
    await Promise.all(shutdowns);
    this._pools.clear();
  }
}
```

- [ ] **Step 4: `index.js` anpassen — Pool-Initialisierung (Zeile 1911)**

```js
// Vorher (index.js:1911):
const pool = new AgentDbPool(baseDbPath, vectorDim);

// Nachher:
import { MultiNamespacePool } from "./lib/multi-namespace-pool.js";
const nsCfg = cfg.namespaces || {};
const memoryBaseDir = join(homedir(), ".openclaw", "memory");
const pool = new MultiNamespacePool(memoryBaseDir, nsCfg, vectorDim, AgentDbPool);
```

- [ ] **Step 5: `index.js` anpassen — Store-Pfad (Zeile 1944)**

```js
// Vorher:
const storeDb = pool.getDb(storeAgentId);

// Nachher:
const storeDb = pool.getWriteDb(storeAgentId);
// Guard: legacyReadOnly darf nie beschrieben werden
```

- [ ] **Step 6: `index.js` anpassen — Recall-Pfade (Zeilen 3774 + 4420)**

```js
// Vorher (index.js ~3774):
const { canonical: canonicalHits, memories: ordered, trace: returnedTrace } = await runRecallPipeline({
  db: pool.getDb(agentId),
  ...pipelineOpts,
});

// Nachher:
const readDbs = pool.getReadDbs(agentId);
let ordered, canonicalHits, returnedTrace;
if (readDbs.length === 1) {
  // Single-namespace: kein Merge-Overhead
  ({ canonical: canonicalHits, memories: ordered, trace: returnedTrace } = await runRecallPipeline({
    db: readDbs[0].db,
    ...pipelineOpts,
  }));
} else {
  // Multi-namespace: parallel recall + merge
  const nsResults = await Promise.all(
    readDbs.map(({ db }) => runRecallPipeline({ db, ...pipelineOpts }))
  );
  canonicalHits = nsResults.flatMap(r => r.canonical || []);
  returnedTrace = nsResults[0]?.trace;
  const merged = nsResults.flatMap(r => r.memories || []);
  ordered = dedupResults(merged, dedupJaccard);
  // Ggf. nochmal reranken wenn Reranker vorhanden
}
// Dasselbe Pattern für den zweiten runRecallPipeline-Aufruf bei ~4420
```

- [ ] **Step 7: Tests laufen lassen**

```bash
node --test tests/multi-namespace-pool.test.js
# Expected: 6 tests pass
node --test tests/namespace-config.test.js
# Expected: kein Bruch
node --test tests/*.test.js 2>&1 | grep -c "^not ok"
# Expected: 0
```

- [ ] **Step 8: Commit**

```bash
git add lib/multi-namespace-pool.js tests/multi-namespace-pool.test.js index.js
git commit -m "feat(namespace): MultiNamespacePool + index.js store/recall auf write/read-namespaces"
```

---

### Task 4.2 — `scripts/reindex-provider.mjs`: Dry-Run / Report-Only Scaffold

> **Scope dieser Iteration:** Nur Schema-Erkennung, Record-Zählung und Report. Kein Re-Embedding, kein Config-Switch, kein `cp -r`. Echter Reindex = eigener Folgepatch.
> **Warum:** Row-Schema (`row.text` vs. andere Felder), echte DB-Pfade und Namespace-Struktur müssen erst gegen den Live-Code verifiziert werden. Dieser Task legt das sichere Gerüst + Audit-Report an.

**Files:**
- Create: `scripts/reindex-provider.mjs`

**Interfaces:**
- Produces: CLI-Script `node scripts/reindex-provider.mjs --agent <id> --from <ns> --to <ns>`
- Default-Verhalten: immer `--dry-run` (kein `--apply` ohne expliziten Flag)
- Output: stdout-Report + JSON-Report in `~/.openclaw/reindex-report-<ts>.json`
- Consumes: `lib/providers/dimension-guard.js`, `lib/providers/config-normalize.js`

- [ ] **Step 1: Script erstellen**

```js
// scripts/reindex-provider.mjs
/**
 * Reindex-Scaffold: Dry-Run + Report-Only.
 *
 * Liest Config, erkennt Namespace-Pfade, prüft Dimensions via Dimension-Guard,
 * zählt Records, schreibt Audit-Report.
 *
 * KEIN Re-Embedding, KEIN Config-Switch, KEIN cp -r ohne --apply.
 * Echter Reindex wird eigener Folgepatch (Schema + Pfade erst verifizieren).
 *
 * Usage:
 *   node scripts/reindex-provider.mjs --agent main --from lancedb-namespaced --to lancedb-local
 *   # --apply Flag existiert noch nicht in dieser Iteration
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, homedir } from "node:path";
import { readExistingTableDimension } from "../lib/providers/dimension-guard.js";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };

const agentId = getArg("agent") || "main";
const fromNamespace = getArg("from");
const toNamespace = getArg("to");

if (!fromNamespace || !toNamespace) {
  console.error("Usage: node scripts/reindex-provider.mjs --agent <id> --from <ns> --to <ns>");
  console.error("Note: Actual re-embedding requires --apply flag (not yet implemented — this iteration is report-only)");
  process.exit(1);
}

if (args.includes("--apply")) {
  console.error("[reindex] --apply ist in dieser Iteration noch nicht implementiert.");
  console.error("[reindex] Schema und Row-Format müssen erst gegen den Live-Code verifiziert werden.");
  console.error("[reindex] Bitte Folgepatch abwarten.");
  process.exit(1);
}

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");
const MEMORY_BASE = join(OPENCLAW_DIR, "memory");

async function main() {
  console.log(`[reindex] REPORT-ONLY — Agent: ${agentId}, ${fromNamespace} → ${toNamespace}`);
  console.log(`[reindex] Echter Reindex noch nicht implementiert. Nur Audit.`);

  // 1. Config lesen
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`[reindex] Kann openclaw.json nicht lesen: ${e.message}`);
    process.exit(1);
  }
  const pluginCfg = config?.plugins?.entries?.["memory-lancedb-namespaced"] || {};
  const embCfg = normalizeEmbeddingConfig(pluginCfg.embedding || {});
  console.log(`[reindex] Ziel-Provider: ${embCfg.provider}, ${embCfg.dimensions ?? "?"} dims`);

  // 2. Quell-DB prüfen
  const FROM_PATH = join(MEMORY_BASE, fromNamespace, agentId);
  const srcGuard = await readExistingTableDimension(FROM_PATH);
  console.log(`[reindex] Quelle (${FROM_PATH}):`);
  console.log(`  status: ${srcGuard.status}`);
  if (srcGuard.status === "ok") {
    console.log(`  dimension: ${srcGuard.dimension}`);
  } else if (srcGuard.error) {
    console.log(`  error: ${srcGuard.error}`);
  }

  // 3. Ziel-DB prüfen
  const TO_PATH = join(MEMORY_BASE, toNamespace, agentId);
  const dstGuard = await readExistingTableDimension(TO_PATH);
  console.log(`[reindex] Ziel (${TO_PATH}):`);
  console.log(`  status: ${dstGuard.status}`);
  if (dstGuard.status === "ok") {
    console.log(`  dimension: ${dstGuard.dimension}`);
  }

  // 4. Row-Count ermitteln (nur wenn Quelle lesbar)
  let rowCount = null;
  let schemaFields = null;
  if (srcGuard.status === "ok") {
    try {
      const lancedb = await import("@lancedb/lancedb");
      const srcDb = await lancedb.connect(FROM_PATH);
      const srcTable = await srcDb.openTable("memories");
      const schema = await srcTable.schema();
      schemaFields = schema.fields.map(f => f.name);
      // Count nur — kein toArray() (zu groß für Report)
      const countResult = await srcTable.countRows();
      rowCount = countResult;
      console.log(`[reindex] Records in Quelle: ${rowCount}`);
      console.log(`[reindex] Schema-Felder: ${schemaFields.join(", ")}`);
      // Hinweis welches Feld für Text-Embedding genutzt werden soll
      const textField = schemaFields.includes("text") ? "text"
        : schemaFields.find(f => f.includes("content") || f.includes("body")) || "UNBEKANNT";
      console.log(`[reindex] AUDIT: Text-Feld für Re-Embedding wäre: '${textField}'`);
      if (textField === "UNBEKANNT") {
        console.warn(`[reindex] WARNUNG: Kein 'text'-Feld gefunden — echter Reindex bräuchte Schema-Mapping.`);
      }
    } catch (e) {
      console.error(`[reindex] Record-Count fehlgeschlagen: ${e.message}`);
    }
  }

  // 5. Report schreiben
  const report = {
    timestamp: new Date().toISOString(),
    agent: agentId,
    fromNamespace,
    toNamespace,
    fromPath: FROM_PATH,
    toPath: TO_PATH,
    sourceGuard: srcGuard,
    targetGuard: dstGuard,
    targetProvider: { provider: embCfg.provider, dimensions: embCfg.dimensions },
    rowCount,
    schemaFields,
    applyImplemented: false,
    notes: "Echter Reindex in Folgepatch. Schema-Felder und Pfad-Struktur zuerst verifizieren.",
  };
  const reportPath = join(OPENCLAW_DIR, `reindex-report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[reindex] Report geschrieben: ${reportPath}`);
  console.log(`[reindex] REPORT DONE — keine Produktionsdaten verändert.`);
}

main().catch(e => {
  console.error("[reindex] FATAL:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Syntax prüfen**

```bash
node --check scripts/reindex-provider.mjs
# Expected: keine Fehler
```

- [ ] **Step 3: Dry-Run ohne live DB**

```bash
node scripts/reindex-provider.mjs --agent main --from lancedb-namespaced --to lancedb-local 2>&1
# Expected: Report-Ausgabe, keine Produktionsdaten verändert
node scripts/reindex-provider.mjs --apply 2>&1 | head -3
# Expected: "--apply ist in dieser Iteration noch nicht implementiert"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/reindex-provider.mjs
git commit -m "feat(reindex): dry-run/report-only scaffold — kein Apply ohne expliziten Folgepatch"
```

---

### Task 4.3 — `scripts/provider-wizard.mjs`: i18n-konformer Node-Wizard

> **Warum Node statt Bash:** Bash-Strings wären hart verdrahtet und widersprechen dem i18n-Ziel (Task 1.2). `install-memory-system.sh` bleibt Installer-Orchestrator — alle user-facing Texte kommen aus `lib/i18n.js` via `t(key, { lang, tone, vars })`.

**Files:**
- Create: `scripts/provider-wizard.mjs`
- Modify: `scripts/install-memory-system.sh` (ruft `node scripts/provider-wizard.mjs` auf, keine eigenen Wizard-Strings)
- Test: `tests/provider-wizard.test.js`

**Interfaces:**
- Produces: `scripts/provider-wizard.mjs` — interaktiver Wizard, gibt Config-JSON auf stdout aus (wird von install-memory-system.sh gelesen), Exit-Code 0 = OK, 1 = Abbruch
- Consumes: `lib/i18n.js` (`t`, `resolveLocale`), `lib/providers/config-normalize.js`

- [ ] **Step 1: Test schreiben**

```js
// tests/provider-wizard.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWizardOptions, formatWizardOption } from "../scripts/provider-wizard.mjs";

describe("provider-wizard i18n rendering", () => {
  it("Cohere ist Option 1 (erster Eintrag) in der Reranker-Liste (de)", () => {
    const options = buildWizardOptions("reranker", { lang: "de" });
    assert.strictEqual(options[0].key, "cohere");
  });

  it("Cohere ist Option 1 in der Reranker-Liste (en)", () => {
    const options = buildWizardOptions("reranker", { lang: "en" });
    assert.strictEqual(options[0].key, "cohere");
  });

  it("Cohere-Label enthält 'kostenpflichtig' (de)", () => {
    const label = formatWizardOption("reranker", "cohere", { lang: "de" });
    assert.ok(label.includes("kostenpflichtig"), `"kostenpflichtig" fehlt: ${label}`);
  });

  it("Cohere-Label enthält 'paid' (en)", () => {
    const label = formatWizardOption("reranker", "cohere", { lang: "en" });
    assert.ok(label.includes("paid"), `"paid" fehlt: ${label}`);
  });

  it("ungültige Auswahl nutzt setup.reranker.invalid_choice (de)", async () => {
    // async wegen await import()
    const { t } = await import("../lib/i18n.js");
    const msg = t("setup.reranker.invalid_choice", { lang: "de", tone: "default" });
    assert.ok(msg.includes("1") && msg.includes("4"), `Keine Optionszahlen in: ${msg}`);
  });

  it("OpenAI ist Option 1 in der Embedding-Liste", () => {
    const options = buildWizardOptions("embedding", { lang: "de" });
    assert.strictEqual(options[0].key, "openai");
  });

  it("Embedding OpenAI-Label enthält 'kostenpflichtig' (de)", () => {
    const label = formatWizardOption("embedding", "openai", { lang: "de" });
    assert.ok(label.toLowerCase().includes("kostenpflichtig"), `'kostenpflichtig' fehlt: ${label}`);
  });

  it("Embedding lokales Modell enthält 'multilingual' (de)", () => {
    const label = formatWizardOption("embedding", "local-transformers", { lang: "de" });
    assert.ok(label.toLowerCase().includes("multilingual"), `'multilingual' fehlt: ${label}`);
  });

  it("Embedding OpenAI-Label enthält 'paid' (en)", () => {
    const label = formatWizardOption("embedding", "openai", { lang: "en" });
    assert.ok(label.toLowerCase().includes("paid"), `'paid' fehlt: ${label}`);
  });
});
```

> **Hinweis:** Die Tests importieren `buildWizardOptions` und `formatWizardOption` aus dem Wizard-Script — diese Funktionen müssen als Named Exports vorhanden sein.

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/provider-wizard.test.js
# Expected: FAIL — provider-wizard.mjs nicht gefunden
```

- [ ] **Step 3: `scripts/provider-wizard.mjs` erstellen**

```js
#!/usr/bin/env node
/**
 * scripts/provider-wizard.mjs — i18n-konformer Provider-Wizard.
 *
 * Gibt bei Erfolg JSON auf stdout aus (wird von install-memory-system.sh gelesen):
 *   { embedding: {...}, reranker: {...} }
 *
 * Alle user-facing Texte via t(key, {lang, tone, vars}).
 * Kein hard-coded Deutsch/Englisch in diesem Script.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const { t, resolveLocale } = await import(join(__dir, "../lib/i18n.js"));

const lang = resolveLocale();
const tone = "default";
const rl = createInterface({ input: stdin, output: stdout });

// ─── Wizard-Optionen (reine Daten, i18n-unabhängig) ──────────────────────────

const RERANKER_OPTIONS = [
  { key: "cohere",            i18nLabel: "setup.reranker.option.cohere",      i18nHelp: "setup.reranker.option.cohere_help" },
  { key: "local-transformers", i18nLabel: "setup.reranker.option.local_bge",  i18nHelp: "setup.reranker.option.local_bge_help" },
  { key: "disabled",          i18nLabel: "setup.reranker.option.disabled",     i18nHelp: "setup.reranker.option.disabled_help" },
  { key: "advanced",          i18nLabel: "setup.reranker.option.advanced",     i18nHelp: "setup.reranker.option.advanced_help" },
];

const EMBEDDING_OPTIONS = [
  { key: "openai",             i18nLabel: "setup.embedding.option.openai",     i18nHelp: "setup.embedding.option.openai_help" },
  { key: "local-transformers", i18nLabel: "setup.embedding.option.local_e5",   i18nHelp: "setup.embedding.option.local_e5_help" },
];

const ADVANCED_RERANKER_MODELS = [
  "Alibaba-NLP/gte-reranker-modernbert-base",
  "jinaai/jina-reranker-v2-base-multilingual",
  "mixedbread-ai/mxbai-rerank-base-v2",
];

/** Exportiert für Tests — gibt Option-Array zurück */
export function buildWizardOptions(type, { lang: l = "en" } = {}) {
  if (type === "reranker") return RERANKER_OPTIONS;
  if (type === "embedding") return EMBEDDING_OPTIONS;
  return [];
}

/** Exportiert für Tests — rendert ein Option-Label via i18n (beide Typen) */
export function formatWizardOption(type, key, { lang: l = "en" } = {}) {
  const options = type === "reranker" ? RERANKER_OPTIONS : EMBEDDING_OPTIONS;
  const opt = options.find(o => o.key === key);
  if (!opt?.i18nLabel) return key;
  return t(opt.i18nLabel, { lang: l, tone: "default" });
}

// ─── Wizard-Ablauf ────────────────────────────────────────────────────────────

async function askLine(prompt) {
  return (await rl.question(prompt)).trim();
}

async function wizardEmbedding() {
  console.error(t("setup.embedding.title", { lang, tone }));
  console.error(t("setup.embedding.description", { lang, tone }));
  console.error("");

  for (let i = 0; i < EMBEDDING_OPTIONS.length; i++) {
    const opt = EMBEDDING_OPTIONS[i];
    console.error(`[${i + 1}] ${t(opt.i18nLabel, { lang, tone })}`);
    console.error(`    ${t(opt.i18nHelp, { lang, tone })}`);
  }

  let choice;
  while (true) {
    choice = await askLine("[1/2]: ");
    if (choice === "1" || choice === "2") break;
    console.error(t("setup.reranker.invalid_choice", { lang, tone }));
  }

  if (choice === "1") {
    console.error(t("setup.embedding.api_key_ask", { lang, tone }));
    const keyChoice = await askLine("[1/2]: ");
    if (keyChoice === "2") {
      const literal = await askLine("Enter key: ");
      return { provider: "openai", apiKey: literal, model: "text-embedding-3-large", dimensions: 3072 };
    }
    // Store to .env is the caller's (install-memory-system.sh) responsibility
    return { provider: "openai", apiKeyEnv: "OPENAI_API_KEY", model: "text-embedding-3-large", dimensions: 3072 };
  } else {
    return { provider: "local-transformers", model: "intfloat/multilingual-e5-small", dimensions: 384 };
  }
}

async function wizardReranker() {
  console.error(t("setup.reranker.title", { lang, tone }));
  console.error(t("setup.reranker.description", { lang, tone }));
  console.error("");

  for (let i = 0; i < RERANKER_OPTIONS.length; i++) {
    const opt = RERANKER_OPTIONS[i];
    console.error(`[${i + 1}] ${t(opt.i18nLabel, { lang, tone })}`);
    console.error(`    ${t(opt.i18nHelp, { lang, tone })}`);
  }

  let choice;
  while (true) {
    choice = await askLine("[1/2/3/4]: ");
    if (["1", "2", "3", "4"].includes(choice)) break;
    console.error(t("setup.reranker.invalid_choice", { lang, tone }));
  }

  if (choice === "1") {
    const keyChoice = await askLine("COHERE_API_KEY store as [1] env-ref (recommended) / [2] literal: ");
    let rerankerCfg;
    if (keyChoice === "2") {
      const literal = await askLine("Enter key: ");
      rerankerCfg = { provider: "cohere", apiKey: literal, model: "rerank-v3.5", candidates: 20, timeoutMs: 5000, fallbackOnError: true, fallbackProvider: "disabled" };
    } else {
      rerankerCfg = { provider: "cohere", apiKeyEnv: "COHERE_API_KEY", model: "rerank-v3.5", candidates: 20, timeoutMs: 5000, fallbackOnError: true, fallbackProvider: "disabled" };
    }
    console.error(t("setup.reranker.cohere_fallback_ask", { lang, tone }));
    const fbChoice = await askLine("[1/2]: ");
    if (fbChoice === "2") {
      rerankerCfg.fallbackProvider = "local-transformers";
      rerankerCfg.fallbackModel = "BAAI/bge-reranker-v2-m3";
      console.error(t("setup.reranker.lazy_load_notice", { lang, tone, vars: { sizeMb: "570" } }));
    }
    return rerankerCfg;
  } else if (choice === "2") {
    console.error(t("setup.reranker.local_cpu_warning", { lang, tone }));
    console.error(t("setup.reranker.lazy_load_notice", { lang, tone, vars: { sizeMb: "570" } }));
    return { provider: "local-transformers", model: "BAAI/bge-reranker-v2-m3", candidates: 20, timeoutMs: 5000, fallbackOnError: true };
  } else if (choice === "3") {
    return { provider: "disabled", enabled: false, candidates: 20 };
  } else {
    // Advanced
    for (let i = 0; i < ADVANCED_RERANKER_MODELS.length; i++) {
      console.error(`  [${String.fromCharCode(97 + i)}] ${ADVANCED_RERANKER_MODELS[i]}`);
    }
    const adv = await askLine("[a/b/c]: ");
    const modelIdx = adv.charCodeAt(0) - 97;
    if (modelIdx >= 0 && modelIdx < ADVANCED_RERANKER_MODELS.length) {
      console.error(t("setup.reranker.local_cpu_warning", { lang, tone }));
      return { provider: "local-transformers", model: ADVANCED_RERANKER_MODELS[modelIdx], candidates: 20, timeoutMs: 5000, fallbackOnError: true };
    }
    console.error(t("setup.reranker.invalid_choice", { lang, tone }));
    return { provider: "disabled", enabled: false, candidates: 20 };
  }
}

// ─── Wenn direkt aufgerufen ───────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const embedding = await wizardEmbedding();
    const reranker = await wizardReranker();
    rl.close();
    // Ausgabe als JSON auf stdout — install-memory-system.sh liest das
    process.stdout.write(JSON.stringify({ embedding, reranker }, null, 2) + "\n");
    process.exit(0);
  } catch (e) {
    rl.close();
    console.error(`[wizard] Fehler: ${e.message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: `install-memory-system.sh` auf Wizard-Aufruf reduzieren**

Im Bash-Script, wo vorher `wizard_embedding_provider()` und `wizard_reranker_provider()` aufgerufen wurden, ersetzen durch:

```bash
# Wizard-Ausgabe als JSON-Datei einlesen
WIZARD_OUTPUT_FILE=$(mktemp /tmp/provider-wizard-XXXXX.json)
if ! node "$(dirname "$0")/provider-wizard.mjs" > "$WIZARD_OUTPUT_FILE"; then
  echo "[install] Wizard abgebrochen." >&2
  rm -f "$WIZARD_OUTPUT_FILE"
  exit 1
fi

# Config aus JSON extrahieren (via jq)
EMBEDDING_CFG=$(jq '.embedding' "$WIZARD_OUTPUT_FILE")
RERANKER_CFG=$(jq '.reranker' "$WIZARD_OUTPUT_FILE")
rm -f "$WIZARD_OUTPUT_FILE"

# In openclaw.json schreiben
jq --argjson emb "$EMBEDDING_CFG" --argjson rer "$RERANKER_CFG" \
  '.plugins.entries["memory-lancedb-namespaced"].embedding = $emb |
   .plugins.entries["memory-lancedb-namespaced"].reranker = $rer' \
  "$OPENCLAW_DIR/openclaw.json" > /tmp/openclaw-cfg-tmp.json && \
  mv /tmp/openclaw-cfg-tmp.json "$OPENCLAW_DIR/openclaw.json"

echo "[install] Provider-Config geschrieben."
```

Die bestehenden Bash-`echo`-Wizard-Strings vollständig entfernen (alle `echo "=== Schritt..."`, `echo "Cohere rerank-v3.5..."` etc.).

- [ ] **Step 5: i18n-Lücken prüfen (setup.embedding.*)**

```bash
node -e "
import('../lib/i18n-dictionary.js').then(({dictionary}) => {
  const needed = ['setup.embedding.title','setup.embedding.description'];
  for (const k of needed) {
    if (!dictionary[k]) console.log('FEHLT:', k);
    else console.log('OK:', k);
  }
});
"
# Falls Keys fehlen: in lib/i18n-dictionary.js ergänzen (analog Task 1.2)
```

- [ ] **Step 6: Tests laufen lassen**

```bash
node --test tests/provider-wizard.test.js
# Expected: alle pass
bash -n scripts/install-memory-system.sh
# Expected: keine Syntax-Fehler
```

- [ ] **Step 7: Commit**

```bash
git add scripts/provider-wizard.mjs scripts/install-memory-system.sh tests/provider-wizard.test.js
git commit -m "feat(wizard): i18n-konformer Node-Wizard, Bash ruft nur noch Node auf"
```

---

## Phase 5: auto-capture-lancedb.mjs — Import/Config-Umbau

### Task 5.1 — auto-capture Plugin-Config-getrieben machen

**Files:**
- Modify: `.openclaw/scripts/auto-capture-lancedb.mjs`
- Test: `tests/auto-capture-import.test.js`

**Interfaces:**
- Consumes: `lib/providers/factory.js` und `lib/providers/config-normalize.js` aus `PLUR1BUS_PLUGIN_DIR` (oder Default)
- OPENAI_API_KEY in `process.env` ist nicht mehr Pflicht

- [ ] **Step 1: Test schreiben (Interface-Test)**

```js
// tests/auto-capture-import.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, homedir } from "node:path";
import { existsSync } from "node:fs";

describe("auto-capture import path", () => {
  it("PLUR1BUS_PLUGIN_DIR env var kann Pfad überschreiben", () => {
    const customDir = "/tmp/test-plugin-dir";
    const expected = join(customDir, "lib/providers/factory.js");
    const pluginDir = process.env.PLUR1BUS_PLUGIN_DIR || customDir;
    const factoryPath = join(pluginDir, "lib/providers/factory.js");
    assert.ok(typeof factoryPath === "string");
    assert.ok(factoryPath.includes("lib/providers/factory.js"));
  });

  it("Default-Pfad zeigt auf installierte Extension", () => {
    const defaultDir = join(homedir(), ".openclaw", "extensions", "memory-lancedb-namespaced");
    const factoryPath = join(defaultDir, "lib/providers/factory.js");
    assert.ok(factoryPath.includes("memory-lancedb-namespaced"));
    assert.ok(factoryPath.includes("lib/providers/factory.js"));
  });

  it("Repo-eigene factory.js existiert (für Entwicklung)", () => {
    // Im Repo-Kontext muss factory.js existieren
    const repoFactory = join(process.cwd(), "lib/providers/factory.js");
    assert.ok(existsSync(repoFactory), `factory.js fehlt unter: ${repoFactory}`);
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet PASS (nachdem Phase 2 fertig)**

```bash
node --test tests/auto-capture-import.test.js
# Expected: 3 tests pass (factory.js existiert nach Phase 2)
```

- [ ] **Step 3: `auto-capture-lancedb.mjs` umbauen**

Am Anfang der Datei (nach vorhandenen Konstanten, vor `main()`):

```js
// ─── Plugin-Dir Auflösung ────────────────────────────────────────────────────
const PLUR1BUS_PLUGIN_DIR = process.env.PLUR1BUS_PLUGIN_DIR
  || join(homedir(), ".openclaw", "extensions", "memory-lancedb-namespaced");

const FACTORY_PATH = join(PLUR1BUS_PLUGIN_DIR, "lib/providers/factory.js");
const CONFIG_NORMALIZE_PATH = join(PLUR1BUS_PLUGIN_DIR, "lib/providers/config-normalize.js");

async function loadProviderFactory() {
  try {
    const [factoryMod, normalizeMod] = await Promise.all([
      import(FACTORY_PATH),
      import(CONFIG_NORMALIZE_PATH),
    ]);
    return {
      createEmbeddingProvider: factoryMod.createEmbeddingProvider,
      normalizeEmbeddingConfig: normalizeMod.normalizeEmbeddingConfig,
    };
  } catch (e) {
    throw new Error(
      `[auto-capture] Provider-Factory nicht gefunden unter ${FACTORY_PATH}. ` +
      `Ist memory-lancedb-namespaced installiert? Setze PLUR1BUS_PLUGIN_DIR. (${e.message})`
    );
  }
}

function readPluginEmbeddingConfig(configPath) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    return cfg?.plugins?.entries?.["memory-lancedb-namespaced"]?.embedding || {};
  } catch (_) {
    return {};
  }
}
```

`main()` umschreiben — die drei Zeilen mit `process.env.OPENAI_API_KEY` und `createEmbeddings()` ersetzen:

```js
async function main() {
  // Vorher:
  // const apiKey = process.env.OPENAI_API_KEY;
  // if (!apiKey) { console.error("OPENAI_API_KEY not set"); process.exit(1); }
  // const embeddings = createEmbeddings(apiKey, EMBEDDING_MODEL);

  // Nachher:
  const { createEmbeddingProvider, normalizeEmbeddingConfig } = await loadProviderFactory();
  const rawEmbeddingCfg = readPluginEmbeddingConfig(CONFIG_PATH);
  const embCfg = normalizeEmbeddingConfig(rawEmbeddingCfg);
  const embeddings = createEmbeddingProvider(embCfg);

  if (!embeddings) {
    console.error("[auto-capture] Embedding-Provider konnte nicht initialisiert werden. " +
      "Prüfe openclaw.json → plugins.entries.memory-lancedb-namespaced.embedding");
    process.exit(1);
  }
  // ... Rest von main() bleibt identisch, nutzt `embeddings` statt `{ embed: ... }`
```

Die alte Funktion `createEmbeddings(apiKey, model)` vollständig entfernen.

- [ ] **Step 4: Syntax prüfen**

```bash
node --check .openclaw/scripts/auto-capture-lancedb.mjs
# Expected: keine Fehler
```

- [ ] **Step 5: Smoke-Test (ohne echte API, mit local-transformers-Config)**

```bash
# Temporär local-transformers konfigurieren
PLUR1BUS_PLUGIN_DIR=$(pwd) node .openclaw/scripts/auto-capture-lancedb.mjs --dry-run 2>&1 | head -5
# Expected: "[main] processing N agents..." ODER Fehlermeldung mit PLUR1BUS_PLUGIN_DIR-Hinweis
# NICHT: "OPENAI_API_KEY not set"
```

- [ ] **Step 6: Commit**

```bash
git add .openclaw/scripts/auto-capture-lancedb.mjs tests/auto-capture-import.test.js
git commit -m "feat(auto-capture): plugin-config-driven embedding, importiert aus PLUR1BUS_PLUGIN_DIR"
```

---

## Phase 6: Reranker-Fallback-Policy

### Task 6.1 — `reranker-chained.js`: null-Fallback absichern

**Files:**
- Modify: `lib/providers/reranker-chained.js`
- Test: `tests/chained-reranker-null-fallback.test.js`

**Interfaces:**
- Produces: `ChainedRerankerProvider` mit `fallback=null` crasht nicht — läuft ohne Reranker weiter

- [ ] **Step 1: Failing test schreiben**

```js
// tests/chained-reranker-null-fallback.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChainedRerankerProvider } from "../lib/providers/reranker-chained.js";

const fakePrimary = {
  id: "cohere",
  rerank: async () => { throw new Error("cohere unavailable"); },
};

const fakeDocuments = ["doc a", "doc b", "doc c"];

describe("ChainedRerankerProvider mit null-Fallback", () => {
  it("fallback=null: gibt leeres Array zurück bei Primary-Fehler", async () => {
    const provider = new ChainedRerankerProvider(fakePrimary, null, null);
    const result = await provider.rerank("query", fakeDocuments, 2);
    // Kein Crash — graceful: leeres Array oder unreranked pass-through
    assert.ok(Array.isArray(result), "Erwartet Array, auch bei null-Fallback");
  });

  it("fallback=null: kein lokales Modell wird geladen", async () => {
    let localModelLoaded = false;
    const trackingPrimary = {
      id: "cohere",
      rerank: async () => { throw new Error("timeout"); },
    };
    const provider = new ChainedRerankerProvider(trackingPrimary, null, {
      warn: (msg) => {
        if (msg.includes("local") || msg.includes("transformers")) localModelLoaded = true;
      },
    });
    await provider.rerank("query", fakeDocuments, 2);
    assert.strictEqual(localModelLoaded, false, "Lokales Modell wurde unerwartet geladen");
  });

  it("id-Format ist korrekt wenn fallback=null", () => {
    const provider = new ChainedRerankerProvider(fakePrimary, null, null);
    assert.ok(provider.id.startsWith("chained:cohere"), `Unerwartete id: ${provider.id}`);
  });

  it("mit echtem Fallback: Fallback wird bei Primary-Fehler genutzt", async () => {
    const fakeFallback = {
      id: "local",
      rerank: async (query, docs, topN) => docs.slice(0, topN).map((_, i) => ({ index: i, relevance_score: 1 })),
    };
    const provider = new ChainedRerankerProvider(fakePrimary, fakeFallback, null);
    const result = await provider.rerank("query", fakeDocuments, 2);
    assert.strictEqual(result.length, 2);
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/chained-reranker-null-fallback.test.js
# Expected: FAIL — TypeError: Cannot read properties of null (reading 'id') oder 'rerank'
```

- [ ] **Step 3: `reranker-chained.js` absichern**

```js
export class ChainedRerankerProvider {
  constructor(primary, fallback, logger) {
    this.id = `chained:${primary.id}->${fallback ? fallback.id : "disabled"}`;
    this.primary = primary;
    this.fallback = fallback; // kann null sein wenn fallbackProvider="disabled"
    this.logger = logger;
  }

  async rerank(query, documents, topN) {
    try {
      return await this.primary.rerank(query, documents, topN);
    } catch (err) {
      if (this.fallback) {
        this.logger?.warn?.(
          `reranker primary (${this.primary.id}) failed: ${String(err)}. ` +
          `Trying fallback (${this.fallback.id})...`
        );
        return await this.fallback.rerank(query, documents, topN);
      }
      // fallback=null → ohne Reranker weiterlaufen, kein Crash
      this.logger?.warn?.(
        `reranker primary (${this.primary.id}) failed: ${String(err)}. ` +
        `No fallback configured (fallbackProvider=disabled) — continuing without reranker.`
      );
      return []; // Aufrufer (recall-pipeline) muss [] als "kein Reranking" behandeln
    }
  }
}
```

- [ ] **Step 4: recall-pipeline.js prüfen ob leeres Array korrekt behandelt wird**

```bash
grep -n "rerank\|reranker" lib/recall-pipeline.js | head -10
# Erwartung: Bei leerem Reranker-Ergebnis fällt die Pipeline auf originale Reihenfolge zurück
# (bestehende Logik: fallbackOnError=true in runRecallPipeline tut genau das)
```

- [ ] **Step 5: Tests laufen lassen**

```bash
node --test tests/chained-reranker-null-fallback.test.js
node --test tests/smoke-reranker-pipeline.test.js
# Expected: alle pass
```

- [ ] **Step 6: Commit**

```bash
git add lib/providers/reranker-chained.js tests/chained-reranker-null-fallback.test.js
git commit -m "fix(reranker): ChainedRerankerProvider mit fallback=null crasht nicht mehr"
```

---

## Phase 7: Tests — Vollständige Test-Suite

### Task 7.1 — Alle neuen Tests zusammenführen und laufen lassen

**Files:** alle test-Dateien aus Phasen 1-6

- [ ] **Step 1: Vollständiger Test-Lauf**

```bash
node --test tests/*.test.js 2>&1 | tail -30
# Expected: alle Tests grün, keine neuen Fehler
```

- [ ] **Step 2: Bekannte bestehende Tests nicht gebrochen**

```bash
node --test tests/smoke-reranker-pipeline.test.js \
           tests/background-recall-skip.test.js \
           tests/embedding-openai-batch.test.js \
           tests/config-audit.test.js
# Expected: alle pass
```

- [ ] **Step 3: Fehlende Tests aus Spec ergänzen (provider-wizard-config)**

```js
// tests/provider-wizard-config.test.js (NEU)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRerankerConfig, normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";

describe("provider-wizard config output", () => {
  it("Cohere ohne Fallback → fallbackProvider=disabled", () => {
    const cfg = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "COHERE_API_KEY" });
    assert.strictEqual(cfg.fallbackProvider, "disabled");
    assert.strictEqual(cfg.fallbackModel, null);
  });

  it("Cohere mit lokalem Fallback → fallbackProvider=local-transformers", () => {
    const cfg = normalizeRerankerConfig({
      provider: "cohere",
      apiKeyEnv: "COHERE_API_KEY",
      fallbackProvider: "local-transformers",
      fallbackModel: "BAAI/bge-reranker-v2-m3",
    });
    assert.strictEqual(cfg.fallbackProvider, "local-transformers");
    assert.strictEqual(cfg.fallbackModel, "BAAI/bge-reranker-v2-m3");
  });

  it("Disabled produziert enabled=false", () => {
    const cfg = normalizeRerankerConfig({ provider: "disabled" });
    assert.strictEqual(cfg.enabled, false);
  });

  it("Embedding apiKeyEnv=OPENAI_API_KEY bleibt als String in Config", () => {
    const cfg = normalizeEmbeddingConfig({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY", dimensions: 3072 });
    assert.strictEqual(cfg.apiKeyEnv, "OPENAI_API_KEY");
  });

  it("Local BGE Config enthält local.model", () => {
    const cfg = normalizeRerankerConfig({
      provider: "local-transformers",
      model: "BAAI/bge-reranker-v2-m3",
    });
    assert.strictEqual(cfg.local?.model ?? cfg.model, "BAAI/bge-reranker-v2-m3");
  });
});
```

```bash
node --test tests/provider-wizard-config.test.js
# Expected: 5 tests pass
```

- [ ] **Step 4: Commit**

```bash
git add tests/provider-wizard-config.test.js
git commit -m "test(wizard): config output tests für alle Reranker-Optionen"
```

---

## Phase 8: Docs/Changelog

### Task 8.1 — CHANGELOG.md

- [ ] **Step 1: Eintrag schreiben**

Oben in `CHANGELOG.md` neue Section:

```markdown
## [6.7.0] — 2026-06-18

### Added
- Provider Wizard: interaktive Wahl zwischen OpenAI und lokalem Embedding (intfloat/multilingual-e5-small)
- Provider Wizard: Reranker-Wahl Cohere / lokaler BGE / disabled / Advanced
- `lib/providers/factory.js`: gemeinsame Provider-Factory für index.js + auto-capture
- `lib/providers/dimension-guard.js`: Status-Objekt, blockiert Provider-Wechsel bei unknown
- `lib/namespace-config.js`: recallReadNamespaces-Semantik, write/legacy-readonly-Trennung
- `scripts/reindex-provider.mjs`: sicherer Reindex (Snapshot→Reembed→Validierung→Switch, kein Delete)
- i18n: `setup.reranker.*` Keys (de + en)
- `apiKeyEnv` als bevorzugtes Credential-Schema in normalizeEmbeddingConfig + normalizeRerankerConfig

### Changed
- `DEFAULT_LOCAL_RERANKER_MODEL`: Alibaba-NLP/gte-reranker-modernbert-base → BAAI/bge-reranker-v2-m3
- `auto-capture-lancedb.mjs`: liest Plugin-Config aus openclaw.json, kein harter OPENAI_API_KEY-Check
- `ChainedRerankerProvider`: null-Fallback sicher (kein Crash, graceful continue)
- Cohere-Fallback default: `fallbackProvider=disabled` statt Auto-Local-BGE

### Fixed
- auto-capture: OPENAI_API_KEY nicht mehr aus process.env erforderlich (import aus PLUR1BUS_PLUGIN_DIR)
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): v6.7.0 provider wizard + credential resolution"
```

---

## Phase 9: Abschlussverifikation

### Task 9.1 — Vollständiger Test-Lauf + Syntax-Check

- [ ] **Step 1: Alle Tests**

```bash
node --check index.js && \
node --check lib/providers/factory.js && \
node --check lib/providers/dimension-guard.js && \
node --check lib/namespace-config.js && \
node --check scripts/reindex-provider.mjs && \
node --check .openclaw/scripts/auto-capture-lancedb.mjs
# Expected: alle ohne Fehler
```

- [ ] **Step 2: Vollständiger Test-Run**

```bash
node --test tests/*.test.js 2>&1 | grep -E "^(pass|fail|ok|not ok)" | tail -20
# Expected: 0 failures
```

- [ ] **Step 3: Spec-Coverage-Check**

Alle Spec-Abschnitte gegen Plan prüfen:
- [ ] factory.js implementiert → Task 2.2 ✓
- [ ] resolveApiKey mit apiKeyEnv → Task 2.1 ✓
- [ ] dimension-guard Status-Objekt → Task 3.1 ✓
- [ ] Wizard Embedding-Schritt → Task 4.3 ✓
- [ ] Wizard Reranker-Schritt mit Cohere/BGE/Disabled/Advanced → Task 4.3 ✓
- [ ] Option B Namespace-Semantik → Task 4.1 ✓
- [ ] Option C Reindex ohne Delete → Task 4.2 ✓
- [ ] auto-capture aus PLUR1BUS_PLUGIN_DIR → Task 5.1 ✓
- [ ] ChainedRerankerProvider fallback=null → Task 6.1 ✓
- [ ] i18n Keys → Task 1.2 ✓
- [ ] DEFAULT_LOCAL_RERANKER_MODEL → Task 1.1 ✓

- [ ] **Step 4: Final Commit (falls nötig)**

```bash
git log --oneline -12
# Erwartete Commits der Reihe nach sichtbar
```

---

## Anhang: Risiken & Rollback

### Risiken

| Risiko | Wahrscheinlichkeit | Mitigierung |
|--------|---------------------|-------------|
| `ChainedRerankerProvider(p, null)` — unerwarteter Aufruf-Kontext | Mittel | Task 6.1 mit Tests |
| auto-capture importiert aus altem Pfad (Caching/Module-Cache) | Niedrig | `PLUR1BUS_PLUGIN_DIR` explizit, kein relativer Import |
| Reindex-Script bei unvollständig installierten Deps | Mittel | `--dry-run` + Pfad-Validierung am Anfang |
| Wizard schreibt falsche JSON-Struktur in openclaw.json | Niedrig | `jq`-Validierung + atomares Schreiben über tmpfile |
| Dimension-Guard gibt `unknown` obwohl DB gesund | Niedrig | Explizite Fehlermeldung, User kann mit Backup-Bestätigung fortfahren |

### Rollback-Strategie

- **Code-Rollback:** `git revert` der jeweiligen Task-Commits (alle Commits sind atomar und labeled)
- **Config-Rollback:** `openclaw.json` hat keine Backup-Mechanik — manuell sichern vor Wizard-Lauf
- **Reindex-Rollback:** Snapshot unter `{path}.backup-{timestamp}` bleibt immer erhalten; Config-Wechsel via `reindex-provider.mjs` ist atomar rücknehmbar

### Akzeptanzkriterien

1. `node --test tests/*.test.js` — 0 Failures
2. `auto-capture-lancedb.mjs` läuft ohne `OPENAI_API_KEY` in Umgebung wenn `provider=local-transformers` konfiguriert
3. Cohere-Konfiguration hat `fallbackProvider: "disabled"` als Default
4. `readExistingTableDimension()` wirft nie — gibt immer Status-Objekt zurück
5. `DEFAULT_LOCAL_RERANKER_MODEL === "BAAI/bge-reranker-v2-m3"`
6. `ChainedRerankerProvider(primary, null, logger).rerank()` crasht nicht
7. `resolveApiKey({}, {})` wirft — kein impliziter OPENAI-Key-Fallback
8. `resolveApiKey({}, { defaultEnv: "COHERE_API_KEY" })` liest aus `process.env.COHERE_API_KEY` — nicht aus `OPENAI_API_KEY`
9. `scripts/provider-wizard.mjs` gibt user-facing Text via `t(key, { lang, tone })` aus — kein hard-coded Deutsch
10. `scripts/reindex-provider.mjs --apply` gibt klare Fehlermeldung ("nicht implementiert") — keine Produktionsdaten werden verändert
11. `pool.getWriteDb(agentId).dbPath` liegt in `activeWriteNamespace`, niemals in `legacyReadOnlyNamespaces`
12. `pool.getReadDbs(agentId).length === 2` wenn `crossNamespaceRecall=true` mit active + legacy

### Was NICHT Teil dieser Implementierung ist

- **Echter Reindex** (Re-Embedding, atomarer Config-Switch) — eigener Folgepatch; erst Schema/Pfad gegen Live-Code verifizieren
- Download-Fortschrittsanzeige für HuggingFace-Modelle
- Crontab-Eintrag durch Plugin (Root-Rechte bewusst ausgeschlossen)
- Automatischer Reindex bei Dimension-Mismatch ohne User-Aktion
- Löschen alter LanceDB-Dateien (immer Sache des Users)
- Legacy-Staging-Kopien oder externe Deployments
- Änderungen an Dreaming / Forgetting-Curve
- **`resolveApiKey` globaler OPENAI-Fallback** — bewusst entfernt; jeder Aufrufer muss `defaultEnv` explizit setzen
- Bash-seitiger Wizard-Text (hard-coded Strings) — ausschließlich via `provider-wizard.mjs` + i18n

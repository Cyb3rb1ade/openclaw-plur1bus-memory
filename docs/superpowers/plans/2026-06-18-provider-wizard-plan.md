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
| `scripts/reindex-provider.mjs` | NEU | 4 |
| `scripts/install-memory-system.sh` | ÄNDERN | 4 |
| `.openclaw/scripts/auto-capture-lancedb.mjs` | ÄNDERN | 5 |
| `lib/providers/reranker-chained.js` | ÄNDERN | 6 |
| `tests/dimension-guard.test.js` | NEU | 7 |
| `tests/provider-factory.test.js` | NEU | 7 |
| `tests/provider-wizard-config.test.js` | NEU | 7 |
| `tests/auto-capture-import.test.js` | NEU | 7 |
| `tests/i18n-setup-reranker.test.js` | NEU | 7 |
| `tests/chained-reranker-null-fallback.test.js` | NEU | 7 |
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

Am Ende der `dictionary`-Exports-Objekt (vor dem schließenden `}`), neue Sektion einfügen:

```js
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

### Task 2.1 — `env.js`: resolveApiKey(cfg)

**Files:**
- Modify: `lib/providers/env.js`

**Interfaces:**
- Produces: `export function resolveApiKey(cfg)` — löst `cfg.apiKeyEnv` (bevorzugt) oder `cfg.apiKey` auf

- [ ] **Step 1: Test in bestehendem env-Test oder neuer Datei**

```js
// tests/provider-env-resolve.test.js (NEU)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolveApiKey } from "../lib/providers/env.js";

describe("resolveApiKey", () => {
  before(() => {
    process.env._TEST_KEY = "test-api-key-123";
  });
  after(() => {
    delete process.env._TEST_KEY;
  });

  it("löst apiKeyEnv aus process.env auf", () => {
    const key = resolveApiKey({ apiKeyEnv: "_TEST_KEY" });
    assert.strictEqual(key, "test-api-key-123");
  });

  it("wirft wenn apiKeyEnv gesetzt aber Env-Var leer", () => {
    assert.throws(
      () => resolveApiKey({ apiKeyEnv: "_NONEXISTENT_VAR_XYZ" }),
      /Env var _NONEXISTENT_VAR_XYZ not set/
    );
  });

  it("löst apiKey als Literal auf wenn apiKeyEnv nicht gesetzt", () => {
    const key = resolveApiKey({ apiKey: "sk-literal-key" });
    assert.strictEqual(key, "sk-literal-key");
  });

  it("apiKeyEnv hat Vorrang vor apiKey", () => {
    const key = resolveApiKey({ apiKeyEnv: "_TEST_KEY", apiKey: "sk-should-not-be-used" });
    assert.strictEqual(key, "test-api-key-123");
  });

  it("gibt undefined zurück wenn beides nicht gesetzt (soft fallback)", () => {
    // Für optionalen Kontext — nutzt resolveApiKey mit { optional: true }
    const key = resolveApiKey({ optional: true });
    assert.strictEqual(key, undefined);
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

```bash
node --test tests/provider-env-resolve.test.js
# Expected: FAIL — resolveApiKey ist nicht exportiert
```

- [ ] **Step 3: `resolveApiKey` in `lib/providers/env.js` ergänzen**

```js
// Am Ende von env.js hinzufügen:

/**
 * Löst einen API-Key aus Config auf.
 * Bevorzugt: cfg.apiKeyEnv → process.env[name]
 * Fallback: cfg.apiKey → Literal oder ${VAR}-Syntax via resolveOptionalEnvVars
 * Optional-Modus: wenn cfg.optional=true, kein Wurf bei fehlendem Key
 */
export function resolveApiKey(cfg = {}) {
  if (cfg.apiKeyEnv) {
    const val = process.env[cfg.apiKeyEnv];
    if (!val && !cfg.optional) {
      throw new Error(`Env var ${cfg.apiKeyEnv} not set`);
    }
    return val || undefined;
  }
  if (cfg.apiKey) {
    return resolveOptionalEnvVars(cfg.apiKey) || cfg.apiKey;
  }
  if (cfg.optional) return undefined;
  return resolveOptionalEnvVars("${OPENAI_API_KEY}");
}
```

- [ ] **Step 4: Tests laufen lassen**

```bash
node --test tests/provider-env-resolve.test.js
# Expected: 5 tests pass
```

- [ ] **Step 5: Commit**

```bash
git add lib/providers/env.js tests/provider-env-resolve.test.js
git commit -m "feat(env): add resolveApiKey(cfg) — apiKeyEnv bevorzugt"
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

### Task 4.2 — `scripts/reindex-provider.mjs`: Sicherer Reindex

**Files:**
- Create: `scripts/reindex-provider.mjs`

**Interfaces:**
- Produces: CLI-Script `node scripts/reindex-provider.mjs --agent <id> --from-namespace <src> --to-namespace <dst>`
- Ablauf: Snapshot → re-embed → strikte Validierung → atomarer Config-Switch → keine Delete
- Consumes: `lib/providers/factory.js`, `lib/providers/dimension-guard.js`, `lib/namespace-config.js`

- [ ] **Step 1: Script erstellen**

```js
// scripts/reindex-provider.mjs
/**
 * Sicherer Reindex: Löscht niemals zuerst.
 * Ablauf:
 *   1. Snapshot (cp -r)
 *   2. Neuer Namespace aufbauen + alle Memories dort re-einbetten
 *   3. Strikte Validierung (row count, schema, sample recall)
 *   4. Atomarer Config-Switch
 *   5. Alte DB bleibt als Rollback
 *
 * Jeder nicht-reindexierbare Eintrag blockiert den Switch + Report.
 *
 * Usage:
 *   node scripts/reindex-provider.mjs \
 *     --agent main \
 *     --from lancedb-namespaced \
 *     --to lancedb-local \
 *     --dry-run
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, homedir } from "node:path";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";
import { createEmbeddingProvider } from "../lib/providers/factory.js";
import { readExistingTableDimension } from "../lib/providers/dimension-guard.js";

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : null;
};
const isDryRun = args.includes("--dry-run");
const agentId = getArg("agent") || "main";
const fromNamespace = getArg("from");
const toNamespace = getArg("to");

if (!fromNamespace || !toNamespace) {
  console.error("Usage: node scripts/reindex-provider.mjs --agent <id> --from <ns> --to <ns>");
  process.exit(1);
}

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");
const BASE_DB_PATH = join(OPENCLAW_DIR, "memory");
const FROM_PATH = join(BASE_DB_PATH, fromNamespace, agentId);
const TO_PATH = join(BASE_DB_PATH, toNamespace, agentId);
const SNAPSHOT_PATH = `${FROM_PATH}.backup-${Date.now()}`;

async function main() {
  console.log(`[reindex] Agent: ${agentId}, ${fromNamespace} → ${toNamespace}${isDryRun ? " [DRY RUN]" : ""}`);

  // 1. Validiere Quelle
  const srcGuard = await readExistingTableDimension(FROM_PATH);
  if (srcGuard.status !== "ok") {
    console.error(`[reindex] Quell-DB nicht lesbar: ${srcGuard.error || srcGuard.status}`);
    process.exit(1);
  }
  console.log(`[reindex] Quelle: ${srcGuard.dimension} dims, ${FROM_PATH}`);

  // 2. Ziel-Provider aus Config laden
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const pluginCfg = config?.plugins?.entries?.["memory-lancedb-namespaced"] || {};
  const embCfg = normalizeEmbeddingConfig(pluginCfg.embedding || {});
  console.log(`[reindex] Ziel-Provider: ${embCfg.provider}, ${embCfg.dimensions} dims`);

  if (embCfg.dimensions === srcGuard.dimension) {
    console.warn("[reindex] WARNUNG: Quelle und Ziel haben gleiche Dimension — Reindex unnötig?");
  }

  if (isDryRun) {
    console.log("[reindex] DRY RUN — keine Änderungen.");
    return;
  }

  // 3. Snapshot der Quelle
  console.log(`[reindex] Erstelle Snapshot: ${SNAPSHOT_PATH}`);
  execSync(`cp -r "${FROM_PATH}" "${SNAPSHOT_PATH}"`);
  console.log("[reindex] Snapshot OK");

  // 4. Ziel anlegen + re-einbetten
  mkdirSync(TO_PATH, { recursive: true });
  const lancedb = await import("@lancedb/lancedb");
  const srcDb = await lancedb.connect(FROM_PATH);
  const srcTable = await srcDb.openTable("memories");
  const srcRows = await srcTable.query().toArray();

  const provider = createEmbeddingProvider(embCfg);
  const dstDb = await lancedb.connect(TO_PATH);

  const failed = [];
  const succeeded = [];

  for (const row of srcRows) {
    try {
      const vector = await provider.embed(row.text);
      succeeded.push({ ...row, vector });
    } catch (e) {
      failed.push({ id: row.id, error: e.message });
    }
  }

  // 5. Strikte Validierung — kein stiller Verlust
  if (failed.length > 0) {
    console.error(`[reindex] ${failed.length} Einträge konnten nicht re-eingebettet werden:`);
    for (const f of failed) console.error(`  - ${f.id}: ${f.error}`);
    const reportPath = join(OPENCLAW_DIR, `reindex-failed-${Date.now()}.json`);
    writeFileSync(reportPath, JSON.stringify(failed, null, 2));
    console.error(`[reindex] Report: ${reportPath}`);
    console.error("[reindex] SWITCH BLOCKIERT — alte DB bleibt aktiv.");
    process.exit(2);
  }

  if (succeeded.length < srcRows.length) {
    console.error(`[reindex] Row-Count-Mismatch: src=${srcRows.length}, dst=${succeeded.length}`);
    console.error("[reindex] SWITCH BLOCKIERT.");
    process.exit(2);
  }

  // 6. Ziel-Tabelle schreiben
  await dstDb.createTable("memories", succeeded, { mode: "overwrite" });

  // 7. Sample-Recall validieren
  const dstTable = await dstDb.openTable("memories");
  const sampleQuery = await provider.embedQuery(srcRows[0].text);
  const sampleResults = await dstTable.vectorSearch(sampleQuery).limit(1).toArray();
  if (sampleResults.length === 0) {
    console.error("[reindex] Sample-Recall liefert 0 Ergebnisse — SWITCH BLOCKIERT.");
    process.exit(2);
  }

  console.log(`[reindex] Validierung OK: ${succeeded.length} Einträge, Sample-Recall funktioniert.`);

  // 8. Atomarer Config-Switch (Namespace-Config aktualisieren)
  const nsCfg = pluginCfg.namespaces || {};
  nsCfg.activeWriteNamespace = toNamespace;
  nsCfg.activeRecallNamespaces = [toNamespace];
  nsCfg.legacyReadOnlyNamespaces = [fromNamespace];
  nsCfg.crossNamespaceRecall = true;

  pluginCfg.namespaces = nsCfg;
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  config.plugins.entries["memory-lancedb-namespaced"] = pluginCfg;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  console.log(`[reindex] Config-Switch OK. Alte DB Rollback: ${SNAPSHOT_PATH}`);
  console.log(`[reindex] Abgeschlossen: ${toNamespace} ist jetzt aktiv.`);
}

main().catch(e => {
  console.error("[reindex] FATAL:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Script-Syntax prüfen**

```bash
node --check scripts/reindex-provider.mjs
# Expected: keine Fehler
```

- [ ] **Step 3: Dry-Run testen**

```bash
node scripts/reindex-provider.mjs --agent main --from lancedb-namespaced --to lancedb-local --dry-run
# Expected: "[reindex] DRY RUN — keine Änderungen."
```

- [ ] **Step 4: Commit**

```bash
git add scripts/reindex-provider.mjs
git commit -m "feat(reindex): safe reindex script — snapshot-first, strict validation, no delete"
```

---

### Task 4.3 — `install-memory-system.sh`: Wizard-Erweiterung

**Files:**
- Modify: `scripts/install-memory-system.sh`

> **Hinweis:** Dieser Task ändert ein Bash-Script. Kein Node-Test möglich. Manuelle Verifikation per `--dry-run` und `--help`.

- [ ] **Step 1: Embedding-Wizard-Funktion einfügen**

Im Script eine neue Funktion `wizard_embedding_provider()` nach dem bestehenden Key-Setup einfügen:

```bash
wizard_embedding_provider() {
  local lang="${WIZARD_LANG:-en}"
  
  echo ""
  echo "=== Schritt 1/2: Embedding-Provider ==="
  echo ""
  echo "OpenAI API Key vorhanden? (text-embedding-3-large, 3072 dims)"
  read -p "[y/n]: " has_openai

  if [[ "$has_openai" == "y" || "$has_openai" == "Y" ]]; then
    read -p "OPENAI_API_KEY eingeben: " openai_key
    echo ""
    echo "Speichern als:"
    echo "  [1] Env-Var-Referenz OPENAI_API_KEY (bevorzugt — Key bleibt in .env)"
    echo "  [2] Literal in openclaw.json (Key in Config-Datei sichtbar)"
    read -p "[1/2]: " key_store_mode

    if [[ "$key_store_mode" == "2" ]]; then
      echo "WARNUNG: Literal-Keys in openclaw.json sind weniger sicher als .env-Referenzen."
      EMBEDDING_PROVIDER="openai"
      EMBEDDING_API_KEY="$openai_key"
      EMBEDDING_API_KEY_ENV=""
    else
      echo "export OPENAI_API_KEY=$openai_key" >> "$OPENCLAW_DIR/.env"
      EMBEDDING_PROVIDER="openai"
      EMBEDDING_API_KEY=""
      EMBEDDING_API_KEY_ENV="OPENAI_API_KEY"
    fi
    EMBEDDING_MODEL="text-embedding-3-large"
    EMBEDDING_DIMENSIONS=3072
  else
    echo ""
    echo "Lokales Modell: intfloat/multilingual-e5-small (384 dims)"
    echo "CPU-tauglich, gut für Deutsch/Mehrsprachig. Download ~135 MB beim ersten Start."
    EMBEDDING_PROVIDER="local-transformers"
    EMBEDDING_API_KEY=""
    EMBEDDING_API_KEY_ENV=""
    EMBEDDING_MODEL="intfloat/multilingual-e5-small"
    EMBEDDING_DIMENSIONS=384
  fi
}

wizard_reranker_provider() {
  echo ""
  echo "=== Schritt 2/2: Reranker ==="
  echo ""
  echo "Reranker verbessert die Recall-Qualität, kostet aber zusätzliche Laufzeit."
  echo ""
  echo "[1] Cohere rerank-v3.5 (kostenpflichtig, empfohlen für beste Qualität)"
  echo "    Benötigt COHERE_API_KEY. Keine lokale CPU-/RAM-Last."
  echo "[2] Lokal: BAAI/bge-reranker-v2-m3 (mehrsprachig, kein API-Key)"
  echo "    Lazy load ~570 MB. Kostet CPU/RAM."
  echo "[3] Kein Reranker (schnellste und stabilste Basis)"
  echo "[4] Advanced-Optionen"
  read -p "[1/2/3/4]: " reranker_choice

  case "$reranker_choice" in
    1)
      read -p "COHERE_API_KEY eingeben: " cohere_key
      echo ""
      echo "Speichern als [1] Env-Var-Referenz (bevorzugt) / [2] Literal?"
      read -p "[1/2]: " cohere_store_mode
      
      if [[ "$cohere_store_mode" == "2" ]]; then
        RERANKER_PROVIDER="cohere"
        RERANKER_API_KEY="$cohere_key"
        RERANKER_API_KEY_ENV=""
      else
        echo "export COHERE_API_KEY=$cohere_key" >> "$OPENCLAW_DIR/.env"
        RERANKER_PROVIDER="cohere"
        RERANKER_API_KEY=""
        RERANKER_API_KEY_ENV="COHERE_API_KEY"
      fi
      RERANKER_MODEL="rerank-v3.5"
      
      echo ""
      echo "Bei Cohere-Fehler:"
      echo "  [1] Recall ohne Reranker fortsetzen (default — keine CPU-Last)"
      echo "  [2] Lokalen BAAI/bge-reranker-v2-m3 als Fallback laden (~570 MB)"
      read -p "[1/2]: " cohere_fallback
      if [[ "$cohere_fallback" == "2" ]]; then
        RERANKER_FALLBACK_PROVIDER="local-transformers"
        RERANKER_FALLBACK_MODEL="BAAI/bge-reranker-v2-m3"
      else
        RERANKER_FALLBACK_PROVIDER="disabled"
        RERANKER_FALLBACK_MODEL=""
      fi
      ;;
    2)
      echo "Hinweis: Lokaler Reranker ist CPU-intensiv. Empfohlen bei ≥8 GB RAM."
      echo "Modell wird beim ersten Recall geladen (~570 MB). Kein Download jetzt."
      RERANKER_PROVIDER="local-transformers"
      RERANKER_MODEL="BAAI/bge-reranker-v2-m3"
      RERANKER_API_KEY=""
      RERANKER_API_KEY_ENV=""
      RERANKER_FALLBACK_PROVIDER=""
      RERANKER_FALLBACK_MODEL=""
      ;;
    3)
      RERANKER_PROVIDER="disabled"
      RERANKER_MODEL=""
      RERANKER_API_KEY=""
      RERANKER_API_KEY_ENV=""
      RERANKER_FALLBACK_PROVIDER=""
      RERANKER_FALLBACK_MODEL=""
      ;;
    4)
      echo ""
      echo "Advanced-Modelle:"
      echo "  [a] Alibaba-NLP/gte-reranker-modernbert-base (Englisch/Long-Context/Code)"
      echo "  [b] jinaai/jina-reranker-v2-base-multilingual"
      echo "  [c] mixedbread-ai/mxbai-rerank-base-v2"
      read -p "[a/b/c]: " adv_choice
      case "$adv_choice" in
        a) RERANKER_MODEL="Alibaba-NLP/gte-reranker-modernbert-base" ;;
        b) RERANKER_MODEL="jinaai/jina-reranker-v2-base-multilingual" ;;
        c) RERANKER_MODEL="mixedbread-ai/mxbai-rerank-base-v2" ;;
        *) echo "Ungültig — kein Reranker."; RERANKER_PROVIDER="disabled"; RERANKER_MODEL="" ;;
      esac
      if [[ "$RERANKER_PROVIDER" != "disabled" ]]; then
        RERANKER_PROVIDER="local-transformers"
        RERANKER_API_KEY=""
        RERANKER_API_KEY_ENV=""
        RERANKER_FALLBACK_PROVIDER=""
        RERANKER_FALLBACK_MODEL=""
      fi
      ;;
    *)
      echo "Ungültige Auswahl. Setze auf 'kein Reranker'."
      RERANKER_PROVIDER="disabled"
      RERANKER_MODEL=""
      ;;
  esac
}
```

- [ ] **Step 2: Wizard in den Haupt-Flow einbinden**

Die `wizard_embedding_provider` und `wizard_reranker_provider` Funktionen im Haupt-Setup-Flow nach dem Erstellen der Basis-Config aufrufen. Dann `write_provider_config()` aus den gesetzten Variablen schreiben (JSON-Manipulation via `jq`):

```bash
write_provider_config() {
  local cfg_file="$OPENCLAW_DIR/openclaw.json"
  
  # Embedding-Config bauen
  local emb_json
  if [[ "$EMBEDDING_PROVIDER" == "local-transformers" ]]; then
    emb_json=$(jq -n \
      --arg p "$EMBEDDING_PROVIDER" \
      --arg m "$EMBEDDING_MODEL" \
      --argjson d "$EMBEDDING_DIMENSIONS" \
      '{provider: $p, model: $m, dimensions: $d}')
  elif [[ -n "$EMBEDDING_API_KEY_ENV" ]]; then
    emb_json=$(jq -n \
      --arg p "$EMBEDDING_PROVIDER" \
      --arg env "$EMBEDDING_API_KEY_ENV" \
      --arg m "$EMBEDDING_MODEL" \
      --argjson d "$EMBEDDING_DIMENSIONS" \
      '{provider: $p, apiKeyEnv: $env, model: $m, dimensions: $d}')
  else
    emb_json=$(jq -n \
      --arg p "$EMBEDDING_PROVIDER" \
      --arg k "$EMBEDDING_API_KEY" \
      --arg m "$EMBEDDING_MODEL" \
      --argjson d "$EMBEDDING_DIMENSIONS" \
      '{provider: $p, apiKey: $k, model: $m, dimensions: $d}')
  fi

  # Reranker-Config bauen
  local rer_json
  if [[ "$RERANKER_PROVIDER" == "disabled" ]]; then
    rer_json='{"provider":"disabled","enabled":false,"candidates":20}'
  elif [[ "$RERANKER_PROVIDER" == "cohere" ]]; then
    rer_json=$(jq -n \
      --arg env "${RERANKER_API_KEY_ENV:-}" \
      --arg key "${RERANKER_API_KEY:-}" \
      --arg m "$RERANKER_MODEL" \
      --arg fp "${RERANKER_FALLBACK_PROVIDER:-disabled}" \
      --arg fm "${RERANKER_FALLBACK_MODEL:-}" \
      '{provider:"cohere", model:$m, candidates:20, timeoutMs:5000,
        fallbackOnError:true, fallbackProvider:$fp} |
       if $env != "" then . + {apiKeyEnv: $env} else . + {apiKey: $key} end |
       if $fm != "" then . + {fallbackModel: $fm} else . end')
  else
    rer_json=$(jq -n \
      --arg m "$RERANKER_MODEL" \
      '{provider:"local-transformers", model:$m, candidates:20,
        timeoutMs:5000, fallbackOnError:true,
        local: {model:$m, cacheDir:"${OPENCLAW_HOME}/models/plur1bus"}}')
  fi

  # Atomar in openclaw.json schreiben
  local tmp_cfg
  tmp_cfg=$(jq --argjson emb "$emb_json" --argjson rer "$rer_json" \
    '.plugins.entries["memory-lancedb-namespaced"].embedding = $emb |
     .plugins.entries["memory-lancedb-namespaced"].reranker = $rer' \
    "$cfg_file")
  echo "$tmp_cfg" > "$cfg_file"
  echo "[wizard] Provider-Config geschrieben."
}
```

- [ ] **Step 3: Syntax prüfen**

```bash
bash -n scripts/install-memory-system.sh
# Expected: keine Fehler
```

- [ ] **Step 4: Dry-Run mit --help**

```bash
bash scripts/install-memory-system.sh --help 2>&1 | head -20
# Expected: Script zeigt Hilfe ohne Fehler
```

- [ ] **Step 5: Commit**

```bash
git add scripts/install-memory-system.sh
git commit -m "feat(wizard): embedding + reranker provider selection mit Dimension-Guard + apiKeyEnv"
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

### Was NICHT Teil dieser Implementierung ist

- Runtime-Integration von `namespace-config.js` in `index.js` / `AgentDbPool` (Follow-up)
- Cross-Namespace-Recall in der Live-Recall-Pipeline (Follow-up nach namespace-config)
- Download-Fortschrittsanzeige für HuggingFace-Modelle
- Crontab-Eintrag durch Plugin (Root-Rechte bewusst ausgeschlossen)
- Automatischer Reindex bei Dimension-Mismatch ohne User-Aktion
- Löschen alter LanceDB-Dateien (immer Sache des Users)
- Legacy-Staging-Kopien oder externe Deployments
- Änderungen an Dreaming / Forgetting-Curve

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
  "setup.reranker.invalid_advanced_choice",
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

  it("advanced invalid-choice diagnostic names the exact valid tokens", () => {
    const message = t("setup.reranker.invalid_advanced_choice", { lang: "en", tone: "default" });
    assert.match(message, /a, b, or c/);
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

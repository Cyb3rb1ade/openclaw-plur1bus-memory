import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWizardOptions, formatWizardOption } from "../scripts/provider-wizard.mjs";

describe("provider-wizard i18n rendering", () => {
  it("Cohere ist Option 1 in der Reranker-Liste (de)", () => {
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

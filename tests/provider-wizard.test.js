import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWizardOptions, formatWizardOption } from "../scripts/provider-wizard.mjs";

describe("provider-wizard i18n rendering", () => {
  // Seit 7.10.0 ist der lokale BGE-Reranker die Empfehlung und steht vorn;
  // Cohere folgt als gehostete Alternative.
  it("lokaler BGE ist Option 1, Cohere Option 2 in der Reranker-Liste (de)", () => {
    const options = buildWizardOptions("reranker", { lang: "de" });
    assert.strictEqual(options[0].key, "local-transformers");
    assert.strictEqual(options[1].key, "cohere");
    assert.ok(formatWizardOption("reranker", "local-transformers", { lang: "de" }).includes("empfohlen"));
  });

  it("lokaler BGE ist Option 1, Cohere Option 2 in der Reranker-Liste (en)", () => {
    const options = buildWizardOptions("reranker", { lang: "en" });
    assert.strictEqual(options[0].key, "local-transformers");
    assert.strictEqual(options[1].key, "cohere");
    assert.ok(formatWizardOption("reranker", "local-transformers", { lang: "en" }).includes("recommended"));
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

  // Seit 7.12.0 ist Jina v5 Text Nano die Empfehlung und steht vorn; OpenAI
  // folgt als gehostete Alternative, E5 als schlüsselloser Notnagel, v3 als
  // Bestandsoption.
  it("Jina v5 Text Nano ist Option 1, OpenAI Option 2 in der Embedding-Liste", () => {
    const options = buildWizardOptions("embedding", { lang: "de" });
    assert.deepStrictEqual(options.map((o) => o.key), ["local-jina-v5-nano", "openai", "local-transformers", "local-jina"]);
    assert.ok(formatWizardOption("embedding", "local-jina-v5-nano", { lang: "de" }).includes("empfohlen"));
    assert.ok(formatWizardOption("embedding", "local-jina-v5-nano", { lang: "en" }).includes("recommended"));
    assert.ok(!formatWizardOption("embedding", "openai", { lang: "de" }).includes("empfohlen"));
  });

  it("Embedding OpenAI-Label enthält 'kostenpflichtig' (de)", () => {
    const label = formatWizardOption("embedding", "openai", { lang: "de" });
    assert.ok(label.toLowerCase().includes("kostenpflichtig"), `'kostenpflichtig' fehlt: ${label}`);
  });

  it("Embedding lokales Modell enthält 'multilingual' (de)", () => {
    const label = formatWizardOption("embedding", "local-transformers", { lang: "de" });
    assert.ok(label.toLowerCase().includes("multilingual"), `'multilingual' fehlt: ${label}`);
  });

  it("bietet JinaAI v3 als separates nachladbares mehrsprachiges Embedding an", () => {
    const options = buildWizardOptions("embedding", { lang: "de" });
    assert.equal(options[3].key, "local-jina");
    const label = formatWizardOption("embedding", "local-jina", { lang: "de" });
    assert.match(label, /JinaAI.*mehrsprachig.*1024d/i);
  });

  it("Embedding OpenAI-Label enthält 'paid' (en)", () => {
    const label = formatWizardOption("embedding", "openai", { lang: "en" });
    assert.ok(label.toLowerCase().includes("paid"), `'paid' fehlt: ${label}`);
  });
});

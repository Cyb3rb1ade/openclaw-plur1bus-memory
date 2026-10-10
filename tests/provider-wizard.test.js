import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWizardOptions, formatWizardOption } from "../scripts/provider-wizard.mjs";
import { t } from "../lib/i18n.js";

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
    assert.equal(options[4].key, "local-jina");
    const label = formatWizardOption("embedding", "local-jina", { lang: "de" });
    assert.match(label, /JinaAI.*mehrsprachig.*1024d/i);
  });

  it("bietet EmbeddingGemma 2 (Apache-2.0, 768d) als lokales Embedding an, ohne Nicht-Kommerziell-Hinweis", () => {
    const de = formatWizardOption("embedding", "local-embeddinggemma-2", { lang: "de" });
    const en = formatWizardOption("embedding", "local-embeddinggemma-2", { lang: "en" });
    assert.equal(en, "Local: google/embeddinggemma-2 (Apache-2.0, 768d, recommended)");
    assert.equal(de, "Lokal: google/embeddinggemma-2 (Apache-2.0, 768d, empfohlen)");
    const option = buildWizardOptions("embedding", { lang: "en" }).find((o) => o.key === "local-embeddinggemma-2");
    assert.ok(option.i18nHelp);
    assert.ok(!/CC BY-NC/.test(formatWizardOption("embedding", "local-embeddinggemma-2", { lang: "en" })));
  });

  it("E5 bleibt wählbar", () => {
    assert.ok(buildWizardOptions("embedding", { lang: "en" }).some((o) => o.key === "local-transformers"));
    assert.match(formatWizardOption("embedding", "local-transformers", { lang: "en" }), /intfloat\/multilingual-e5-small/);
  });

  it("Embedding OpenAI-Label enthält 'paid' (en)", () => {
    const label = formatWizardOption("embedding", "openai", { lang: "en" });
    assert.ok(label.toLowerCase().includes("paid"), `'paid' fehlt: ${label}`);
  });

  // Der Owner hat EmbeddingGemma 2 zum einheitlichen lokalen Standard erklärt: erste Option und einzige "empfohlen".
  it("embedding list: EmbeddingGemma 2 first, then Jina v5 Nano, OpenAI, E5, Jina v3", () => {
    assert.deepStrictEqual(buildWizardOptions("embedding").map((o) => o.key), ["local-embeddinggemma-2", "local-jina-v5-nano", "openai", "local-transformers", "local-jina"]);
  });

  it("embedding list: only EmbeddingGemma 2 carries the recommendation, in both languages", () => {
    for (const [lang, word] of [["de", "empfohlen"], ["en", "recommended"]]) {
      for (const opt of buildWizardOptions("embedding")) {
        const label = formatWizardOption("embedding", opt.key, { lang });
        const help = t(opt.i18nHelp, { lang, tone: "default" });
        const text = `${label} ${help}`.toLowerCase();
        if (opt.key === "local-embeddinggemma-2") assert.ok(label.includes(word), `${lang}: gemma label lacks ${word}: ${label}`);
        else assert.ok(!text.includes(word) && !text.includes(lang === "de" ? "neuinstallationen nehmen nano" : "new installs take nano"), `${lang}: ${opt.key} must not be recommended: ${text}`);
      }
    }
  });

  it("embedding list: Jina v5 Nano keeps its non-commercial notice, E5 stays selectable", () => {
    for (const lang of ["de", "en"]) {
      const nano = buildWizardOptions("embedding").find((o) => o.key === "local-jina-v5-nano");
      assert.match(t(nano.i18nHelp, { lang, tone: "default" }), /CC BY-NC 4\.0/);
      assert.ok(buildWizardOptions("embedding").some((o) => o.key === "local-transformers"));
    }
  });
});

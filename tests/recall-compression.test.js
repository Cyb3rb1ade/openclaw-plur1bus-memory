/**
 * tests/recall-compression.test.js
 *
 * P2: Recall-Kompression — generateSummary & compressMemoriesForPrompt
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { generateSummary, compressMemoriesForPrompt } from "../lib/text-utils.js";

describe("P2 generateSummary", () => {
  it("gibt kurzen Text unverändert zurück", () => {
    const text = "Kurzer Text.";
    assert.strictEqual(generateSummary(text, 10), text);
  });

  it("endet an Satzgrenze wenn diese innerhalb von maxWords ± 10% liegt", () => {
    // 5-Wort-Sätze, maxWords=11 → lowerBound=9.9≈9 (bei floor) oder 10 (bei ceil)
    // Wir testen mit maxWords=11: Satzgrenze bei Wort 10 liegt in [9.9, 11]
    const text =
      "Eins zwei drei vier fünf. Sechs sieben acht neun zehn. Elf zwölf dreizehn.";
    const summary = generateSummary(text, 11);
    assert.strictEqual(
      summary,
      "Eins zwei drei vier fünf. Sechs sieben acht neun zehn.",
    );
  });

  it("endet an Satzgrenze auch bei ! und ?", () => {
    const text =
      "Eins zwei drei vier fünf! Sechs sieben acht neun zehn? Elf zwölf dreizehn.";
    const summary = generateSummary(text, 11);
    assert.strictEqual(
      summary,
      "Eins zwei drei vier fünf! Sechs sieben acht neun zehn?",
    );
  });

  it("schneidet hart ab wenn keine Satzgrenze in ±10% von maxWords", () => {
    const text =
      "Eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn";
    const summary = generateSummary(text, 10);
    assert.ok(summary.endsWith("…"));
    assert.ok(!summary.includes("elf"));
    const words = summary.replace(/…$/, "").trim().split(/\s+/);
    assert.strictEqual(words.length, 10);
  });

  it("endet nicht mitten in einem Wort", () => {
    const text =
      "Dies ist ein sehr langes Wort das wir nicht unterbrechen wollen";
    const summary = generateSummary(text, 5);
    const words = summary.replace(/…$/, "").trim().split(/\s+/);
    const lastWord = words.pop();
    assert.strictEqual(lastWord, "langes");
    assert.ok(summary.endsWith("…"));
  });

  it("erhält Acronyme bei Truncation", () => {
    const text =
      "AI and GPU are critical. API and SQL matter. CSS and HTML complete.";
    const summary = generateSummary(text, 10);
    // Wort 10 = "CSS"; Satzgrenze bei Wort 5 (critical.) und 9 (matter.)
    // lowerBound=9, maxWords=10 → Wort 9 liegt in Range
    assert.ok(summary.includes("AI"));
    assert.ok(summary.includes("GPU"));
    assert.ok(summary.includes("API"));
    assert.ok(summary.includes("SQL"));
    assert.ok(!summary.includes("CSS")); // nach Wort 10
  });

  it("findet Satzgrenze auch wenn sie knapp unter lowerBound liegt (ceil-Rundung)", () => {
    // maxWords=10 → lowerBound = 9 (bei floor) oder 10 (bei ceil)
    // Je nach Implementation. Wir erwarten, dass 9 in Range ist.
    const text =
      "Eins zwei drei vier fünf. Sechs sieben acht neun zehn. Elf zwölf.";
    const summary = generateSummary(text, 10);
    // Satzgrenze bei Wort 5 und 10.
    // Wort 10 liegt genau auf maxWords → sollte gefunden werden
    assert.strictEqual(
      summary,
      "Eins zwei drei vier fünf. Sechs sieben acht neun zehn.",
    );
  });
});

describe("P2 compressMemoriesForPrompt", () => {
  it("gibt leeren String für leere Memories zurück", () => {
    assert.strictEqual(compressMemoriesForPrompt([], 100), "");
  });

  it("hält Tokenbudget ein", () => {
    const memories = [
      {
        entry: {
          id: 1,
          text: "word ".repeat(80).trim(),
          summary: "word ".repeat(80).trim(),
          category: "other",
          memoryClass: "standard",
        },
      },
      {
        entry: {
          id: 2,
          text: "word ".repeat(80).trim(),
          summary: "word ".repeat(80).trim(),
          category: "project",
          memoryClass: "standard",
        },
      },
    ];
    const result = compressMemoriesForPrompt(memories, 50);
    const wordCount = result
      .replace(/…/g, "")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
    assert.ok(
      wordCount <= 50,
      `Expected <= 50 words, got ${wordCount}`,
    );
  });

  it("core/canonical werden weniger komprimiert als episodic", () => {
    const longText = "word ".repeat(60).trim();
    const memories = [
      {
        entry: {
          id: 1,
          text: "CORE " + longText,
          summary: "CORE " + longText,
          category: "canonical",
          memoryClass: "core",
        },
      },
      {
        entry: {
          id: 2,
          text: "EPISODIC " + longText,
          summary: "EPISODIC " + longText,
          category: "other",
          memoryClass: "standard",
        },
      },
    ];
    const result = compressMemoriesForPrompt(memories, 60);
    const lines = result
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const coreLine = lines.find((l) => l.startsWith("CORE")) || "";
    const episodicLine = lines.find((l) => l.startsWith("EPISODIC")) || "";

    const coreWords = coreLine.replace(/…/g, "").trim().split(/\s+/).filter(Boolean).length;
    const episodicWords = episodicLine.replace(/…/g, "").trim().split(/\s+/).filter(Boolean).length;

    assert.ok(
      coreWords > episodicWords,
      `Expected core (${coreWords}) > episodic (${episodicWords})`,
    );
  });

  it("reduziert lower-priority Memories zuerst bei Budgetüberschreitung", () => {
    // 3 Memories: 1 core, 1 project, 1 episodic
    // Base = 30. Raw: core=45, project=30, episodic=18 → Total=93
    // Budget=60. Excess=33.
    // Episodic soll zuerst reduziert werden, dann project, dann core.
    const text = "w ".repeat(50).trim();
    const memories = [
      {
        entry: {
          id: 1,
          text: "CORE " + text,
          summary: "CORE " + text,
          category: "canonical",
          memoryClass: "core",
        },
      },
      {
        entry: {
          id: 2,
          text: "PROJECT " + text,
          summary: "PROJECT " + text,
          category: "project",
          memoryClass: "standard",
        },
      },
      {
        entry: {
          id: 3,
          text: "EPISODIC " + text,
          summary: "EPISODIC " + text,
          category: "other",
          memoryClass: "standard",
        },
      },
    ];
    const result = compressMemoriesForPrompt(memories, 60);
    const lines = result
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const coreWords = (lines.find((l) => l.startsWith("CORE")) || "")
      .replace(/…/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    const projectWords = (lines.find((l) => l.startsWith("PROJECT")) || "")
      .replace(/…/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    const episodicWords = (lines.find((l) => l.startsWith("EPISODIC")) || "")
      .replace(/…/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

    // Core should keep the most, episodic the least
    assert.ok(coreWords >= projectWords, `core ${coreWords} >= project ${projectWords}`);
    assert.ok(projectWords >= episodicWords, `project ${projectWords} >= episodic ${episodicWords}`);
  });

  it("verwendet generateSummary für finale Kompression", () => {
    const text =
      "Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.";
    const memories = [
      {
        entry: {
          id: 1,
          text,
          summary: text,
          category: "other",
          memoryClass: "standard",
        },
      },
    ];
    const result = compressMemoriesForPrompt(memories, 6);
    // generateSummary with maxWords=6 (base=6 * 0.6 = 3.6 ≈ 3?)
    // Wait: base = tokenBudget / N = 6 / 1 = 6
    // episodic multiplier = 0.6 → alloc = 3
    // generateSummary(text, 3) should hard-cut at 3 words + …
    assert.ok(result.endsWith("…"));
  });
});

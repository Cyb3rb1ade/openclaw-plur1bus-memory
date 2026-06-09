/**
 * tests/recall-golden-set.test.js
 *
 * Golden-Set Recall Quality Validation (P5).
 * Bekannte Memories mit erwartetem Verhalten — Regressionsschutz.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { tokenize, generateSummary } from "../lib/text-utils.js";
import { computeDecayedStrength, resolveHalfLifeDays } from "../lib/memory-dynamics.js";
import { dedupResults } from "../lib/recall-pipeline.js";

const MS_PER_DAY = 86400000;

// ─── 1. tokenize behält Akronyme ───────────────────────────────────────────

describe("Golden-Set: tokenize preserves acronyms", () => {
  it('keeps AI, API, GPU, CUDA from "AI API GPU CUDA machine learning project"', () => {
    const tokens = tokenize("AI API GPU CUDA machine learning project");
    assert.ok(tokens.has("ai"), "expected 'ai' token");
    assert.ok(tokens.has("api"), "expected 'api' token");
    assert.ok(tokens.has("gpu"), "expected 'gpu' token");
    assert.ok(tokens.has("cuda"), "expected 'cuda' token");
    assert.ok(tokens.has("machine"), "expected 'machine' token");
    assert.ok(tokens.has("learning"), "expected 'learning' token");
    assert.ok(tokens.has("project"), "expected 'project' token");
  });
});

// ─── 2. computeDecayedStrength korrekt für jede Kategorie ─────────────────

describe("Golden-Set: computeDecayedStrength by category", () => {
  const now = Date.now();

  it("person memory still >0.88 after 100 days", () => {
    const row = {
      memoryStrength: 1.0,
      halfLifeDays: resolveHalfLifeDays("person"),
      createdAt: now - 100 * MS_PER_DAY,
    };
    const strength = computeDecayedStrength(row, now);
    assert.ok(
      strength > 0.88,
      `expected person strength > 0.88 after 100 days, got ${strength}`,
    );
  });

  it("project memory still >0.88 after 100 days", () => {
    const row = {
      memoryStrength: 1.0,
      halfLifeDays: resolveHalfLifeDays("project"),
      createdAt: now - 100 * MS_PER_DAY,
    };
    const strength = computeDecayedStrength(row, now);
    assert.ok(
      strength > 0.88,
      `expected project strength > 0.88 after 100 days, got ${strength}`,
    );
  });

  it("general memory (halfLifeDays=60) much lower after 100 days", () => {
    const row = {
      memoryStrength: 1.0,
      halfLifeDays: 60,
      createdAt: now - 100 * MS_PER_DAY,
    };
    const strength = computeDecayedStrength(row, now);
    assert.ok(
      strength < 0.5,
      `expected general strength < 0.5 after 100 days, got ${strength}`,
    );
  });

  it("core memory (emotionalIntensity=0.99, importance=0.99) always 1.0", () => {
    const row = {
      memoryClass: "core",
      emotionalIntensity: 0.99,
      importance: 0.99,
      memoryStrength: 1.0,
      halfLifeDays: 365,
      createdAt: now - 1000 * MS_PER_DAY,
    };
    const strength = computeDecayedStrength(row, now);
    assert.strictEqual(strength, 1.0, "core memory must always stay at 1.0");
  });
});

// ─── 3. dedupResults nicht zu aggressiv ────────────────────────────────────

describe("Golden-Set: dedupResults lets similar project memories through", () => {
  it("two near-identical project memories survive at 0.78 threshold", () => {
    const m1 = {
      entry: {
        id: "proj-a",
        text: "Project Alpha: implement auth service for internal tools",
      },
    };
    const m2 = {
      entry: {
        id: "proj-b",
        text: "Project Alpha: implement login service for internal tools",
      },
    };
    const deduped = dedupResults([m1, m2], 10, 0.78);
    assert.strictEqual(
      deduped.length,
      2,
      "expected both near-identical project memories to survive dedup",
    );
  });
});

// ─── 4. generateSummary an Satzgrenzen ─────────────────────────────────────

describe("Golden-Set: generateSummary respects sentence boundaries", () => {
  it("cuts at the last sentence boundary within ±10% of maxWords", () => {
    // Build a text where a sentence boundary sits right inside the window.
    const sentence1 = "This is the first sentence that contains exactly ten words.";
    const sentence2 = "Here is another sentence with exactly ten words inside.";
    const sentence3 = "Yet another ten word sentence is placed right here.";
    const sentence4 = "The final sentence also has ten words for this test.";
    const text = `${sentence1} ${sentence2} ${sentence3} ${sentence4}`;
    // 40 words total; maxWords=25, lowerBound=22.5 → ceil=23.
    // Sentence 1+2 = 20 words (<23). Sentence 1+2+3 = 30 words (>25).
    // No single sentence boundary within [23,25], so it should hard-truncate.
    // Let's use maxWords=30, lowerBound=27. Sentence 1+2+3 = 30 words (within window).
    const summary = generateSummary(text, 30);
    assert.ok(
      summary.endsWith("here."),
      `expected summary to end at sentence boundary, got: "${summary}"`,
    );
    assert.ok(
      !summary.includes("The final"),
      "summary should not include the fourth sentence",
    );
  });

  it("hard-truncates with ellipsis when no sentence boundary is in window", () => {
    // 25 words before any sentence boundary, maxWords=20 → no boundary within [18,20]
    const text =
      "One two three four five six seven eight nine ten " +
      "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty " +
      "twentyone twentytwo twentythree twentyfour twentyfive. " +
      "This second sentence is extra text that should not appear.";
    const summary = generateSummary(text, 20);
    assert.ok(
      summary.endsWith("…"),
      `expected ellipsis when no boundary in window, got: "${summary}"`,
    );
  });
});

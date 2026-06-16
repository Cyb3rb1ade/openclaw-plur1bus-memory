import { describe, it } from "node:test";
import assert from "node:assert";
import {
  classifyFactDurability,
  detectTrivialMemory,
  detectTemporaryMemory,
  detectDurablePreference,
  detectProjectFact,
  detectCorrectionSignal,
  normalizeImportanceScore,
  explainFactQuality,
} from "../lib/memory-fact-quality.js";

describe("memory-fact-quality", () => {
  it("explainFactQuality returns a structured result with required fields", () => {
    const result = explainFactQuality("User prefers concise answers");
    assert.strictEqual(typeof result, "object");
    assert.ok(["durable", "temporary", "ephemeral", "unknown"].includes(result.durability), "durability is valid");
    assert.ok(Array.isArray(result.categoryHints), "categoryHints is array");
    assert.ok(["low", "medium", "high", "critical"].includes(result.importanceBand), "importanceBand is valid");
    assert.strictEqual(typeof result.shouldPromote, "boolean");
    assert.strictEqual(typeof result.shouldDownrank, "boolean");
    assert.ok(Array.isArray(result.reasons), "reasons is array");
    assert.ok(result.reasons.length > 0, "reasons not empty");
  });

  it("detects trivial filler", () => {
    for (const text of ["ok", "yes", "go on", "weiter", "mach", "danke", "OK!!!", "  ok  "]) {
      const result = detectTrivialMemory(text);
      assert.strictEqual(result.trivial, true, `${text} should be trivial`);
      assert.ok(result.reasons.length > 0, `${text} should have reasons`);
    }
  });

  it("does not mark normal sentences as trivial", () => {
    const result = detectTrivialMemory("User prefers concise answers");
    assert.strictEqual(result.trivial, false);
  });

  it("detects temporary/status statements", () => {
    const examples = [
      "Today npm test passed",
      "Heute läuft npm test",
      "currently downloading the update",
      "right now the build is red",
      "tomorrow we will deploy",
      "test run finished",
    ];
    for (const text of examples) {
      const result = detectTemporaryMemory(text);
      assert.strictEqual(result.temporary, true, `${text} should be temporary`);
      assert.ok(result.reasons.length > 0, `${text} should have reasons`);
    }
  });

  it("does not mark durable facts as temporary", () => {
    const result = detectTemporaryMemory("From now on, use German for repo prompts");
    assert.strictEqual(result.temporary, false);
  });

  it("detects durable preferences", () => {
    const examples = [
      "User prefers concise answers",
      "I always want German responses",
      "From now on, use German for repo prompts",
      "I never want emojis in summaries",
      "bevorzuge kurze Antworten",
    ];
    for (const text of examples) {
      const result = detectDurablePreference(text);
      assert.strictEqual(result.durablePreference, true, `${text} should be durable preference`);
    }
  });

  it("detects project facts", () => {
    const examples = [
      "Deployment läuft auf Node 22",
      "Dreamdale ist ein Festival",
      "The project uses React and PostgreSQL",
      "Auth bypass in group chats was fixed",
    ];
    for (const text of examples) {
      const result = detectProjectFact(text);
      assert.strictEqual(result.projectFact, true, `${text} should be project fact`);
    }
  });

  it("detects correction signals", () => {
    const examples = [
      "Nicht mehr Vue, jetzt React",
      "No longer Postgres, use MySQL instead",
      "Dreamdale is a festival, not a city",
      "statt Python nun JavaScript",
      "Instead of REST we now use GraphQL",
    ];
    for (const text of examples) {
      const result = detectCorrectionSignal(text);
      assert.strictEqual(result.correction, true, `${text} should be correction`);
    }
  });

  it("detects explicit remember instructions", () => {
    const examples = [
      "Remember this: deploy on Fridays is forbidden",
      "Always use Node 22 for this project",
      "Don't forget to pin the version",
      "Merke dir das bitte",
    ];
    for (const text of examples) {
      const result = explainFactQuality(text);
      assert.ok(
        result.reasons.some((r) => /remember|explicit instruction|always|merke/i.test(r)),
        `${text} should have remember reason: ${JSON.stringify(result.reasons)}`
      );
    }
  });

  it("classifies durability correctly for representative examples", () => {
    assert.strictEqual(explainFactQuality("ok").durability, "ephemeral");
    assert.strictEqual(explainFactQuality("Today npm test passed").durability, "temporary");
    assert.strictEqual(explainFactQuality("User prefers concise answers").durability, "durable");
    assert.strictEqual(explainFactQuality("From now on, use German").durability, "durable");
    assert.strictEqual(explainFactQuality("Dreamdale ist ein Festival").durability, "durable");
    assert.strictEqual(explainFactQuality("Auth bypass in group chats was fixed").durability, "durable");
  });

  it("classifies importance band correctly for representative examples", () => {
    assert.strictEqual(explainFactQuality("ok").importanceBand, "low");
    assert.strictEqual(explainFactQuality("go on!!!!").importanceBand, "low");
    assert.strictEqual(explainFactQuality("Today npm test passed").importanceBand, "low");
    assert.strictEqual(explainFactQuality("User prefers concise answers").importanceBand, "medium");
    assert.strictEqual(explainFactQuality("From now on, use German for repo prompts").importanceBand, "high");
    assert.strictEqual(explainFactQuality("Dreamdale is a festival, not a city").importanceBand, "high");
    assert.strictEqual(explainFactQuality("Auth bypass in group chats was fixed").importanceBand, "high");
  });

  it("does not let emotion-only text become high importance", () => {
    const result = explainFactQuality("I am so angry and frustrated");
    assert.ok(result.importanceBand !== "high" && result.importanceBand !== "critical", "emotion-only should not be high");
    assert.strictEqual(result.shouldPromote, false);
  });

  it("does not let generic technical words alone become high importance", () => {
    const result = explainFactQuality("node react postgres");
    assert.ok(result.importanceBand !== "high" && result.importanceBand !== "critical", "generic tech words should not be high");
  });

  it("normalizeImportanceScore clamps to valid range", () => {
    assert.strictEqual(normalizeImportanceScore(-0.5), 0);
    assert.strictEqual(normalizeImportanceScore(1.5), 1);
    assert.strictEqual(normalizeImportanceScore(0.5), 0.5);
  });

  it("normalizeImportanceScore applies downrank for trivial reasons", () => {
    const score = normalizeImportanceScore(0.9, ["trivial filler"], { downrankTrivial: true });
    assert.ok(score <= 0.3, `trivial should be downranked, got ${score}`);
  });

  it("normalizeImportanceScore applies floor for durable preferences", () => {
    const score = normalizeImportanceScore(0.3, ["preference verb"], { minDurablePreference: 0.55 });
    assert.ok(score >= 0.55, `durable preference should have floor, got ${score}`);
  });

  it("normalizeImportanceScore applies floor for project facts", () => {
    const score = normalizeImportanceScore(0.3, ["technical term", "named entity with descriptive content"], { minProjectFact: 0.65 });
    assert.ok(score >= 0.65, `project fact should have floor, got ${score}`);
  });

  it("normalizeImportanceScore applies floor for explicit remember instructions", () => {
    const score = normalizeImportanceScore(0.3, ["explicit remember instruction"], { minExplicitRemember: 0.7 });
    assert.ok(score >= 0.7, `remember instruction should have floor, got ${score}`);
  });

  it("normalizeImportanceScore preserves explicit high importance over floors", () => {
    const score = normalizeImportanceScore(0.95, ["explicit durable preference"], { minDurablePreference: 0.55 });
    assert.strictEqual(score, 0.95);
  });
});

/**
 * Regressionstests für die INJECTED_CONTEXT_RE-Performance in lib/neo-arch.js.
 *
 * Kontext: Das Audit vom 2026-06-16 hat die ursprüngliche komplexe Alternation-
 * Regex als super-linear markiert. Der Code wurde bereits auf einen linearen
 * String.includes()-Vorfilter plus kleine begrenzte Regexen umgestellt.
 * Diese Tests sichern das Verhalten und das Zeitbudget ab.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { isInjectedContextText } from "../lib/neo-arch.js";

describe("neo-arch isInjectedContextText", () => {
  it("erkennt kurze injizierte Kontexte unverändert", () => {
    assert.strictEqual(isInjectedContextText("<plur1bus-recall>foo</plur1bus-recall>"), true);
    assert.strictEqual(isInjectedContextText("RECALL SAFETY RULES"), true);
    assert.strictEqual(isInjectedContextText('{"capturedBy" :  "agent_end_capture"}'), true);
    assert.strictEqual(isInjectedContextText('{"embeddingStatus"  :   "pending"}'), true);
    assert.strictEqual(isInjectedContextText('{"chat_id" : "telegram:123"}'), true);
    assert.strictEqual(isInjectedContextText("[cron: heartbeat]"), true);
    assert.strictEqual(isInjectedContextText("bounded search query"), true);
  });

  it("erkennt kurze normale Texte als nicht-injiziert", () => {
    assert.strictEqual(isInjectedContextText("regular user text"), false);
    assert.strictEqual(isInjectedContextText("Captured by the wind"), false);
    assert.strictEqual(isInjectedContextText("The embedding status is ready"), false);
    assert.strictEqual(isInjectedContextText("Use only the available memory tools please"), true);
    assert.strictEqual(isInjectedContextText(""), false);
  });

  it("hält lange normale Eingaben unter einem Zeitbudget", () => {
    const longNormal = "a".repeat(10_000);
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      isInjectedContextText(longNormal);
    }
    const ms = performance.now() - start;
    // Budget: deutlich unter dem alten Audit-Wert (~1.400 ms gemessen).
    // Mit dem linearen Vorfilter sollten 10k Checks auf 10k Zeichen < 500 ms sein.
    assert.ok(ms < 500, `10k Checks auf 10k Zeichen dauerten ${ms.toFixed(2)}ms, erwartet < 500ms`);
  });

  it("hält adversariale Eingaben mit vielen '<' unter einem Zeitbudget", () => {
    const adversarial = Array.from({ length: 1_000 }, (_, i) => `<tag${i % 10}>${"x".repeat(20)}</tag${i % 10}>`).join(" ");
    const start = performance.now();
    for (let i = 0; i < 1_000; i++) {
      isInjectedContextText(adversarial);
    }
    const ms = performance.now() - start;
    assert.ok(ms < 500, `1k adversariale Checks dauerten ${ms.toFixed(2)}ms, erwartet < 500ms`);
  });

  it("kein Catastrophic Backtracking auf gemischten langen Inputs", () => {
    const mixed = "abc ".repeat(2_500) + "<plur1bus-recall>marker</plur1bus-recall>" + " def".repeat(2_500);
    const start = performance.now();
    const result = isInjectedContextText(mixed);
    const ms = performance.now() - start;
    assert.strictEqual(result, true);
    assert.ok(ms < 5, `Einzelcheck auf 10k+ Zeichen dauerte ${ms.toFixed(2)}ms, erwartet < 5ms`);
  });
});

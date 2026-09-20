import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

// Der Capture-Hook lässt sich ohne Gateway nicht aufrufen; geprüft wird
// deshalb, dass der Pfad keinen geschätzten Wert mehr bildet.
describe("capture writes a neutral importance", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const captureBlock = source.slice(source.indexOf("const categoryResult = categorizeMemoryWithReason(p.text)"), source.indexOf("await db.store(row)"));

  it("no longer derives importance from keywords at capture", () => {
    assert.strictEqual(captureBlock.includes("computeMemoryImportance"), false);
  });

  it("marks the row as pending for the hourly cron", () => {
    assert.match(captureBlock, /importanceStatus: IMPORTANCE_STATUS\.PENDING/);
  });

  it("uses the neutral value in the meantime", () => {
    // Toleriert sowohl "importance: 0.5" als auch ein lokales
    // "const importance = 0.5;" mit Leerzeichen um das Gleichheitszeichen —
    // die Assertion soll den Wert festnageln, nicht die gewählte Syntax.
    // (?!\d) verhindert, dass 0.55, 0.51 oder 0.500 als Treffer durchrutschen.
    assert.match(captureBlock, /importance\s*[:=]\s*0\.5(?!\d)/);
  });
});

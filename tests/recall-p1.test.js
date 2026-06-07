/**
 * tests/recall-p1.test.js
 *
 * P1: Typbasierte Memory-Halbwertszeiten (halfLifeDays)
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolveHalfLifeDays,
  applyDynamicsDefaults,
  computeDecayedStrength,
  CORE_MEMORY_HALF_LIFE_DAYS,
} from "../lib/memory-dynamics.js";

describe("P1 resolveHalfLifeDays", () => {
  it("maps transient categories (fact, general) to 60 days", () => {
    assert.strictEqual(resolveHalfLifeDays("fact"), 60);
    assert.strictEqual(resolveHalfLifeDays("general"), 60);
  });

  it("maps episodic category (other) to 180 days", () => {
    assert.strictEqual(resolveHalfLifeDays("other"), 180);
  });

  it("maps longContext categories (person, work) to 600 days", () => {
    assert.strictEqual(resolveHalfLifeDays("person"), 600);
    assert.strictEqual(resolveHalfLifeDays("work"), 600);
  });

  it("maps project categories (project, decision) to 600 days", () => {
    assert.strictEqual(resolveHalfLifeDays("project"), 600);
    assert.strictEqual(resolveHalfLifeDays("decision"), 600);
  });

  it("defaults unknown categories to 180 (episodic)", () => {
    assert.strictEqual(resolveHalfLifeDays("random"), 180);
    assert.strictEqual(resolveHalfLifeDays(""), 180);
  });

  it("allows config override per group", () => {
    const overrides = { transient: 90, project: 730 };
    assert.strictEqual(resolveHalfLifeDays("fact", null, overrides), 90);
    assert.strictEqual(resolveHalfLifeDays("project", null, overrides), 730);
    // Non-overridden groups keep defaults
    assert.strictEqual(resolveHalfLifeDays("person", null, overrides), 600);
  });

  it("ignores category mapping for core memories", () => {
    assert.strictEqual(
      resolveHalfLifeDays("fact", "core"),
      CORE_MEMORY_HALF_LIFE_DAYS,
    );
    assert.strictEqual(
      resolveHalfLifeDays("project", "core"),
      CORE_MEMORY_HALF_LIFE_DAYS,
    );
  });
});

describe("P1 applyDynamicsDefaults", () => {
  it("sets halfLifeDays from category for new standard memories", () => {
    const out = applyDynamicsDefaults({ category: "project" });
    assert.strictEqual(out.halfLifeDays, 600);
    assert.strictEqual(out.memoryClass, "standard");
  });

  it("sets halfLifeDays from category for new fact memories", () => {
    const out = applyDynamicsDefaults({ category: "fact" });
    assert.strictEqual(out.halfLifeDays, 60);
  });

  it("preserves existing halfLifeDays on existing rows (lastDynamicsAt set)", () => {
    const out = applyDynamicsDefaults({
      category: "project",
      halfLifeDays: 30,
      lastDynamicsAt: Date.now(),
    });
    // Should not override existing halfLifeDays
    assert.strictEqual(out.halfLifeDays, 30);
  });

  it("preserves explicit halfLifeDays on new rows when provided", () => {
    const out = applyDynamicsDefaults({ category: "fact", halfLifeDays: 999 });
    assert.strictEqual(out.halfLifeDays, 999);
  });

  it("core memory encoding overrides halfLifeDays to CORE_MEMORY_HALF_LIFE_DAYS", () => {
    const out = applyDynamicsDefaults({
      category: "person",
      emotionalIntensity: 0.99,
      importance: 0.99,
      novelty: 0.99,
      userCorrection: 0.99,
    });
    assert.strictEqual(out.memoryClass, "core");
    assert.strictEqual(out.halfLifeDays, CORE_MEMORY_HALF_LIFE_DAYS);
  });
});

describe("P1 computeDecayedStrength respects category halfLife", () => {
  it("fact memory decays faster (60d) than project memory (600d)", () => {
    const now = Date.now();
    const factRow = {
      memoryStrength: 1.0,
      halfLifeDays: 60,
      createdAt: now - 86400000 * 60, // exactly 60 days ago
    };
    const projectRow = {
      memoryStrength: 1.0,
      halfLifeDays: 600,
      createdAt: now - 86400000 * 60, // 60 days ago
    };
    const factStrength = computeDecayedStrength(factRow, now);
    const projectStrength = computeDecayedStrength(projectRow, now);
    assert.ok(factStrength < projectStrength, "fact should decay faster than project");
    assert.ok(Math.abs(factStrength - 0.5) < 0.01, "fact after 60d should be ~0.5");
    assert.ok(projectStrength > 0.88, "project after 60d should be > 0.88 (1/2^(60/600))");
  });
});

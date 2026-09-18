import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveHalfLifeFromEncoding, CORE_MEMORY_HALF_LIFE_DAYS } from "../lib/memory-dynamics.js";

describe("half-life from encoding", () => {
  it("maps the four automatic bands", () => {
    assert.strictEqual(resolveHalfLifeFromEncoding(0.2), 30);
    assert.strictEqual(resolveHalfLifeFromEncoding(0.5), 180);
    assert.strictEqual(resolveHalfLifeFromEncoding(0.8), 600);
    assert.strictEqual(resolveHalfLifeFromEncoding(0.94), 600);
  });

  it("gives the agent band the core half-life", () => {
    assert.strictEqual(resolveHalfLifeFromEncoding(0.95), CORE_MEMORY_HALF_LIFE_DAYS);
    assert.strictEqual(resolveHalfLifeFromEncoding(1.0), CORE_MEMORY_HALF_LIFE_DAYS);
  });

  it("gives flashbulb ten years without touching the agent band", () => {
    assert.strictEqual(resolveHalfLifeFromEncoding(0.6, { flashbulb: true }), 3650);
    assert.strictEqual(resolveHalfLifeFromEncoding(0.2, { flashbulb: true }), 3650);
  });

  it("treats a missing value as the middle band", () => {
    assert.strictEqual(resolveHalfLifeFromEncoding(undefined), 180);
  });
});

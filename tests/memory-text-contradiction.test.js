import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveContradictionWinner, rankMemoryVersions } from "../lib/memory-text-contradiction.js";

describe("resolveContradictionWinner", () => {
  it("prefers the corrected version over the original", () => {
    const a = { id: "old", text: "We use Postgres.", versionNumber: 1, status: "superseded", supersededBy: "new" };
    const b = { id: "new", text: "We use MySQL.", versionNumber: 2, status: "active", supersededBy: "" };
    assert.strictEqual(resolveContradictionWinner(a, b), b);
    assert.strictEqual(resolveContradictionWinner(b, a), b);
  });

  it("prefers user_correction updateSource when versions are equal", () => {
    const a = { id: "a", text: "x", versionNumber: 1, updateSource: "dm" };
    const b = { id: "b", text: "y", versionNumber: 1, updateSource: "user_correction" };
    assert.strictEqual(resolveContradictionWinner(a, b), b);
  });

  it("prefers telegram:/correct updateSource when versions are equal", () => {
    const a = { id: "a", text: "x", versionNumber: 1, updateSource: "dm" };
    const b = { id: "b", text: "y", versionNumber: 1, updateSource: "telegram:/correct" };
    assert.strictEqual(resolveContradictionWinner(a, b), b);
  });

  it("prefers more recent versionCreatedAt as tie-breaker", () => {
    const now = Date.now();
    const a = { id: "a", text: "x", versionNumber: 1, versionCreatedAt: now - 1000 };
    const b = { id: "b", text: "y", versionNumber: 1, versionCreatedAt: now };
    assert.strictEqual(resolveContradictionWinner(a, b), b);
  });

  it("falls back to first argument when everything is equal", () => {
    const a = { id: "a", text: "x" };
    const b = { id: "b", text: "y" };
    assert.strictEqual(resolveContradictionWinner(a, b), a);
  });
});

describe("rankMemoryVersions", () => {
  it("ranks corrected memories first", () => {
    const memories = [
      { id: "old", text: "Postgres.", versionNumber: 1, status: "superseded", supersededBy: "new" },
      { id: "new", text: "MySQL.", versionNumber: 2, status: "active", supersededBy: "" },
    ];
    const ranked = rankMemoryVersions(memories);
    assert.strictEqual(ranked[0].id, "new");
    assert.strictEqual(ranked[1].id, "old");
  });
});

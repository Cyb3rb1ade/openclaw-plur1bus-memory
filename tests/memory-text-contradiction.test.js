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

  it("prefers higher versionNumber even when opponent is authoritative", () => {
    const a = { id: "a", text: "x", versionNumber: 3, updateSource: "dm" };
    const b = { id: "b", text: "y", versionNumber: 2, updateSource: "user_correction" };
    assert.strictEqual(resolveContradictionWinner(a, b), a);
    assert.strictEqual(resolveContradictionWinner(b, a), a);
  });

  it("authoritative source only wins when versionNumber is equal", () => {
    const authoritative = { id: "auth", text: "auth", versionNumber: 1, updateSource: "user_correction" };
    const nonAuthoritativeHigher = { id: "nonAuthHigh", text: "nonAuthHigh", versionNumber: 2, updateSource: "dm" };
    assert.strictEqual(resolveContradictionWinner(authoritative, nonAuthoritativeHigher), nonAuthoritativeHigher);

    const equalVersionAuth = { id: "eqAuth", text: "eqAuth", versionNumber: 1, updateSource: "user_correction" };
    const equalVersionNonAuth = { id: "eqNonAuth", text: "eqNonAuth", versionNumber: 1, updateSource: "dm" };
    assert.strictEqual(resolveContradictionWinner(equalVersionNonAuth, equalVersionAuth), equalVersionAuth);
  });

  it("does not let reconsolidationConfidence override versionCreatedAt", () => {
    const now = Date.now();
    const olderButConfident = {
      id: "olderConfident",
      text: "older",
      versionNumber: 1,
      versionCreatedAt: now - 1000,
      reconsolidationConfidence: 1.0,
    };
    const newerButUncertain = {
      id: "newerUncertain",
      text: "newer",
      versionNumber: 1,
      versionCreatedAt: now,
      reconsolidationConfidence: 0.0,
    };
    assert.strictEqual(resolveContradictionWinner(olderButConfident, newerButUncertain), newerButUncertain);
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

  it("ranks using strict lexicographic ordering", () => {
    const now = Date.now();
    const memories = [
      { id: "lowAuth", text: "a", versionNumber: 1, updateSource: "user_correction", versionCreatedAt: now },
      { id: "highNonAuth", text: "b", versionNumber: 2, updateSource: "dm", versionCreatedAt: now - 1000 },
      { id: "equalAuthOld", text: "c", versionNumber: 1, updateSource: "user_correction", versionCreatedAt: now - 1000 },
      { id: "equalNonAuth", text: "d", versionNumber: 1, updateSource: "dm", versionCreatedAt: now - 500 },
    ];
    const ranked = rankMemoryVersions(memories);
    assert.deepStrictEqual(
      ranked.map((m) => m.id),
      ["highNonAuth", "lowAuth", "equalAuthOld", "equalNonAuth"],
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeReviewProfile, REVIEW_PROFILES } from "../lib/obsidian-control-room.js";

describe("smoke-ux: U6 — normalizeReviewProfile", () => {
  it("maps adversarial to standard", () => {
    assert.strictEqual(normalizeReviewProfile("adversarial"), "standard");
  });

  it("preserves standard", () => {
    assert.strictEqual(normalizeReviewProfile("standard"), "standard");
  });

  it("preserves maintenance", () => {
    assert.strictEqual(normalizeReviewProfile("maintenance"), "maintenance");
  });

  it("unknown profile falls back to standard", () => {
    assert.strictEqual(normalizeReviewProfile("totally-unknown"), "standard");
  });

  it("REVIEW_PROFILES does not include adversarial", () => {
    assert.strictEqual(REVIEW_PROFILES.includes("adversarial"), false);
  });
});

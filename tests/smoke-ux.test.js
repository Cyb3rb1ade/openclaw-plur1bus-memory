import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeReviewProfile,
  REVIEW_PROFILES,
  writeCommandsMarkdown,
} from "../lib/obsidian-control-room.js";

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

describe("smoke-ux: U2 — writeCommandsMarkdown", () => {
  it("writes commands.md to vault and returns written:true", () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "smoke-ux-u2-"));
    const result = writeCommandsMarkdown({ vaultPath }, {});
    assert.strictEqual(result.written, true, "expected written:true");
    const content = readFileSync(join(vaultPath, "plur1bus", "commands.md"), "utf8");
    assert.ok(content.includes("plur1bus_type: command_reference"), "frontmatter present");
    assert.ok(content.includes("/plur1bus_morning"), "command list present");
  });

  it("returns written:false when vaultPath is missing", () => {
    const result = writeCommandsMarkdown({}, {});
    assert.strictEqual(result.written, false, "expected written:false for bad config");
  });
});

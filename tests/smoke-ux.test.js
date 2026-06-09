import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewProgressSection } from "../lib/obsidian/dashboard-generator.js";
import {
  normalizeReviewProfile,
  REVIEW_PROFILES,
  writeCommandsMarkdown,
  quickapplySummary,
  generateMemoryCardTemplate,
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

describe("smoke-ux: U1 — reviewProgressSection", () => {
  it("counts pending/applied/rejected/total correctly", () => {
    const records = [
      { status: "pending" },
      { status: "applied" },
      { status: "rejected" },
      { status: "pending" },
    ];
    const section = reviewProgressSection(records);
    assert.ok(section.includes("Pending review items: 2"), `expected pending=2, got:\n${section}`);
    assert.ok(section.includes("Applied: 1"), `expected applied=1, got:\n${section}`);
    assert.ok(section.includes("Rejected: 1"), `expected rejected=1, got:\n${section}`);
    assert.ok(section.includes("Total tracked: 4"), `expected total=4, got:\n${section}`);
  });

  it("returns all-zero counts for empty array", () => {
    const section = reviewProgressSection([]);
    assert.ok(section.includes("Pending review items: 0"));
    assert.ok(section.includes("Applied: 0"));
    assert.ok(section.includes("Total tracked: 0"));
  });

  it("treats missing status as pending", () => {
    const section = reviewProgressSection([{ id: "x" }, { status: "applied" }]);
    assert.ok(section.includes("Pending review items: 1"));
    assert.ok(section.includes("Applied: 1"));
  });
});

describe("smoke-ux: U4 — quickapplySummary", () => {
  it("shows plural applied count for 2 items", () => {
    const out = quickapplySummary({ applied: [{}, {}], blocked: [], items: [], hygieneItems: [] });
    assert.ok(out.includes("2 Einträge gespeichert"), `got: ${out}`);
  });

  it("shows singular for 1 applied item", () => {
    const out = quickapplySummary({ applied: [{}], blocked: [], items: [], hygieneItems: [] });
    assert.ok(out.includes("1 Eintrag gespeichert"), `got: ${out}`);
  });

  it("shows pending warning when medium-risk items remain", () => {
    const out = quickapplySummary({
      applied: [{}],
      blocked: [],
      items: [{ status: "pending", risk: "medium" }],
      hygieneItems: [],
    });
    assert.ok(out.includes("wartet"), `expected 'wartet', got: ${out}`);
  });

  it("shows nothing-to-do when all fields are empty", () => {
    const out = quickapplySummary({ applied: [], blocked: [], items: [], hygieneItems: [] });
    assert.ok(out.includes("Nichts zu tun"), `got: ${out}`);
  });
});

describe("smoke-ux: U7 — generateMemoryCardTemplate", () => {
  it("contains all 12 required frontmatter fields", () => {
    const template = generateMemoryCardTemplate({ workspaceId: "main", agentId: "main" });
    const required = [
      "plur1bus_type", "workspace_id", "agent_id", "memory_id",
      "category", "importance", "scope", "source_kind",
      "sync_status", "content_hash", "validated", "updated_at",
    ];
    for (const field of required) {
      assert.ok(template.includes(field + ":"), `missing field: ${field}`);
    }
  });

  it("sets sync_status to draft", () => {
    const template = generateMemoryCardTemplate({});
    assert.ok(template.includes("sync_status: draft"), "sync_status should be draft");
  });

  it("leaves content_hash blank (filled by bridge on first scan)", () => {
    const template = generateMemoryCardTemplate({});
    assert.ok(/content_hash: *\n/.test(template), "content_hash should be blank");
  });

  it("sets validated to false", () => {
    const template = generateMemoryCardTemplate({});
    assert.ok(template.includes("validated: false"), "validated should be false");
  });
});

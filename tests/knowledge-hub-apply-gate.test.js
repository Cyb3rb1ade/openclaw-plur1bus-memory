import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyKnowledgeHubGraphLinks,
  planKnowledgeHubGraphLinks,
} from "../lib/obsidian/knowledge-hub-graph.js";

function makeVault(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeMemory(vault, id, title = `Memory ${id}`, type = "memory") {
  const dir = join(vault, "plur1bus", "memories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), [
    "---",
    `memory_id: ${id}`,
    `plur1bus_type: ${type}`,
    "category: fact",
    "importance: 0.7",
    "scope: agent-private",
    "created_at: 2026-06-01T00:00:00.000Z",
    "content_hash: sha256:test",
    "---",
    "",
    `# ${title}`,
    "",
    "Mirror body",
  ].join("\n"), "utf8");
}

function writeKnowledge(vault, sourceMemories) {
  const dir = join(vault, "memory");
  mkdirSync(dir, { recursive: true });
  const sourceLines = sourceMemories.map((id) => `  - ${id}`).join("\n");
  const content = [
    "---",
    "type: knowledge",
    "agent: main",
    "last_verified: 2026-06-13",
    "source_memories:",
    sourceLines,
    "---",
    "",
    "# Knowledge",
    "",
    "Stable body.",
  ].join("\n");
  const filePath = join(dir, "KNOWLEDGE.md");
  writeFileSync(filePath, content, "utf8");
  return { filePath, content };
}

describe("KNOWLEDGE.md graph hub apply gate", () => {
  it("plans a managed graph block from resolvable source_memories", () => {
    const vault = makeVault("knowledge-hub-plan-");
    writeMemory(vault, "mem-a", "Resolvable A");
    writeMemory(vault, "mem-b", "Resolvable B");
    writeKnowledge(vault, ["mem-a", "mem-b"]);

    const plan = planKnowledgeHubGraphLinks({ vaultPath: vault, reviewRoot: "plur1bus" });

    assert.strictEqual(plan.sourceMemoriesTotal, 2);
    assert.strictEqual(plan.resolvable, 2);
    assert.strictEqual(plan.missing, 0);
    assert.strictEqual(plan.links.length, 2);
    assert.match(plan.preview, /\[\[plur1bus\/memories\/mem-a\|Resolvable A\]\]/);
    assert.match(plan.preview, /plur1bus:managed:start/);
  });

  it("skips missing source_memories instead of writing broken links", () => {
    const vault = makeVault("knowledge-hub-missing-");
    writeMemory(vault, "mem-a", "Resolvable A");
    writeKnowledge(vault, ["mem-a", "missing"]);

    const plan = planKnowledgeHubGraphLinks({ vaultPath: vault, reviewRoot: "plur1bus" });

    assert.strictEqual(plan.sourceMemoriesTotal, 2);
    assert.strictEqual(plan.resolvable, 1);
    assert.strictEqual(plan.missing, 1);
    assert.deepStrictEqual(plan.missingIds, ["missing"]);
    assert.strictEqual(plan.links.length, 1);
    assert.doesNotMatch(plan.links.join("\n"), /missing/);
  });

  it("does not produce an empty managed block when no links resolve", () => {
    const vault = makeVault("knowledge-hub-empty-");
    writeKnowledge(vault, ["missing"]);

    const plan = planKnowledgeHubGraphLinks({ vaultPath: vault, reviewRoot: "plur1bus" });
    const result = applyKnowledgeHubGraphLinks({ vaultPath: vault, reviewRoot: "plur1bus" }, { confirm: true });

    assert.strictEqual(plan.links.length, 0);
    assert.strictEqual(plan.wouldWrite, false);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 1);
    assert.doesNotMatch(readFileSync(join(vault, "memory", "KNOWLEDGE.md"), "utf8"), /plur1bus:managed:start/);
  });

  it("preserves content outside the managed block", () => {
    const vault = makeVault("knowledge-hub-body-");
    writeMemory(vault, "mem-a", "Resolvable A");
    const { filePath, content } = writeKnowledge(vault, ["mem-a"]);

    const result = applyKnowledgeHubGraphLinks({ vaultPath: vault, reviewRoot: "plur1bus" }, { confirm: true });
    const after = readFileSync(filePath, "utf8");

    assert.strictEqual(result.updated, 1);
    assert.ok(after.startsWith(content));
    assert.match(after, /plur1bus:managed:start/);
  });

  it("is idempotent on a second confirmed apply", () => {
    const vault = makeVault("knowledge-hub-idem-");
    writeMemory(vault, "mem-a", "Resolvable A");
    const { filePath } = writeKnowledge(vault, ["mem-a"]);

    const first = applyKnowledgeHubGraphLinks({ vaultPath: vault, reviewRoot: "plur1bus" }, { confirm: true });
    const afterFirst = readFileSync(filePath, "utf8");
    const second = applyKnowledgeHubGraphLinks({ vaultPath: vault, reviewRoot: "plur1bus" }, { confirm: true });
    const afterSecond = readFileSync(filePath, "utf8");

    assert.strictEqual(first.updated, 1);
    assert.strictEqual(second.updated, 0);
    assert.strictEqual(second.unchanged, 1);
    assert.strictEqual(afterSecond, afterFirst);
  });

  it("does not link generated memory-shaped records", () => {
    const vault = makeVault("knowledge-hub-generated-");
    writeMemory(vault, "generated", "Generated Provenance", "provenance");
    writeKnowledge(vault, ["generated"]);

    const plan = planKnowledgeHubGraphLinks({ vaultPath: vault, reviewRoot: "plur1bus" });

    assert.strictEqual(plan.resolvable, 0);
    assert.strictEqual(plan.links.length, 0);
    assert.strictEqual(plan.wouldWrite, false);
  });

  it("blocks apply unless confirm is explicit", () => {
    const vault = makeVault("knowledge-hub-confirm-");
    writeMemory(vault, "mem-a", "Resolvable A");
    const { filePath } = writeKnowledge(vault, ["mem-a"]);

    const result = applyKnowledgeHubGraphLinks({ vaultPath: vault, reviewRoot: "plur1bus" });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.updated, 0);
    assert.doesNotMatch(readFileSync(filePath, "utf8"), /plur1bus:managed:start/);
  });

  it("writes an apply manifest before confirmed changes", () => {
    const vault = makeVault("knowledge-hub-manifest-");
    const manifestDir = join(vault, ".plur1bus", "apply-manifests");
    writeMemory(vault, "mem-a", "Resolvable A");
    writeKnowledge(vault, ["mem-a"]);

    const result = applyKnowledgeHubGraphLinks(
      { vaultPath: vault, reviewRoot: "plur1bus" },
      { confirm: true, manifestDir },
    );

    assert.strictEqual(result.updated, 1);
    assert.ok(result.manifestPath);
    assert.ok(existsSync(result.manifestPath));
    assert.strictEqual(readdirSync(manifestDir).length, 1);
  });
});

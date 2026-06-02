import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { correctCard } from "../lib/telegram-commands/memory-edit.js";

describe("memory-edit correctCard", () => {
  it("archives first and calls the safe update hook", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "plur1bus-archive-"));
    try {
      const calls = [];
      const db = {
        getCard: async () => ({
          id: "card-1",
          title: "Old title",
          text: "old text",
          summary: "old summary",
        }),
        updateCard: async () => {
          throw new Error("legacy update should not run");
        },
      };

      const result = await correctCard(db, "agent-a", "card-1", "new text", {
        archiveDir,
        updateMemory: async (payload) => {
          calls.push(payload);
        },
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].id, "card-1");
      assert.strictEqual(calls[0].newContent, "new text");
      assert.ok(result.archivePath);
      assert.strictEqual(readdirSync(join(archiveDir, "agent-a")).length, 1);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });
});

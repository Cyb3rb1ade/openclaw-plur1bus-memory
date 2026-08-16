import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProposal } from "../lib/jobs/skill-miner/proposal-writer.js";
import { buildSkillReviewPayload } from "../lib/telegram-commands/skill-commands.js";
import { createConfirmation, validateConfirmation } from "../lib/security.js";

describe("skill review confirmations", () => {
  it("binds approve/reject to user and chat and rejects the wrong user", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-confirm-"));
    writeProposal(dir, {
      id: "prop-1",
      skillName: "a-skill",
      skillTitle: "A Skill",
      description: "d",
      instructions: "i",
      examples: [],
      status: "pending_review",
      evidence: { memoryIds: [], grade: "observed" },
    });
    const payload = buildSkillReviewPayload(dir, { userId: "u1", chatId: "c1" });
    assert.ok(payload.inline_keyboard.length > 0);
    assert.match(payload.text, /skills confirm/);
    const store = new Map();
    for (const pending of payload.confirmations) {
      store.set(`${pending.nonce}:${pending.targetId}`, pending);
    }
    const approve = payload.confirmations.find((c) => c.command === "skills-approve");
    const bad = validateConfirmation(approve.callbackData, store, { userId: "attacker", chatId: "c1" });
    assert.equal(bad.valid, false);
    const replayStore = new Map([[`${approve.nonce}:${approve.targetId}`, approve]]);
    const good = validateConfirmation(approve.callbackData, replayStore, { userId: "u1", chatId: "c1" });
    assert.equal(good.valid, true);
    const replay = validateConfirmation(approve.callbackData, replayStore, { userId: "u1", chatId: "c1" });
    assert.equal(replay.valid, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects expired confirmations", () => {
    const store = new Map();
    const pending = createConfirmation({
      userId: "u1",
      chatId: "c1",
      command: "skills-approve",
      targetId: "prop-1",
      expiryMinutes: -1,
    });
    store.set(`${pending.nonce}:${pending.targetId}`, pending);
    const result = validateConfirmation(pending.callbackData, store, { userId: "u1", chatId: "c1" });
    assert.equal(result.valid, false);
  });
});

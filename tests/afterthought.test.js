import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAfterthoughtCandidate, composeAfterthought, runAfterthoughtJob } from "../lib/afterthought.js";

const M = 60000;
const T0 = 1750000000000;
function o(agoMin, outcome, userPrompt = "wie richte ich das Backup ein?") {
  return { timestamp: T0 - agoMin * M, outcome, userPrompt };
}

describe("findAfterthoughtCandidate", () => {
  it("findet offenen jüngsten Eintrag im 30–120min-Fenster", () => {
    const c = findAfterthoughtCandidate([o(45, "asked_details")], { now: T0 });
    assert.ok(c);
    assert.match(c.topic, /Backup/);
  });

  it("null wenn zu frisch, zu alt oder Outcome geschlossen", () => {
    assert.strictEqual(findAfterthoughtCandidate([o(10, "asked_details")], { now: T0 }), null);
    assert.strictEqual(findAfterthoughtCandidate([o(300, "asked_details")], { now: T0 }), null);
    assert.strictEqual(findAfterthoughtCandidate([o(45, "confirmed_or_continued")], { now: T0 }), null);
  });

  it("nur der JÜNGSTE Eintrag zählt (Gespräch ging danach weiter → kein Nachgedanke)", () => {
    const entries = [o(20, "confirmed_or_continued"), o(45, "asked_details")]; // newest-first wie readReplyOutcomeLog
    assert.strictEqual(findAfterthoughtCandidate(entries, { now: T0 }), null);
  });

  it("fail-open bei leerem/kaputtem Input", () => {
    assert.strictEqual(findAfterthoughtCandidate([], { now: T0 }), null);
    assert.strictEqual(findAfterthoughtCandidate(null, { now: T0 }), null);
  });
});

describe("composeAfterthought", () => {
  it("liefert LLM-Text, null ohne LLM", async () => {
    const text = await composeAfterthought({ topic: "Backup", userPrompt: "…" }, { llmCfg: { model: "x" }, callLlm: async () => "Mir ist zum Backup noch eingefallen: rsync reicht." });
    assert.match(text, /Backup/);
    assert.strictEqual(await composeAfterthought({ topic: "x" }, {}), null);
  });
});

describe("runAfterthoughtJob", () => {
  function seedDir(entries) {
    const dir = mkdtempSync(join(tmpdir(), "at-"));
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
    if (entries.length) {
      writeFileSync(join(dir, ".adaptive-learning", "reply-outcomes.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    }
    return dir;
  }
  const llm = { llmCfg: { model: "x" }, callLlm: async () => "Mir ist zum Backup noch was eingefallen: probier rsync." };

  it("sendet bei offenem Kandidaten und stempelt Tages-Cap", async () => {
    const dir = seedDir([o(45, "asked_details")]);
    const first = await runAfterthoughtJob({ workspaceDir: dir, agentId: "a", ...llm, now: T0, hour: 12 });
    assert.ok(first.text);
    const second = await runAfterthoughtJob({ workspaceDir: dir, agentId: "a", ...llm, now: T0 + M, hour: 12 });
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(second.reason, "daily_cap");
  });

  it("Ruhezeiten blocken (22:00–08:00), wrap-aware", async () => {
    const night = await runAfterthoughtJob({ workspaceDir: seedDir([o(45, "asked_details")]), agentId: "a", ...llm, now: T0, hour: 23 });
    assert.strictEqual(night.reason, "quiet_hours");
    const earlyMorning = await runAfterthoughtJob({ workspaceDir: seedDir([o(45, "asked_details")]), agentId: "a", ...llm, now: T0, hour: 7 });
    assert.strictEqual(earlyMorning.reason, "quiet_hours");
  });

  it("überspringt Thema, das heute schon als offener Faden lief", async () => {
    const dir = seedDir([o(45, "asked_details")]);
    writeFileSync(join(dir, ".open-threads-shown.json"), JSON.stringify({ date: new Date(T0).toISOString().slice(0, 10), topics: ["wie richte ich das Backup ein?"] }), "utf8");
    const res = await runAfterthoughtJob({ workspaceDir: dir, agentId: "a", ...llm, now: T0, hour: 12 });
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, "open_thread_overlap");
  });

  it("skipped ohne Kandidaten", async () => {
    const dir = seedDir([]);
    const res = await runAfterthoughtJob({ workspaceDir: dir, agentId: "a", ...llm, now: T0, hour: 12 });
    assert.strictEqual(res.skipped, true);
  });
});

// Schreibstatus des Workspaces im Abend-Review (7.18.12).
//
// Das Review prüfte bis 7.18.11 nur die Gedächtnisqualität. Ob Tagesnotiz,
// Traumtagebuch und REM-Bericht tatsächlich geschrieben wurden, sah man nicht.
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { collectReviewWorkspaceStatus } from "../lib/review-workspace-status.js";
import { eveningReviewSummary, handleObsidianBridgeCommand } from "../lib/obsidian-control-room.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const NOW = new Date("2026-10-03T16:00:00.000Z");

function touch(dir, rel, iso) {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const time = new Date(iso);
  utimesSync(path, time, time);
}

function workspace() {
  const dir = makeTempDir("plur1bus-review-ws-");
  mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
  touch(dir, "memory/2026-10-01.md", "2026-10-01T21:46:00.000Z");
  touch(dir, "memory/2026-10-02.md", "2026-10-02T21:46:34.000Z");
  touch(dir, "memory/2026-10-02-2247.md", "2026-10-02T20:47:00.000Z");
  touch(dir, "memory/dream-diary/light/2026-10-03-light-dream-1.md", "2026-10-03T00:44:45.000Z");
  touch(dir, "memory/dream-diary/rem/2026-W39-abc-rem-dream.md", "2026-09-27T23:17:35.000Z");
  touch(dir, "memory/dream-diary/rem/2026-W38-abc-rem-dream.md", "2026-09-20T23:16:00.000Z");
  touch(dir, "DREAMS.md", "2026-09-27T23:17:27.000Z");
  touch(dir, "memory/KNOWLEDGE.md", "2026-09-26T23:31:44.000Z");
  writeFileSync(join(dir, ".adaptive-learning", "knowledge-pending.json"), JSON.stringify({ pending: [
    { sourceAgent: "main", memoryId: "a", queuedAt: "2026-08-15T11:56:18.186Z" },
    { sourceAgent: "main", memoryId: "b", queuedAt: "2026-10-03T00:44:33.645Z" },
  ] }));
  return dir;
}

describe("collectReviewWorkspaceStatus", () => {
  it("reads the newest daily note, dreams and knowledge files", () => {
    const status = collectReviewWorkspaceStatus(workspace(), { now: NOW, timeZone: "Europe/Berlin" });
    assert.equal(status.dailyNote.date, "2026-10-02");
    assert.equal(status.dailyNote.mtime.toISOString(), "2026-10-02T21:46:34.000Z");
    assert.equal(status.dailyNote.ok, true);
    assert.equal(status.lightDream.mtime.toISOString(), "2026-10-03T00:44:45.000Z");
    assert.deepStrictEqual({ week: status.remDream.week, ageDays: status.remDream.ageDays, ok: status.remDream.ok }, { week: "2026-W39", ageDays: 5, ok: true });
    assert.equal(status.dreamDiary.ageDays, 5);
    assert.equal(status.knowledge.ageDays, 6);
    assert.equal(status.memoryFile, undefined, "a missing MEMORY.md is left out");
    assert.deepStrictEqual({ withRem: status.dreamDiary.withRem, ok: status.dreamDiary.ok }, { withRem: true, ok: true });
    assert.deepStrictEqual({ pending: status.knowledge.pending, since: status.knowledge.pendingSince.toISOString(), ok: status.knowledge.ok }, { pending: 2, since: "2026-08-15T11:56:18.186Z", ok: true });
  });

  it("flags a missing daily note and an overdue REM report", () => {
    const status = collectReviewWorkspaceStatus(workspace(), { now: new Date("2026-10-07T16:00:00.000Z"), timeZone: "Europe/Berlin" });
    assert.deepStrictEqual({ ageDays: status.dailyNote.ageDays, ok: status.dailyNote.ok }, { ageDays: 5, ok: false });
    assert.equal(status.remDream.ok, false);
    assert.equal(status.knowledge.ok, false, "pending memories and no merge for over a week");
  });

  it("flags a REM run whose diary entry is missing", () => {
    const dir = workspace();
    touch(dir, "DREAMS.md", "2026-09-20T23:16:00.000Z");
    const status = collectReviewWorkspaceStatus(dir, { now: NOW, timeZone: "Europe/Berlin" });
    assert.equal(status.dreamDiary.ok, false);
  });

  it("returns null for workspaces without any of these files or without a path", () => {
    assert.equal(collectReviewWorkspaceStatus(makeTempDir("plur1bus-review-ws-empty-"), { now: NOW }), null);
    assert.equal(collectReviewWorkspaceStatus("", { now: NOW }), null);
    assert.equal(collectReviewWorkspaceStatus("/nonexistent/plur1bus-review", { now: NOW }), null);
  });
});

describe("evening review shows the workspace write status", () => {
  const summary = { createdAt: NOW.toISOString(), pendingItems: 0, status: { maintenance: { label: "ok", count: 1 } } };

  it("renders German and English lines in the configured time zone", () => {
    const workspaceStatus = collectReviewWorkspaceStatus(workspace(), { now: NOW, timeZone: "Europe/Berlin" });
    const de = eveningReviewSummary(summary, { timeZone: "Europe/Berlin", workspaceStatus });
    assert.match(de, /📂 Geschrieben:\n✅ Tagesnotiz: Fr\., 2\. Okt\., 23:46\n💭 Light-Traum: Sa\., 3\. Okt\., 02:44\n✅ REM-Traum 2026-W39: Mo\., 28\. Sept\., 01:17 \(vor 5 Tagen\)\n✅ Traumtagebuch \(mit REM\): .*\(vor 5 Tagen\)\n✅ KNOWLEDGE\.md: .*\(vor 6 Tagen\) · 2 offen seit 15\. Aug\./);
    const en = eveningReviewSummary(summary, { lang: "en", timeZone: "Europe/Berlin", workspaceStatus });
    assert.match(en, /📂 Written:\n✅ Daily note: Fri, Oct 2, 11:46 PM/);
    assert.match(en, /✅ REM dream 2026-W39: .*\(5 days ago\)/);
    assert.doesNotMatch(en, /Tagesnotiz|vor \d/);
  });

  it("warns about stale writes", () => {
    const workspaceStatus = collectReviewWorkspaceStatus(workspace(), { now: new Date("2026-10-07T16:00:00.000Z"), timeZone: "Europe/Berlin" });
    const de = eveningReviewSummary({ ...summary, createdAt: "2026-10-07T16:00:00.000Z" }, { timeZone: "Europe/Berlin", workspaceStatus });
    assert.match(de, /⚠️ Tagesnotiz: zuletzt Fr\., 2\. Okt\., 23:46 — seit 5 Tagen keine neue/);
    assert.match(de, /⚠️ REM-Traum 2026-W39: .* — überfällig/);
    assert.match(de, /⚠️ KNOWLEDGE\.md: .* · 2 offen seit 15\. Aug\. — über eine Woche nicht eingearbeitet/);
  });

  it("omits the block without workspace data", () => {
    assert.doesNotMatch(eveningReviewSummary(summary, {}), /Geschrieben/);
  });

  it("the evening-review command reads the status from the command workspace", async () => {
    const dir = workspace();
    mkdirSync(join(dir, "plur1bus"), { recursive: true });
    const identity = "workspace:v1:main";
    const result = await handleObsidianBridgeCommand(["evening-review"], {
      config: { vaultPath: dir, reviewRoot: "plur1bus", mode: "apply", allowWrite: true },
      baseDbPath: dir,
      workspaceDir: dir,
      memoryCtx: { agentId: "main", workspaceIdentity: identity, workspaceId: identity, userId: "owner", conversationPrincipal: "c", chatId: "owner", chatKind: "private" },
      commandCtx: { agentId: "main", userId: "owner", senderId: "owner", chatId: "owner", chatType: "private", chatKind: "private", workspaceDir: dir },
      pluginConfig: { baseDbPath: dir, security: { allowedUserIds: ["owner"] }, language: "de", timezone: "Europe/Berlin" },
      vaultConfirmed: true,
      records: [],
      items: [],
    });
    assert.match(result.text, /📂 Geschrieben:/);
    assert.match(result.text, /Tagesnotiz: (zuletzt )?Fr\., 2\. Okt\., 23:46/);
  });
});

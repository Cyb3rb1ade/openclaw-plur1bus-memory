/**
 * tests/private-file-modes.test.js
 *
 * N2 leak audit I-8: files that hold message text are created 0600 in a 0700
 * directory, and an older, looser file is tightened on the next write.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appendConflictLog } from "../engine/commands/command-helpers.js";
import { recordPendingReplyOutcome, completePendingReplyOutcomes, REPLY_OUTCOME_LOG_FILE, REPLY_OUTCOME_PENDING_FILE } from "../lib/reply-outcome-tracking.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const SKIP = process.platform === "win32" ? "POSIX file modes are not enforced on win32" : false;
const dirs = [];
const oldUmask = process.umask();

afterEach(() => { process.umask(oldUmask); });

function workspace() {
  const dir = makeTempDir("plur1bus-private-modes-");
  dirs.push(dir);
  return dir;
}
const mode = (p) => statSync(p).mode & 0o777;
const entry = { schemaVersion: 1, timestamp: new Date().toISOString(), newText: "private text", mergeDecision: "x" };

describe("conflict-log permissions", { skip: SKIP, timeout: 30_000 }, () => {
  it("creates dir 0700 and files with no group/other access under umask 022", () => {
    process.umask(0o022);
    const ws = workspace();
    appendConflictLog(ws, entry);
    const dir = join(ws, ".adaptive-learning");
    assert.equal(mode(dir) & 0o077, 0);
    assert.equal(mode(join(dir, "conflict-log.jsonl")) & 0o077, 0);
    for (const name of ["conflict-summary.json"]) {
      try { assert.equal(mode(join(dir, name)) & 0o077, 0); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  });

  it("tightens an existing 0644 log on the next write and keeps content", () => {
    process.umask(0o022);
    const ws = workspace();
    const dir = join(ws, ".adaptive-learning");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "conflict-log.jsonl");
    writeFileSync(file, "{\"old\":true}\n");
    chmodSync(file, 0o644);
    chmodSync(dir, 0o755);
    appendConflictLog(ws, entry);
    assert.equal(mode(file) & 0o077, 0);
    assert.equal(mode(dir) & 0o077, 0);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines[0], "{\"old\":true}");
    assert.equal(JSON.parse(lines[1]).newText, "private text");
  });
});

describe("reply-outcome-tracking permissions", { skip: SKIP, timeout: 30_000 }, () => {
  it("writes pending and log files owner-only under umask 022", async () => {
    process.umask(0o022);
    const ws = workspace();
    recordPendingReplyOutcome(ws, { sessionKey: "s1", userPrompt: "private prompt", assistantText: "reply", memoryIds: ["m1"] });
    const dir = join(ws, ".adaptive-learning");
    assert.equal(mode(dir) & 0o077, 0);
    assert.equal(mode(join(dir, REPLY_OUTCOME_PENDING_FILE)) & 0o077, 0);
    await completePendingReplyOutcomes(ws, { sessionKey: "s1", replyText: "yes thanks" });
    assert.equal(mode(join(dir, REPLY_OUTCOME_LOG_FILE)) & 0o077, 0);
  });

  it("tightens a pre-existing 0644 pending file on the next write", () => {
    process.umask(0o022);
    const ws = workspace();
    const dir = join(ws, ".adaptive-learning");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, REPLY_OUTCOME_PENDING_FILE);
    writeFileSync(file, JSON.stringify({ schema: 1, pending: [] }));
    chmodSync(file, 0o644);
    recordPendingReplyOutcome(ws, { sessionKey: "s2", userPrompt: "p", assistantText: "a", memoryIds: ["m1"] });
    assert.equal(mode(file) & 0o077, 0);
  });
});

/**
 * tests/neo-timestamps-legacy-read.test.js
 *
 * Aufgabe A — turnEventsFromMessages batch-stamped every message in a
 * capture with the SAME createdAt (the one `params.createdAt` the caller
 * computed once per batch). groupTurnsIntoEpisodes (lib/episodes.js) splits
 * episodes on the time gap between consecutive turns' createdAt, so identical
 * timestamps meant zero gaps were ever detected — every episode ended up with
 * startTime === endTime and durationMinutes: 0 in production. Fixed by
 * reading each message's own `timestamp` field (see the messageCreatedAt
 * comment in lib/neo-arch.js for the evidence trail behind that field name),
 * falling back to the batch createdAt only when a message lacks one.
 *
 * Aufgabe B — createNeoStore's readMerged accepted a legacyPath parameter
 * but never read it, and readEpisodes/readDreams/readGraphEdges/readPatterns
 * bypassed readMerged entirely, reading only the canonical path. Workspaces
 * migrated to the `--<hash>` naming scheme lost read access to everything
 * still sitting under the old, unhashed directory name. Fixed by merging
 * both paths, deduping by id (canonical wins), sorting by time, and — for
 * the record types that carry visibility/origin scope — still enforcing the
 * requester ACL over the merged set.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { turnEventsFromMessages, createNeoStore } from "../lib/neo-arch.js";
import { groupTurnsIntoEpisodes, createEpisode } from "../lib/episodes.js";

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJsonlLine(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

describe("turnEventsFromMessages — per-message createdAt (Aufgabe A)", () => {
  it("uses each message's own timestamp instead of one batch-wide value", () => {
    const t0 = Date.parse("2026-01-01T10:00:00.000Z");
    const t1 = t0 + 5 * 60 * 1000; // +5 min
    const messages = [
      { role: "user", content: "message number one for the batch", timestamp: t0 },
      { role: "assistant", content: "message number two for the batch", timestamp: t1 },
    ];

    const turns = turnEventsFromMessages(messages, {
      workspaceKey: "ws-per-message-ts",
      agentId: "agent",
      sessionId: "session-per-message-ts",
      // Deliberately a THIRD, later value — must lose to msg.timestamp.
      createdAt: new Date().toISOString(),
    });

    assert.strictEqual(turns.length, 2);
    assert.notStrictEqual(turns[0].createdAt, turns[1].createdAt, "distinct message timestamps must survive as distinct createdAt");
    assert.strictEqual(turns[0].createdAt, new Date(t0).toISOString());
    assert.strictEqual(turns[1].createdAt, new Date(t1).toISOString());
  });

  it("falls back cleanly to params.createdAt when a message carries no timestamp of its own", () => {
    const fallback = "2026-05-05T05:05:05.000Z";

    const turns = turnEventsFromMessages(
      [{ role: "user", content: "no per-message timestamp on this one" }],
      { workspaceKey: "ws-fallback", agentId: "agent", sessionId: "session-fallback", createdAt: fallback },
    );

    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].createdAt, fallback);
  });
});

describe("groupTurnsIntoEpisodes + createEpisode fed by turnEventsFromMessages (Aufgabe A)", () => {
  it("splits into two episodes across a >30-minute gap between real per-message timestamps", () => {
    const base = Date.parse("2026-01-01T09:00:00.000Z");
    const messages = [
      { role: "user", content: "first conversation opener message", timestamp: base },
      { role: "assistant", content: "first conversation reply message", timestamp: base + 2 * 60 * 1000 },
      // 40-minute gap to the next turn — bigger than DEFAULT_MAX_GAP_MINUTES (30).
      { role: "user", content: "second conversation opener after the gap", timestamp: base + 42 * 60 * 1000 },
      { role: "assistant", content: "second conversation reply after the gap", timestamp: base + 44 * 60 * 1000 },
    ];

    const turns = turnEventsFromMessages(messages, {
      workspaceKey: "ws-episode-split",
      agentId: "agent",
      sessionId: "session-episode-split",
      createdAt: new Date().toISOString(),
    });

    const episodeGroups = groupTurnsIntoEpisodes(turns);

    assert.strictEqual(episodeGroups.length, 2, "a >30min gap between real per-message timestamps must split episodes");
    assert.strictEqual(episodeGroups[0].length, 2);
    assert.strictEqual(episodeGroups[1].length, 2);
  });

  it("produces an episode with startTime !== endTime and durationMinutes > 0", () => {
    const base = Date.parse("2026-01-01T09:00:00.000Z");
    const messages = [
      { role: "user", content: "opening message of a single episode", timestamp: base },
      { role: "assistant", content: "closing message of the same episode", timestamp: base + 12 * 60 * 1000 },
    ];

    const turns = turnEventsFromMessages(messages, {
      workspaceKey: "ws-episode-duration",
      agentId: "agent",
      sessionId: "session-episode-duration",
      createdAt: new Date().toISOString(),
    });

    const [group] = groupTurnsIntoEpisodes(turns);
    const episode = createEpisode(group, { workspaceKey: "ws-episode-duration", agentId: "agent" });

    assert.notStrictEqual(episode.startTime, episode.endTime);
    assert.ok(episode.durationMinutes > 0, `expected durationMinutes > 0, got ${episode.durationMinutes}`);
  });
});

describe("createNeoStore — legacy-path merge on read (Aufgabe B)", () => {
  it("readEpisodes returns records from BOTH the canonical and legacy workspace directory", (t) => {
    const root = tmpDir("plur1bus-neo-legacy-episodes-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createNeoStore(root, "legacy-merge-ws");

    writeJsonlLine(store.paths.episodes, {
      id: "ep-canonical-only",
      startTime: "2026-02-02T00:00:00.000Z",
      createdAt: "2026-02-02T00:00:00.000Z",
    });
    writeJsonlLine(store.legacyPaths.episodes, {
      id: "ep-legacy-only",
      startTime: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const episodes = store.readEpisodes(10);
    const ids = episodes.map((e) => e.id);

    assert.ok(ids.includes("ep-canonical-only"), "canonical-only episode must be visible");
    assert.ok(ids.includes("ep-legacy-only"), "legacy-only episode must now be visible (previously invisible)");
    assert.strictEqual(ids.length, 2);
  });

  it("does NOT merge a legacy directory whose name is an ambiguous (lossy) sanitization of the workspace key", (t) => {
    const root = tmpDir("plur1bus-neo-legacy-collision-");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // "tenant/a" sanitizes to "tenant_a" (sanitizePathPart replaces "/" with
    // "_"), and so would "tenant_a", "tenant a", "tenant:a", etc. — the same
    // legacy directory name could have been produced by several different
    // workspace keys. Auto-merging it would risk leaking another workspace's
    // legacy data into this one (see tests/neo-b8-closure.test.js "uses
    // collision-resistant storage after an explicit legacy migration", which
    // exercises this same guard through readCandidates/readTurns — this test
    // covers the SAME guard for readEpisodes, one of the four readers this
    // fix newly routed through readMerged and which had no prior coverage of
    // the suppression path at all).
    const store = createNeoStore(root, "tenant/a");
    writeJsonlLine(join(root, "workspaces", "tenant_a", "episodes.jsonl"), {
      id: "ambiguous-legacy-episode",
      startTime: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(store.readEpisodes(10).length, 0, "a legacy dir reachable only via lossy sanitization must stay invisible until an explicit migration resolves the ambiguity");
  });

  it("dedupes a record with the same id present in both directories, canonical wins", (t) => {
    const root = tmpDir("plur1bus-neo-legacy-dedupe-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createNeoStore(root, "legacy-dedupe-ws");

    writeJsonlLine(store.paths.episodes, {
      id: "ep-shared-id",
      startTime: "2026-03-03T00:00:00.000Z",
      createdAt: "2026-03-03T00:00:00.000Z",
      summary: "canonical version",
    });
    writeJsonlLine(store.legacyPaths.episodes, {
      id: "ep-shared-id",
      startTime: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      summary: "stale legacy version",
    });
    // A non-colliding legacy record alongside the shared id: if the legacy
    // file were never read at all (the pre-fix bug), this record would be
    // silently missing rather than merely un-deduped, so its presence is
    // proof the legacy file was actually read, not just that "only one
    // survived" by coincidence of legacy being ignored entirely.
    writeJsonlLine(store.legacyPaths.episodes, {
      id: "ep-legacy-unique",
      startTime: "2026-01-05T00:00:00.000Z",
      createdAt: "2026-01-05T00:00:00.000Z",
      summary: "legacy-only, no canonical counterpart",
    });

    const episodes = store.readEpisodes(10);
    const ids = episodes.map((e) => e.id);

    assert.strictEqual(ids.length, 2, "expected the deduped shared id once plus the unique legacy record");
    assert.ok(ids.includes("ep-legacy-unique"), "a non-colliding legacy record must come through (proves the legacy file was actually read)");

    const matches = episodes.filter((e) => e.id === "ep-shared-id");
    assert.strictEqual(matches.length, 1, "the same id present in both directories must appear exactly once");
    assert.strictEqual(matches[0].summary, "canonical version", "canonical record must win over legacy on id collision");
  });

  it("ACL: a legacy record isNeoRecordAccessible rejects for the requester is dropped, the accessible canonical one is kept", (t) => {
    const root = tmpDir("plur1bus-neo-legacy-acl-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createNeoStore(root, "legacy-acl-ws");

    // Canonical: agent-private turn owned by the requesting agent -> accessible.
    writeJsonlLine(store.paths.turns, {
      id: "turn-canonical-accessible",
      createdAt: "2026-04-02T00:00:00.000Z",
      agentId: "agent-a",
      workspaceKey: "legacy-acl-ws",
      visibility: { scope: "agent_private" },
    });
    // Legacy: agent-private turn owned by a DIFFERENT agent -> must be rejected.
    writeJsonlLine(store.legacyPaths.turns, {
      id: "turn-legacy-foreign",
      createdAt: "2026-04-01T00:00:00.000Z",
      agentId: "agent-b",
      workspaceKey: "legacy-acl-ws",
      visibility: { scope: "agent_private" },
    });

    // Sanity: without a requester both are merged in (proves this is an ACL
    // rejection, not the legacy record failing to merge at all).
    const unfiltered = store.readTurns(10);
    assert.deepStrictEqual(
      unfiltered.map((r) => r.id).sort(),
      ["turn-canonical-accessible", "turn-legacy-foreign"],
    );

    const requester = { requesterAgentId: "agent-a" };
    const filtered = store.readTurns(10, requester);

    assert.deepStrictEqual(filtered.map((r) => r.id), ["turn-canonical-accessible"]);
  });
});

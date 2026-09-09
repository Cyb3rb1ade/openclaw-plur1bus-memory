import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pruneGraphEdges } from "../lib/memory-graph.js";

// 7.12.24: consolidate-daily entfernt Kanten auf verschwundene Endpunkte.
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-10T04:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const priv = { scope: "agent-private", agentId: "a", workspaceIdentity: "" };

function edge(source, target, type = "temporal", extra = {}) {
  return { source, target, type, strength: 0.6, directed: false, createdAt: iso(1), observations: 2, ...extra };
}

describe("pruneGraphEdges", () => {
  const live = new Set(["m1", "m2", "m3"]);
  const episodes = new Set(["ep1"]);

  it("drops edges whose memory endpoint no longer exists and keeps the rest verbatim", () => {
    const keep = edge("m1", "m2", "semantic", { sourceOwnership: priv, targetOwnership: priv, algorithmVersion: 3 });
    const gone = edge("m1", "deleted-id");
    const result = pruneGraphEdges([keep, gone], { liveMemoryIds: live, now: NOW });
    assert.deepEqual(result.kept, [keep]);
    assert.equal(result.kept[0], keep, "records are returned by identity, not rebuilt");
    assert.equal(result.removedMissing, 1);
    assert.equal(result.before, 2);
    assert.equal(result.after, 1);
  });

  it("resolves episode anchors against the episode ids instead of LanceDB", () => {
    const ok = edge("m1", "episode-ep1", "episode");
    const gone = edge("m2", "episode-ep-missing", "episode");
    const result = pruneGraphEdges([ok, gone], { liveMemoryIds: live, episodeIds: episodes, now: NOW });
    assert.deepEqual(result.kept, [ok]);
    assert.equal(result.removedMissing, 1);
  });

  it("keeps episode anchors when no episode ids are supplied", () => {
    const anchor = edge("m1", "episode-whatever", "episode");
    const result = pruneGraphEdges([anchor], { liveMemoryIds: live, now: NOW });
    assert.deepEqual(result.kept, [anchor]);
  });

  it("never judges edges bound to other scopes", () => {
    const foreign = edge("m1", "not-in-agent-table", "semantic", {
      sourceOwnership: priv,
      targetOwnership: { scope: "workspace", agentId: "", workspaceIdentity: "ws" },
    });
    const result = pruneGraphEdges([foreign], { liveMemoryIds: live, now: NOW });
    assert.deepEqual(result.kept, [foreign]);
    assert.equal(result.skippedForeign, 1);
    assert.equal(result.removedMissing, 0);
  });

  it("removes weak, old, unreinforced edges but never episode edges", () => {
    const weak = edge("m1", "m2", "temporal", { strength: 0.1, observations: 1, createdAt: iso(90) });
    const weakEpisode = edge("m1", "episode-ep1", "episode", { strength: 0.1, observations: 1, createdAt: iso(90) });
    const reinforced = edge("m2", "m3", "temporal", { strength: 0.1, observations: 1, createdAt: iso(90), lastReinforcedAt: iso(2) });
    const result = pruneGraphEdges([weak, weakEpisode, reinforced], { liveMemoryIds: live, episodeIds: episodes, now: NOW });
    assert.deepEqual(result.kept, [weakEpisode, reinforced]);
    assert.equal(result.removedWeak, 1);
  });

  it("drops malformed records and tolerates empty input", () => {
    assert.deepEqual(pruneGraphEdges([null, { type: "temporal" }], { liveMemoryIds: live, now: NOW }).kept, []);
    assert.deepEqual(pruneGraphEdges(undefined, { liveMemoryIds: live, now: NOW }), {
      kept: [], before: 0, after: 0, removedMissing: 0, removedWeak: 0, skippedForeign: 0,
    });
  });
});

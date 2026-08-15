import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEpisodeAnchorEdges,
  canonicalGraphOwnership,
  isBoundGraphEdge,
  readBoundGraph,
  readGraph,
} from "../lib/memory-graph.js";

function makeBoundMemory(id) {
  return {
    id,
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
    status: "active",
    expiresAt: 0,
  };
}

function makeBoundEpisode(id) {
  return {
    id,
    agentId: "agent-a",
    status: "active",
    expiresAt: 0,
    vividness: 0.8,
  };
}

describe("release 7.3.1 graph follow-up", () => {
  it("does not create a hydration edge when episode or memory ownership is unbound", () => {
    const edges = buildEpisodeAnchorEdges(
      [{ id: "episode-unbound", vividness: 0.8 }],
      ["memory-unbound"],
    );

    assert.deepEqual(edges, []);
  });

  it("creates a bound episode-anchor edge only from bound endpoint records", () => {
    const episode = makeBoundEpisode("episode-bound");
    const memory = makeBoundMemory("memory-bound");
    const [edge] = buildEpisodeAnchorEdges([episode], [memory]);

    assert.ok(edge, "bound endpoint records should create an episode edge");
    assert.equal(isBoundGraphEdge(edge), true);
    assert.deepEqual(
      edge.ownership,
      edge.source === memory.id
        ? { source: canonicalGraphOwnership(memory), target: canonicalGraphOwnership(episode) }
        : { source: canonicalGraphOwnership(episode), target: canonicalGraphOwnership(memory) },
    );
  });

  it("lets a strict-bound read ignore an unbound equivalent when a bound replacement exists", () => {
    const [bound] = buildEpisodeAnchorEdges(
      [makeBoundEpisode("episode-replacement")],
      [makeBoundMemory("memory-replacement")],
    );
    const legacy = {
      source: bound.source,
      target: bound.target,
      type: bound.type,
      strength: 1,
    };

    const permissive = readGraph([legacy, bound]);
    assert.ok(
      permissive.edges.some((edge) => edge.needsRebuild === true),
      "the compatibility reader should still expose the legacy record for migration",
    );

    const strict = readBoundGraph([legacy, bound]);
    assert.equal(strict.edges.length, 1);
    assert.equal(isBoundGraphEdge(strict.edges[0]), true);
    assert.equal(
      strict.adjacency.get(bound.source).filter((edge) => edge.target === bound.target && edge.type === bound.type).length,
      1,
    );
  });
});

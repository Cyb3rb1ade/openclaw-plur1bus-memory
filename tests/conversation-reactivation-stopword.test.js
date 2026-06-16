// tests/conversation-reactivation-stopword.test.js
//
// Fix K1-03: CRR token overlap must ignore stopwords / generic terms and
// require at least 2 significant tokens before a memory is reactivated.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectReactivationMemories } from "../lib/conversation-reactivation-recall.js";

const baseCfg = {
  enabled: true,
  idleThresholdMinutes: 45,
  cooldownMinutes: 30,
  maxReactivationMemories: 3,
  maxFadedReactivationMemories: 1,
  maxOpenThreads: 3,
  maxCommunities: 2,
  timeoutMs: 50,
  visibleHints: false,
};

describe("conversation-reactivation-stopword", () => {
  it("does not reactivate a memory that only shares generic/stopword tokens", async () => {
    const memory = {
      id: "m1",
      category: "project",
      display: "api project memory recall test",
    };
    const result = await selectReactivationMemories({
      prompt: "api project recall test user bot agent openclaw plur1bus",
      baseRecallIds: new Set(),
      semanticLens: {
        communities: [{ id: "c1", representativeMemoryIds: ["m1"] }],
        memories: [memory],
        entries: {},
      },
      cfg: baseCfg,
    });
    assert.strictEqual(result.memories.length, 0, "generic-token-only overlap must not reactivate");
  });

  it("reactivates a memory that shares 2–3 specific tokens with the prompt", async () => {
    const memory = {
      id: "m2",
      category: "project",
      display: "redis caching strategy overview",
    };
    const result = await selectReactivationMemories({
      prompt: "we should continue the redis caching strategy",
      baseRecallIds: new Set(),
      semanticLens: {
        communities: [{ id: "c1", representativeMemoryIds: ["m2"] }],
        memories: [memory],
        entries: {},
      },
      cfg: baseCfg,
    });
    assert.strictEqual(result.memories.length, 1);
    assert.strictEqual(result.memories[0].id, "m2");
  });

  it("still allows continuation-signal open-project memories when they have 2+ specific tokens", async () => {
    const memory = {
      id: "m3",
      category: "plan",
      display: "postgres migration checklist",
    };
    const result = await selectReactivationMemories({
      prompt: "continue postgres migration",
      baseRecallIds: new Set(),
      semanticLens: {
        communities: [],
        memories: [memory],
        entries: {},
      },
      cfg: baseCfg,
    });
    assert.strictEqual(result.memories.length, 1);
    assert.strictEqual(result.memories[0].id, "m3");
    assert.strictEqual(result.memories[0].source, "open-project");
  });

  it("blocks continuation-signal open-project memories with only one specific token", async () => {
    const memory = {
      id: "m4",
      category: "plan",
      display: "project checklist",
    };
    const result = await selectReactivationMemories({
      prompt: "continue the project",
      baseRecallIds: new Set(),
      semanticLens: {
        communities: [],
        memories: [memory],
        entries: {},
      },
      cfg: baseCfg,
    });
    assert.strictEqual(result.memories.length, 0, "only 'project' is generic, no significant overlap");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";
import {
  confirmSemanticDiscovery,
  prepareSemanticDiscovery,
} from "../lib/obsidian-semantic-discovery-flow.js";

const EMPTY_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });

function ctx(overrides = {}) {
  return Object.freeze({
    agentId: "agent-a",
    workspaceIdentity: "workspace:v1:shared",
    workspaceId: "workspace:v1:shared",
    workspaceAliases: EMPTY_ALIASES,
    userId: "owner",
    userPrincipal: "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    chatId: "chat-a",
    conversationPrincipal: "conversation:v1:chat-a",
    ...overrides,
  });
}

function confirmedPolicy(baseDbPath, memoryCtx) {
  return parseObsidianCommandPlan(["semantic-discovery", "confirm"], {
    memoryCtx,
    baseDbPath,
    mode: "apply",
    allowWrite: true,
    vaultConfirmed: true,
    actionConfirmed: true,
  }).mutationPolicy;
}

function rows() {
  return [
    {
      id: "a",
      vector: [1, 0],
      text: "owned",
      scope: "agent-private",
      agentId: "agent-a",
    },
    {
      id: "b",
      vector: [0.9, 0.1],
      text: "workspace",
      scope: "workspace",
      agentId: "agent-b",
      workspaceId: "workspace:v1:shared",
    },
    {
      id: "foreign",
      vector: [1, 0],
      text: "foreign",
      scope: "agent-private",
      agentId: "agent-b",
    },
  ];
}

describe("B14 bound Semantic Discovery", () => {
  it("prepare is in-memory only and ACL-filters both sources and ANN neighbors", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "b14-semantic-prepare-"));
    const store = new Map();
    const result = await prepareSemanticDiscovery({
      rawConfig: { vaultPath, graphLinks: { semanticDiscovery: { threshold: 0.5 } } },
      memoryCtx: ctx(),
      records: rows(),
      confirmationStore: store,
      searchSimilar: async () => rows().map((entry) => ({ entry })),
    });

    assert.equal(result.ok, true);
    assert.match(result.nonce, /^[0-9a-f-]{36}$/);
    assert.deepEqual(result.plan.sourceIds, ["a", "b"]);
    assert.deepEqual(Object.keys(result.plan.entries).sort(), ["a", "b"]);
    assert.deepEqual(result.plan.entries.a.similar, ["b"]);
    assert.deepEqual(result.plan.entries.b.similar, ["a"]);
    assert.deepEqual(readdirSync(vaultPath), []);
    assert.equal(store.size, 1);
  });

  it("wrong user/chat/scope/digest and replay produce no writes; exact confirmation writes once", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "b14-semantic-confirm-"));
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-semantic-db-"));
    const store = new Map();
    const memoryCtx = ctx();
    const rawConfig = { vaultPath, graphLinks: { semanticDiscovery: { threshold: 0.5 } } };
    const prepared = await prepareSemanticDiscovery({
      rawConfig,
      memoryCtx,
      records: rows(),
      confirmationStore: store,
      searchSimilar: async () => rows().map((entry) => ({ entry })),
    });
    let writes = 0;
    const writeIndex = async () => {
      writes++;
      return { path: join(vaultPath, ".plur1bus", "link-index.json") };
    };
    const policy = confirmedPolicy(baseDbPath, memoryCtx);

    for (const invalid of [
      { memoryCtx: ctx({ userId: "attacker" }), rawConfig },
      { memoryCtx: ctx({ conversationPrincipal: "conversation:v1:other" }), rawConfig },
      { memoryCtx: ctx({ agentId: "agent-b" }), rawConfig },
      { memoryCtx, rawConfig: { ...rawConfig, vaultPath: `${vaultPath}-changed` } },
    ]) {
      const result = await confirmSemanticDiscovery({
        callbackData: prepared.callbackData,
        confirmationStore: store,
        policy,
        writeIndex,
        ...invalid,
      });
      assert.equal(result.ok, false);
      assert.equal(writes, 0);
    }

    const confirmed = await confirmSemanticDiscovery({
      callbackData: prepared.callbackData,
      confirmationStore: store,
      memoryCtx,
      rawConfig,
      policy,
      writeIndex,
    });
    assert.equal(confirmed.ok, true);
    assert.equal(writes, 1);

    const replay = await confirmSemanticDiscovery({
      callbackData: prepared.callbackData,
      confirmationStore: store,
      memoryCtx,
      rawConfig,
      policy,
      writeIndex,
    });
    assert.equal(replay.ok, false);
    assert.equal(writes, 1);
    assert.equal(existsSync(join(vaultPath, ".plur1bus", "tmp")), false);
  });
});

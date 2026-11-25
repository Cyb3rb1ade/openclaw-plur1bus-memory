/**
 * tests/recall-context-7212.test.js — 7.21.2: weighting recall hits by
 * origin, the confidentiality filter, the foreign cap, the background
 * classification queue.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyContextWeighting,
  applyContextWeightingToNeoLanes,
  buildContextPolicy,
  chatContextFromSessionKey,
  contextAllows,
  isOwnerDirectChat,
  originRelation,
  resolveContextWeightingConfig,
} from "../lib/recall-context.js";
import { classifySensitivityByRules } from "../lib/sensitivity.js";
import { createSensitivityStore } from "../lib/sensitivity-queue.js";

const DM_CHRISTIAN = "agent:main:telegram:default:direct:55736530:thread:55736530:64934";
const DM_OTHER = "agent:main:telegram:default:direct:99999999";
const GROUP = "agent:main:telegram:group:-1003839640481:topic:5778";
const GROUP_B = "agent:main:telegram:group:-1009999999999";
const config = resolveContextWeightingConfig(undefined);

describe("chatContextFromSessionKey", () => {
  it("whole DM and whole group, without thread or topic", () => {
    assert.deepEqual(chatContextFromSessionKey(DM_CHRISTIAN), { kind: "direct", chatKey: "telegram:default:direct:55736530" });
    assert.deepEqual(chatContextFromSessionKey("agent:main:telegram:default:direct:55736530"), { kind: "direct", chatKey: "telegram:default:direct:55736530" });
    assert.deepEqual(chatContextFromSessionKey(GROUP), { kind: "group", chatKey: "telegram:group:-1003839640481" });
    assert.deepEqual(chatContextFromSessionKey("agent:main:telegram:group:-1003839640481"), { kind: "group", chatKey: "telegram:group:-1003839640481" });
    assert.deepEqual(chatContextFromSessionKey("agent:main:discord:channel:123"), { kind: "channel", chatKey: "discord:channel:123" });
    assert.equal(chatContextFromSessionKey("agent:main:main").kind, "unknown");
    assert.equal(chatContextFromSessionKey("").kind, "unknown");
  });
});

describe("originRelation", () => {
  const dm = { ...chatContextFromSessionKey(DM_CHRISTIAN), ownerDirect: true };
  const group = chatContextFromSessionKey(GROUP);
  it("same chat by session key, foreign DM, other group, group in DM", () => {
    assert.equal(originRelation({ sessionKey: "agent:main:telegram:default:direct:55736530:thread:55736530:1" }, dm), "sameChat");
    assert.equal(originRelation({ sessionKey: DM_OTHER }, dm), "foreignDirect");
    assert.equal(originRelation({ sessionKey: DM_CHRISTIAN }, group), "foreignDirect");
    assert.equal(originRelation({ sessionKey: GROUP_B }, group), "otherGroup");
    assert.equal(originRelation({ sessionKey: GROUP }, dm), "groupInDirect");
  });
  it("legacy rows (no sessionKey): origin dm is the owner DM, a foreign DM in groups; the rest unknown", () => {
    assert.equal(originRelation({ origin: "dm" }, dm), "sameChat");
    assert.equal(originRelation({ origin: "dm" }, { ...dm, ownerDirect: false }), "unknown");
    assert.equal(originRelation({ origin: "dm" }, group), "foreignDirect");
    assert.equal(originRelation({ origin: "group" }, dm), "groupInDirect");
    assert.equal(originRelation({ origin: "dream" }, dm), "unknown");
  });
});

describe("applyContextWeighting", () => {
  const row = (id, score, entry) => ({ entry: { id, ...entry }, score, rerankScore: score });
  const banal = { sensitivity: "banal", sensitivitySource: "rules" };

  it("in the owner DM: own rows full, group knowledge slightly down, confidential foreign out", () => {
    const request = { ...chatContextFromSessionKey(DM_CHRISTIAN), ownerDirect: true };
    const { results, counts } = applyContextWeighting([
      row("own", 0.5, { origin: "dm" }),
      row("group", 0.6, { sessionKey: GROUP, ...banal }),
      row("secret", 0.9, { sessionKey: GROUP, sensitivity: "confidential", sensitivitySource: "rules" }),
      row("unclassified", 0.95, { sessionKey: GROUP }),
    ], { request, config });
    assert.deepEqual(results.map((r) => r.entry.id), ["group", "own"]);
    assert.ok(Math.abs(results[0].weightedScore - 0.6 * 0.85) < 1e-12);
    assert.deepEqual(counts, { same: 1, foreignPassed: 1, downweighted: 1, filteredConfidential: 2, queued: 0, capped: 0 });
  });

  it("in a group: DM memories need an LLM verdict; without one they are held back and queued", () => {
    const queued = [];
    const request = chatContextFromSessionKey(GROUP);
    const { results, counts } = applyContextWeighting([
      row("groupOwn", 0.3, { sessionKey: GROUP }),
      row("dmRules", 0.9, { origin: "dm", ...banal }),
      row("dmLlm", 0.95, { origin: "dm", sensitivity: "personal", sensitivitySource: "llm" }),
      row("dmUnclassified", 0.99, { origin: "dm", text: "x" }),
    ], { request, config, enqueueClassification: (e) => queued.push(e.id) });
    assert.deepEqual(results.map((r) => r.entry.id), ["dmLlm", "groupOwn"]);
    assert.ok(Math.abs(results[0].weightedScore - 0.95 * 0.35) < 1e-12, "a strong DM hit still makes it, weighted down");
    assert.deepEqual(queued.sort(), ["dmRules", "dmUnclassified"]);
    assert.equal(counts.queued, 2);
  });

  it("a sidecar LLM verdict wins over the row", () => {
    const request = chatContextFromSessionKey(GROUP);
    const lookup = (id) => (id === "dm" ? { sensitivity: "banal", source: "llm" } : null);
    const { results } = applyContextWeighting([row("dm", 0.9, { origin: "dm" })], { request, config, sensitivityLookup: lookup });
    assert.equal(results.length, 1);
    const confidential = (id) => (id === "dm" ? { sensitivity: "confidential", source: "llm" } : null);
    assert.equal(applyContextWeighting([row("dm", 0.9, { origin: "dm", ...banal })], { request: chatContextFromSessionKey(DM_OTHER), config, sensitivityLookup: confidential }).results.length, 0);
  });

  it("caps foreign memories per block (within the visible places)", () => {
    const request = { ...chatContextFromSessionKey(DM_CHRISTIAN), ownerDirect: true };
    const rows = Array.from({ length: 8 }, (_, i) => row(`g${i}`, 0.9 - i * 0.01, { sessionKey: GROUP, ...banal }));
    rows.push(row("own", 0.1, { origin: "dm" }));
    const { results, counts } = applyContextWeighting(rows, { request, config, limit: 30 });
    assert.equal(results.filter((r) => r.contextRelation !== "sameChat").length, 5);
    assert.equal(counts.capped, 3);
    assert.ok(results.some((r) => r.entry.id === "own"));
  });

  it("weights and cap come from the config; enabled=false changes nothing", () => {
    const custom = resolveContextWeightingConfig({ weights: { groupInDirect: 0.5, bogus: 3 }, maxForeignPerBlock: 1 });
    assert.equal(custom.weights.groupInDirect, 0.5);
    assert.equal(custom.maxForeignPerBlock, 1);
    const list = [row("a", 0.5, { sessionKey: GROUP })];
    assert.equal(applyContextWeighting(list, { request: chatContextFromSessionKey(DM_OTHER), config: resolveContextWeightingConfig(false) }).results, list);
  });
});

describe("Neo lanes and single memories", () => {
  it("Neo items without session key are treated like legacy DM rows", () => {
    const lanes = {
      facts: [
        { item: { id: "n1", statement: "Eva mag Tee", origin: {} }, score: 0.8 },
        { item: { id: "n2", statement: "Gruppenthema", origin: { sessionKey: GROUP }, sensitivity: "banal", sensitivitySource: "rules" }, score: 0.5 },
      ],
    };
    const inOwnerDm = applyContextWeightingToNeoLanes(lanes, { request: { ...chatContextFromSessionKey(DM_CHRISTIAN), ownerDirect: true }, config });
    assert.deepEqual(inOwnerDm.lanes.facts.map((r) => r.item.id), ["n1", "n2"]);
    assert.ok(Math.abs(inOwnerDm.lanes.facts[1].score - 0.5 * 0.85) < 1e-12);
    const inGroup = applyContextWeightingToNeoLanes(lanes, { request: chatContextFromSessionKey(GROUP), config });
    assert.deepEqual(inGroup.lanes.facts.map((r) => r.item.id), ["n2"]);
  });

  it("contextAllows gates CRR and lens additions", () => {
    const policy = { request: chatContextFromSessionKey(GROUP), config };
    assert.equal(contextAllows({ id: "x", sessionKey: GROUP }, policy), true);
    assert.equal(contextAllows({ id: "y", origin: "dm", sensitivity: "banal", sensitivitySource: "rules" }, policy), false);
  });
});

describe("owner DM and policy", () => {
  const hostConfig = { channels: { telegram: { accounts: { default: { allowFrom: [55736530] }, bernhardine: { allowFrom: [1211667028, 1] } } } } };
  it("needs a proved sender, a direct chat and the single allowed person (or configured owners)", () => {
    const base = { sessionKey: DM_CHRISTIAN, userPrincipal: "user:v1:abc", agentId: "main", hostConfig };
    assert.equal(isOwnerDirectChat(base), true);
    assert.equal(isOwnerDirectChat({ ...base, userPrincipal: "" }), false, "unproved sender");
    assert.equal(isOwnerDirectChat({ ...base, sessionKey: GROUP }), false);
    assert.equal(isOwnerDirectChat({ ...base, sessionKey: "agent:bernhardine:telegram:bernhardine:direct:1211667028" }), false, "allowlist with two people");
    assert.equal(isOwnerDirectChat({ ...base, sessionKey: "agent:bernhardine:telegram:bernhardine:direct:1211667028", owners: { main: ["x"] }, agentId: "bernhardine" }), false);
    assert.equal(isOwnerDirectChat({ ...base, sessionKey: "agent:bernhardine:telegram:bernhardine:direct:1211667028", owners: { bernhardine: ["telegram:1211667028"] }, agentId: "bernhardine" }), true);
  });

  it("no policy for unknown chats (CLI, webchat) or when disabled", () => {
    assert.equal(buildContextPolicy({ contextWeightingCfg: config, sessionKey: "agent:main:main" }), null);
    assert.equal(buildContextPolicy({ contextWeightingCfg: resolveContextWeightingConfig(false), sessionKey: GROUP }), null);
    assert.equal(buildContextPolicy({ contextWeightingCfg: config, sessionKey: GROUP }).request.kind, "group");
  });
});

describe("sensitivity queue", () => {
  it("queues once, classifies in one LLM call per batch, persists verdicts in the sidecar only", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-sens-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const store = createSensitivityStore({ baseDir: dir });
    assert.equal(store.enqueue({ id: "a", text: "Eva hat Geburtstag" }), true);
    assert.equal(store.enqueue({ id: "a", text: "Eva hat Geburtstag" }), false, "deduplicated");
    store.enqueue({ id: "b", text: "Diagnose beim Arzt" });
    store.enqueue({ id: "c", text: "" });
    let calls = 0;
    const result = await store.processBatch({ complete: async () => { calls++; return '{"a":"personal","b":"confidential"}'; } });
    assert.equal(calls, 1);
    assert.deepEqual(result, { classified: 2, failed: 0, skipped: false });
    assert.equal(store.lookup("a").sensitivity, "personal");
    assert.equal(store.pending(), 0);
    const reread = createSensitivityStore({ baseDir: dir });
    assert.equal(reread.lookup("b").sensitivity, "confidential");
    assert.doesNotMatch(readFileSync(join(dir, "_sensitivity", "verdicts.jsonl"), "utf8"), /Geburtstag|Diagnose/, "no memory text on disk");
  });

  it("a failed call keeps the queue", async () => {
    const store = createSensitivityStore({ baseDir: "" });
    store.enqueue({ id: "a", text: "x y" });
    await store.processBatch({ complete: async () => { throw new Error("down"); } });
    assert.equal(store.pending(), 1);
  });
});

describe("rules are deterministic and cheap", () => {
  it("classifies without a model", () => {
    assert.equal(classifySensitivityByRules("Mein Kontostand ist im Minus, die Bank droht mit Inkasso.").sensitivity, "confidential");
  });
});

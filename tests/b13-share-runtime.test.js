import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { shareCard as productionShareCard } from "../lib/telegram-commands/memory-edit.js";
import { stableDirectoryCapabilitiesSupported } from "../lib/directory-capability.js";
import { MultiNamespacePool } from "../lib/multi-namespace-pool.js";
import { resolveNamespaceLayout } from "../lib/namespace-config.js";

const VECTOR_DIM = 384;
const OWNER = "owner";
const OTHER_OWNER = "other-owner";
const SOURCE_IDS = Object.freeze({
  normal: "11111111-1111-4111-8111-111111111111",
  sensitive: "22222222-2222-4222-8222-222222222222",
  core: "33333333-3333-4333-8333-333333333333",
  neverForget: "44444444-4444-4444-8444-444444444444",
  important: "55555555-5555-4555-8555-555555555555",
  missing: "66666666-6666-4666-8666-666666666666",
  legacyOnly: "77777777-7777-4777-8777-777777777777",
});

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    const match = /^(.*):thread:([^:]+)$/.exec(value);
    return match ? { baseSessionKey: match[1], threadId: match[2] } : { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

function officialHostCommand(args, {
  accountId = "account-a",
  chat = "chat-a",
  senderId = OWNER,
  sessionId = "session-a",
  thread = "thread-a",
} = {}) {
  const target = thread
    ? `telegram:group:${chat}:topic:${thread}`
    : `telegram:direct:${chat}`;
  const sessionRoute = thread
    ? `telegram:group:${chat}:topic:${thread}`
    : `telegram:${accountId}:direct:${chat}`;
  return {
    args,
    agentId: "agent-a",
    accountId,
    channel: "telegram",
    config: {},
    from: target,
    messageThreadId: thread,
    senderId,
    sessionId,
    sessionKey: `agent:agent-a:${sessionRoute}`,
    threadParentId: thread ? chat : "",
    getCurrentConversationBinding: async () => ({
      channel: "telegram",
      accountId,
      conversationId: thread || chat,
      parentConversationId: chat,
      threadId: thread,
      peerKind: thread ? "group" : "direct",
    }),
  };
}

function sourceCard(id, patch = {}) {
  return {
    id,
    text: `source ${id}`,
    summary: `source ${id}`,
    category: "fact",
    importance: 0.5,
    status: "active",
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
    ...patch,
  };
}

function fakeTargetDb(rows) {
  const textType = Object.freeze({ name: "Utf8" });
  const vectorType = Object.freeze({ listSize: VECTOR_DIM });
  const fields = [
    ["text", textType], ["vector", vectorType], ["agentId", textType], ["workspaceId", textType],
    ["sourceMemoryId", textType], ["sourceAgentId", textType], ["shareIdempotencyKey", textType],
    ["shareProvenance", textType],
  ].map(([name, type]) => ({ name, type }));
  return {
    vectorDim: VECTOR_DIM,
    async init() {},
    table: {
      async schema() { return { fields }; },
      query() {
        let where = "";
        return {
          where(value) { where = value; return this; },
          limit() { return this; },
          async toArray() {
            const key = /shareIdempotencyKey = '([a-f0-9]+)'/.exec(where)?.[1];
            if (key) return rows.filter((row) => row.shareIdempotencyKey === key);
            const id = /id = '([0-9a-f-]+)'/.exec(where)?.[1];
            return id ? rows.filter((row) => row.id === id) : [];
          },
        };
      },
    },
    async store(row) { rows.push({ ...row }); },
  };
}

function createShareRuntime(cards, { baseDbPath, legacyCards = [], namespaces } = {}) {
  const activeCards = new Map(cards.map((card) => [card.id, card]));
  const legacyCardMap = new Map(legacyCards.map((card) => [card.id, card]));
  const targetRows = { workspace: new Map(), user: new Map() };
  const counters = { source: 0, embed: 0, workspaceTarget: 0, userTarget: 0 };
  const flatSourcePool = {
    async withWriteDb(agentId, operation) {
      counters.source += 1;
      assert.equal(agentId, "agent-a");
      return operation({
        async init() {},
        async getById(id) {
          const card = activeCards.get(id);
          return card ? { ...card } : null;
        },
      });
    },
  };
  let sourcePool = flatSourcePool;
  if (namespaces) {
    class FixtureAgentDbPool {
      constructor(namespacePath) {
        this.namespace = basename(namespacePath);
      }
      getDb(agentId) {
        assert.equal(agentId, "agent-a");
        const rows = this.namespace === namespaces.activeWriteNamespace ? activeCards : legacyCardMap;
        return {
          async init() {},
          async getById(id) {
            const card = rows.get(id);
            return card ? { ...card } : null;
          },
        };
      }
      async withDb(agentId, operation) {
        counters.source += 1;
        return operation(this.getDb(agentId));
      }
      async shutdown() {}
    }
    sourcePool = new MultiNamespacePool(
      resolveNamespaceLayout(baseDbPath, namespaces, { explicit: true }),
      VECTOR_DIM,
      FixtureAgentDbPool,
    );
  }
  const embeddings = {
    async embed() {
      counters.embed += 1;
      const vector = Array(VECTOR_DIM).fill(0);
      vector[0] = 1;
      return vector;
    },
  };
  const targetLease = (scope) => async (ctx, operation) => {
    counters[scope === "workspace" ? "workspaceTarget" : "userTarget"] += 1;
    const principal = scope === "workspace" ? ctx.workspaceIdentity : ctx.userPrincipal;
    let rows = targetRows[scope].get(principal);
    if (!rows) {
      rows = [];
      targetRows[scope].set(principal, rows);
    }
    return operation(fakeTargetDb(rows));
  };
  const sharedPool = {
    withWorkspaceDb: targetLease("workspace"),
    withUserDb: targetLease("user"),
  };
  return {
    activeCards,
    counters,
    legacyCards: legacyCardMap,
    targetRows,
    async close() { await sourcePool.shutdown?.(); },
    async shareCard(_privatePool, _sharedPool, _embeddings, agentId, sourceId, options) {
      return productionShareCard(sourcePool, sharedPool, embeddings, agentId, sourceId, options);
    },
  };
}

function makeApi(baseDbPath, workspaceDir, namespaces) {
  const commands = new Map();
  const shutdown = [];
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      ...(namespaces ? { namespaces } : {}),
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      emotion: { t3: { enabled: false } },
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      security: {
        allowedUserIds: [OWNER, OTHER_OWNER],
        allowedChatIds: ["chat-a", "chat-b"],
      },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    runtime: {
      agent: {
        async resolveAgentWorkspaceDir() { return workspaceDir; },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.set(command.name, command); },
    registerTool: noop,
    registerService: noop,
    on(event, handler) { if (event === "gateway_stop") shutdown.push(handler); },
    commands,
    async close() {
      for (const handler of shutdown) await handler();
    },
  };
}

async function registeredHarness(t, cards, { legacyCards, namespaces } = {}) {
  const baseDbPath = mkdtempSync(join(tmpdir(), "p1b-share-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "p1b-share-ws-"));
  const runtime = createShareRuntime(cards, { baseDbPath, legacyCards, namespaces });
  const confirmationIdentities = [];
  const api = makeApi(baseDbPath, workspaceDir, namespaces);
  const { default: plugin } = await import("../index.js");
  plugin.register(api, {
    importRouting: async () => routingCapability,
    shareCard: runtime.shareCard,
    commandRuntimeHooks: {
      onShareConfirmationIdentity(event) { confirmationIdentities.push(event); },
    },
  });
  t.after(async () => {
    await api.close();
    await runtime.close();
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
  const run = async (name, args, overrides) => {
    const command = api.commands.get(name);
    assert.ok(command, `/${name} must be registered`);
    return command.handler(officialHostCommand(args, overrides));
  };
  return { api, confirmationIdentities, run, runtime };
}

function confirmationToken(text) {
  const match = String(text).match(/\/share confirm ([0-9a-f-]+)/i);
  assert.ok(match, `expected complete /share confirmation token, got: ${text}`);
  assert.match(match[1], /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  return match[1];
}

function workSnapshot(counters) {
  return {
    source: counters.source,
    embed: counters.embed,
    workspaceTarget: counters.workspaceTarget,
    userTarget: counters.userTarget,
  };
}

describe("B13 authoritative registered share handlers", () => {
  it("uses the official host binding for positive workspace/user shares and stable idempotency", async (t) => {
    const { api, run, runtime } = await registeredHarness(t, [sourceCard(SOURCE_IDS.normal)]);
    assert.equal(api.commands.get("share").handler, api.commands.get("teile").handler);

    const first = await run("share", SOURCE_IDS.normal);
    assert.match(first.text, /shared|geteilt/i);
    const firstId = /([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/i.exec(first.text)?.[1];
    assert.ok(firstId);

    const repeated = await run("teile", SOURCE_IDS.normal);
    assert.match(repeated.text, new RegExp(firstId));
    const user = await run("share", `${SOURCE_IDS.normal} --user`);
    assert.match(user.text, /shared|geteilt/i);
    assert.equal(runtime.activeCards.get(SOURCE_IDS.normal).status, "active");
    assert.equal([...runtime.targetRows.workspace.values()].flat().length, 1);
    assert.equal([...runtime.targetRows.user.values()].flat().length, 1);
    assert.deepEqual(runtime.counters, {
      source: 3,
      embed: 3,
      workspaceTarget: 2,
      userTarget: 1,
    });
  });

  it("uses one host-derived conversation principal for a complete sensitive roundtrip and rejects zero-work attacks without consuming it", async (t) => {
    const cards = [
      sourceCard(SOURCE_IDS.sensitive, { category: "secret" }),
      sourceCard(SOURCE_IDS.normal),
    ];
    const { confirmationIdentities, run, runtime } = await registeredHarness(t, cards);
    const initiated = await run("share", `${SOURCE_IDS.sensitive} --user`);
    const token = confirmationToken(initiated.text);
    assert.deepEqual(runtime.counters, { source: 1, embed: 0, workspaceTarget: 0, userTarget: 0 });
    assert.equal(confirmationIdentities.length, 1);
    const createdBinding = confirmationIdentities[0];
    assert.equal(createdBinding.phase, "create");
    assert.equal(createdBinding.rawChatId, "chat-a", "authorization must retain the raw allowedChatIds value");
    assert.match(createdBinding.identity.chatId, /^conversation:v1:/);

    const altered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    const attacks = [
      { label: "wrong account", args: `confirm ${token}`, overrides: { accountId: "account-b" } },
      { label: "wrong thread", args: `confirm ${token}`, overrides: { thread: "thread-b" } },
      { label: "wrong session", args: `confirm ${token}`, overrides: { sessionId: "session-b" } },
      { label: "wrong chat", args: `confirm ${token}`, overrides: { chat: "chat-b" } },
      { label: "wrong user", args: `confirm ${token}`, overrides: { senderId: OTHER_OWNER } },
      { label: "altered suffix", args: `confirm ${altered}` },
      { label: "shortened prefix", args: `confirm ${token.slice(0, 6)}` },
      { label: "different target", args: `confirm ${token} ${SOURCE_IDS.normal}` },
    ];
    for (const attack of attacks) {
      const before = workSnapshot(runtime.counters);
      const denied = await run("share", attack.args, attack.overrides);
      assert.match(denied.text, /failed|fehlgeschlagen/i, attack.label);
      assert.deepEqual(workSnapshot(runtime.counters), before, `${attack.label} must do zero source/embed/target work`);
    }

    confirmationIdentities.length = 0;
    const completed = await run("teile", `confirm ${token}`);
    assert.match(completed.text, /shared|geteilt/i);
    assert.deepEqual(confirmationIdentities, [{
      phase: "complete",
      identity: createdBinding.identity,
      rawChatId: "chat-a",
    }], "creation and completion must use one identical derived conversation binding");
    assert.deepEqual(runtime.counters, { source: 2, embed: 1, workspaceTarget: 0, userTarget: 1 });
    const afterCompletion = workSnapshot(runtime.counters);
    const replay = await run("share", `confirm ${token}`);
    assert.match(replay.text, /failed|fehlgeschlagen/i);
    assert.deepEqual(workSnapshot(runtime.counters), afterCompletion, "replay must do zero work");

    const expiring = await run("share", SOURCE_IDS.sensitive);
    const expiringToken = confirmationToken(expiring.text);
    const beforeExpiry = workSnapshot(runtime.counters);
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      const expired = await run("share", `confirm ${expiringToken}`);
      assert.match(expired.text, /failed|fehlgeschlagen/i);
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(workSnapshot(runtime.counters), beforeExpiry, "expiry must do zero work");
  });

  it("requires confirmation for every core, neverForget, high-importance, and sensitive-category variant", async (t) => {
    const variants = [
      sourceCard(SOURCE_IDS.core, { memoryClass: "core" }),
      sourceCard(SOURCE_IDS.neverForget, { neverForget: true }),
      sourceCard(SOURCE_IDS.important, { importance: 0.95 }),
      sourceCard(SOURCE_IDS.sensitive, { category: "health" }),
    ];
    const { run, runtime } = await registeredHarness(t, variants);
    for (const card of variants) {
      const before = workSnapshot(runtime.counters);
      const result = await run("share", card.id);
      confirmationToken(result.text);
      assert.deepEqual(workSnapshot(runtime.counters), {
        ...before,
        source: before.source + 1,
      }, `${card.id} must stop before embedding or target work`);
    }
  });

  it("treats a named legacy-namespace-only UUID exactly like missing and performs no embed or target work", async (t) => {
    if (!stableDirectoryCapabilitiesSupported()) {
      t.skip("stable directory capabilities are unavailable on this platform; explicit named namespace routing is disabled");
      return;
    }
    const namespaces = {
      activeWriteNamespace: "active",
      activeRecallNamespaces: ["active"],
      legacyReadOnlyNamespaces: ["legacy"],
      crossNamespaceRecall: true,
    };
    const { run, runtime } = await registeredHarness(t, [], {
      namespaces,
      legacyCards: [sourceCard(SOURCE_IDS.legacyOnly)],
    });
    assert.equal(runtime.legacyCards.has(SOURCE_IDS.legacyOnly), true);
    const legacyOnly = await run("share", SOURCE_IDS.legacyOnly);
    const missing = await run("share", SOURCE_IDS.missing);
    assert.equal(legacyOnly.text, missing.text);
    assert.match(legacyOnly.text, /not found|nicht gefunden/i);
    assert.deepEqual(runtime.counters, {
      source: 2,
      embed: 0,
      workspaceTarget: 0,
      userTarget: 0,
    });
  });
});

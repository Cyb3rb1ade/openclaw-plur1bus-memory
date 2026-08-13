/**
 * tests/smoke-wiki-command.test.js
 *
 * Unit tests for /wiki command — wikiAdd, wikiSearch, wikiDelete.
 * All DB I/O is mocked; no real LanceDB instance.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { MemoryDB } from "../index.js";
import { checkAccess } from "../lib/acl-middleware.js";
import { runWikiCommand } from "../lib/wiki-command.js";
import {
  resolveHostCommandMemoryContext,
  resolveMemoryRequestContext,
} from "../lib/memory-request-context.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

const REQUEST_NOW = 1_800_000_000_000;
const OWNER_AGENT = "test-agent";
const OWNER_WORKSPACE = "workspace-1";
const FOREIGN_WORKSPACE = "workspace-2";
const OWNER_USER = "test-user-42";
const OWNER_CHAT = "test-chat-42";
const OWNER_WIKI_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SECOND_OWNER_WIKI_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FOREIGN_WIKI_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MISSING_WIKI_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    return { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeTable({
  wikiRows = [],
  memoryRows = [],
  supportsWhere = true,
  queryRows = [],
  whereError = null,
  fallbackError = null,
  whereSpy = () => {},
  deleteSpy = async () => {},
} = {}) {
  return {
    vectorSearch: () => {
      const builder = {
        limit: (n) => ({
          toArray: async () => {
            if (fallbackError) throw fallbackError;
            return [...wikiRows, ...memoryRows].slice(0, n);
          },
        }),
      };
      if (supportsWhere) {
        builder.where = (clause) => {
          whereSpy(clause);
          return {
            limit: (n) => ({
              toArray: async () => {
                if (whereError) throw whereError;
                return clause.includes("'wiki'") && !clause.includes("'memory'")
                  ? wikiRows.slice(0, n)
                  : memoryRows.slice(0, n);
              },
            }),
          };
        };
      }
      return builder;
    },
    delete: deleteSpy,
    query: () => ({
      where: () => ({ limit: () => ({ toArray: async () => queryRows }) }),
    }),
  };
}

function makeDb({
  wikiRows = [],
  memoryRows = [],
  supportsWhere = true,
  queryRows = [],
  whereError = null,
  fallbackError = null,
  whereSpy = () => {},
  deleteSpy = async () => {},
  getByIdFn = async () => null,
  findSimilarFn = async () => [],
  storeSpy = async () => {},
} = {}) {
  return {
    init: async () => {},
    table: makeTable({
      wikiRows,
      memoryRows,
      supportsWhere,
      queryRows,
      whereError,
      fallbackError,
      whereSpy,
      deleteSpy,
    }),
    getById: getByIdFn,
    findSimilar: findSimilarFn,
    store: storeSpy,
    search: async () => [],
  };
}

function makeCtx(args, extra = {}) {
  return {
    args,
    agentId: OWNER_AGENT,
    messages: [],
    workspaceDir: null,
    workspaceId: OWNER_WORKSPACE,
    channel: "telegram",
    accountId: "primary",
    userId: OWNER_USER,
    chatId: OWNER_CHAT,
    chatKind: "private",
    ...extra,
  };
}

function makeDeps(db, {
  callLlm,
  archiveDir,
  cfg,
  embeddings,
  logger,
  ctx,
  now = REQUEST_NOW,
  workspaceDir,
} = {}) {
  const resolvedLogger = logger
    ?? { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return {
    pool: { getDb: () => db },
    embeddings: embeddings ?? {
      embed: async () => new Float32Array(4).fill(0.1),
      embedQuery: async () => new Float32Array(4).fill(0.1),
    },
    reranker: null,
    callLlm: callLlm ?? (async () => "synthesized answer"),
    cfg: cfg ?? { security: { allowedUserIds: [OWNER_USER] } },
    api: { logger: resolvedLogger },
    llmCfg: { model: "test-model", maxTokens: 400 },
    archiveDir,
    ctx,
    now,
    workspaceDir,
  };
}

function makeNoDataDeps(events, commandCtx) {
  const db = {
    async init() {
      events.push("init");
    },
  };
  const pool = {};
  Object.defineProperty(pool, "withDb", {
    get() {
      events.push("pool");
      return async (_agentId, fn) => {
        events.push("lease");
        return fn(db);
      };
    },
  });
  return {
    pool,
    embeddings: {
      async embed() {
        events.push("provider");
        return new Float32Array(4).fill(0.1);
      },
      async embedQuery() {
        events.push("provider");
        return new Float32Array(4).fill(0.1);
      },
    },
    reranker: null,
    callLlm: async () => {
      events.push("runtime");
      return "must not run";
    },
    cfg: { security: { allowedUserIds: [OWNER_USER] } },
    api: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
    llmCfg: { model: "test-model", maxTokens: 400 },
    ctx: memoryContextFor(commandCtx),
    now: REQUEST_NOW,
  };
}

function memoryContextFor(commandCtx) {
  return resolveMemoryRequestContext(commandCtx);
}

function workspaceWiki(memoryCtx, overrides = {}) {
  return {
    id: OWNER_WIKI_ID,
    memoryKind: "wiki",
    _distance: 0.1,
    status: "active",
    expiresAt: 0,
    text: "own wiki preview",
    summary: "[Wiki] own wiki preview",
    scope: "workspace",
    agentId: memoryCtx.agentId,
    storedBy: memoryCtx.agentId,
    workspaceId: memoryCtx.workspaceIdentity,
    workspaceKey: memoryCtx.workspaceIdentity,
    ownerUserId: "",
    ...overrides,
  };
}

function normalMemory(memoryCtx, overrides = {}) {
  return workspaceWiki(memoryCtx, {
    id: SECOND_OWNER_WIKI_ID,
    memoryKind: "memory",
    text: "own normal memory",
    summary: "own normal memory",
    ...overrides,
  });
}

function foreignWorkspaceWiki(memoryCtx, overrides = {}) {
  const foreignCtx = memoryContextFor(makeCtx("", {
    workspaceId: FOREIGN_WORKSPACE,
    workspaceDir: null,
  }));
  return workspaceWiki(memoryCtx, {
    id: FOREIGN_WIKI_ID,
    text: "foreign title victim secret",
    summary: "foreign title victim secret",
    workspaceId: foreignCtx.workspaceIdentity,
    workspaceKey: foreignCtx.workspaceIdentity,
    ...overrides,
  });
}

function foreignUserMemory(memoryCtx, overrides = {}) {
  const foreignUser = memoryContextFor(makeCtx("", { userId: "victim-user" }));
  return normalMemory(memoryCtx, {
    id: FOREIGN_WIKI_ID,
    text: "victim secret",
    summary: "victim secret",
    scope: "user",
    ownerUserId: foreignUser.userPrincipal,
    workspaceId: "",
    workspaceKey: "",
    ...overrides,
  });
}

async function runDirect(args, db, options = {}) {
  const commandCtx = makeCtx(args, options.commandCtx || {});
  const ctx = options.ctx || memoryContextFor(commandCtx);
  return runWikiCommand(commandCtx, makeDeps(db, {
    ...options,
    ctx,
    workspaceDir: options.workspaceDir ?? ctx.workspaceDir,
  }));
}

function officialCommandContext(args, {
  senderId = "owner-user",
  runtimeContext,
} = {}) {
  return {
    args,
    agentId: "official-agent",
    senderId,
    channel: "telegram",
    accountId: "default",
    sessionKey: "agent:official-agent:main",
    from: "telegram:official-chat",
    to: "telegram:official-chat",
    config: {},
    getCurrentConversationBinding: () => null,
    ...(runtimeContext ? { runtimeContext } : {}),
  };
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
}

function registerWikiHarness(t, {
  workspaceDir,
  baseDbPath,
  events = [],
  stored = [],
  ownerUserId = "owner-user",
} = {}) {
  const commands = [];
  const shutdownHandlers = [];
  const originals = {
    dbInit: MemoryDB.prototype.init,
    dbFindSimilar: MemoryDB.prototype.findSimilar,
    dbStore: MemoryDB.prototype.store,
    embed: LocalTransformersEmbeddingProvider.prototype.embed,
    embedQuery: LocalTransformersEmbeddingProvider.prototype.embedQuery,
  };
  MemoryDB.prototype.init = async function initWikiFixture() {
    events.push("db:init");
    return true;
  };
  MemoryDB.prototype.findSimilar = async function findSimilarWikiFixture() {
    events.push("db:findSimilar");
    return [];
  };
  MemoryDB.prototype.store = async function storeWikiFixture(entry) {
    events.push("db:store");
    stored.push(entry);
  };
  LocalTransformersEmbeddingProvider.prototype.embed = async function embedWikiFixture(text, context) {
    events.push(["provider:embed", text, context]);
    return new Float32Array(384).fill(0.125);
  };
  LocalTransformersEmbeddingProvider.prototype.embedQuery = async function embedQueryWikiFixture(text, context) {
    events.push(["provider:embedQuery", text, context]);
    return new Float32Array(384).fill(0.125);
  };

  const api = {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      merging: { enabled: false },
      emotion: { t3: { enabled: false } },
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      replyOutcomeTracking: { enabled: false },
      neo: { enabled: false },
      gc: { enabled: false },
      featureCronSetup: { auto: false },
      security: {
        allowedUserIds: [ownerUserId],
        allowedChatIds: ["official-chat"],
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      agent: {
        async resolveAgentWorkspaceDir() {
          events.push("route:start");
          await Promise.resolve();
          events.push("route:end");
          return workspaceDir;
        },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool() {},
    registerService() {},
    on(name, handler) {
      if (name === "gateway_stop") shutdownHandlers.push(handler);
    },
  };
  plugin.register(api, { importRouting: async () => routingCapability });

  t.after(async () => {
    for (const shutdown of shutdownHandlers) await shutdown();
    MemoryDB.prototype.init = originals.dbInit;
    MemoryDB.prototype.findSimilar = originals.dbFindSimilar;
    MemoryDB.prototype.store = originals.dbStore;
    LocalTransformersEmbeddingProvider.prototype.embed = originals.embed;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originals.embedQuery;
  });

  return {
    handler: commands.find((command) => command.name === "wiki")?.handler,
    api,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("wiki-command smoke", () => {
  let archiveDir;

  before(() => {
    // realpathSync: macOS tmpdir is a symlink (/var -> /private/var) and the
    // production code resolves real paths, so expectations must match.
    archiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-archive-")));
    mkdirSync(join(archiveDir, "test-agent"), { recursive: true });
  });

  after(() => {
    rmSync(archiveDir, { recursive: true, force: true });
  });

  it("returns localized usage for missing or null direct args without data work", async () => {
    for (const args of [undefined, null]) {
      const events = [];
      const commandCtx = makeCtx(args);
      const result = await runWikiCommand(commandCtx, makeNoDataDeps(events, commandCtx));

      assert.match(result.text, /Wiki commands|Wiki-Befehle/);
      assert.deepEqual(events, []);
    }
  });

  it("rejects malformed direct add and UUID grammar before pool, lease, init, or provider work", async () => {
    const cases = [
      ["add no-colon", /\/wiki add/i],
      ["add : body", /\/wiki add/i],
      ["add term:", /\/wiki add/i],
      ["delete id:not-a-uuid", /No entry found|Kein Eintrag/],
    ];

    for (const [args, expected] of cases) {
      const events = [];
      const commandCtx = makeCtx(args);
      const result = await runWikiCommand(commandCtx, makeNoDataDeps(events, commandCtx));

      assert.match(result.text, expected);
      assert.deepEqual(events, [], args);
    }
  });

  it("wikiAdd stores entry with memoryKind: 'wiki'", async () => {
    const stored = [];
    const db = makeDb({ storeSpy: async (entry) => { stored.push(entry); } });
    const result = await runWikiCommand(makeCtx("add Kimi API: Der Key endet auf wKxqM", { workspaceKey: "workspace-1" }), makeDeps(db, { archiveDir }));
    assert.ok(!result.text.includes("Fehler") && !result.text.includes("error"), `unexpected error: ${result.text}`);
    assert.strictEqual(stored.length, 1, "store should have been called once");
    assert.strictEqual(stored[0].memoryKind, "wiki", "memoryKind must be 'wiki'");
    assert.strictEqual(stored[0].workspaceKey, "workspace:v1:workspace-1", "canonical workspaceKey must be persisted for wiki entries");
    assert.strictEqual(stored[0].workspaceId, "workspace:v1:workspace-1");
    assert.strictEqual(stored[0].agentId, "test-agent");
  });

  it("authorizes Wiki writes only from the supplied frozen memory context", async () => {
    const stored = [];
    let dbLeases = 0;
    let embeds = 0;
    const db = makeDb({ storeSpy: async (entry) => { stored.push(entry); } });
    const memoryCtx = resolveMemoryRequestContext({
      agentId: "test-agent",
      workspaceId: "workspace-1",
      channel: "telegram",
      accountId: "primary",
      userId: "owner-user",
      chatId: "owner-chat",
      chatKind: "private",
    });
    const deps = makeDeps(db, {
      archiveDir,
      cfg: { security: { allowedUserIds: ["owner-user"], allowedChatIds: ["owner-chat"] } },
    });
    deps.pool = {
      getDb() {
        dbLeases++;
        return db;
      },
    };
    deps.embeddings = {
      async embed() {
        embeds++;
        return new Float32Array(4).fill(0.1);
      },
    };
    const rawCtx = makeCtx("add Frozen owner: canonical route wins", {
      userId: "attacker",
      chatId: "attacker-chat",
      chatType: "group",
    });
    const allowed = await runWikiCommand(rawCtx, { ...deps, ctx: memoryCtx });
    assert.equal(stored.length, 1, allowed.text);
    assert.equal(dbLeases, 1);
    assert.equal(embeds, 1);

    const deniedCtx = Object.freeze({ ...memoryCtx, chatKind: "group" });
    const deniedDeps = makeDeps(db, { archiveDir, cfg: {} });
    deniedDeps.pool = { getDb() { throw new Error("DB lease must not happen before auth"); } };
    deniedDeps.embeddings = { async embed() { throw new Error("provider must not run before auth"); } };
    const denied = await runWikiCommand(makeCtx("add Denied: no side effects"), {
      ...deniedDeps,
      ctx: deniedCtx,
    });
    assert.match(denied.text, /not authorized|nicht autorisiert/i);
  });

  it("wikiDelete removes a wiki entry by query", async () => {
    const deleted = [];
    const commandCtx = makeCtx("delete Kimi", {
      workspaceDir: archiveDir,
      workspaceId: undefined,
    });
    const memoryCtx = memoryContextFor(commandCtx);
    const wikiRows = [
      workspaceWiki(memoryCtx, {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        _distance: 0.3,
        text: "Kimi wiki entry",
        summary: "[Wiki] Kimi",
      }),
    ];
    const db = makeDb({
      wikiRows,
      deleteSpy: async (sql) => { deleted.push(sql); },
    });
    const result = await runWikiCommand(commandCtx, makeDeps(db, {
      archiveDir,
      ctx: memoryCtx,
      workspaceDir: archiveDir,
    }));
    assert.ok(deleted.length > 0, `delete should have been called, result: ${result.text}`);
    assert.ok(deleted[0].includes("aaaaaaaa"), "should delete the wiki entry by its UUID");
  });

  it("wikiDelete rejects non-wiki entry by ID — does not call delete", async () => {
    const deleted = [];
    const memoryCtx = memoryContextFor(makeCtx(""));
    const db = makeDb({
      getByIdFn: async () => normalMemory(memoryCtx, {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        text: "normal memory",
        summary: "normal memory",
      }),
      deleteSpy: async (sql) => { deleted.push(sql); },
    });
    const result = await runWikiCommand(
      makeCtx("delete id:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
      makeDeps(db, { archiveDir }),
    );
    assert.strictEqual(deleted.length, 0, "delete must NOT be called for a non-wiki entry");
    assert.ok(
      result.text.includes("Normal memories") || result.text.includes("Normale Erinnerungen"),
      `expected wiki.delete_not_wiki message, got: ${result.text}`,
    );
  });

  it("wikiDelete rejects an invalid agent before DB or archive work", async () => {
    const deleted = [];
    const db = makeDb({
      getByIdFn: async () => ({
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        memoryKind: "wiki",
        text: "wiki entry",
        summary: "wiki entry",
      }),
      deleteSpy: async (sql) => { deleted.push(sql); },
    });
    // Invalid agentId forces archiveCard to throw via safeAgentId.
    await assert.rejects(() => runWikiCommand(
      makeCtx("delete id:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { agentId: "../../etc" }),
      makeDeps(db, { archiveDir }),
    ), /Invalid agent ID/);
    assert.strictEqual(deleted.length, 0, "delete must NOT be called when archive fails");
  });

  it("wikiSearch returns wiki-labelled result when wiki entries exist", async () => {
    const wikiRows = [
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", memoryKind: "wiki", _distance: 0.2,
        status: "active", text: "Kimi: LLM provider", summary: "[Wiki] Kimi", agentId: "test-agent", storedBy: "test-agent" },
    ];
    const db = makeDb({ wikiRows });
    const result = await runWikiCommand(makeCtx("Kimi"), makeDeps(db, { archiveDir }));
    assert.ok(
      result.text.includes("(Wiki)"),
      `expected wiki.result_wiki label, got: ${result.text}`,
    );
  });

  it("wikiSearch falls back to memory result when no wiki entries exist", async () => {
    const memoryRows = [
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", memoryKind: "memory", _distance: 0.25,
        status: "active", text: "Kimi memory entry", summary: "Kimi memory", agentId: "test-agent", storedBy: "test-agent" },
    ];
    const db = makeDb({ memoryRows });
    const result = await runWikiCommand(makeCtx("Kimi"), makeDeps(db, { archiveDir }));
    assert.ok(
      result.text.includes("No curated wiki entry") || result.text.includes("kuratierter"),
      `expected wiki.result_fallback label, got: ${result.text}`,
    );
  });

  it("wikiSearch filters fallback memories by ACL", async () => {
    const memoryRows = [
      { id: "abababab-abab-abab-abab-abababababab", memoryKind: "memory", _distance: 0.25,
        status: "active", text: "foreign memory entry", summary: "foreign", scope: "agent-private", storedBy: "other-agent" },
    ];
    const db = makeDb({ memoryRows });
    const result = await runWikiCommand(makeCtx("Kimi"), makeDeps(db, { archiveDir }));
    assert.ok(
      result.text.includes("No entry found") || result.text.includes("Kein Eintrag"),
      `expected ACL-filtered not-found result, got: ${result.text}`,
    );
  });

  it("wikiSearch filters user-scoped fallback memories when the caller is not the owner", async () => {
    const memoryRows = [
      { id: "cdcdcdcd-abab-abab-abab-abababababab", memoryKind: "memory", _distance: 0.25,
        status: "active", text: "user scoped memory", summary: "user scoped", scope: "user", ownerUserId: "owner-user" },
    ];
    const db = makeDb({ memoryRows });
    const result = await runWikiCommand(
      makeCtx("Kimi", { userId: "other-user" }),
      makeDeps(db, {
        archiveDir,
        cfg: { security: { allowedUserIds: ["other-user"] } },
      }),
    );
    assert.ok(
      result.text.includes("No entry found") || result.text.includes("Kein Eintrag"),
      `expected ACL-filtered not-found result, got: ${result.text}`,
    );
  });

  it("wikiSearch still returns a user-scoped fallback memory for the owning user", async () => {
    const ownerCtx = makeCtx("Kimi", { userId: "owner-user" });
    const ownerPrincipal = resolveMemoryRequestContext(ownerCtx).userPrincipal;
    const memoryRows = [
      { id: "dededede-abab-abab-abab-abababababab", memoryKind: "memory", _distance: 0.25,
        status: "active", text: "user scoped memory", summary: "user scoped", scope: "user", ownerUserId: ownerPrincipal },
    ];
    const db = makeDb({ memoryRows });
    const result = await runWikiCommand(
      ownerCtx,
      makeDeps(db, {
        archiveDir,
        cfg: { security: { allowedUserIds: ["owner-user"] } },
      }),
    );
    assert.ok(
      result.text.includes("No curated wiki entry") || result.text.includes("kuratierter"),
      `expected fallback memory result for owner, got: ${result.text}`,
    );
  });

  it("wikiDelete filters out higher-ranking normal memory — only deletes wiki entry", async () => {
    const deleted = [];
    const commandCtx = makeCtx("delete Kimi", {
      workspaceDir: archiveDir,
      workspaceId: undefined,
    });
    const memoryCtx = memoryContextFor(commandCtx);
    // Normal memory ranks higher (lower _distance = higher score)
    // Both appear in overfetch; only wiki entry should be deleted
    const allRows = [
      normalMemory(memoryCtx, {
        id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        _distance: 0.05,
        text: "high-ranking normal memory",
        summary: "normal",
      }),
      workspaceWiki(memoryCtx, {
        id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        _distance: 0.3,
        text: "wiki entry about Kimi",
        summary: "[Wiki] Kimi",
      }),
    ];
    // supportsWhere: false forces overfetch+post-filter path — tests JS-level filtering
    const db = makeDb({
      wikiRows: allRows, // all rows returned in overfetch
      supportsWhere: false,
      deleteSpy: async (sql) => { deleted.push(sql); },
    });
    const result = await runWikiCommand(commandCtx, makeDeps(db, {
      archiveDir,
      ctx: memoryCtx,
      workspaceDir: archiveDir,
    }));
    assert.ok(deleted.length > 0, `should have deleted something, result: ${result.text}`);
    assert.ok(deleted.every(sql => sql.includes("ffff")), "must only delete the wiki entry (fff...)");
    assert.ok(!deleted.some(sql => sql.includes("eeee")), "must NOT delete the normal memory (eee...)");
  });

  it("previews only an own active wiki duplicate", async () => {
    const ctx = memoryContextFor(makeCtx("add Local: allowed body"));
    const stored = [];
    const duplicateCalls = [];
    const db = makeDb({
      findSimilarFn: async (...args) => {
        duplicateCalls.push(args);
        return [
          { entry: foreignUserMemory(ctx), score: 0.99 },
          { entry: workspaceWiki(ctx), score: 0.94 },
        ];
      },
      storeSpy: async (entry) => stored.push(entry),
    });

    const result = await runDirect("add Local: allowed body", db, { ctx, archiveDir });

    assert.doesNotMatch(result.text, /victim secret/);
    assert.match(result.text, /own wiki preview/);
    assert.equal(stored.length, 0);
    assert.equal(duplicateCalls.length, 1);
    assert.equal(duplicateCalls[0][1], "Local: allowed body");
    assert.equal(duplicateCalls[0][2], 0.92);
  });

  it("does not let foreign or normal-memory duplicates suppress an add", async () => {
    const ctx = memoryContextFor(makeCtx("add Local: allowed body"));
    const stored = [];
    const db = makeDb({
      findSimilarFn: async () => [
        { entry: foreignWorkspaceWiki(ctx), score: 0.99 },
        { entry: normalMemory(ctx, { text: "normal-memory secret" }), score: 0.98 },
      ],
      storeSpy: async (entry) => stored.push(entry),
    });

    const result = await runDirect("add Local: allowed body", db, { ctx, archiveDir });

    assert.match(result.text, /stored|gespeichert/i);
    assert.doesNotMatch(result.text, /foreign title|victim secret|normal-memory secret/i);
    assert.equal(stored.length, 1);
  });

  it("does not preview expired or malformed-expiry duplicates", async () => {
    const ctx = memoryContextFor(makeCtx("add Lifecycle: allowed body"));
    const stored = [];
    const invalidExpiries = [
      REQUEST_NOW - 1,
      REQUEST_NOW,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0",
      false,
      {},
    ];
    const db = makeDb({
      findSimilarFn: async () => invalidExpiries.map((expiresAt, index) => ({
        entry: workspaceWiki(ctx, {
          id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
          text: `lifecycle secret ${index}`,
          summary: `lifecycle secret ${index}`,
          expiresAt,
        }),
        score: 0.99,
      })),
      storeSpy: async (entry) => stored.push(entry),
    });

    const result = await runDirect("add Lifecycle: allowed body", db, { ctx, archiveDir });

    assert.match(result.text, /stored|gespeichert/i);
    assert.doesNotMatch(result.text, /lifecycle secret/i);
    assert.equal(stored.length, 1);
  });

  it("uses passage embedding with only agent scope for stored wiki content", async () => {
    const ctx = memoryContextFor(makeCtx("add Purpose: stored body"));
    const calls = [];
    const db = makeDb();
    const embeddings = {
      async embed(text, context) {
        calls.push(["embed", text, context]);
        return new Float32Array(4).fill(0.2);
      },
      async embedQuery(text, context) {
        calls.push(["embedQuery", text, context]);
        return new Float32Array(4).fill(0.3);
      },
    };

    await runDirect("add Purpose: stored body", db, { ctx, embeddings, archiveDir });

    assert.deepEqual(calls, [
      ["embed", "Purpose: stored body", { agentId: OWNER_AGENT }],
    ]);
  });

  it("uses query embedding with only agent scope and applies lifecycle SQL", async () => {
    const ctx = memoryContextFor(makeCtx("Purpose query"));
    const calls = [];
    const whereClauses = [];
    const embeddings = {
      async embed(text, context) {
        calls.push(["embed", text, context]);
        return new Float32Array(4).fill(0.2);
      },
      async embedQuery(text, context) {
        calls.push(["embedQuery", text, context]);
        return new Float32Array(4).fill(0.3);
      },
    };
    const db = makeDb({
      wikiRows: [workspaceWiki(ctx)],
      whereSpy: (clause) => whereClauses.push(clause),
    });

    const result = await runDirect("Purpose query", db, {
      ctx,
      embeddings,
      archiveDir,
      now: REQUEST_NOW,
    });

    assert.match(result.text, /\(Wiki\)/);
    assert.deepEqual(calls, [
      ["embedQuery", "Purpose query", { agentId: OWNER_AGENT }],
    ]);
    assert.ok(whereClauses.length >= 1);
    for (const clause of whereClauses) {
      assert.match(clause, /status\s*=\s*'active'|status IS NULL/);
      assert.match(clause, /expiresAt IS NULL/);
      assert.match(clause, /expiresAt = 0/);
      assert.match(clause, new RegExp(`expiresAt > ${REQUEST_NOW}`));
      assert.match(clause, /scope = 'workspace'/);
      assert.match(clause, /workspaceId = 'workspace:v1:workspace-1'/);
      assert.match(clause, /workspaceKey = 'workspace:v1:workspace-1'/);
    }
  });

  it("filters higher-ranked foreign SQL candidates before the final search top-k", async () => {
    const ctx = memoryContextFor(makeCtx("bounded search"));
    const prompts = [];
    const foreignRows = Array.from({ length: 8 }, (_unused, index) => foreignWorkspaceWiki(ctx, {
      id: `${String(index + 1).padStart(8, "0")}-2222-4222-8222-222222222222`,
      _distance: (index + 1) / 100,
      text: `foreign ranked secret ${index + 1}`,
      summary: `foreign ranked secret ${index + 1}`,
    }));
    const own = workspaceWiki(ctx, {
      _distance: 0.2,
      text: "own bounded search result",
      summary: "own bounded search result",
    });
    const db = makeDb({ wikiRows: [...foreignRows, own] });

    const result = await runDirect("bounded search", db, {
      ctx,
      archiveDir,
      callLlm: async (messages) => {
        prompts.push(messages[0].content);
        return "own bounded answer";
      },
    });

    assert.match(result.text, /own bounded answer/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /own bounded search result/);
    assert.doesNotMatch(prompts[0], /foreign ranked secret/);
  });

  it("filters higher-ranked foreign fallback candidates before the final search top-k", async () => {
    const ctx = memoryContextFor(makeCtx("bounded fallback"));
    const foreignRows = Array.from({ length: 8 }, (_unused, index) => foreignWorkspaceWiki(ctx, {
      id: `${String(index + 1).padStart(8, "0")}-2444-4244-8244-222222222222`,
      _distance: (index + 1) / 100,
      text: `foreign fallback secret ${index + 1}`,
      summary: `foreign fallback secret ${index + 1}`,
    }));
    const own = workspaceWiki(ctx, {
      _distance: 0.2,
      text: "own bounded fallback result",
      summary: "own bounded fallback result",
    });
    const db = makeDb({
      wikiRows: [...foreignRows, own],
      supportsWhere: false,
    });

    const result = await runDirect("bounded fallback", db, {
      ctx,
      archiveDir,
      callLlm: async (messages) => {
        assert.match(messages[0].content, /own bounded fallback result/);
        assert.doesNotMatch(messages[0].content, /foreign fallback secret/);
        return "own bounded fallback answer";
      },
    });

    assert.match(result.text, /own bounded fallback answer/);
  });

  it("filters ACL and lifecycle before constructing LLM input", async () => {
    const ctx = memoryContextFor(makeCtx("safe synthesis"));
    const prompts = [];
    const db = makeDb({
      wikiRows: [
        foreignWorkspaceWiki(ctx),
        workspaceWiki(ctx, { text: "allowed synthesis fact", summary: "allowed synthesis fact" }),
        workspaceWiki(ctx, {
          id: SECOND_OWNER_WIKI_ID,
          text: "expired synthesis secret",
          summary: "expired synthesis secret",
          expiresAt: REQUEST_NOW,
        }),
      ],
    });
    const result = await runDirect("safe synthesis", db, {
      ctx,
      archiveDir,
      callLlm: async (messages) => {
        prompts.push(messages[0].content);
        return "safe synthesized answer";
      },
    });

    assert.match(result.text, /safe synthesized answer/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /allowed synthesis fact/);
    assert.doesNotMatch(prompts[0], /foreign title|expired synthesis secret|victim secret/i);
  });

  it("makes every inactive or malformed-expiry search row invisible without LLM work", async () => {
    const ctx = memoryContextFor(makeCtx("old fact"));
    let llmCalls = 0;
    const invalidRows = [
      workspaceWiki(ctx, { status: "superseded", text: "superseded secret" }),
      workspaceWiki(ctx, { id: SECOND_OWNER_WIKI_ID, status: "archived", text: "archived secret" }),
      workspaceWiki(ctx, { id: FOREIGN_WIKI_ID, expiresAt: REQUEST_NOW, text: "expired secret" }),
      workspaceWiki(ctx, { id: MISSING_WIKI_ID, expiresAt: -1, text: "negative expiry secret" }),
      workspaceWiki(ctx, { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", expiresAt: "0", text: "string expiry secret" }),
      workspaceWiki(ctx, { id: "ffffffff-ffff-ffff-ffff-ffffffffffff", expiresAt: Number.NaN, text: "nan expiry secret" }),
    ];
    const db = makeDb({ wikiRows: invalidRows });

    const result = await runDirect("old fact", db, {
      ctx,
      archiveDir,
      callLlm: async () => {
        llmCalls++;
        return "must not run";
      },
    });

    assert.match(result.text, /No entry found|Kein Eintrag/);
    assert.equal(llmCalls, 0);
    assert.doesNotMatch(result.text, /secret/i);
  });

  it("fallback search excludes superseded, archived, expired, and malformed rows", async () => {
    const ctx = memoryContextFor(makeCtx("old fact"));
    let llmCalls = 0;
    const memoryRows = [
      normalMemory(ctx, { status: "superseded", text: "superseded fallback secret" }),
      normalMemory(ctx, { id: FOREIGN_WIKI_ID, status: "archived", text: "archived fallback secret" }),
      normalMemory(ctx, { id: MISSING_WIKI_ID, expiresAt: REQUEST_NOW, text: "expired fallback secret" }),
      normalMemory(ctx, { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", expiresAt: {}, text: "object expiry secret" }),
    ];
    const db = makeDb({ memoryRows, supportsWhere: false });

    const result = await runDirect("old fact", db, {
      ctx,
      archiveDir,
      callLlm: async () => {
        llmCalls++;
        return "must not run";
      },
    });

    assert.match(result.text, /No entry found|Kein Eintrag/);
    assert.equal(llmCalls, 0);
    assert.doesNotMatch(result.text, /fallback secret/i);
  });

  it("Lücke 3 (epistemicStatus, Auflage B): fallback search (supportsWhere:false) excludes an invalidated wiki entry via isActiveKindRow, even when it outranks the live entry", async () => {
    const ctx = memoryContextFor(makeCtx("trust fallback"));
    const invalidatedEntry = workspaceWiki(ctx, {
      id: SECOND_OWNER_WIKI_ID,
      _distance: 0.05, // closer / higher-ranked than the live entry below
      text: "trust fallback invalidated entry",
      summary: "trust fallback invalidated entry",
      epistemicStatus: "invalidated",
    });
    const liveEntry = workspaceWiki(ctx, {
      _distance: 0.2,
      text: "trust fallback live entry",
      summary: "trust fallback live entry",
    });
    // supportsWhere:false -> searchByKind's `typeof builder.where === "function"`
    // check is false, forcing the fallback branch (plain vectorSearch().limit()
    // .toArray(), filtered only by the JS-side isActiveKindRow()) — the same
    // fallback path proven for foreign-workspace exclusion above, now proven
    // for epistemicStatus exclusion.
    const db = makeDb({ wikiRows: [invalidatedEntry, liveEntry], supportsWhere: false });

    const prompts = [];
    const result = await runDirect("trust fallback", db, {
      ctx,
      archiveDir,
      callLlm: async (messages) => {
        prompts.push(messages[0].content);
        return "trust fallback answer";
      },
    });

    assert.match(result.text, /trust fallback answer/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /trust fallback live entry/);
    assert.doesNotMatch(prompts[0], /trust fallback invalidated entry/);
  });

  it("Lücke 3 (epistemicStatus, Auflage B): a throwing where() (catch-fallback path) still excludes an invalidated wiki entry", async () => {
    const ctx = memoryContextFor(makeCtx("trust throw fallback"));
    const invalidatedEntry = workspaceWiki(ctx, {
      id: SECOND_OWNER_WIKI_ID,
      _distance: 0.05,
      text: "trust throw fallback invalidated entry",
      summary: "trust throw fallback invalidated entry",
      epistemicStatus: "invalidated",
    });
    const liveEntry = workspaceWiki(ctx, {
      _distance: 0.2,
      text: "trust throw fallback live entry",
      summary: "trust throw fallback live entry",
    });
    // where() exists and is offered, but its own query rejects — forces the
    // outer catch-fallback branch (distinct trigger from supportsWhere:false
    // above; same downstream isActiveKindRow() safety net).
    const db = makeDb({
      wikiRows: [invalidatedEntry, liveEntry],
      supportsWhere: true,
      whereError: new Error("simulated where() query failure"),
    });

    const prompts = [];
    const result = await runDirect("trust throw fallback", db, {
      ctx,
      archiveDir,
      callLlm: async (messages) => {
        prompts.push(messages[0].content);
        return "trust throw fallback answer";
      },
    });

    assert.match(result.text, /trust throw fallback answer/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /trust throw fallback live entry/);
    assert.doesNotMatch(prompts[0], /trust throw fallback invalidated entry/);
  });

  it("safely logs both search failures without record content", async () => {
    const ctx = memoryContextFor(makeCtx("safe failure"));
    const debugCalls = [];
    const logger = {
      debug(...args) { debugCalls.push(args); },
      info() {},
      warn() {},
      error() {},
    };
    const db = makeDb({
      whereError: new Error("Authorization: Bearer top-secret-token"),
      fallbackError: new Error("victim body must not be logged"),
    });

    const result = await runDirect("safe failure", db, { ctx, logger, archiveDir });

    assert.match(result.text, /No entry found|Kein Eintrag/);
    assert.ok(debugCalls.length >= 2);
    const logged = JSON.stringify(debugCalls);
    assert.doesNotMatch(logged, /top-secret-token|victim body/i);
    assert.match(logged, /wiki search failed/);
  });

  it("safely logs an LLM failure and falls back only to visible excerpts", async () => {
    const ctx = memoryContextFor(makeCtx("LLM fallback"));
    const debugCalls = [];
    const db = makeDb({
      wikiRows: [workspaceWiki(ctx, {
        text: "visible fallback fact",
        summary: "visible fallback fact",
      })],
    });
    const result = await runDirect("LLM fallback", db, {
      ctx,
      archiveDir,
      logger: {
        debug(...args) { debugCalls.push(args); },
        info() {},
        warn() {},
        error() {},
      },
      callLlm: async () => {
        throw new Error("apiKey=super-secret-value");
      },
    });

    assert.match(result.text, /visible fallback fact/);
    assert.ok(debugCalls.length >= 1);
    assert.doesNotMatch(JSON.stringify(debugCalls), /super-secret-value/);
  });

  it("makes denied UUID deletion indistinguishable from missing", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-denied-id-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-denied-id-archive-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    const deleteCalls = [];
    const deniedDb = makeDb({
      getByIdFn: async () => foreignWorkspaceWiki(ctx),
      deleteSpy: async (sql) => deleteCalls.push(sql),
    });
    const missingDb = makeDb({ getByIdFn: async () => null });

    const denied = await runDirect(`delete id:${FOREIGN_WIKI_ID}`, deniedDb, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });
    const missing = await runDirect(`delete id:${MISSING_WIKI_ID}`, missingDb, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.equal(denied.text, missing.text);
    assert.equal(deleteCalls.length, 0);
    assert.equal(readdirSync(localArchiveDir).length, 0);
    assert.equal(readJsonl(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl")).length, 0);
  });

  it("makes expired and malformed UUID rows indistinguishable from missing", async () => {
    const ctx = memoryContextFor(makeCtx(""));
    const missing = await runDirect(`delete id:${MISSING_WIKI_ID}`, makeDb(), { ctx, archiveDir });
    const badRows = [
      workspaceWiki(ctx, { expiresAt: REQUEST_NOW }),
      workspaceWiki(ctx, { expiresAt: -1 }),
      workspaceWiki(ctx, { expiresAt: "0" }),
      workspaceWiki(ctx, { status: "archived" }),
    ];
    let deletes = 0;
    for (const row of badRows) {
      const result = await runDirect(`delete id:${row.id}`, makeDb({
        getByIdFn: async () => row,
        deleteSpy: async () => { deletes++; },
      }), { ctx, archiveDir });
      assert.equal(result.text, missing.text);
    }
    assert.equal(deletes, 0);
  });

  it("returns not-found for a malformed UUID before DB work", async () => {
    let reads = 0;
    const db = makeDb({
      getByIdFn: async () => { reads++; return null; },
    });
    const result = await runDirect("delete id:not-a-uuid", db, { archiveDir });
    assert.match(result.text, /No entry found|Kein Eintrag/);
    assert.equal(reads, 0);
  });

  it("fails closed before UUID archive or delete when the canonical audit workspace is missing", async (t) => {
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-missing-audit-archive-")));
    t.after(() => {
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const ctx = memoryContextFor(makeCtx(""));
    let deletes = 0;
    const db = makeDb({
      getByIdFn: async () => workspaceWiki(ctx),
      deleteSpy: async () => { deletes++; },
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir: localArchiveDir,
    });

    assert.match(result.text, /audit|protokoll|not deleted|nicht gelöscht/i);
    assert.doesNotMatch(result.text, /^🗑/);
    assert.equal(deletes, 0);
    assert.deepEqual(readdirSync(localArchiveDir), []);
  });

  it("fails closed before archive or delete when the canonical audit directory is a file", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-file-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-file-archive-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    writeFileSync(join(workspaceDir, ".adaptive-learning"), "not a directory\n", "utf8");
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    let deletes = 0;
    const db = makeDb({
      getByIdFn: async () => workspaceWiki(ctx),
      deleteSpy: async () => { deletes++; },
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /audit|protokoll|not deleted|nicht gelöscht/i);
    assert.doesNotMatch(result.text, /^🗑/);
    assert.equal(deletes, 0);
    assert.deepEqual(readdirSync(localArchiveDir), []);
    assert.equal(readJsonl(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl")).length, 0);
  });

  it("fails closed before archive or delete when the canonical audit directory is not writable", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-readonly-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-readonly-archive-")));
    const auditDir = join(workspaceDir, ".adaptive-learning");
    mkdirSync(auditDir);
    chmodSync(auditDir, 0o555);
    t.after(() => {
      chmodSync(auditDir, 0o755);
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    let deletes = 0;
    const db = makeDb({
      getByIdFn: async () => workspaceWiki(ctx),
      deleteSpy: async () => { deletes++; },
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /audit|protokoll|not deleted|nicht gelöscht/i);
    assert.doesNotMatch(result.text, /^🗑/);
    assert.equal(deletes, 0);
    assert.deepEqual(readdirSync(localArchiveDir), []);
    assert.equal(readJsonl(join(auditDir, "destructive-ops.jsonl")).length, 0);
  });

  it("fails closed before archive or delete when the audit parent is a broken symlink", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-parent-link-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-parent-link-archive-")));
    const auditDir = join(workspaceDir, ".adaptive-learning");
    symlinkSync("missing-audit-parent", auditDir);
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    let deletes = 0;
    const db = makeDb({
      getByIdFn: async () => workspaceWiki(ctx),
      deleteSpy: async () => { deletes++; },
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /audit|protokoll|not deleted|nicht gelöscht/i);
    assert.doesNotMatch(result.text, /^🗑/);
    assert.equal(deletes, 0);
    assert.deepEqual(readdirSync(localArchiveDir), []);
    assert.equal(existsSync(join(workspaceDir, "missing-audit-parent")), false);
  });

  it("fails closed before archive or delete when the existing audit target is a directory", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-target-dir-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-target-dir-archive-")));
    const auditDir = join(workspaceDir, ".adaptive-learning");
    const auditPath = join(auditDir, "destructive-ops.jsonl");
    mkdirSync(auditPath, { recursive: true });
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    let deletes = 0;
    const db = makeDb({
      getByIdFn: async () => workspaceWiki(ctx),
      deleteSpy: async () => { deletes++; },
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /audit|protokoll|not deleted|nicht gelöscht/i);
    assert.doesNotMatch(result.text, /^🗑/);
    assert.equal(deletes, 0);
    assert.deepEqual(readdirSync(localArchiveDir), []);
    assert.deepEqual(readdirSync(auditPath), []);
  });

  it("fails closed before archive or delete when the existing audit target is unwritable", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-target-readonly-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-target-readonly-archive-")));
    const auditDir = join(workspaceDir, ".adaptive-learning");
    const auditPath = join(auditDir, "destructive-ops.jsonl");
    mkdirSync(auditDir);
    writeFileSync(auditPath, "", "utf8");
    chmodSync(auditPath, 0o444);
    t.after(() => {
      chmodSync(auditPath, 0o644);
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    let deletes = 0;
    const db = makeDb({
      getByIdFn: async () => workspaceWiki(ctx),
      deleteSpy: async () => { deletes++; },
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /audit|protokoll|not deleted|nicht gelöscht/i);
    assert.doesNotMatch(result.text, /^🗑/);
    assert.equal(deletes, 0);
    assert.deepEqual(readdirSync(localArchiveDir), []);
    assert.equal(readFileSync(auditPath, "utf8"), "");
  });

  it("fails closed before archive or delete when the existing audit target is a symlink", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-target-link-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-target-link-archive-")));
    const auditDir = join(workspaceDir, ".adaptive-learning");
    const auditPath = join(auditDir, "destructive-ops.jsonl");
    mkdirSync(auditDir);
    symlinkSync("alternate-audit.jsonl", auditPath);
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    let deletes = 0;
    const db = makeDb({
      getByIdFn: async () => workspaceWiki(ctx),
      deleteSpy: async () => { deletes++; },
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /audit|protokoll|not deleted|nicht gelöscht/i);
    assert.doesNotMatch(result.text, /^🗑/);
    assert.equal(deletes, 0);
    assert.deepEqual(readdirSync(localArchiveDir), []);
    assert.equal(existsSync(join(auditDir, "alternate-audit.jsonl")), false);
  });

  it("keeps an existing writable regular audit target", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-target-file-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-target-file-archive-")));
    const auditDir = join(workspaceDir, ".adaptive-learning");
    const auditPath = join(auditDir, "destructive-ops.jsonl");
    mkdirSync(auditDir);
    writeFileSync(auditPath, "", "utf8");
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    let deletes = 0;
    const db = makeDb({
      getByIdFn: async () => workspaceWiki(ctx),
      deleteSpy: async () => { deletes++; },
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /deleted|gelöscht/i);
    assert.equal(deletes, 1);
    assert.equal(readJsonl(auditPath).length, 1);
  });

  it("fails closed before query archive or delete when the supplied audit workspace is not canonical", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-canonical-ws-")));
    const otherWorkspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-other-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-audit-invalid-archive-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(otherWorkspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    let deletes = 0;
    const db = makeDb({
      wikiRows: [workspaceWiki(ctx)],
      deleteSpy: async () => { deletes++; },
    });

    const result = await runDirect("delete project", db, {
      ctx,
      archiveDir: localArchiveDir,
      workspaceDir: otherWorkspaceDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /audit|protokoll|not deleted|nicht gelöscht/i);
    assert.doesNotMatch(result.text, /^🗑/);
    assert.equal(deletes, 0);
    assert.deepEqual(readdirSync(localArchiveDir), []);
    assert.equal(
      readJsonl(join(otherWorkspaceDir, ".adaptive-learning", "destructive-ops.jsonl")).length,
      0,
    );
  });

  it("archives first, awaits UUID delete, then writes exactly one destructive audit entry", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-id-audit-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-id-audit-archive-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    const events = [];
    const auditPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    const card = workspaceWiki(ctx);
    const db = makeDb({
      getByIdFn: async () => card,
      deleteSpy: async () => {
        const agentArchiveDir = join(localArchiveDir, OWNER_AGENT);
        assert.ok(existsSync(agentArchiveDir));
        assert.ok(readdirSync(agentArchiveDir).some((name) => name.endsWith(`-${card.id}.json`)));
        assert.equal(existsSync(auditPath), false, "audit must not precede settled delete");
        events.push("delete:settled");
      },
    });

    const result = await runDirect(`delete id:${card.id}`, db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /deleted|gelöscht/i);
    assert.deepEqual(events, ["delete:settled"]);
    const audit = readJsonl(auditPath);
    assert.equal(audit.length, 1);
    assert.deepEqual({
      event: audit[0].event,
      source: audit[0].source,
      agentId: audit[0].agentId,
      memoryId: audit[0].memoryId,
      via: audit[0].via,
    }, {
      event: "memory.deleted",
      source: "wiki.delete",
      agentId: OWNER_AGENT,
      memoryId: card.id,
      via: "id",
    });
    assert.equal(typeof audit[0].archivePath, "string");
    assert.equal(typeof audit[0].timestamp, "string");
  });

  it("does not audit when the UUID delete fails after archiving", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-id-fail-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-id-fail-archive-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    const db = makeDb({
      getByIdFn: async () => workspaceWiki(ctx),
      deleteSpy: async () => { throw new Error("delete failed"); },
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /Archive failed|Archivierung fehlgeschlagen/i);
    assert.equal(readJsonl(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl")).length, 0);
  });

  it("filters query matches before ambiguity text or mutation", async () => {
    const commandCtx = makeCtx("delete project", {
      workspaceDir: archiveDir,
      workspaceId: undefined,
    });
    const ctx = memoryContextFor(commandCtx);
    const deleteCalls = [];
    const db = makeDb({
      wikiRows: [
        foreignWorkspaceWiki(ctx),
        workspaceWiki(ctx, { text: "own project wiki", summary: "own project wiki" }),
      ],
      deleteSpy: async (sql) => deleteCalls.push(sql),
    });

    const result = await runDirect("delete project", db, {
      ctx,
      archiveDir,
      commandCtx: { workspaceDir: archiveDir, workspaceId: undefined },
    });

    assert.doesNotMatch(result.text, new RegExp(`foreign title|${FOREIGN_WIKI_ID}`));
    assert.equal(deleteCalls.length, 1);
    assert.match(deleteCalls[0], new RegExp(OWNER_WIKI_ID));
  });

  it("renders ambiguity only among allowed active wiki rows", async () => {
    const ctx = memoryContextFor(makeCtx("delete project"));
    const first = workspaceWiki(ctx, { text: "allowed project one", summary: "allowed project one" });
    const second = workspaceWiki(ctx, {
      id: SECOND_OWNER_WIKI_ID,
      text: "allowed project two",
      summary: "allowed project two",
    });
    const db = makeDb({
      wikiRows: [
        foreignWorkspaceWiki(ctx),
        workspaceWiki(ctx, {
          id: MISSING_WIKI_ID,
          text: "expired ambiguity secret",
          summary: "expired ambiguity secret",
          expiresAt: REQUEST_NOW,
        }),
        first,
        second,
      ],
    });

    const result = await runDirect("delete project", db, { ctx, archiveDir });

    assert.match(result.text, new RegExp(first.id));
    assert.match(result.text, new RegExp(second.id));
    assert.match(result.text, /allowed project one/);
    assert.match(result.text, /allowed project two/);
    assert.doesNotMatch(result.text, new RegExp(`foreign title|${FOREIGN_WIKI_ID}|expired ambiguity secret|${MISSING_WIKI_ID}`));
  });

  it("makes a denied query match indistinguishable from no match", async () => {
    const ctx = memoryContextFor(makeCtx("delete project"));
    let deletes = 0;
    const denied = await runDirect("delete project", makeDb({
      wikiRows: [foreignWorkspaceWiki(ctx)],
      deleteSpy: async () => { deletes++; },
    }), { ctx, archiveDir });
    const missing = await runDirect("delete project", makeDb(), { ctx, archiveDir });

    assert.equal(denied.text, missing.text);
    assert.equal(deletes, 0);
  });

  it("filters higher-ranked foreign candidates before query-delete top-k", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-delete-topk-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-delete-topk-archive-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    const foreignRows = Array.from({ length: 5 }, (_unused, index) => foreignWorkspaceWiki(ctx, {
      id: `${String(index + 1).padStart(8, "0")}-3333-4333-8333-333333333333`,
      _distance: (index + 1) / 100,
      text: `foreign delete secret ${index + 1}`,
      summary: `foreign delete secret ${index + 1}`,
    }));
    const own = workspaceWiki(ctx, {
      _distance: 0.2,
      text: "own bounded delete result",
      summary: "own bounded delete result",
    });
    const deletes = [];
    const db = makeDb({
      wikiRows: [...foreignRows, own],
      deleteSpy: async (sql) => deletes.push(sql),
    });

    const result = await runDirect("delete bounded", db, {
      ctx,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /deleted|gelöscht/i);
    assert.doesNotMatch(result.text, /foreign delete secret/);
    assert.deepEqual(deletes, [`id = "${own.id}"`]);
    const audit = readJsonl(join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl"));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].memoryId, own.id);
    assert.equal(audit[0].via, "query");
  });

  it("uses query embedding purpose and audits one successful query delete after settlement", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-query-audit-ws-")));
    const localArchiveDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-query-audit-archive-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(localArchiveDir, { recursive: true, force: true });
    });
    const commandCtx = makeCtx("", { workspaceDir, workspaceId: undefined });
    const ctx = memoryContextFor(commandCtx);
    const calls = [];
    const auditPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    const db = makeDb({
      wikiRows: [workspaceWiki(ctx)],
      deleteSpy: async () => {
        assert.equal(existsSync(auditPath), false);
        calls.push("delete:settled");
      },
    });
    const embeddings = {
      async embed(text, context) {
        calls.push(["embed", text, context]);
        return new Float32Array(4).fill(0.2);
      },
      async embedQuery(text, context) {
        calls.push(["embedQuery", text, context]);
        return new Float32Array(4).fill(0.3);
      },
    };

    const result = await runDirect("delete project", db, {
      ctx,
      embeddings,
      archiveDir: localArchiveDir,
      commandCtx: { workspaceDir, workspaceId: undefined },
    });

    assert.match(result.text, /deleted|gelöscht/i);
    assert.deepEqual(calls[0], ["embedQuery", "project", { agentId: OWNER_AGENT }]);
    assert.equal(calls[1], "delete:settled");
    const audit = readJsonl(auditPath);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].via, "query");
    assert.equal(audit[0].memoryId, OWNER_WIKI_ID);
  });

  it("logs getById failure safely before using the table fallback", async () => {
    const commandCtx = makeCtx("", {
      workspaceDir: archiveDir,
      workspaceId: undefined,
    });
    const ctx = memoryContextFor(commandCtx);
    const debugCalls = [];
    const deleted = [];
    const db = makeDb({
      getByIdFn: async () => {
        throw new Error("Authorization: Bearer db-secret");
      },
      queryRows: [workspaceWiki(ctx)],
      deleteSpy: async (sql) => deleted.push(sql),
    });

    const result = await runDirect(`delete id:${OWNER_WIKI_ID}`, db, {
      ctx,
      archiveDir,
      commandCtx: { workspaceDir: archiveDir, workspaceId: undefined },
      logger: {
        debug(...args) { debugCalls.push(args); },
        info() {},
        warn() {},
        error() {},
      },
    });

    assert.match(result.text, /deleted|gelöscht/i);
    assert.equal(deleted.length, 1);
    assert.ok(debugCalls.length >= 1);
    assert.doesNotMatch(JSON.stringify(debugCalls), /db-secret/);
  });

  it("logs findSimilar failure safely and continues storing", async () => {
    const ctx = memoryContextFor(makeCtx("add Safe log: body"));
    const debugCalls = [];
    const stored = [];
    const db = makeDb({
      findSimilarFn: async () => {
        throw new Error("api_key=duplicate-secret");
      },
      storeSpy: async (entry) => stored.push(entry),
    });

    const result = await runDirect("add Safe log: body", db, {
      ctx,
      archiveDir,
      logger: {
        debug(...args) { debugCalls.push(args); },
        info() {},
        warn() {},
        error() {},
      },
    });

    assert.match(result.text, /stored|gespeichert/i);
    assert.equal(stored.length, 1);
    assert.ok(debugCalls.length >= 1);
    assert.doesNotMatch(JSON.stringify(debugCalls), /duplicate-secret/);
  });

  it("registered handler returns usage for missing or null args without route, runtime, DB, or provider work", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-null-ws-")));
    const baseDbPath = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-null-db-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(baseDbPath, { recursive: true, force: true });
    });
    const events = [];
    const { handler } = registerWikiHarness(t, { workspaceDir, baseDbPath, events });
    const runtimeContext = {};
    Object.defineProperty(runtimeContext, "llm", {
      get() {
        events.push("runtime");
        return null;
      },
    });

    for (const args of [undefined, null]) {
      const result = await handler(officialCommandContext(args, { runtimeContext }));
      assert.match(result.text, /Wiki commands|Wiki-Befehle/);
      assert.deepEqual(events, [], String(args));
    }
  });

  it("registered handler rejects malformed add and UUID grammar before route, runtime, DB, or provider work", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-grammar-ws-")));
    const baseDbPath = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-grammar-db-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(baseDbPath, { recursive: true, force: true });
    });
    const events = [];
    const { handler } = registerWikiHarness(t, { workspaceDir, baseDbPath, events });
    const runtimeContext = {};
    Object.defineProperty(runtimeContext, "llm", {
      get() {
        events.push("runtime");
        return null;
      },
    });
    const cases = [
      ["add no-colon", /\/wiki add/i],
      ["add : body", /\/wiki add/i],
      ["add term:", /\/wiki add/i],
      ["delete id:not-a-uuid", /No entry found|Kein Eintrag/],
    ];

    for (const [args, expected] of cases) {
      const result = await handler(officialCommandContext(args, { runtimeContext }));
      assert.match(result.text, expected);
      assert.deepEqual(events, [], args);
    }
  });

  it("registered handler returns usage and invalid-input errors without route, DB, or provider work", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-usage-ws-")));
    const baseDbPath = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-usage-db-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(baseDbPath, { recursive: true, force: true });
    });
    const events = [];
    const { handler } = registerWikiHarness(t, { workspaceDir, baseDbPath, events });
    assert.equal(typeof handler, "function");

    const usage = await handler(officialCommandContext(""));
    assert.match(usage.text, /Wiki commands|Wiki-Befehle/);
    assert.deepEqual(events, []);

    const invalid = await handler(officialCommandContext("x".repeat(4001)));
    assert.match(invalid.text, /invalid|ungültig|maximum|Maximal/i);
    assert.deepEqual(events, []);
  });

  it("registered handler authorizes the official context before touching runtime LLM, DB, or provider", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-denied-ws-")));
    const baseDbPath = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-denied-db-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(baseDbPath, { recursive: true, force: true });
    });
    const events = [];
    const { handler } = registerWikiHarness(t, { workspaceDir, baseDbPath, events });
    const runtimeContext = {};
    Object.defineProperty(runtimeContext, "llm", {
      get() {
        throw new Error("runtime LLM touched before authorization");
      },
    });

    const denied = await handler(officialCommandContext("add Denied: body", {
      senderId: "intruder",
      runtimeContext,
    }));

    assert.match(denied.text, /not authorized|nicht autorisiert/i);
    assert.deepEqual(events, ["route:start", "route:end"]);
  });

  it("registered handler stores the exact canonical ownership tuple from an official context", async (t) => {
    const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-owner-ws-")));
    const otherWorkspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-other-ws-")));
    const baseDbPath = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-wiki-handler-owner-db-")));
    t.after(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(otherWorkspaceDir, { recursive: true, force: true });
      rmSync(baseDbPath, { recursive: true, force: true });
    });
    const events = [];
    const stored = [];
    const { handler } = registerWikiHarness(t, {
      workspaceDir,
      baseDbPath,
      events,
      stored,
    });
    const officialCtx = officialCommandContext("add Canonical: body");
    const canonicalCtx = await resolveHostCommandMemoryContext(officialCtx, {
      resolveAgentWorkspaceDir: async () => workspaceDir,
      routingLoader: async () => routingCapability,
      requireConversation: true,
    });
    const otherWorkspaceCtx = await resolveHostCommandMemoryContext(officialCtx, {
      resolveAgentWorkspaceDir: async () => otherWorkspaceDir,
      routingLoader: async () => routingCapability,
      requireConversation: true,
    });

    const result = await handler(officialCtx);

    assert.match(result.text, /stored|gespeichert/i);
    assert.equal(stored.length, 1);
    assert.deepEqual({
      agentId: stored[0].agentId,
      storedBy: stored[0].storedBy,
      workspaceId: stored[0].workspaceId,
      workspaceKey: stored[0].workspaceKey,
      ownerUserId: stored[0].ownerUserId,
      scope: stored[0].scope,
    }, {
      agentId: canonicalCtx.agentId,
      storedBy: canonicalCtx.agentId,
      workspaceId: canonicalCtx.workspaceIdentity,
      workspaceKey: canonicalCtx.workspaceIdentity,
      ownerUserId: "",
      scope: "workspace",
    });
    assert.equal(checkAccess(canonicalCtx, stored[0]).allowed, true);
    assert.equal(checkAccess(otherWorkspaceCtx, stored[0]).allowed, false);
    assert.ok(events.indexOf("route:end") < events.findIndex((event) => Array.isArray(event) && event[0] === "provider:embed"));
    assert.deepEqual(
      events.find((event) => Array.isArray(event) && event[0] === "provider:embed"),
      ["provider:embed", "Canonical: body", { agentId: "official-agent" }],
    );
  });
});

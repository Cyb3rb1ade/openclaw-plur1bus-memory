/**
 * tests/smoke-wiki-command.test.js
 *
 * Unit tests for /wiki command — wikiAdd, wikiSearch, wikiDelete.
 * All DB I/O is mocked; no real LanceDB instance.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWikiCommand } from "../lib/wiki-command.js";
import { resolveMemoryRequestContext } from "../lib/memory-request-context.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeTable({
  wikiRows = [],
  memoryRows = [],
  supportsWhere = true,
  deleteSpy = async () => {},
} = {}) {
  return {
    vectorSearch: () => {
      const builder = {
        limit: (n) => ({
          toArray: async () => [...wikiRows, ...memoryRows].slice(0, n),
        }),
      };
      if (supportsWhere) {
        builder.where = (clause) => ({
          limit: (n) => ({
            toArray: async () =>
              clause.includes("'wiki'") && !clause.includes("'memory'")
                ? wikiRows.slice(0, n)
                : memoryRows.slice(0, n),
          }),
        });
      }
      return builder;
    },
    delete: deleteSpy,
    query: () => ({
      where: () => ({ limit: () => ({ toArray: async () => [] }) }),
    }),
  };
}

function makeDb({
  wikiRows = [],
  memoryRows = [],
  supportsWhere = true,
  deleteSpy = async () => {},
  getByIdFn = async () => null,
  storeSpy = async () => {},
} = {}) {
  return {
    init: async () => {},
    table: makeTable({ wikiRows, memoryRows, supportsWhere, deleteSpy }),
    getById: getByIdFn,
    findSimilar: async () => [],
    store: storeSpy,
    search: async () => [],
  };
}

function makeCtx(args, extra = {}) {
  return {
    args,
    agentId: "test-agent",
    messages: [],
    workspaceDir: null,
    workspaceId: "workspace-1",
    channel: "telegram",
    accountId: "primary",
    userId: "test-user-42",
    chatId: "test-chat-42",
    ...extra,
  };
}

function makeDeps(db, { callLlm, archiveDir } = {}) {
  return {
    pool: { getDb: () => db },
    embeddings: { embed: async () => new Float32Array(4).fill(0.1) },
    reranker: null,
    callLlm: callLlm ?? (async () => "synthesized answer"),
    cfg: { security: { allowedUserIds: ["test-user-42"] } },
    api: { logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } },
    llmCfg: { model: "test-model", maxTokens: 400 },
    archiveDir,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("wiki-command smoke", () => {
  let archiveDir;

  before(() => {
    archiveDir = mkdtempSync(join(tmpdir(), "plur1bus-wiki-archive-"));
    mkdirSync(join(archiveDir, "test-agent"), { recursive: true });
  });

  after(() => {
    rmSync(archiveDir, { recursive: true, force: true });
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

  it("wikiDelete removes a wiki entry by query", async () => {
    const deleted = [];
    const wikiRows = [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", memoryKind: "wiki", _distance: 0.3,
        status: "active", text: "Kimi wiki entry", summary: "[Wiki] Kimi" },
    ];
    const db = makeDb({
      wikiRows,
      deleteSpy: async (sql) => { deleted.push(sql); },
    });
    const result = await runWikiCommand(makeCtx("delete Kimi"), makeDeps(db, { archiveDir }));
    assert.ok(deleted.length > 0, `delete should have been called, result: ${result.text}`);
    assert.ok(deleted[0].includes("aaaaaaaa"), "should delete the wiki entry by its UUID");
  });

  it("wikiDelete rejects non-wiki entry by ID — does not call delete", async () => {
    const deleted = [];
    const db = makeDb({
      getByIdFn: async () => ({
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        memoryKind: "memory",
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
      makeDeps(db, { archiveDir }),
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
      makeDeps(db, { archiveDir }),
    );
    assert.ok(
      result.text.includes("No curated wiki entry") || result.text.includes("kuratierter"),
      `expected fallback memory result for owner, got: ${result.text}`,
    );
  });

  it("wikiDelete filters out higher-ranking normal memory — only deletes wiki entry", async () => {
    const deleted = [];
    // Normal memory ranks higher (lower _distance = higher score)
    // Both appear in overfetch; only wiki entry should be deleted
    const allRows = [
      { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", memoryKind: "memory", _distance: 0.05,
        status: "active", text: "high-ranking normal memory", summary: "normal" },
      { id: "ffffffff-ffff-ffff-ffff-ffffffffffff", memoryKind: "wiki", _distance: 0.3,
        status: "active", text: "wiki entry about Kimi", summary: "[Wiki] Kimi" },
    ];
    // supportsWhere: false forces overfetch+post-filter path — tests JS-level filtering
    const db = makeDb({
      wikiRows: allRows, // all rows returned in overfetch
      supportsWhere: false,
      deleteSpy: async (sql) => { deleted.push(sql); },
    });
    const result = await runWikiCommand(makeCtx("delete Kimi"), makeDeps(db, { archiveDir }));
    assert.ok(deleted.length > 0, `should have deleted something, result: ${result.text}`);
    assert.ok(deleted.every(sql => sql.includes("ffff")), "must only delete the wiki entry (fff...)");
    assert.ok(!deleted.some(sql => sql.includes("eeee")), "must NOT delete the normal memory (eee...)");
  });
});

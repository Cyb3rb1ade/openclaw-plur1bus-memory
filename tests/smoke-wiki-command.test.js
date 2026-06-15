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
    const result = await runWikiCommand(makeCtx("add Kimi API: Der Key endet auf wKxqM"), makeDeps(db, { archiveDir }));
    assert.ok(!result.text.includes("Fehler") && !result.text.includes("error"), `unexpected error: ${result.text}`);
    assert.strictEqual(stored.length, 1, "store should have been called once");
    assert.strictEqual(stored[0].memoryKind, "wiki", "memoryKind must be 'wiki'");
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

  it("wikiDelete aborts when archive fails — does not call delete", async () => {
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
    const result = await runWikiCommand(
      makeCtx("delete id:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { agentId: "../../etc" }),
      makeDeps(db, { archiveDir }),
    );
    assert.strictEqual(deleted.length, 0, "delete must NOT be called when archive fails");
    assert.ok(
      result.text.includes("Archive failed") || result.text.includes("NICHT gelöscht"),
      `expected wiki.archive_failed message, got: ${result.text}`,
    );
  });

  it("wikiSearch returns wiki-labelled result when wiki entries exist", async () => {
    const wikiRows = [
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", memoryKind: "wiki", _distance: 0.2,
        status: "active", text: "Kimi: LLM provider", summary: "[Wiki] Kimi" },
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
        status: "active", text: "Kimi memory entry", summary: "Kimi memory" },
    ];
    const db = makeDb({ memoryRows });
    const result = await runWikiCommand(makeCtx("Kimi"), makeDeps(db, { archiveDir }));
    assert.ok(
      result.text.includes("No curated wiki entry") || result.text.includes("kuratierter"),
      `expected wiki.result_fallback label, got: ${result.text}`,
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

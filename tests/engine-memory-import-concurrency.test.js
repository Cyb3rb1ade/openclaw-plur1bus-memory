/**
 * tests/engine-memory-import-concurrency.test.js — K1: concurrent
 * `Engine.memory.import` of one idempotencyKey must store the card once.
 *
 * Contract 1.11.0: the store id is deterministic, so a second import of the
 * same key is `matched-existing`. Before K1 the write phase ran under a shared
 * lease (`pool.withWriteDb`), so two imports could both re-check "absent" and
 * both `store()` the same id (duplicate rows, two `created` outcomes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync, existsSync, fsyncSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { importCardId } from "../engine/memory-ops/import-id.js";
import { createImportLedger, fsyncDirectory, importLedgerPath } from "../engine/memory-ops/import-ledger.js";
import { importLockPath, withImportLock } from "../engine/memory-ops/import-lock.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TEST_TIMEOUT_MS = 90_000;

function freshBaseDbPath(prefix) {
  return join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
}

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: false,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
  duplicateThreshold: 1.01,
});

/** Embedder with a real await so concurrent imports interleave between classify and store. */
function slowEmbedder(delayMs = 15) {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  const one = async () => { await wait(); return vector(); };
  return {
    embed: one, embedQuery: one, embedPassage: one,
    embedBatch: async (texts) => { await wait(); return texts.map(vector); },
    shutdown: async () => {},
  };
}

function principalFor(agentId) {
  return { agentId, workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
}

const systemAgent = { origin: "system", background: false };

function importReq(agentId, keys) {
  return {
    agentId,
    principal: principalFor(agentId),
    cards: keys.map((key) => ({ idempotencyKey: key, text: `Imported fact for ${key}.`, provenance: "imported" })),
  };
}

async function rowsWithId(engine, agentId, id) {
  return internalsOf(engine).pool.withDb(agentId, async (db) => {
    await db.init();
    const rows = await db.table.query().where(`id = "${id}"`).toArray();
    return rows.length;
  });
}

function ledgerLinesFor(baseDbPath, agentId, key) {
  const path = importLedgerPath(baseDbPath, agentId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((row) => row && row.idempotencyKey === key);
}

function outcomesFor(results, key) {
  return results.map((r) => r.cards.find((c) => c.idempotencyKey === key)?.outcome).sort();
}

function newEngine(baseDbPath, stateDir) {
  return createEngine(
    createStubHost({ stateDir }),
    config(baseDbPath),
    { internals: { embeddings: slowEmbedder() } },
  );
}

describe("Engine.memory.import concurrency (K1)", () => {
  it("Promise.all on one engine: one created, the rest matched-existing, one row", { timeout: TEST_TIMEOUT_MS }, async () => {
    const baseDbPath = freshBaseDbPath("imp-conc-one-");
    const engine = newEngine(baseDbPath, makeTempDir("imp-conc-one-state-"));
    const agentId = "agent-a";
    const id = importCardId(agentId, "k-race");
    try {
      const results = await Promise.all(Array.from({ length: 4 }, () => engine.memory.import(
        importReq(agentId, ["k-race"]), principalFor(agentId), systemAgent,
      )));
      assert.deepEqual(outcomesFor(results, "k-race"), ["created", "matched-existing", "matched-existing", "matched-existing"]);
      for (const r of results) {
        const row = r.cards[0];
        assert.equal(row.id, id);
        if (row.outcome === "matched-existing") assert.equal(row.reason, "already-imported");
      }
      assert.equal(await rowsWithId(engine, agentId, id), 1);
      assert.equal(ledgerLinesFor(baseDbPath, agentId, "k-race").length, 1);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("two engines on one store: one created, one matched-existing, one row", { timeout: TEST_TIMEOUT_MS }, async () => {
    const baseDbPath = freshBaseDbPath("imp-conc-two-");
    const a = newEngine(baseDbPath, makeTempDir("imp-conc-two-a-"));
    const b = newEngine(baseDbPath, makeTempDir("imp-conc-two-b-"));
    const agentId = "agent-a";
    const id = importCardId(agentId, "k-race");
    try {
      const results = await Promise.all([a, b, a, b].map((engine) => engine.memory.import(
        importReq(agentId, ["k-race", "k-solo-x"]), principalFor(agentId), systemAgent,
      )));
      assert.deepEqual(outcomesFor(results, "k-race"), ["created", "matched-existing", "matched-existing", "matched-existing"]);
      assert.deepEqual(outcomesFor(results, "k-solo-x"), ["created", "matched-existing", "matched-existing", "matched-existing"]);
      assert.equal(await rowsWithId(a, agentId, id), 1);
      assert.equal(await rowsWithId(b, agentId, importCardId(agentId, "k-solo-x")), 1);
      assert.equal(ledgerLinesFor(baseDbPath, agentId, "k-race").length, 1);
    } finally {
      await a.close({ budgetMs: 5_000 });
      await b.close({ budgetMs: 5_000 });
    }
  });

  it("two processes on one store: one created, one matched-existing, one row", { timeout: TEST_TIMEOUT_MS }, async () => {
    const baseDbPath = freshBaseDbPath("imp-conc-proc-");
    const agentId = "agent-a";
    const childPath = join(HERE, "helpers", "import-concurrency-child.js");
    // Warm the store first: two processes creating a fresh baseDbPath race on the
    // schema marker's fixed `.tmp` name (engine/store/schema-version.js), which is
    // not what this test probes.
    const warm = newEngine(baseDbPath, makeTempDir("imp-conc-proc-warm-"));
    try {
      await warm.memory.import(importReq(agentId, ["k-warm"]), principalFor(agentId), systemAgent);
    } finally {
      await warm.close({ budgetMs: 5_000 });
    }
    const children = [0, 1].map((n) => {
      const child = spawn(process.execPath, [childPath, baseDbPath, makeTempDir(`imp-conc-proc-${n}-`), agentId, "k-race"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const ready = new Promise((resolve) => {
        child.stdout.on("data", (chunk) => {
          out += chunk;
          if (out.includes("ready\n")) resolve();
        });
      });
      child.stderr.on("data", (chunk) => { err += chunk; });
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child ${n} timed out: ${err.slice(-500)}`)); }, 75_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          const line = out.split("\n").find((l) => l.startsWith("{"));
          if (code !== 0 || !line) reject(new Error(`child ${n} exit ${code}: ${err.slice(-500)}`));
          else resolve(JSON.parse(line));
        });
      });
      return { child, ready, done };
    });
    let outputs;
    try {
      await Promise.race([
        Promise.all(children.map((c) => c.ready)),
        Promise.all(children.map((c) => c.done)), // a child that dies before "ready" rejects here
      ]);
      for (const c of children) c.child.stdin.end("go\n");
      outputs = await Promise.all(children.map((c) => c.done));
    } finally {
      for (const c of children) {
        if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGKILL");
        c.done.catch(() => {});
      }
    }
    for (const o of outputs) assert.equal(o.ok, true, `child failed: ${o.code}`);
    const results = outputs.map((o) => o.result);
    assert.deepEqual(outcomesFor(results, "k-race"), ["created", "matched-existing"]);
    assert.equal(ledgerLinesFor(baseDbPath, agentId, "k-race").length, 1);

    const engine = newEngine(baseDbPath, makeTempDir("imp-conc-proc-check-"));
    try {
      assert.equal(await rowsWithId(engine, agentId, importCardId(agentId, "k-race")), 1);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });
});

// A pid above every platform's pid_max (Linux caps at 2^22): process.kill → ESRCH.
const DEAD_PID = 2 ** 22 + 12_345;

function writeForeignLock(lockPath, { pid, ageMs = 0 }) {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ nonce: "foreign-nonce", pid, host: hostname(), acquiredAt: new Date().toISOString() }));
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    utimesSync(lockPath, past, past);
  }
}

describe("withImportLock (K1)", () => {
  it("serialises overlapping holders in one process and releases the file", { timeout: TEST_TIMEOUT_MS }, async () => {
    const base = makeTempDir("imp-lock-mutex-");
    let active = 0;
    let maxActive = 0;
    const run = () => withImportLock(base, "agent-a", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    });
    await Promise.all([run(), run(), run()]);
    assert.equal(maxActive, 1);
    assert.equal(existsSync(importLockPath(base, "agent-a")), false);
  });

  it("different agents do not block each other", { timeout: TEST_TIMEOUT_MS }, async () => {
    const base = makeTempDir("imp-lock-agents-");
    let inner = null;
    await withImportLock(base, "agent-a", async () => {
      inner = await withImportLock(base, "agent-b", async () => "b-ran", { timeoutMs: 500 });
    });
    assert.equal(inner, "b-ran");
  });

  it("a live foreign holder times out with IMPORT_LOCK_BUSY and is left untouched", { timeout: TEST_TIMEOUT_MS }, async () => {
    const base = makeTempDir("imp-lock-busy-");
    const lockPath = importLockPath(base, "agent-a");
    writeForeignLock(lockPath, { pid: process.ppid, ageMs: 60_000 });
    let ran = false;
    await assert.rejects(
      () => withImportLock(base, "agent-a", async () => { ran = true; }, { timeoutMs: 200 }),
      (e) => e.code === "IMPORT_LOCK_BUSY",
    );
    assert.equal(ran, false);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).nonce, "foreign-nonce");
  });

  it("a stale lock of a dead process is reaped", { timeout: TEST_TIMEOUT_MS }, async () => {
    const base = makeTempDir("imp-lock-stale-");
    const lockPath = importLockPath(base, "agent-a");
    writeForeignLock(lockPath, { pid: DEAD_PID, ageMs: 60_000 });
    const out = await withImportLock(base, "agent-a", async () => "ran", { timeoutMs: 1_000 });
    assert.equal(out, "ran");
    assert.equal(existsSync(lockPath), false);
  });

  it("a fresh lock of a dead process is not reaped before staleMs", { timeout: TEST_TIMEOUT_MS }, async () => {
    const base = makeTempDir("imp-lock-fresh-");
    const lockPath = importLockPath(base, "agent-a");
    writeForeignLock(lockPath, { pid: DEAD_PID });
    await assert.rejects(
      () => withImportLock(base, "agent-a", async () => {}, { timeoutMs: 150 }),
      (e) => e.code === "IMPORT_LOCK_BUSY",
    );
    assert.equal(existsSync(lockPath), true);
  });

  it("abort while waiting throws AbortError", { timeout: TEST_TIMEOUT_MS }, async () => {
    const base = makeTempDir("imp-lock-abort-");
    writeForeignLock(importLockPath(base, "agent-a"), { pid: process.ppid });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      () => withImportLock(base, "agent-a", async () => {}, { timeoutMs: 5_000, signal: controller.signal }),
      (e) => e.name === "AbortError",
    );
  });

  it("heartbeat refreshes our lock's mtime; release after a throw", { timeout: TEST_TIMEOUT_MS }, async () => {
    const base = makeTempDir("imp-lock-beat-");
    const lockPath = importLockPath(base, "agent-a");
    await assert.rejects(() => withImportLock(base, "agent-a", async ({ heartbeat }) => {
      const past = new Date(Date.now() - 60_000);
      utimesSync(lockPath, past, past);
      heartbeat();
      assert.ok(Date.now() - statSync(lockPath).mtimeMs < 5_000, "mtime refreshed");
      throw new Error("boom");
    }, { heartbeatMs: 0 }), /boom/);
    assert.equal(existsSync(lockPath), false);
  });
});

describe("memory.import with a lock left behind (K1)", () => {
  it("a stale lock of a dead process does not block import; the lock is gone afterwards", { timeout: TEST_TIMEOUT_MS }, async () => {
    const baseDbPath = freshBaseDbPath("imp-conc-stale-");
    mkdirSync(baseDbPath, { recursive: true });
    const agentId = "agent-a";
    const lockPath = importLockPath(baseDbPath, agentId);
    writeForeignLock(lockPath, { pid: DEAD_PID, ageMs: 120_000 });
    const engine = newEngine(baseDbPath, makeTempDir("imp-conc-stale-state-"));
    try {
      const result = await engine.memory.import(importReq(agentId, ["k-1"]), principalFor(agentId), systemAgent);
      assert.equal(result.created, 1);
      assert.equal(existsSync(lockPath), false);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("dryRun takes no lock and creates no lock directory", { timeout: TEST_TIMEOUT_MS }, async () => {
    const baseDbPath = freshBaseDbPath("imp-conc-dry-");
    const agentId = "agent-a";
    const engine = newEngine(baseDbPath, makeTempDir("imp-conc-dry-state-"));
    try {
      const result = await engine.memory.import({ ...importReq(agentId, ["k-1"]), dryRun: true }, principalFor(agentId), systemAgent);
      assert.equal(result.created, 1);
      assert.equal(existsSync(dirname(importLockPath(baseDbPath, agentId))), false);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });
});

describe("import ledger durability (K1)", () => {
  function spyLedger(baseDbPath) {
    const calls = [];
    const ledger = createImportLedger({
      baseDbPath,
      syncFile: (fd) => { calls.push(["file", typeof fd]); fsyncSync(fd); },
      syncDir: (dir) => { calls.push(["dir", dir]); fsyncDirectory(dir); },
    });
    return { ledger, calls };
  }
  const row = (key) => ({ idempotencyKey: key, cardId: `id-${key}`, importedAt: 1, sourceRef: "" });

  it("fsyncs the file on every append and the directories only on creation", { timeout: TEST_TIMEOUT_MS }, () => {
    const baseDbPath = join(realpathSync(makeTempDir("imp-ledger-sync-")), "db");
    mkdirSync(baseDbPath, { recursive: true });
    const { ledger, calls } = spyLedger(baseDbPath);
    ledger.append("agent-a", row("k1"));
    assert.deepEqual(calls, [
      ["file", "number"],
      ["dir", join(baseDbPath, "_imports")],
      ["dir", baseDbPath],
    ]);
    calls.length = 0;
    ledger.append("agent-a", row("k2"));
    assert.deepEqual(calls, [["file", "number"]]);
    assert.equal(ledger.load("agent-a").byKey.size, 2);
  });

  it("an fsync failure is a storage error", { timeout: TEST_TIMEOUT_MS }, () => {
    const baseDbPath = join(makeTempDir("imp-ledger-syncfail-"), "db");
    const ledger = createImportLedger({
      baseDbPath,
      syncFile: () => { const e = new Error("io"); e.code = "EIO"; throw e; },
    });
    assert.throws(() => ledger.append("agent-a", row("k1")), (e) => e.code === "storage");
  });

  it("a torn last line is terminated before the next append; both neighbours survive", { timeout: TEST_TIMEOUT_MS }, () => {
    const baseDbPath = join(makeTempDir("imp-ledger-torn-"), "db");
    const ledger = createImportLedger({ baseDbPath });
    ledger.append("agent-a", row("k1"));
    const path = importLedgerPath(baseDbPath, "agent-a");
    appendFileSync(path, '{"v":1,"idempotencyKey":"k-torn","card');
    ledger.append("agent-a", row("k2"));
    const lines = readFileSync(path, "utf8").split("\n");
    assert.equal(lines.at(-1), "");
    const index = ledger.load("agent-a");
    assert.deepEqual([...index.byKey.keys()].sort(), ["k1", "k2"]);
  });

  it("fsyncDirectory is a no-op on win32 and closes the fd elsewhere", () => {
    const opened = [];
    fsyncDirectory("C:\\x", { platform: "win32", openSync: () => { opened.push("open"); return 3; } });
    assert.deepEqual(opened, []);
    const seen = [];
    fsyncDirectory("/x", {
      platform: "linux",
      openSync: (p, flags) => { seen.push(["open", p, flags]); return 7; },
      fsyncSync: (fd) => { seen.push(["sync", fd]); },
      closeSync: (fd) => { seen.push(["close", fd]); },
    });
    assert.deepEqual(seen, [["open", "/x", "r"], ["sync", 7], ["close", 7]]);
  });
});

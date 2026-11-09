/**
 * 7.19.3 — Neo-Aufbewahrung: Mindestaufbewahrung (90 Tage), Kuerzen nach Wert,
 * Archiv statt Verwerfen, Bereinigung des Hook-Stores in der Konsolidierung.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { makeTempDir } from "./helpers/temp-dir.js";
import {
  archiveNeoLines,
  createNeoStore,
  pruneHookNeoStoreFiles,
  pruneNeoJsonlFile,
  selectNeoRetention,
} from "../lib/neo-arch.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const line = (record) => JSON.stringify(record);

function withTmp(fn) {
  const root = makeTempDir("neo-retention-");
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readArchive(dir) {
  const archiveDir = join(dir, "archive");
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir).flatMap((name) => gunzipSync(readFileSync(join(archiveDir, name))).toString("utf8").split("\n").filter(Boolean));
}

describe("selectNeoRetention", () => {
  it("keeps everything at or below the soft limit, however old", () => {
    const lines = [line({ id: "a", createdAt: iso(400) }), line({ id: "b", createdAt: iso(300) })];
    const result = selectNeoRetention(lines, { softMax: 2, hardMax: 10, retentionMs: 90 * DAY, now: NOW });
    assert.deepStrictEqual(result.keep, [true, true]);
    assert.strictEqual(result.removedAge, 0);
  });

  it("drops only expired, unprotected entries above the soft limit — weakest first", () => {
    const lines = [
      line({ id: "old-strong", status: "candidate", salience: 0.9, confidence: 0.9, createdAt: iso(200) }),
      line({ id: "old-weak", status: "candidate", salience: 0.1, confidence: 0.2, createdAt: iso(100) }),
      line({ id: "young-weak", status: "candidate", salience: 0.1, confidence: 0.1, createdAt: iso(5) }),
    ];
    const result = selectNeoRetention(lines, { softMax: 2, hardMax: 10, retentionMs: 90 * DAY, now: NOW });
    assert.deepStrictEqual(result.keep, [true, false, true], "the weak old entry goes before the strong old one; the young one stays");
    assert.strictEqual(result.removedAge, 1);
  });

  it("never drops entries inside the retention window on the soft path", () => {
    const lines = Array.from({ length: 6 }, (_, i) => line({ id: `t${i}`, createdAt: iso(i) }));
    const result = selectNeoRetention(lines, { softMax: 2, hardMax: 10, retentionMs: 90 * DAY, now: NOW });
    assert.ok(result.keep.every(Boolean));
  });

  it("protects active entries with good confidence and pending queue items past the window", () => {
    const lines = [
      line({ id: "keep-active", status: "active", confidence: 0.8, createdAt: iso(300) }),
      line({ id: "keep-pending", status: "pending", queuedAt: iso(300) }),
      line({ id: "drop-active-weak", status: "active", confidence: 0.3, salience: 0.2, createdAt: iso(300) }),
      line({ id: "drop-candidate", status: "candidate", createdAt: iso(300) }),
    ];
    const result = selectNeoRetention(lines, { softMax: 1, hardMax: 10, retentionMs: 90 * DAY, now: NOW });
    assert.deepStrictEqual(result.keep, [true, true, false, false]);
  });

  it("keeps or drops all revisions of one id together, timed by the newest revision", () => {
    const lines = [
      line({ id: "x", status: "candidate", createdAt: iso(200) }),
      line({ id: "y", status: "candidate", createdAt: iso(150) }),
      line({ id: "x", status: "candidate", createdAt: iso(200), updatedAt: iso(1) }),
    ];
    const result = selectNeoRetention(lines, { softMax: 1, hardMax: 10, retentionMs: 90 * DAY, now: NOW });
    assert.deepStrictEqual(result.keep, [true, false, true], "x was touched yesterday, so both of its lines stay");
  });

  it("groups graph edges by source/target/type and keeps strong old edges", () => {
    const lines = [
      line({ source: "a", target: "b", type: "semantic", strength: 0.9, createdAt: iso(200) }),
      line({ source: "c", target: "d", type: "semantic", strength: 0.2, createdAt: iso(200) }),
      line({ source: "c", target: "d", type: "semantic", strength: 0.25, createdAt: iso(200), updatedAt: iso(150) }),
    ];
    const result = selectNeoRetention(lines, { softMax: 1, hardMax: 10, retentionMs: 90 * DAY, now: NOW });
    assert.deepStrictEqual(result.keep, [true, false, false]);
  });

  it("applies the hard limit to young entries too, weakest first and protected last", () => {
    const lines = [
      line({ id: "p", status: "active", confidence: 0.9, createdAt: iso(1) }),
      line({ id: "w1", status: "candidate", salience: 0.1, createdAt: iso(1) }),
      line({ id: "w2", status: "candidate", salience: 0.4, createdAt: iso(1) }),
    ];
    const result = selectNeoRetention(lines, { softMax: 1, hardMax: 2, retentionMs: 90 * DAY, now: NOW });
    assert.deepStrictEqual(result.keep, [true, false, true]);
    assert.strictEqual(result.removedHard, 1);
  });

  it("reads numeric timestamps in seconds (retrieval ledger) as seconds", () => {
    const lines = [line({ id: "sec", timestamp: Math.floor((NOW - DAY) / 1000) }), line({ id: "old", createdAt: iso(200) })];
    const result = selectNeoRetention(lines, { softMax: 1, hardMax: 10, retentionMs: 90 * DAY, now: NOW });
    assert.deepStrictEqual(result.keep, [true, false]);
  });

  it("treats entries without timestamps as fresh", () => {
    const lines = [line({ id: "no-time" }), line({ id: "old", createdAt: iso(200) })];
    const result = selectNeoRetention(lines, { softMax: 1, hardMax: 10, retentionMs: 90 * DAY, now: NOW });
    assert.deepStrictEqual(result.keep, [true, false]);
  });
});

describe("pruneNeoJsonlFile archives what it removes", () => {
  it("writes removed lines to the monthly archive and keeps the rest", () => withTmp((root) => {
    const path = join(root, "memory-candidates.jsonl");
    const lines = [
      line({ id: "old", status: "candidate", statement: "Alt.", createdAt: iso(200) }),
      line({ id: "new", status: "candidate", statement: "Neu.", createdAt: iso(2) }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    const stats = pruneNeoJsonlFile(path, { softMaxRecords: 1, retentionDays: 90, now: NOW, dedup: false });
    assert.strictEqual(stats.removedAge, 1);
    assert.strictEqual(stats.archived, 1);
    assert.deepStrictEqual(readFileSync(path, "utf8").split("\n").filter(Boolean), [lines[1]]);
    assert.deepStrictEqual(readArchive(root), [lines[0]]);
    assert.ok(existsSync(join(root, "archive", "memory-candidates.2026-11.jsonl.gz")));
  }));

  it("leaves the file untouched when the archive cannot be written", () => withTmp((root) => {
    const path = join(root, "memory-candidates.jsonl");
    const content = [line({ id: "old", createdAt: iso(200) }), line({ id: "new", createdAt: iso(2) })].join("\n") + "\n";
    writeFileSync(path, content);
    writeFileSync(join(root, "archive"), "not a directory");
    assert.throws(() => pruneNeoJsonlFile(path, { softMaxRecords: 1, retentionDays: 90, now: NOW, dedup: false }));
    assert.strictEqual(readFileSync(path, "utf8"), content);
  }));

  it("keeps an explicit maxRecords as a hard limit", () => withTmp((root) => {
    const path = join(root, "turn-journal.jsonl");
    const lines = Array.from({ length: 4 }, (_, i) => line({ id: `t${i}`, createdAt: iso(4 - i) }));
    writeFileSync(path, lines.join("\n") + "\n");
    const stats = pruneNeoJsonlFile(path, { maxRecords: 2, now: NOW, dedup: false });
    assert.strictEqual(stats.after, 2);
    assert.strictEqual(stats.removedHard, 2);
    assert.deepStrictEqual(readFileSync(path, "utf8").split("\n").filter(Boolean), lines.slice(2));
    assert.deepStrictEqual(readArchive(root), lines.slice(0, 2));
  }));

  it("does not archive in dry runs", () => withTmp((root) => {
    const path = join(root, "memory-candidates.jsonl");
    writeFileSync(path, [line({ id: "old", createdAt: iso(200) }), line({ id: "new", createdAt: iso(2) })].join("\n") + "\n");
    const stats = pruneNeoJsonlFile(path, { softMaxRecords: 1, now: NOW, dedup: false, dryRun: true });
    assert.strictEqual(stats.removedAge, 1);
    assert.strictEqual(existsSync(join(root, "archive")), false);
  }));
});

describe("archiveNeoLines", () => {
  it("appends gzip members that read back as one stream", () => withTmp((root) => {
    const path = join(root, "episodes.jsonl");
    archiveNeoLines(path, ["{\"id\":1}"], NOW);
    archiveNeoLines(path, ["{\"id\":2}", "{\"id\":3}"], NOW);
    assert.deepStrictEqual(readArchive(root), ["{\"id\":1}", "{\"id\":2}", "{\"id\":3}"]);
  }));
});

describe("pruneHookNeoStoreFiles", () => {
  it("prunes the hook store's files once and skips stores already handled", () => withTmp((root) => {
    const store = createNeoStore(root, "main--abc");
    const injected = { id: "inj", statement: "<relevant-memories>\nx\n</relevant-memories>", createdAt: iso(1) };
    store.appendCandidates([{ id: "keep", statement: "Bleibt.", category: "project_fact", createdAt: iso(1) }]);
    writeFileSync(store.paths.candidates, readFileSync(store.paths.candidates, "utf8") + line(injected) + "\n");
    const report = pruneHookNeoStoreFiles(store, new Set());
    assert.strictEqual(report.skipped, false);
    assert.match(report.workspace, /^main--abc/);
    assert.strictEqual(report.removedInjected, 1);
    assert.strictEqual(report.archived, 1);
    assert.deepStrictEqual(pruneHookNeoStoreFiles(store, new Set([store.paths.workspaceDir])), { skipped: true, reason: "already_pruned" });
    assert.deepStrictEqual(pruneHookNeoStoreFiles(null), { skipped: true, reason: "no_store" });
  }));

  it("does not drop content duplicates that carry their own ids", () => withTmp((root) => {
    const store = createNeoStore(root, "main");
    store.appendCandidates([
      { id: "a", statement: "Gleich.", category: "project_fact", createdAt: iso(2) },
      { id: "b", statement: "Gleich.", category: "project_fact", createdAt: iso(1) },
    ]);
    const before = readFileSync(store.paths.candidates, "utf8");
    const report = pruneHookNeoStoreFiles(store, new Set());
    assert.strictEqual(report.removedDup, 0);
    assert.strictEqual(readFileSync(store.paths.candidates, "utf8"), before);
  }));

  it("does not compact the index or vectors (the daily job does that separately)", () => withTmp((root) => {
    const store = createNeoStore(root, "ws");
    const report = store.pruneAll({ filesOnly: true });
    assert.strictEqual(Object.hasOwn(report, "candidateIndex"), false);
    assert.strictEqual(Object.hasOwn(report, "vectors"), false);
  }));
});

describe("daily consolidation wiring", () => {
  it("prunes the hook store after the partition stores", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.match(source, /dailyStoreDirs\.add\(dailyStore\.paths\.workspaceDir\)/);
    assert.match(source, /hookStorePrune = pruneHookNeoStoreFiles\(commandStore, dailyStoreDirs\)/);
    assert.match(source, /hookStorePrune,\n\s+candidateIndex,/);
  });
});

describe("createNeoStore with a directory name", () => {
  it("resolves an existing canonical directory name to itself instead of nesting a new one", () => withTmp((root) => {
    const byKey = createNeoStore(root, "main");
    const dirName = byKey.paths.workspaceDir.split("/").pop();
    assert.match(dirName, /^main--[0-9a-f]{20}$/);
    const byDirName = createNeoStore(root, dirName);
    assert.strictEqual(byDirName.paths.workspaceDir, byKey.paths.workspaceDir);
  }));

  it("still hashes keys that merely look canonical", () => withTmp((root) => {
    const store = createNeoStore(root, "main--0000000000000000000a");
    assert.notStrictEqual(store.paths.workspaceDir.split("/").pop(), "main--0000000000000000000a");
  }));
});


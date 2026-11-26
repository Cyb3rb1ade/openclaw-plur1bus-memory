/**
 * tests/neo-origin-backfill-7215.test.js — scripts/neo-origin-backfill.mjs
 * (7.21.5): origin.sessionKey for old Neo candidates from the host DBs.
 *
 * Temp dirs, a real Neo store, tiny node:sqlite fixtures; no LanceDB.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { makeTempDir } from "./helpers/temp-dir.js";
import {
  candidateIndexEntry,
  createNeoStore,
  findLatestNeoRecord,
  memoryCandidatesFromTurns,
  routeNeoRecall,
  transitionRecordStatus,
  turnEventsFromMessages,
} from "../lib/neo-arch.js";
import {
  applyNeoOriginBackfill,
  BACKFILL_SOURCES,
  buildRunKeyMap,
  checkApplyPreconditions,
  checkSnapshotCovers,
  createRunKeyResolver,
  createTurnHashResolver,
  isGatewayProcessArgs,
  neoTurnId,
  parseArgs,
  planIndexOnlyBackfill,
  planNeoOriginBackfill,
  readJournalRecords,
  readRunMap,
  readSessionKeys,
  runNeoOriginBackfill,
  scanLegacyTrajectories,
} from "../scripts/neo-origin-backfill.mjs";

const DIRECT = "agent:main:telegram:default:direct:55736530:thread:55736530:64373";
const GROUP = "agent:main:telegram:group:-1003839640481:topic:5778";
const MAIN = "agent:main:main";
const CRON = "agent:main:cron:job-1:run:run-cron";
const OTHER_DIRECT = "agent:main:telegram:default:direct:999";
const NOW = "2026-11-26T03:00:00.000Z";
const CREATED = "2026-10-01T10:00:00.000Z";
// float32-exakt, damit der Sidecar bitgleich zurueckkommt
const V_DIRECT = [0.25, -0.5, 0.125, 1];
const V_GROUP = [0.75, 0.0625, -0.375, -1];

function candidate(id, statement, runId, extra = {}) {
  return {
    id,
    workspaceKey: "main",
    agentId: "main",
    statement,
    normalizedStatement: statement.toLowerCase(),
    category: "project_fact",
    origin: {
      kind: "user_claim", role: "user", sourceTurnIds: [`turn-${id}`], capturedBy: "agent_end_capture",
      trustLevel: "user_asserted", confidence: 0.7, scope: "agent_private", workspaceKey: "main", agentId: "main", sessionId: runId,
    },
    sourceTurnIds: [`turn-${id}`],
    status: "active",
    confidence: 0.8,
    salience: 0.6,
    recency: 1,
    embeddingStatus: "pending",
    createdAt: CREATED,
    ...extra,
  };
}

function transcriptEvent(runId) {
  return JSON.stringify({ type: "message", message: { role: "user", content: "x", __openclaw: { runId } } });
}

function createAgentDb(path, { wal = false } = {}) {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL);
    CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL);
    CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, event_zstd BLOB, PRIMARY KEY (session_id, seq));
  `);
  return db;
}

/** Neo-Store + Host-DBs fuer einen Workspace "main" unter einem Temp-Verzeichnis. */
async function fixture({ withVectors = true } = {}) {
  const root = makeTempDir("plur1bus-neo-origin-");
  const home = join(root, "home");
  const base = join(root, "memory", "lancedb-namespaced");
  const agentsDir = join(root, "agents");
  const stateDb = join(root, "state", "openclaw.sqlite");
  mkdirSync(home, { recursive: true });

  const store = createNeoStore(join(base, "_neo"), "main");
  const records = [
    candidate("c-direct", "Diagnose beim Facharzt am Montag.", "run-direct"),
    candidate("c-group", "Der Gruppenchat plant das Sommerfest im Juli.", "run-group"),
    candidate("c-main", "Der Heartbeat prueft die Crons.", "run-main"),
    candidate("c-cron", "Der Cron-Lauf meldet keine Fehler.", "run-cron"),
    candidate("c-keyed", "Schon mit Schluessel erfasst.", "run-keyed", { origin: { ...candidate("x", "x", "run-keyed").origin, sessionKey: DIRECT }, sensitivity: "banal", sensitivitySource: "rules" }),
    candidate("c-pruned", "Diese Erinnerung wurde verworfen.", "run-pruned"),
    { id: "c-noorigin", workspaceKey: "default", statement: "Ohne Herkunftsobjekt.", category: "agent_strategy", status: "candidate", sourceSessionId: "run-direct", embeddingStatus: "pending", createdAt: CREATED },
    candidate("c-inline", "Mit eingebettetem Vektor in der Zeile.", "run-inline", { embedding: [1, 0, 0, 0], embeddingStatus: "fresh" }),
    candidate("c-amb", "Zwei Quellen, zwei Schluessel.", "run-amb"),
    candidate("c-unresolved", "Lauf ohne Transkript.", "run-unknown"),
  ];
  store.appendCandidates(records);
  store.appendCandidates([transitionRecordStatus(records[5], "pruned", { now: "2026-10-02T10:00:00.000Z" })]);
  if (withVectors) {
    store.appendEmbeddingQueue([records[0], records[1]]);
    const drained = await store.drainEmbeddingQueue({ impact: "low", maxItems: 10, dimensions: 4, embedder: (text) => (text.startsWith("Diagnose") ? V_DIRECT : V_GROUP) });
    assert.equal(drained.processed, 2, "fixture: two vectors in the sidecar");
  }

  const agentDb = createAgentDb(join(agentsDir, "main", "agent", "openclaw-agent.sqlite"));
  agentDb.exec(`
    INSERT INTO session_windows VALUES ('s-direct', '${DIRECT}'), ('s-group', '${GROUP}'), ('s-amb', '${DIRECT}');
    INSERT INTO session_nodes VALUES ('${MAIN}', 's-main');
  `);
  const insert = agentDb.prepare("INSERT INTO transcript_events (session_id, seq, event_json, event_zstd) VALUES (?, ?, ?, ?)");
  insert.run("s-direct", 1, transcriptEvent("run-direct"), null);
  insert.run("s-direct", 2, transcriptEvent("run-pruned"), null);
  insert.run("s-direct", 3, null, zstdCompressSync(Buffer.from(transcriptEvent("run-inline"))));
  insert.run("s-group", 1, transcriptEvent("run-group"), null);
  insert.run("s-main", 1, transcriptEvent("run-main"), null);
  insert.run("s-amb", 1, transcriptEvent("run-amb"), null);
  insert.run("s-direct", 4, "{not json", null);
  agentDb.close();

  mkdirSync(join(stateDb, ".."), { recursive: true });
  const state = new DatabaseSync(stateDb);
  state.exec(`
    CREATE TABLE audit_events (run_id TEXT, session_key TEXT);
    CREATE TABLE session_state_events (run_id TEXT, session_key TEXT NOT NULL);
    INSERT INTO audit_events VALUES ('run-cron', '${CRON}'), ('run-amb', '${OTHER_DIRECT}'), (NULL, '${DIRECT}');
  `);
  state.close();

  const opts = (extra = {}) => ({
    workspaces: ["main"], apply: false, base, agentsDir, stateDb, snapshot: "", includeNonChat: false, sensitivity: true,
    runMap: "", legacyTrajectories: false, compactIndex: false, json: false, allowRunningGateway: false, ...extra,
  });
  const deps = { home, now: NOW, gatewayRunning: () => false };
  // Snapshot wie scripts/backup-snapshot.sh: Kopie der beiden Dateien, jetzt.
  let snapshots = 0;
  const snapshot = () => {
    const snap = join(root, `snapshot-${++snapshots}`);
    const dir = join(snap, "memory", "lancedb-namespaced", "_neo", "workspaces", basename(store.paths.workspaceDir));
    mkdirSync(dir, { recursive: true });
    for (const file of [store.paths.candidates, store.paths.candidateIndex]) if (existsSync(file)) copyFileSync(file, join(dir, basename(file)));
    return snap;
  };
  const apply = (extra = {}) => opts({ apply: true, snapshot: snapshot(), ...extra });
  return { root, home, base, agentsDir, stateDb, store, opts, deps, snapshot, apply };
}

/** Turns und Kandidaten wie captureNeoFromAgentEnd, Turn-IDs mit Sitzungsschluessel. */
function capturedCandidates(sessionKey, messages, runId = "run-unknown-x") {
  const turns = turnEventsFromMessages(messages, { workspaceKey: "main", agentId: "main", sessionId: runId, sessionKey });
  return { turns, candidates: memoryCandidatesFromTurns(turns) };
}

function bytes(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function newestById(path) {
  const latest = new Map();
  for (const record of readJournalRecords(path).records) if (record?.id) latest.set(record.id, record);
  return latest;
}

describe("neo-origin-backfill (7.21.5)", () => {
  it("1. dry run counts every case and writes 0 bytes", async () => {
    const fx = await fixture();
    const before = { journal: bytes(fx.store.paths.candidates), index: bytes(fx.store.paths.candidateIndex), record: bytes(fx.store.paths.index) };
    const report = runNeoOriginBackfill(fx.opts(), fx.deps);
    assert.deepEqual(report.errors, []);
    const s = report.workspaces[0].stats;
    assert.deepEqual(
      [s.ids, s.keyed, s.noKey, s.skippedStatus, s.live, s.noOrigin, s.resolved, s.unresolved, s.ambiguous, s.chat, s.nonChat, s.wouldWrite],
      [10, 1, 9, 1, 8, 1, 5, 1, 1, 3, 2, 2],
    );
    assert.deepEqual(s.byKind, { direct: 2, group: 1 });
    assert.deepEqual(s.nonChatByFamily, { main: 1, cron: 1 });
    assert.equal(s.inlineVectorNoSidecar, 1, "c-inline: vector only inline, no sidecar → skipped");
    assert.deepEqual(s.writeBySource, { "transcript-events": 2 });
    const x = report.workspaces[0].indexStats;
    assert.deepEqual([x.entries, x.indexOnly, x.wouldWrite], [10, 0, 0], "every index entry still has journal lines");
    assert.equal(report.workspaces[0].indexRepair, 0);
    assert.equal(s.bySource["state-events"], 1, "cron key from audit_events");
    assert.equal(s.sensitivity.confidential, 1, "Diagnose … → confidential");
    assert.deepEqual(report.workspaces[0].ambiguousIds, ["c-amb"]);
    assert.deepEqual(
      { journal: bytes(fx.store.paths.candidates), index: bytes(fx.store.paths.candidateIndex), record: bytes(fx.store.paths.index) },
      before,
    );
    assert.equal(existsSync(join(fx.base, "..", ".adaptive-learning", "destructive-ops.jsonl")), false, "a dry run logs nothing");
  });

  it("2. apply appends exactly the chat-key revisions, everything else verbatim", async () => {
    const fx = await fixture();
    const linesBefore = readJournalRecords(fx.store.paths.candidates).lines;
    const before = newestById(fx.store.paths.candidates);
    const report = runNeoOriginBackfill(fx.apply(), fx.deps);
    assert.deepEqual(report.errors, []);
    assert.equal(report.workspaces[0].applied.written, 2);
    const journal = readJournalRecords(fx.store.paths.candidates);
    assert.equal(journal.lines, linesBefore + 2);
    const appended = journal.records.slice(-2);
    assert.deepEqual(appended.map((r) => r.id), ["c-direct", "c-group"], "original newest-line order");
    const keys = { "c-direct": DIRECT, "c-group": GROUP };
    for (const rec of appended) {
      const old = before.get(rec.id);
      assert.equal(rec.origin.sessionKey, keys[rec.id]);
      assert.equal(rec.origin.sessionKeySource, "backfill:transcript-events");
      assert.equal(rec.origin.sessionKeyBackfilledAt, NOW);
      assert.equal(rec.origin.sessionId, old.origin.sessionId, "run id stays");
      assert.ok(["banal", "personal", "confidential"].includes(rec.sensitivity));
      assert.equal(rec.sensitivitySource, "rules");
      assert.equal(rec.createdAt, old.createdAt);
      assert.equal(rec.updatedAt, undefined, "no new updatedAt (retention clock)");
      assert.equal(rec.statement, old.statement);
      assert.equal(rec.status, old.status);
      assert.equal(rec.embeddingStatus, old.embeddingStatus);
      assert.equal(rec.embeddingDims, old.embeddingDims);
      assert.equal(Object.hasOwn(rec, "embedding"), false, "inline vector stripped");
    }
    assert.equal(appended.find((r) => r.id === "c-direct").sensitivity, "confidential");
    // c-inline: nur Inline-Vektor, kein Sidecar — bleibt unangetastet samt Vektor.
    assert.deepEqual(newestById(fx.store.paths.candidates).get("c-inline"), before.get("c-inline"));
    assert.deepEqual(newestById(fx.store.paths.candidates).get("c-inline").embedding, [1, 0, 0, 0]);
  });

  it("3. routeNeoRecall, the candidate index and findLatestNeoRecord return the keyed revision", async () => {
    const fx = await fixture();
    runNeoOriginBackfill(fx.apply(), fx.deps);
    const requester = { requesterAgentId: "main", requesterWorkspaceKey: "main" };
    const lanes = routeNeoRecall(fx.store.readCandidates(500), "Diagnose beim Facharzt", { ...requester, queryVector: V_DIRECT, maxPerLane: 10 });
    const routed = Object.values(lanes).flat().find((row) => row.item.id === "c-direct");
    assert.ok(routed, "c-direct is routed");
    assert.equal(routed.item.origin.sessionKey, DIRECT);
    const entry = fx.store.readCandidateIndex().entries.get("c-group");
    assert.equal(entry.origin.sessionKey, GROUP);
    assert.ok(entry.sensitivity, "index carries sensitivity");
    assert.equal(entry.sensitivitySource, "rules");
    assert.equal(fx.store.readCandidateIndex().entries.get("c-main").origin.sessionKey, undefined, "non-chat stays unkeyed");
    assert.equal(findLatestNeoRecord(fx.store, "c-direct", requester).origin.sessionKey, DIRECT);
    const projected = candidateIndexEntry({ id: "x", statement: "s", sensitivity: "personal", sensitivitySource: "llm" });
    assert.deepEqual([projected.sensitivity, projected.sensitivitySource], ["personal", "llm"]);
  });

  it("4. the sidecar vector still attaches by id", async () => {
    const fx = await fixture();
    runNeoOriginBackfill(fx.apply(), fx.deps);
    assert.deepEqual(fx.store.readVector("c-direct"), V_DIRECT);
    const latest = fx.store.readCandidates(500).filter((r) => r.id === "c-group").at(-1);
    assert.equal(latest.origin.sessionKey, GROUP);
    assert.deepEqual(latest.embedding, V_GROUP, "lazy vector on the keyed revision");
  });

  it("5. a second apply writes nothing", async () => {
    const fx = await fixture();
    runNeoOriginBackfill(fx.apply(), fx.deps);
    const sizes = [bytes(fx.store.paths.candidates), bytes(fx.store.paths.candidateIndex)];
    const second = runNeoOriginBackfill(fx.apply(), fx.deps);
    assert.deepEqual(second.errors, []);
    assert.equal(second.workspaces[0].stats.wouldWrite, 0);
    assert.equal(second.workspaces[0].indexRepair, 0);
    assert.equal(second.workspaces[0].applied, undefined);
    assert.deepEqual([bytes(fx.store.paths.candidates), bytes(fx.store.paths.candidateIndex)], sizes);
  });

  it("6. non-chat keys only with includeNonChat; pruned and keyed rows untouched", async () => {
    const fx = await fixture();
    const before = newestById(fx.store.paths.candidates);
    const report = runNeoOriginBackfill(fx.apply({ includeNonChat: true }), fx.deps);
    assert.equal(report.workspaces[0].applied.written, 4);
    const after = newestById(fx.store.paths.candidates);
    assert.equal(after.get("c-main").origin.sessionKey, MAIN);
    assert.equal(after.get("c-cron").origin.sessionKey, CRON);
    assert.equal(after.get("c-cron").origin.sessionKeySource, "backfill:state-events");
    assert.deepEqual(after.get("c-pruned"), before.get("c-pruned"));
    assert.equal(after.get("c-pruned").status, "pruned");
    assert.deepEqual(after.get("c-keyed"), before.get("c-keyed"));
    assert.deepEqual(after.get("c-noorigin"), before.get("c-noorigin"));
    assert.deepEqual(after.get("c-inline"), before.get("c-inline"), "inline vector without sidecar: skipped here too");
  });

  it("7. a run id with two keys is skipped as ambiguous", () => {
    const records = [candidate("a", "Eins.", "run-a"), candidate("b", "Zwei.", "run-b")];
    const resolve = (runId) => (runId === "run-a"
      ? [{ sessionKey: DIRECT, source: "transcript-events" }, { sessionKey: OTHER_DIRECT, source: "state-events" }]
      : [{ sessionKey: GROUP, source: "transcript-events" }, { sessionKey: ` ${GROUP} `, source: "state-events" }]);
    const plan = planNeoOriginBackfill(records, resolve, { now: NOW });
    assert.deepEqual(plan.ambiguousIds, ["a"]);
    assert.deepEqual(plan.writes.map((r) => r.id), ["b"], "the same key from two sources is no conflict");
    assert.equal(plan.writes[0].origin.sessionKeySource, "backfill:transcript-events", "first source names the revision");
  });

  it("8. buildRunKeyMap reads JSON and zstd events (WAL and immutable paths) without writing", () => {
    const root = makeTempDir("plur1bus-neo-origin-db-");
    const path = join(root, "agent.sqlite");
    const writer = createAgentDb(path, { wal: true });
    writer.exec(`INSERT INTO session_windows VALUES ('s1', '${DIRECT}');`);
    writer.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run("s1", 1, transcriptEvent("run-json"), null);
    writer.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run("s1", 2, null, zstdCompressSync(Buffer.from(transcriptEvent("run-zstd"))));
    // Writer offen: Zeilen liegen im WAL, der Leser muss sie sehen.
    assert.ok(existsSync(`${path}-wal`));
    const live = buildRunKeyMap({ agentDb: path });
    assert.deepEqual(live.runs.get("run-json"), [{ sessionKey: DIRECT, source: BACKFILL_SOURCES.transcriptEvents }]);
    assert.deepEqual(live.runs.get("run-zstd"), [{ sessionKey: DIRECT, source: BACKFILL_SOURCES.transcriptEvents }]);
    assert.ok(live.stats.missingTables.includes("trajectory_runtime_events"), "missing tables are skipped");
    writer.close();
    assert.equal(existsSync(`${path}-wal`), false, "checkpointed on close");
    const dbBytes = statSync(path).size;
    const cold = buildRunKeyMap({ agentDb: path, wanted: new Set(["run-zstd"]) });
    assert.deepEqual([...cold.runs.keys()], ["run-zstd"], "wanted filter");
    assert.equal(existsSync(`${path}-wal`) || existsSync(`${path}-shm`), false, "immutable read creates no -wal/-shm");
    assert.equal(statSync(path).size, dbBytes);
    // session id as run id (old cron runs) comes first
    const resolver = createRunKeyResolver({ agentRuns: new Map([["main", buildRunKeyMap({ agentDb: path }).runs]]) });
    assert.deepEqual(resolver("s1", { origin: { agentId: "main" } }), [{ sessionKey: DIRECT, source: BACKFILL_SOURCES.sessionId }]);
  });

  it("9. the --apply guard rejects a missing snapshot and a running gateway", () => {
    const root = makeTempDir("plur1bus-neo-origin-guard-");
    const home = join(root, "home");
    const copy = join(root, "copy");
    mkdirSync(join(home, ".openclaw", "memory"), { recursive: true });
    mkdirSync(copy, { recursive: true });
    const stopped = { home, gatewayRunning: () => false };
    const running = { home, gatewayRunning: () => ({ running: true, systemd: "active", processes: ["1"] }) };
    assert.throws(() => checkApplyPreconditions({ base: copy, snapshot: "" }, stopped), /--snapshot/);
    assert.throws(() => checkApplyPreconditions({ base: copy, snapshot: join(root, "missing") }, stopped), /--snapshot/);
    assert.throws(() => checkApplyPreconditions({ base: copy, snapshot: root }, running), /gateway is running/);
    assert.ok(checkApplyPreconditions({ base: copy, snapshot: root }, stopped));
    assert.ok(checkApplyPreconditions({ base: copy, snapshot: root, allowRunningGateway: true }, running), "copy outside ~/.openclaw");
    const live = join(home, ".openclaw", "memory", "lancedb-namespaced");
    assert.throws(() => checkApplyPreconditions({ base: live, snapshot: root, allowRunningGateway: true }, running), /only allowed for a copy/);
    assert.throws(() => checkApplyPreconditions({ base: live, snapshot: root, allowRunningGateway: true }, stopped), /only allowed for a copy/);
    // A symlinked home (macOS /var -> /private/var) with a base that does not exist yet.
    const linkedHome = join(root, "linked-home");
    symlinkSync(home, linkedHome);
    assert.throws(() => checkApplyPreconditions({ base: join(linkedHome, ".openclaw", "memory", "lancedb-namespaced"), snapshot: root, allowRunningGateway: true }, { ...running, home }), /only allowed for a copy/);
    assert.throws(() => checkApplyPreconditions({ base: live, snapshot: root, allowRunningGateway: true }, { ...running, home: linkedHome }), /only allowed for a copy/);
  });

  it("10. apply logs started and committed entries in destructive-ops.jsonl", async () => {
    const fx = await fixture();
    const journalBytes = bytes(fx.store.paths.candidates);
    const indexBytes = bytes(fx.store.paths.candidateIndex);
    const opts = fx.apply();
    runNeoOriginBackfill(opts, fx.deps);
    const log = readFileSync(join(fx.base, "..", ".adaptive-learning", "destructive-ops.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => [e.op, e.phase, e.workspace]), [["neo-origin-backfill", "started", "main"], ["neo-origin-backfill", "committed", "main"]]);
    assert.equal(log[0].planned, 2);
    assert.equal(log[0].snapshot, opts.snapshot);
    assert.deepEqual([log[0].journalBytesBefore, log[0].indexBytesBefore, log[0].indexExistedBefore], [journalBytes, indexBytes, true], "rollback sizes");
    assert.equal(log[1].written, 2);
    assert.equal(log[1].journalBytesAfter, bytes(fx.store.paths.candidates));
    const report = readFileSync(join(fx.store.paths.workspaceDir, "archive", log[1].report), "utf8");
    assert.equal(report.includes("Diagnose"), false, "the id report carries no statement text");
    assert.deepEqual(report.trim().split("\n").map((l) => JSON.parse(l).target), ["journal", "journal"]);
  });

  it("11. appendCandidates still drops such a revision (why appendCandidateRevisions exists)", async () => {
    const fx = await fixture({ withVectors: false });
    const record = newestById(fx.store.paths.candidates).get("c-direct");
    const keyed = { ...record, origin: { ...record.origin, sessionKey: DIRECT } };
    const size = bytes(fx.store.paths.candidates);
    assert.deepEqual(fx.store.appendCandidates([keyed]), [], "content dedupe drops it");
    assert.equal(bytes(fx.store.paths.candidates), size);
    const statusRow = transitionRecordStatus(newestById(fx.store.paths.candidates).get("c-group"), "demoted", { now: "2026-10-05T00:00:00.000Z" });
    assert.equal(fx.store.appendCandidates([statusRow]).length, 1);
    assert.deepEqual(fx.store.appendCandidates([{ ...statusRow, origin: { ...statusRow.origin, sessionKey: DIRECT } }]), [], "status dedupe drops it too");
    assert.equal(applyNeoOriginBackfill(fx.store, { writes: [keyed] }).written, 1);
    assert.equal(newestById(fx.store.paths.candidates).get("c-direct").origin.sessionKey, DIRECT);
    // Groessenpruefung im Lock: weicht das Journal ab, wird nichts geschrieben.
    const sizes = [bytes(fx.store.paths.candidates), bytes(fx.store.paths.candidateIndex)];
    assert.throws(() => fx.store.appendCandidateRevisions([keyed], { expectedJournalBytes: sizes[0] - 1 }), /memory-candidates\.jsonl changed since it was read/);
    assert.throws(() => fx.store.appendCandidateRevisions([keyed], { expectedJournalBytes: sizes[0], expectedIndexBytes: sizes[1] + 1 }), /candidate-index\.jsonl changed since it was read/);
    assert.deepEqual([bytes(fx.store.paths.candidates), bytes(fx.store.paths.candidateIndex)], sizes);
  });

  it("12. an inline vector is written (and stripped) only when the sidecar has one", () => {
    const records = [candidate("v", "Mit Vektor.", "run-v", { embedding: [0.5, 0.5], embeddingStatus: "fresh" })];
    const resolve = () => [{ sessionKey: DIRECT, source: "transcript-events" }];
    const without = planNeoOriginBackfill(records, resolve, { now: NOW });
    assert.deepEqual([without.writes.length, without.stats.inlineVectorNoSidecar], [0, 1], "no checker: skipped");
    const missing = planNeoOriginBackfill(records, resolve, { now: NOW, hasSidecarVector: () => false });
    assert.deepEqual([missing.writes.length, missing.stats.inlineVectorNoSidecar], [0, 1]);
    const present = planNeoOriginBackfill(records, resolve, { now: NOW, hasSidecarVector: (id) => id === "v" });
    assert.equal(present.writes.length, 1);
    assert.equal(Object.hasOwn(present.writes[0], "embedding"), false, "the sidecar copy stays the vector");
    const empty = planNeoOriginBackfill([candidate("e", "Leer.", "run-e", { embedding: [] })], resolve, { now: NOW });
    assert.equal(empty.writes.length, 1, "an empty inline array loses nothing");
  });

  it("13. neoTurnId is the library's turn id (drift guard) and the hash resolves captured candidates", () => {
    const text = "Wir grillen am Freitag im Gruppenchat.";
    const { turns, candidates } = capturedCandidates(GROUP, [
      { role: "user", content: text },
      { role: "assistant", content: "Notiert:   Freitag\nGrillen." },
      { role: "user", content: text },
    ]);
    assert.equal(turns.length, 3);
    const ordinals = [0, 0, 1];
    turns.forEach((turn, i) => {
      assert.equal(neoTurnId({ workspaceKey: "main", agentId: "main", sessionKey: GROUP, role: turn.role, statement: turn.content, ordinal: ordinals[i] }), turn.id);
    });
    assert.notEqual(neoTurnId({ workspaceKey: "main", agentId: "main", sessionKey: DIRECT, role: "user", statement: text }), turns[0].id);
    assert.ok(candidates.length >= 2);
    const turnHash = createTurnHashResolver({ keysByAgent: new Map([["main", new Set([DIRECT, MAIN, GROUP])]]) });
    for (const c of candidates) {
      assert.equal(c.origin.sessionKey, undefined, "pre-7.20.10 shape: no key in origin");
      assert.deepEqual(turnHash(c, { agentIds: ["main"] }), [{ sessionKey: GROUP, source: BACKFILL_SOURCES.turnHash }]);
    }
    assert.deepEqual(turnHash(candidates[0], { agentIds: ["other"] }), [], "other agent: no match");
    assert.deepEqual(turnHash({ ...candidates[0], statement: `${text} (bearbeitet)` }, { agentIds: ["main"] }), [], "changed statement: no match");

    const only = planNeoOriginBackfill(candidates, createRunKeyResolver({ turnHash }), { now: NOW });
    assert.equal(only.writes.length, candidates.length);
    assert.equal(only.stats.turnHashOnly, candidates.length);
    assert.ok(only.writes.every((r) => r.origin.sessionKey === GROUP && r.origin.sessionKeySource === "backfill:turn-hash"));
    const agree = planNeoOriginBackfill(candidates, createRunKeyResolver({ runMap: new Map([["run-unknown-x", [{ sessionKey: GROUP, source: BACKFILL_SOURCES.runMap }]]]), turnHash }), { now: NOW });
    assert.equal(agree.stats.turnHashConfirmed, candidates.length);
    assert.ok(agree.writes.every((r) => r.origin.sessionKeySource === "backfill:run-map"), "the run-id source names the revision");
    const clash = planNeoOriginBackfill(candidates, createRunKeyResolver({ runMap: new Map([["run-unknown-x", [{ sessionKey: DIRECT, source: BACKFILL_SOURCES.runMap }]]]), turnHash }), { now: NOW });
    assert.deepEqual([clash.writes.length, clash.stats.ambiguous, clash.stats.turnHashConflicts], [0, candidates.length, candidates.length], "a different hash key makes the id ambiguous");
  });

  it("14. index-only entries are counted; written (index line only) with includeIndexOnly", async () => {
    const fx = await fixture();
    const { candidates } = capturedCandidates(GROUP, [{ role: "user", content: "Im Gruppenchat steht das Sommerfest am 12. Juli fest." }]);
    const { sensitivity: _s, sensitivitySource: _ss, ...old } = candidates[0];
    const indexOnly = candidateIndexEntry(old);
    appendFileSync(fx.store.paths.candidateIndex, `${JSON.stringify(indexOnly)}\n`);
    assert.equal(readSessionKeys(join(fx.agentsDir, "main", "agent", "openclaw-agent.sqlite")).has(GROUP), true);

    const dry = runNeoOriginBackfill(fx.opts(), fx.deps);
    const x = dry.workspaces[0].indexStats;
    assert.deepEqual(
      [x.entries, x.indexOnly, x.searchable, x.noKey, x.resolved, x.chat, x.wouldWrite, x.turnHashOnly],
      [11, 1, 1, 1, 1, 1, 1, 1],
    );
    assert.deepEqual(x.byKind, { group: 1 });
    const noHash = runNeoOriginBackfill(fx.opts({ turnHash: false }), fx.deps).workspaces[0].indexStats;
    assert.deepEqual([noHash.noKey, noHash.resolved, noHash.wouldWrite], [1, 0, 0], "without the turn hash the index-only gap stays visible");

    const indexBytes = bytes(fx.store.paths.candidateIndex);
    const plain = runNeoOriginBackfill(fx.apply(), fx.deps);
    assert.equal(plain.workspaces[0].applied.indexOnlyWritten, 0, "default: index-only entries are only reported");
    assert.equal(fx.store.readCandidateIndex().entries.get(indexOnly.id).origin.sessionKey, undefined);
    assert.ok(bytes(fx.store.paths.candidateIndex) > indexBytes, "the journal revisions got their index lines");

    const journalBytes = bytes(fx.store.paths.candidates);
    const report = runNeoOriginBackfill(fx.apply({ includeIndexOnly: true }), fx.deps);
    assert.deepEqual(report.errors, []);
    assert.deepEqual([report.workspaces[0].applied.written, report.workspaces[0].applied.indexOnlyWritten], [0, 1]);
    assert.equal(bytes(fx.store.paths.candidates), journalBytes, "no journal line for an index-only id");
    const entry = fx.store.readCandidateIndex().entries.get(indexOnly.id);
    assert.equal(entry.origin.sessionKey, GROUP);
    assert.equal(entry.sensitivitySource, "rules");
    assert.equal(entry.statement, indexOnly.statement);
    assert.equal(entry.createdAt, indexOnly.createdAt);
    const again = runNeoOriginBackfill(fx.apply({ includeIndexOnly: true }), fx.deps);
    assert.deepEqual([again.workspaces[0].indexStats.keyed, again.workspaces[0].indexStats.wouldWrite, again.workspaces[0].applied], [1, 0, undefined]);

    // reine Planung: nicht suchbare und schon verschluesselte Eintraege bleiben aussen vor
    const plan = planIndexOnlyBackfill(new Map([
      ["p", { ...indexOnly, id: "p", status: "pruned" }],
      ["k", { ...indexOnly, id: "k", origin: { ...indexOnly.origin, sessionKey: DIRECT } }],
      ["j", { ...indexOnly, id: "j" }],
    ]), new Set(["j"]), () => [{ sessionKey: GROUP, source: "turn-hash" }], { now: NOW });
    assert.deepEqual([plan.stats.indexOnly, plan.stats.searchable, plan.stats.keyed, plan.stats.wouldWrite], [2, 1, 1, 0]);
  });

  it("15. a re-run repairs index lines an interrupted apply left out", async () => {
    const fx = await fixture();
    const indexBytes = bytes(fx.store.paths.candidateIndex);
    runNeoOriginBackfill(fx.apply(), fx.deps);
    // Abbruch zwischen Journal- und Index-Append nachstellen.
    truncateSync(fx.store.paths.candidateIndex, indexBytes);
    assert.equal(fx.store.readCandidateIndex().entries.get("c-direct").origin.sessionKey, undefined);
    const dry = runNeoOriginBackfill(fx.opts(), fx.deps);
    assert.deepEqual([dry.workspaces[0].stats.wouldWrite, dry.workspaces[0].indexRepair], [0, 2]);
    const journalBytes = bytes(fx.store.paths.candidates);
    const report = runNeoOriginBackfill(fx.apply(), fx.deps);
    assert.deepEqual(report.errors, []);
    assert.deepEqual([report.workspaces[0].applied.written, report.workspaces[0].applied.indexRepaired], [0, 2]);
    assert.equal(bytes(fx.store.paths.candidates), journalBytes);
    const index = fx.store.readCandidateIndex().entries;
    assert.equal(index.get("c-direct").origin.sessionKey, DIRECT);
    assert.equal(index.get("c-group").origin.sessionKey, GROUP);
    assert.equal(index.get("c-direct").sensitivity, "confidential");
    const third = runNeoOriginBackfill(fx.apply(), fx.deps);
    assert.deepEqual([third.workspaces[0].indexRepair, third.workspaces[0].applied], [0, undefined]);
  });

  it("16. --apply needs a real, current snapshot of each workspace", async () => {
    const fx = await fixture();
    const live = () => ({
      dir: basename(fx.store.paths.workspaceDir), candidates: fx.store.paths.candidates, candidateIndex: fx.store.paths.candidateIndex,
      journalBytes: bytes(fx.store.paths.candidates), indexBytes: bytes(fx.store.paths.candidateIndex), indexExists: true,
    });
    const empty = join(fx.root, "empty-snapshot");
    mkdirSync(empty);
    assert.throws(() => checkSnapshotCovers(empty, live()), /holds no .*memory-candidates\.jsonl/);
    assert.throws(() => checkSnapshotCovers(fx.root, live()), /is the live file/, "the parent of the live dir is no snapshot");
    assert.throws(() => checkSnapshotCovers(fx.base, live()), /is the live file/, "nor is the live dir itself");
    const snap = fx.snapshot();
    assert.ok(checkSnapshotCovers(snap, live()));
    // cp -r lancedb-namespaced <snapshot> (AGENTS.md, manuell)
    const flat = join(fx.root, "flat-copy", "_neo", "workspaces", basename(fx.store.paths.workspaceDir));
    mkdirSync(flat, { recursive: true });
    copyFileSync(fx.store.paths.candidates, join(flat, "memory-candidates.jsonl"));
    assert.throws(() => checkSnapshotCovers(join(fx.root, "flat-copy"), live()), /holds no .*candidate-index\.jsonl/);
    copyFileSync(fx.store.paths.candidateIndex, join(flat, "candidate-index.jsonl"));
    assert.ok(checkSnapshotCovers(join(fx.root, "flat-copy"), live()));
    appendFileSync(fx.store.paths.candidates, `${JSON.stringify(candidate("c-late", "Nach dem Snapshot erfasst.", "run-late"))}\n`);
    assert.throws(() => checkSnapshotCovers(snap, live()), /take a fresh snapshot/);
    const sizes = [bytes(fx.store.paths.candidates), bytes(fx.store.paths.candidateIndex)];
    assert.throws(() => runNeoOriginBackfill(fx.opts({ apply: true, snapshot: snap }), fx.deps), /take a fresh snapshot/);
    assert.throws(() => runNeoOriginBackfill(fx.opts({ apply: true, snapshot: fx.root }), fx.deps), /is the live file/);
    assert.deepEqual([bytes(fx.store.paths.candidates), bytes(fx.store.paths.candidateIndex)], sizes, "nothing written");
  });

  it("17. the gateway is checked again right before the write, with pid and command in the refusal", async () => {
    const fx = await fixture();
    let calls = 0;
    const deps = { ...fx.deps, gatewayRunning: () => (++calls === 1 ? { running: false, systemd: "inactive", processes: [] } : { running: true, systemd: "inactive", processes: [{ pid: "4242", command: "/usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js gateway --port" }] }) };
    const sizes = [bytes(fx.store.paths.candidates), bytes(fx.store.paths.candidateIndex)];
    const report = runNeoOriginBackfill(fx.apply(), deps);
    assert.equal(calls, 2);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /gateway is running \(systemd openclaw-gateway: inactive; pid 4242: \/usr\/bin\/node .*openclaw.* gateway/);
    assert.deepEqual([bytes(fx.store.paths.candidates), bytes(fx.store.paths.candidateIndex)], sizes, "nothing written");
    assert.equal(existsSync(join(fx.base, "..", ".adaptive-learning", "destructive-ops.jsonl")), false, "refused before the started entry");
  });

  it("18. the process scan matches the gateway, not viewers of its unit", () => {
    assert.equal(isGatewayProcessArgs(["/usr/bin/node", "/usr/lib/node_modules/openclaw/dist/index.js", "gateway", "--port", "18789"]), true);
    assert.equal(isGatewayProcessArgs(["node", "--max-old-space-size=8192", "/usr/lib/node_modules/openclaw/openclaw.mjs", "agent", "--message", "x"]), true);
    assert.equal(isGatewayProcessArgs(["/usr/bin/openclaw", "gateway"]), true);
    assert.equal(isGatewayProcessArgs(["openclaw-gateway"]), true, "process title");
    assert.equal(isGatewayProcessArgs(["openclaw gateway   "]), true, "process title with spaces");
    assert.equal(isGatewayProcessArgs(["journalctl", "--user", "-u", "openclaw-gateway"]), false);
    assert.equal(isGatewayProcessArgs(["systemctl", "--user", "status", "openclaw-gateway"]), false);
    assert.equal(isGatewayProcessArgs(["tail", "-f", "/root/.openclaw/logs/gateway"]), false);
    assert.equal(isGatewayProcessArgs(["node", "/root/x/scripts/neo-origin-backfill.mjs", "--agent", "main"]), false);
    assert.equal(isGatewayProcessArgs([]), false);
  });

  it("legacy trajectory headers map run id and session id to the key", () => {
    const root = makeTempDir("plur1bus-neo-origin-traj-");
    const dir = join(root, "session-sqlite-import-archive");
    mkdirSync(dir, { recursive: true });
    const header = (run, sid, key) => JSON.stringify({ traceSchema: "openclaw-trajectory", type: "session.started", sessionId: sid, sessionKey: key, runId: run, data: { big: "x".repeat(2000) } });
    writeFileSync(join(dir, "archive-tier.s1.trajectory.jsonl.imported-1"), `${header("run-1", "s1", DIRECT)}\n${header("run-2", "run-3", CRON)}\n{"no":"key"}\n`);
    writeFileSync(join(dir, "s1.trajectory-path.json"), header("run-4", "s4", GROUP));
    const { runs, stats } = scanLegacyTrajectories([dir, join(root, "missing")], new Set(["run-1", "run-3", "run-4"]));
    assert.equal(stats.files, 1, "trajectory-path files are skipped");
    assert.deepEqual(runs.get("run-1"), [{ sessionKey: DIRECT, source: BACKFILL_SOURCES.legacyTrajectory }]);
    assert.deepEqual(runs.get("run-3"), [{ sessionKey: CRON, source: BACKFILL_SOURCES.legacyTrajectory }], "sessionId == run id");
    assert.equal(runs.has("run-2"), false, "only wanted run ids");
  });

  it("--run-map pairs resolve run ids (R6) and parseArgs keeps the defaults safe", () => {
    const root = makeTempDir("plur1bus-neo-origin-map-");
    const tsv = join(root, "runs.tsv");
    writeFileSync(tsv, `run-a\t${GROUP}\r\nbroken-line\nrun-b\t\n\t${DIRECT}\n`);
    const runMap = readRunMap(tsv);
    assert.deepEqual([...runMap.keys()], ["run-a"]);
    const plan = planNeoOriginBackfill([candidate("a", "Eins.", "run-a")], createRunKeyResolver({ runMap }), { now: NOW });
    assert.equal(plan.writes[0].origin.sessionKey, GROUP);
    assert.equal(plan.writes[0].origin.sessionKeySource, `backfill:${BACKFILL_SOURCES.runMap}`);

    const opts = parseArgs(["--workspace", "main", "--workspace", "main", "--workspace", "heisenberg"], "/home/x");
    assert.deepEqual(opts.workspaces, ["main", "heisenberg"]);
    assert.equal(opts.apply, false, "dry run by default");
    assert.equal(opts.includeNonChat, false);
    assert.equal(opts.includeIndexOnly, false, "index-only writes are opt-in");
    assert.equal(opts.turnHash, true);
    assert.deepEqual([parseArgs(["--workspace", "main", "--no-turn-hash", "--include-index-only"]).turnHash, parseArgs(["--workspace", "main", "--include-index-only"]).includeIndexOnly], [false, true]);
    assert.equal(opts.sensitivity, true);
    assert.equal(opts.base, join("/home/x", ".openclaw", "memory", "lancedb-namespaced"));
    assert.equal(parseArgs(["--workspace", "main", "--apply", "--no-sensitivity", "--include-non-chat"]).sensitivity, false);
    assert.throws(() => parseArgs([]), /--workspace/);
    assert.throws(() => parseArgs(["--workspace", "../etc"]), /invalid workspace key/);
    assert.throws(() => parseArgs(["--workspace", "main", "--snapshot"]), /needs a value/);
    assert.throws(() => parseArgs(["--workspace", "main", "--rebuild-index"]), /unknown argument/);
  });
});

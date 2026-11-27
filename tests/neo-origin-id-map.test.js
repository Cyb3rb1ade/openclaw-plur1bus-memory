/**
 * tests/neo-origin-id-map.test.js — scripts/neo-origin-backfill.mjs --id-map:
 * session keys by Neo candidate id for journal candidates and index-only
 * entries, under the same ambiguity rule as the other sources.
 *
 * Temp dirs (makeTempDir), a real Neo store, a tiny node:sqlite host DB; no
 * LanceDB, no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { makeTempDir } from "./helpers/temp-dir.js";
import {
  candidateIndexEntry,
  createNeoStore,
  memoryCandidatesFromTurns,
  routeNeoRecall,
  searchNeoCandidatesGlobal,
  transitionRecordStatus,
  turnEventsFromMessages,
} from "../lib/neo-arch.js";
import {
  BACKFILL_SOURCES,
  ID_MAP_MAX_BYTES,
  parseArgs,
  planIndexOnlyBackfill,
  planNeoOriginBackfill,
  readIdMap,
  readJournalRecords,
  runNeoOriginBackfill,
  topicMergeTargets,
} from "../scripts/neo-origin-backfill.mjs";
import { classifySensitivityByRules } from "../lib/sensitivity.js";

const DIRECT = "agent:main:telegram:default:direct:55736530";
const DIRECT_THREAD = `${DIRECT}:thread:55736530:64373`;
const GROUP = "agent:main:telegram:group:-1003839640481";
const GROUP_A = `${GROUP}:topic:5778`;
const GROUP_B = `${GROUP}:topic:13`;
const HEARTBEAT = `${GROUP_A}:heartbeat`;
const MAIN = "agent:main:main";
const CRON = "agent:main:cron:job-1:run:run-cron";
const NOW = "2026-11-27T03:00:00.000Z";
const CREATED = "2026-08-01T10:00:00.000Z";
const V_INDEX = [0.5, -0.25, 0.75, 0.125];
const V_JOURNAL = [-0.5, 0.25, 0.125, 1];

const memId = (n) => `mem_${n.toString(16).padStart(20, "0")}`;
const J_MAP = memId(1);
const J_AGREE = memId(2);
const J_CLASH = memId(3);
const J_KEYED = memId(4);
const J_DEV = memId(5);
const J_PRUNED = memId(6);
const I_MAP = memId(7);
const I_NOAGENT = memId(8);
const UNKNOWN = memId(9);
const NONCHAT = memId(10);

function candidate(id, statement, runId, extra = {}) {
  const agentId = extra.agentId || "main";
  return {
    id,
    workspaceKey: "main",
    agentId,
    statement,
    normalizedStatement: statement.toLowerCase(),
    category: "project_fact",
    origin: {
      kind: "user_claim", role: "user", sourceTurnIds: [`turn-${id}`], capturedBy: "agent_end_capture",
      trustLevel: "user_asserted", confidence: 0.7, scope: "agent_private", workspaceKey: "main", agentId, sessionId: runId,
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

/** A captured candidate as before 7.20.10: turn id with the key, no key in origin, no sensitivity. */
function captured(sessionKey, text) {
  const turns = turnEventsFromMessages([{ role: "user", content: text }], { workspaceKey: "main", agentId: "main", sessionId: "run-gone", sessionKey });
  const [first] = memoryCandidatesFromTurns(turns);
  assert.ok(first, `fixture: "${text}" yields a candidate`);
  const { sensitivity: _s, sensitivitySource: _ss, ...old } = first;
  return old;
}

function bytes(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function newestById(path) {
  const latest = new Map();
  for (const record of readJournalRecords(path).records) if (record?.id) latest.set(record.id, record);
  return latest;
}

function tsv(rows, header = "id\tsessionKey\tmethod") {
  return `${[header, ...rows.map((row) => row.join("\t"))].join("\n")}\n`;
}

/** Neo store "main" with journal candidates, index-only entries and a host DB. */
async function fixture() {
  const root = makeTempDir("plur1bus-neo-idmap-");
  const home = join(root, "home");
  const base = join(root, "memory", "lancedb-namespaced");
  const agentsDir = join(root, "agents");
  mkdirSync(home, { recursive: true });
  const store = createNeoStore(join(base, "_neo"), "main");

  // Index-only entries: first in the journal (for the sidecar vector), then
  // the journal lines go, as the retention trim did before 7.19.3.
  const iMap = candidate(I_MAP, "Das Sommerfest der Gruppe findet am 12. Juli statt.", "run-gone-1");
  const iNoAgent = candidate(I_NOAGENT, "Der Zahnarzttermin ist am Dienstag um neun.", "run-gone-2");
  const hashClash = captured(GROUP_A, "Im Thema Planung steht der Grillabend am Freitag fest.");
  const hashTopic = captured(GROUP_A, "Im Thema Planung kommt der Kuchen von Eva.");
  const mapTopic = captured(GROUP, "In der Gruppe ist der Treffpunkt der Bahnhof.");
  store.appendCandidates([iMap, iNoAgent, hashClash, hashTopic, mapTopic]);
  store.appendEmbeddingQueue([iMap]);
  const drained = await store.drainEmbeddingQueue({ impact: "low", maxItems: 10, dimensions: 4, embedder: () => V_INDEX });
  assert.equal(drained.processed, 1, "fixture: one vector in the sidecar");
  const indexOnlyIds = new Set([I_MAP, I_NOAGENT, hashClash.id, hashTopic.id, mapTopic.id]);
  const kept = readFileSync(store.paths.candidates, "utf8").split("\n").filter((line) => line && !indexOnlyIds.has(JSON.parse(line).id));
  writeFileSync(store.paths.candidates, kept.length ? `${kept.join("\n")}\n` : "");
  // The index projection of a record with origin.agentId only has no agent.
  const { agentId: _agent, ...noAgentEntry } = candidateIndexEntry(iNoAgent);
  appendFileSync(store.paths.candidateIndex, `${JSON.stringify(noAgentEntry)}\n`);

  const journal = [
    candidate(J_MAP, "Christian bevorzugt Tee statt Kaffee am Morgen.", "run-none"),
    candidate(J_AGREE, "Der Wocheneinkauf ist immer am Samstag.", "run-direct"),
    candidate(J_CLASH, "Die Gruppe trifft sich im Dezember zum Wichteln.", "run-group"),
    candidate(J_KEYED, "Schon mit Schluessel erfasst.", "run-keyed", { origin: { ...candidate("x", "x", "run-keyed").origin, sessionKey: DIRECT }, sensitivity: "banal", sensitivitySource: "rules" }),
    candidate(J_DEV, "Der Build laeuft mit Node 24.", "run-dev", { agentId: "developer" }),
    candidate(J_PRUNED, "Diese Erinnerung wurde verworfen.", "run-pruned"),
  ];
  store.appendCandidates(journal);
  store.appendCandidates([transitionRecordStatus(journal[5], "pruned", { now: "2026-08-02T10:00:00.000Z" })]);
  store.appendEmbeddingQueue([journal[0]]);
  await store.drainEmbeddingQueue({ impact: "low", maxItems: 10, dimensions: 4, embedder: () => V_JOURNAL });

  mkdirSync(join(agentsDir, "main", "agent"), { recursive: true });
  const db = new DatabaseSync(join(agentsDir, "main", "agent", "openclaw-agent.sqlite"));
  db.exec(`
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL);
    CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL);
    CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, event_zstd BLOB, PRIMARY KEY (session_id, seq));
    INSERT INTO session_windows VALUES ('s-direct', '${DIRECT}'), ('s-group', '${GROUP_A}'), ('s-plain', '${GROUP}');
  `);
  const event = (runId) => JSON.stringify({ type: "message", message: { role: "user", content: "x", __openclaw: { runId } } });
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run("s-direct", 1, event("run-direct"), null);
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run("s-group", 1, event("run-group"), null);
  db.close();

  const map = join(root, "id-map.tsv");
  writeFileSync(map, tsv([
    [J_MAP, DIRECT, "A-verified:test-j1"],
    [J_AGREE, DIRECT, "A-verified:test-j2"],
    [J_CLASH, DIRECT, "B-hashbound:test-j3"],
    [J_KEYED, DIRECT, "A-verified:test-j4"],
    [J_DEV, DIRECT, "A-verified:test-j5"],
    [J_PRUNED, DIRECT, "A-verified:test-j6"],
    [I_MAP, GROUP_A, "A-verified:test-i1"],
    [I_NOAGENT, DIRECT, "B-hashbound:test-i2"],
    [hashClash.id, GROUP_B, "B-hashbound:test-i3"],
    [hashTopic.id, GROUP, "A-verified:test-i4"],
    [mapTopic.id, GROUP_A, "A-verified:test-i5"],
    [UNKNOWN, DIRECT, "A-verified:test-x"],
    [NONCHAT, MAIN, "A-verified:test-y"],
  ]));

  const opts = (extra = {}) => ({
    workspaces: ["main"], apply: false, base, agentsDir, stateDb: join(root, "state", "missing.sqlite"), snapshot: "",
    includeNonChat: false, includeIndexOnly: true, turnHash: true, sensitivity: true, runMap: "", idMap: map,
    legacyTrajectories: false, compactIndex: false, json: false, allowRunningGateway: false, ...extra,
  });
  const deps = { home, now: NOW, gatewayRunning: () => false };
  let snapshots = 0;
  const snapshot = () => {
    const snap = join(root, `snapshot-${++snapshots}`);
    const dir = join(snap, "_neo", "workspaces", basename(store.paths.workspaceDir));
    mkdirSync(dir, { recursive: true });
    for (const file of [store.paths.candidates, store.paths.candidateIndex]) writeFileSync(join(dir, basename(file)), readFileSync(file));
    return snap;
  };
  const apply = (extra = {}) => opts({ apply: true, snapshot: snapshot(), ...extra });
  const sizes = () => [bytes(store.paths.candidates), bytes(store.paths.candidateIndex)];
  const ids = { hashClash: hashClash.id, hashTopic: hashTopic.id, mapTopic: mapTopic.id };
  return { root, base, store, map, opts, deps, apply, sizes, ids };
}

describe("neo-origin-backfill --id-map", () => {
  it("1. readIdMap: header, CRLF, BOM, malformed rows, duplicates, conflicts, non-chat, size limit", () => {
    const root = makeTempDir("plur1bus-neo-idmap-parse-");
    const path = join(root, "map.tsv");
    const rows = [
      `\uFEFFsessionKey\tid\tmethod\r`,
      `${DIRECT}\t${memId(1)}\tA-verified:x\r`,
      "",
      `${DIRECT}\t${memId(1)}\tA-verified:again`,
      `${DIRECT}\t${memId(2)}\t`,
      `${GROUP}\t${memId(3)}\tB-hashbound:plain`,
      `${GROUP_A}\t${memId(3)}\tB-hashbound:topic`,
      `${GROUP_A}\t${memId(4)}\tm`,
      `${GROUP_B}\t${memId(4)}\tm`,
      `${GROUP_A}\t${memId(5)}\tm`,
      `${HEARTBEAT}\t${memId(5)}\tm`,
      `${DIRECT}\t${memId(6)}\tm`,
      `${DIRECT_THREAD}\t${memId(6)}\tm`,
      `${MAIN}\t${memId(7)}\tm`,
      `${CRON}\t${memId(8)}\tm`,
      `${DIRECT}\t${memId(9)}`,
      `${DIRECT}\tMEM_${"0".repeat(19)}a\tm`,
      `${DIRECT}\tmem_${"0".repeat(19)}\tm`,
      `${DIRECT}\t3f2b8c1e-1111-4222-8333-444455556666\tm`,
      `telegram:group:-1003839640481\t${memId(10)}\tm`,
      `agent:../x:telegram:group:-1\t${memId(11)}\tm`,
      `agent:main:telegram:group:\u0007x\t${memId(12)}\tm`,
      `${DIRECT}\t${memId(13)}\tm\textra`,
      `${DIRECT}`,
      `${DIRECT}\t${memId(14)}\t${"x".repeat(201)}`,
    ];
    writeFileSync(path, rows.join("\n"));
    const { entries, stats } = readIdMap(path);
    assert.deepEqual(
      { rows: stats.rows, malformed: stats.malformed, duplicates: stats.duplicates, conflicts: stats.conflicts, nonChat: stats.nonChat, accepted: stats.accepted },
      { rows: 23, malformed: 9, duplicates: 5, conflicts: 3, nonChat: 2, accepted: 4 },
    );
    assert.deepEqual(stats.conflictIds, [memId(4), memId(5), memId(6)], "two topics, topic vs. …:heartbeat, thread vs. none");
    assert.deepEqual(entries.get(memId(1)), { sessionKey: DIRECT, method: "A-verified:x", agentId: "main", kind: "direct" }, "first row's method, CRLF stripped");
    assert.equal(entries.get(memId(2)).method, "", "empty method is allowed");
    assert.equal(entries.get(memId(3)).sessionKey, GROUP_A, "topic vs. no topic: the topic key, no conflict");
    assert.equal(entries.get(memId(3)).method, "B-hashbound:topic");
    assert.equal(entries.get(memId(9)).method, "", "a missing trailing method cell is fine");
    assert.deepEqual(stats.byKind, { direct: 3, group: 1 });
    for (const id of [memId(7), memId(8)]) assert.equal(entries.has(id), false, "non-chat keys are never used");

    const noHeader = join(root, "no-header.tsv");
    writeFileSync(noHeader, `${memId(1)}\t${DIRECT}\n`);
    assert.throws(() => readIdMap(noHeader), /header "id<TAB>sessionKey/);
    const empty = join(root, "empty.tsv");
    writeFileSync(empty, "\n\r\n");
    assert.throws(() => readIdMap(empty), /is empty/);
    const dupHeader = join(root, "dup-header.tsv");
    writeFileSync(dupHeader, "id\tsessionKey\tid\n");
    assert.throws(() => readIdMap(dupHeader), /duplicate column/);
    assert.throws(() => readIdMap(path, { maxBytes: 100 }), /more than the limit of 100/);
    assert.equal(ID_MAP_MAX_BYTES, 8 * 1024 * 1024);
    assert.throws(() => readIdMap(join(root, "missing.tsv")), /ENOENT/);
    const twoCols = join(root, "two.tsv");
    writeFileSync(twoCols, `id\tsessionKey\n${memId(1)}\t${GROUP_A}\n${memId(2)}\t${GROUP_A}\tsurplus\n`);
    const two = readIdMap(twoCols);
    assert.deepEqual([two.stats.accepted, two.stats.malformed, two.entries.get(memId(1)).method], [1, 1, ""], "without a method column a third cell is malformed");
  });

  it("2. topic merge: no topic goes into the topic key; two topics, …:heartbeat and :thread: stay apart", () => {
    assert.deepEqual(Object.fromEntries(topicMergeTargets([GROUP, GROUP_A])), { [GROUP]: GROUP_A, [GROUP_A]: GROUP_A });
    assert.deepEqual(Object.fromEntries(topicMergeTargets([GROUP, GROUP_A, GROUP_B])), { [GROUP]: GROUP, [GROUP_A]: GROUP_A, [GROUP_B]: GROUP_B });
    assert.deepEqual(Object.fromEntries(topicMergeTargets([GROUP_A, HEARTBEAT])), { [GROUP_A]: GROUP_A, [HEARTBEAT]: HEARTBEAT });
    assert.deepEqual(Object.fromEntries(topicMergeTargets([DIRECT, DIRECT_THREAD])), { [DIRECT]: DIRECT, [DIRECT_THREAD]: DIRECT_THREAD });
    assert.deepEqual(Object.fromEntries(topicMergeTargets([DIRECT, `${DIRECT}:topic:1`])), { [DIRECT]: DIRECT, [`${DIRECT}:topic:1`]: `${DIRECT}:topic:1` }, "only groups and channels have topics");

    // In the plan: the source of the topic key names the revision.
    const records = [candidate(memId(1), "Eins.", "run-1"), candidate(memId(2), "Zwei.", "run-2"), candidate(memId(3), "Drei.", "run-3")];
    const idMap = new Map([
      [memId(1), { sessionKey: GROUP_A, method: "m1", agentId: "main", kind: "group" }],
      [memId(2), { sessionKey: GROUP, method: "m2", agentId: "main", kind: "group" }],
      [memId(3), { sessionKey: GROUP_B, method: "m3", agentId: "main", kind: "group" }],
    ]);
    const resolve = (runId) => ({
      "run-1": [{ sessionKey: GROUP, source: BACKFILL_SOURCES.transcriptEvents }],
      "run-2": [{ sessionKey: GROUP_A, source: BACKFILL_SOURCES.transcriptEvents }],
      "run-3": [{ sessionKey: GROUP_A, source: BACKFILL_SOURCES.transcriptEvents }],
    })[runId];
    const plan = planNeoOriginBackfill(records, resolve, { now: NOW, idMap, workspaceAgent: "main" });
    const byId = new Map(plan.writes.map((r) => [r.id, r.origin]));
    assert.deepEqual([byId.get(memId(1)).sessionKey, byId.get(memId(1)).sessionKeySource], [GROUP_A, "backfill:id-map"], "run id without topic + map with topic");
    assert.deepEqual([byId.get(memId(2)).sessionKey, byId.get(memId(2)).sessionKeySource], [GROUP_A, "backfill:transcript-events"], "map without topic + run id with topic");
    assert.equal(byId.has(memId(3)), false, "two different topics: ambiguous");
    assert.deepEqual(plan.ambiguousIds, [memId(3)]);
    assert.deepEqual([plan.stats.idMap.wouldWrite, plan.stats.idMap.confirmed, plan.stats.idMap.ambiguous], [2, 2, 1]);
    assert.deepEqual(plan.entries.map((e) => e.method), ["m1", "m2"]);
    // Same rule for the other sources among themselves.
    const noMap = planNeoOriginBackfill([records[0]], () => [
      { sessionKey: GROUP, source: BACKFILL_SOURCES.transcriptEvents }, { sessionKey: GROUP_A, source: BACKFILL_SOURCES.turnHash },
    ], { now: NOW });
    assert.deepEqual(
      [noMap.writes[0].origin.sessionKey, noMap.writes[0].origin.sessionKeySource, noMap.stats.turnHashOnly, noMap.stats.turnHashConfirmed],
      [GROUP_A, "backfill:turn-hash", 0, 1],
      "the turn hash names the topic key, the run id confirms the group",
    );
  });

  it("3. dry run: every case counted per workspace, 0 bytes written", async () => {
    const fx = await fixture();
    const before = [...fx.sizes(), bytes(fx.store.paths.vectorIndex)];
    const report = runNeoOriginBackfill(fx.opts(), fx.deps);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      { rows: report.sources.idMap.rows, accepted: report.sources.idMap.accepted, nonChat: report.sources.idMap.nonChat, malformed: report.sources.idMap.malformed },
      { rows: 13, accepted: 12, nonChat: 1, malformed: 0 },
    );
    const ws = report.workspaces[0];
    assert.equal(ws.workspaceAgent, "main");
    const m = ws.idMap;
    assert.deepEqual(
      { unknownId: m.unknownId, alreadyKeyed: m.alreadyKeyed, ineligible: m.ineligible, agentMismatch: m.agentMismatch, applicable: m.applicable, ambiguous: m.ambiguous, confirmed: m.confirmed },
      { unknownId: 1, alreadyKeyed: 1, ineligible: 1, agentMismatch: 1, applicable: 8, ambiguous: 2, confirmed: 3 },
    );
    assert.deepEqual(m.wouldWrite, { journal: 2, indexOnly: 4 });
    assert.deepEqual(m.byKind, { direct: 3, group: 3 });
    assert.equal(m.accepted, m.unknownId + m.alreadyKeyed + m.ineligible + m.agentMismatch + m.applicable, "every accepted row is accounted for");
    assert.equal(m.applicable, m.wouldWrite.journal + m.wouldWrite.indexOnly + m.ambiguous + m.inlineVectorNoSidecar + m.notWritten);
    assert.deepEqual(ws.ambiguousIds, [J_CLASH], "map vs. run id");
    assert.equal(ws.indexStats.ambiguous, 1, "map vs. turn hash");
    assert.equal(ws.indexStats.turnHashConflicts, 1);
    assert.deepEqual(ws.stats.writeBySource, { "id-map": 1, "transcript-events": 1 });
    assert.deepEqual(ws.indexStats.writeBySource, { "id-map": 3, "turn-hash": 1 });
    assert.deepEqual([...fx.sizes(), bytes(fx.store.paths.vectorIndex)], before);
    assert.equal(existsSync(join(fx.store.paths.workspaceDir, "archive")), false, "no audit report");
    assert.equal(existsSync(join(fx.base, "..", ".adaptive-learning", "destructive-ops.jsonl")), false, "a dry run logs nothing");
  });

  it("4. apply: journal revisions carry backfill:id-map, index-only lines the key and sensitivity, the report the method", async () => {
    const fx = await fixture();
    const linesBefore = readJournalRecords(fx.store.paths.candidates).lines;
    const before = newestById(fx.store.paths.candidates);
    const opts = fx.apply();
    const report = runNeoOriginBackfill(opts, fx.deps);
    assert.deepEqual(report.errors, []);
    const applied = report.workspaces[0].applied;
    assert.deepEqual([applied.written, applied.indexOnlyWritten], [2, 4]);
    assert.deepEqual(applied.idMap, { journal: 2, indexOnly: 4 });
    assert.equal(readJournalRecords(fx.store.paths.candidates).lines, linesBefore + 2, "index-only ids get no journal line");

    const after = newestById(fx.store.paths.candidates);
    assert.deepEqual([after.get(J_MAP).origin.sessionKey, after.get(J_MAP).origin.sessionKeySource], [DIRECT, "backfill:id-map"]);
    assert.equal(after.get(J_MAP).origin.sessionKeyBackfilledAt, NOW);
    assert.equal(after.get(J_MAP).createdAt, before.get(J_MAP).createdAt);
    assert.equal(after.get(J_AGREE).origin.sessionKeySource, "backfill:transcript-events", "the run id names an agreeing key");
    for (const id of [J_CLASH, J_KEYED, J_DEV, J_PRUNED]) assert.deepEqual(after.get(id), before.get(id), `${id} untouched`);

    const index = fx.store.readCandidateIndex().entries;
    const keys = { [I_MAP]: GROUP_A, [I_NOAGENT]: DIRECT, [fx.ids.hashTopic]: GROUP_A, [fx.ids.mapTopic]: GROUP_A };
    for (const [id, key] of Object.entries(keys)) {
      const entry = index.get(id);
      assert.equal(entry.origin.sessionKey, key, id);
      assert.equal(entry.sensitivity, classifySensitivityByRules(entry.statement).sensitivity);
      assert.equal(entry.sensitivitySource, "rules");
      assert.equal(entry.origin.sessionKeySource, undefined, "the index projection drops sessionKeySource");
    }
    assert.equal(index.get(fx.ids.hashClash).origin.sessionKey, undefined, "map vs. turn hash: untouched");

    const log = readFileSync(join(fx.base, "..", ".adaptive-learning", "destructive-ops.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual([log[0].phase, log[0].idMap, log[0].idMapPlanned], ["started", fx.map, { journal: 2, indexOnly: 4 }]);
    assert.deepEqual([log[1].phase, log[1].idMapWritten], ["committed", { journal: 2, indexOnly: 4 }]);
    const text = readFileSync(join(fx.store.paths.workspaceDir, "archive", applied.report), "utf8");
    assert.equal(/Sommerfest|Zahnarzt|Tee statt Kaffee/.test(text), false, "no statement text in the report");
    const lines = new Map(text.trim().split("\n").map((line) => JSON.parse(line)).map((line) => [line.id, line]));
    assert.deepEqual(lines.get(J_MAP), { id: J_MAP, sessionKey: DIRECT, source: "id-map", kind: "direct", method: "A-verified:test-j1", target: "journal" });
    assert.deepEqual(lines.get(J_AGREE), { id: J_AGREE, sessionKey: DIRECT, source: "transcript-events", kind: "direct", method: "A-verified:test-j2", target: "journal" });
    assert.deepEqual(lines.get(I_NOAGENT), { id: I_NOAGENT, sessionKey: DIRECT, source: "id-map", kind: "direct", method: "B-hashbound:test-i2", target: "index-only" });
    assert.deepEqual([lines.get(fx.ids.hashTopic).source, lines.get(fx.ids.hashTopic).method], ["turn-hash", "A-verified:test-i4"]);
    assert.equal(lines.size, 6);
  });

  it("5. the vectors still attach; global search and routeNeoRecall return the keyed entries", async () => {
    const fx = await fixture();
    runNeoOriginBackfill(fx.apply(), fx.deps);
    assert.deepEqual(fx.store.readVector(I_MAP), V_INDEX);
    assert.deepEqual(fx.store.readVector(J_MAP), V_JOURNAL);
    const requester = { requesterAgentId: "main", requesterWorkspaceKey: "main" };
    const global = searchNeoCandidatesGlobal(fx.store, { queryVector: V_INDEX, requester, now: Date.parse(NOW) });
    const hit = global.hits.find((row) => row.item.id === I_MAP);
    assert.ok(hit, "index-only entry found by its own vector");
    assert.equal(hit.item.origin.sessionKey, GROUP_A);
    assert.ok(hit.item.sensitivity);
    const lanes = routeNeoRecall(fx.store.readCandidates(500), "Tee statt Kaffee am Morgen", { ...requester, queryVector: V_JOURNAL, maxPerLane: 10 });
    const routed = Object.values(lanes).flat().find((row) => row.item.id === J_MAP);
    assert.ok(routed, "journal entry routed");
    assert.equal(routed.item.origin.sessionKey, DIRECT);
  });

  it("6. a second apply writes nothing; keyed entries count as already keyed", async () => {
    const fx = await fixture();
    runNeoOriginBackfill(fx.apply(), fx.deps);
    const sizes = fx.sizes();
    const second = runNeoOriginBackfill(fx.apply(), fx.deps);
    assert.deepEqual(second.errors, []);
    const m = second.workspaces[0].idMap;
    assert.deepEqual([m.wouldWrite.journal, m.wouldWrite.indexOnly, m.alreadyKeyed, m.keyDiffers, m.ambiguous], [0, 0, 7, 0, 2]);
    assert.equal(second.workspaces[0].applied, undefined);
    assert.deepEqual(fx.sizes(), sizes);
  });

  it("7. index-only rows without --include-index-only: dry run notes it, --apply refuses and writes 0 bytes", async () => {
    const fx = await fixture();
    const sizes = fx.sizes();
    const dry = runNeoOriginBackfill(fx.opts({ includeIndexOnly: false }), fx.deps);
    assert.deepEqual(dry.errors, []);
    assert.equal(dry.workspaces[0].idMap.indexOnlyNeedsFlag, 4);
    const refused = runNeoOriginBackfill(fx.apply({ includeIndexOnly: false }), fx.deps);
    assert.equal(refused.errors.length, 1);
    assert.match(refused.errors[0], /--include-index-only/);
    assert.match(refused.errors[0], /4 in main/);
    assert.equal(refused.workspaces[0].applied, undefined);
    assert.deepEqual(fx.sizes(), sizes, "not even the journal rows");
    assert.equal(existsSync(join(fx.base, "..", ".adaptive-learning", "destructive-ops.jsonl")), false);
    // A map with journal rows only applies without the flag.
    const journalOnly = join(fx.root, "journal-only.tsv");
    writeFileSync(journalOnly, tsv([[J_MAP, DIRECT, "A-verified:only"]]));
    const ok = runNeoOriginBackfill(fx.apply({ includeIndexOnly: false, idMap: journalOnly }), fx.deps);
    assert.deepEqual(ok.errors, []);
    assert.deepEqual([ok.workspaces[0].applied.written, ok.workspaces[0].applied.indexOnlyWritten], [3, 0], "J_MAP by the map; J_AGREE and J_CLASH (no map row now) by their run ids");
    assert.deepEqual(ok.workspaces[0].applied.idMap, { journal: 1, indexOnly: 0 });
    assert.equal(newestById(fx.store.paths.candidates).get(J_MAP).origin.sessionKeySource, "backfill:id-map");
  });

  it("8. agent gate: entry agent, workspace agent for entries without one, none when it cannot be told", () => {
    const entry = (id, agentId) => {
      const projected = candidateIndexEntry(candidate(id, "Ein Satz.", "run-x", agentId ? { agentId } : {}));
      if (!agentId) delete projected.agentId;
      return projected;
    };
    const index = new Map([[memId(1), entry(memId(1), "main")], [memId(2), entry(memId(2), "")], [memId(3), entry(memId(3), "developer")]]);
    const idMap = new Map([1, 2, 3].map((n) => [memId(n), { sessionKey: DIRECT, method: "", agentId: "main", kind: "direct" }]));
    const withAgent = planIndexOnlyBackfill(index, new Set(), () => [], { now: NOW, idMap, workspaceAgent: "main" });
    assert.deepEqual(withAgent.entries.map((e) => e.id), [memId(1), memId(2)]);
    assert.deepEqual([withAgent.stats.idMap.agentMismatch, withAgent.stats.idMap.noAgent], [1, 0]);
    const unknownAgent = planIndexOnlyBackfill(index, new Set(), () => [], { now: NOW, idMap, workspaceAgent: "" });
    assert.deepEqual(unknownAgent.entries.map((e) => e.id), [memId(1)]);
    assert.deepEqual([unknownAgent.stats.idMap.agentMismatch, unknownAgent.stats.idMap.noAgent], [2, 1]);
    const otherAgentKey = new Map([[memId(1), { sessionKey: "agent:bernhardine:telegram:default:direct:1211667028", method: "", agentId: "bernhardine", kind: "direct" }]]);
    const mismatch = planIndexOnlyBackfill(index, new Set(), () => [], { now: NOW, idMap: otherAgentKey, workspaceAgent: "main" });
    assert.deepEqual([mismatch.writes.length, mismatch.stats.idMap.agentMismatch], [0, 1]);
    // Without an id map the plans carry no idMap block (report unchanged).
    assert.equal(planIndexOnlyBackfill(index, new Set(), () => [], { now: NOW }).stats.idMap, undefined);
  });

  it("9. parseArgs takes --id-map; a broken map stops the run before anything is read", async () => {
    assert.equal(parseArgs(["--workspace", "main"], "/home/x").idMap, "");
    const opts = parseArgs(["--workspace", "main", "--id-map", "map.tsv"], "/home/x");
    assert.equal(basename(opts.idMap), "map.tsv");
    assert.ok(opts.idMap.length > "map.tsv".length, "resolved to an absolute path");
    assert.throws(() => parseArgs(["--workspace", "main", "--id-map"]), /needs a value/);
    const fx = await fixture();
    const broken = join(fx.root, "broken.tsv");
    writeFileSync(broken, `${J_MAP}\t${DIRECT}\n`);
    const sizes = fx.sizes();
    assert.throws(() => runNeoOriginBackfill(fx.apply({ idMap: broken }), fx.deps), /header/);
    assert.deepEqual(fx.sizes(), sizes);
    assert.equal(readdirSync(fx.store.paths.workspaceDir).includes("archive"), false);
  });
});

#!/usr/bin/env node
/**
 * scripts/neo-origin-backfill.mjs — origin.sessionKey for old Neo candidates
 * (7.21.5).
 *
 * Neo candidates from before 7.20.10 carry only origin.sessionId. That is the
 * host RUN id (message.__openclaw.runId), not the session key, and it changes
 * with every turn. Without a key the recall treats such a row as "dm"
 * (lib/recall-context.js): a group memory then counts as the owner's direct
 * chat. This script looks the run ids up in the host databases (read-only)
 * and appends one revision per id that adds origin.sessionKey and, if
 * missing, the rules sensitivity (lib/sensitivity.js, as at capture).
 * createdAt/updatedAt, status and the embedding fields stay verbatim; the
 * vector stays in the sidecar (it is keyed by id). No model, no network.
 *
 * A second, exact source is the Neo turn id itself: since 7.12.19 it is
 * stableId("turn", workspaceKey, agentId, sessionKey, role, statement,
 * toolCallIds, ordinal), so hashing sourceTurnIds[0] against the agent's
 * known session keys names the key. It confirms the run-id answer (a
 * different key makes the id ambiguous) and resolves records the run ids
 * cannot.
 *
 *   node scripts/neo-origin-backfill.mjs --workspace main --workspace bernhardine --workspace heisenberg
 *   node scripts/neo-origin-backfill.mjs --workspace main --apply --snapshot ~/.openclaw/.snapshots/plur1bus-YYYYMMDD-HHMMSS
 *
 * Options:
 *   --workspace <key>        repeatable, required; the Neo store key (main,
 *                            bernhardine, heisenberg), not the directory name
 *   --dry-run                default: read and count, write nothing
 *   --apply                  write; needs the gateway stopped and --snapshot
 *   --snapshot <dir>         snapshot taken with the gateway stopped
 *                            (scripts/backup-snapshot.sh, or a copy of the
 *                            lancedb-namespaced dir); it must hold each
 *                            workspace's memory-candidates.jsonl and
 *                            candidate-index.jsonl at the live sizes
 *   --base <dir>             default ~/.openclaw/memory/lancedb-namespaced
 *   --agents-dir <dir>       default ~/.openclaw/agents
 *   --state-db <file>        default ~/.openclaw/state/openclaw.sqlite
 *   --include-non-chat       also write keys that are no chat (agent:X:main,
 *                            cron, subagent, ios-…); default off, such keys
 *                            count as "unknown" in the recall weighting
 *   --include-index-only     also key candidate-index entries whose journal
 *                            lines were trimmed long ago (index line only,
 *                            resolved by the turn id); default off, the dry
 *                            run reports them
 *   --no-turn-hash           do not use the turn-id hash (run ids only)
 *   --no-sensitivity         do not add the rules sensitivity
 *   --run-map <tsv>          extra pairs "runId<TAB>sessionKey"
 *   --legacy-trajectories    also read agents/<id>/sessions and
 *                            session-sqlite-import-archive *.trajectory.jsonl
 *                            (several GB; run under a memory cap)
 *   --compact-index          compact candidate-index.jsonl after the write
 *                            (default: the daily consolidation does it; without
 *                            it a rollback can truncate both files exactly)
 *   --json                   JSON report on stdout
 *   --allow-running-gateway  only for copies outside ~/.openclaw
 *
 * Only chat keys are written by default (chatContextFromSessionKey kind
 * direct, group or channel). Skipped: ids whose newest revision already has a
 * key, status pruned/tombstoned/demoted, records without origin, run ids
 * without a key, ids with more than one key (ambiguous), and records whose
 * vector exists only inline (run scripts/migrate-neo-vectors-sidecar.mjs
 * first). A second run writes nothing, except index lines a broken earlier
 * run left out (index repair).
 *
 * Rollback: restore the snapshot (scripts/restore-snapshot.sh). While the
 * gateway is still stopped after the apply, truncating is exact as well:
 * memory-candidates.jsonl and candidate-index.jsonl back to journalBytesBefore
 * and indexBytesBefore of the "started" entry in destructive-ops.jsonl (only
 * without --compact-index). If that entry says indexExistedBefore: false,
 * delete candidate-index.jsonl instead; the next append rebuilds it, an empty
 * file would stay empty. Once the gateway has written again, only the
 * snapshot is exact. Never rebuild the candidate index from the journal for a
 * rollback: the index holds ids the journal no longer has.
 */

import { execFileSync } from "node:child_process";
import { hash as cryptoHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { createNeoStore, neoRevisionTimeMs } from "../lib/neo-arch.js";
import { normalizeMemorySessionKey } from "../lib/query-echo.js";
import { chatContextFromSessionKey } from "../lib/recall-context.js";
import { classifySensitivityByRules, normalizeSensitivity } from "../lib/sensitivity.js";
import { appendDestructiveOpLog, resolveInside, safeAgentId } from "../lib/sql-safety.js";

/** Values of origin.sessionKeySource (prefixed with "backfill:"), in resolution order. */
export const BACKFILL_SOURCES = Object.freeze({
  sessionId: "session-id",
  transcriptEvents: "transcript-events",
  trajectoryRuntime: "trajectory-runtime",
  transcriptArchive: "transcript-archive",
  runTables: "run-tables",
  stateEvents: "state-events",
  runMap: "run-map",
  legacyTrajectory: "legacy-trajectory",
  neoSibling: "neo-sibling",
  turnHash: "turn-hash",
});

const SKIP_STATUSES = new Set(["pruned", "tombstoned", "demoted"]);
// wie NEO_GLOBAL_SEARCH_STATUSES in lib/neo-arch.js (globale Suche, Index)
const GLOBAL_SEARCH_STATUSES = new Set(["candidate", "active", "promoted"]);
const TURN_ID_RE = /^turn_[0-9a-f]{20}$/;
// Ordnungszahl gleicher Nachrichten im Verlauf (turnEventsFromMessages)
const TURN_HASH_MAX_ORDINAL = 2;
const INTERPRETER_RE = /^(node|nodejs|bun|deno)[0-9.]*$/;
const WORKSPACE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const TRAJECTORY_HEADER_BYTES = 1500;
const TRAJ_KEY_RE = /"sessionKey"\s*:\s*"([^"]{1,512})"/;
const TRAJ_RUN_RE = /"runId"\s*:\s*"([^"]{1,128})"/;
const TRAJ_SID_RE = /"sessionId"\s*:\s*"([^"]{1,128})"/;

function describe(error) {
  return String(error?.message || error);
}

function warn(message) {
  process.stderr.write(`neo-origin-backfill: ${message}\n`);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function originOf(record) {
  const origin = record?.origin;
  return origin && typeof origin === "object" && !Array.isArray(origin) ? origin : null;
}

function recordAgentId(record) {
  return String(originOf(record)?.agentId || record?.agentId || "");
}

function increment(counter, key, by = 1) {
  counter[key] = (counter[key] || 0) + by;
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI and the --apply guard
// ---------------------------------------------------------------------------

/**
 * Parse the command line.
 * @param {string[]} argv arguments after the script name
 * @param {string} [home] home directory for the defaults
 * @returns {object} options
 */
export function parseArgs(argv, home = homedir()) {
  const opts = {
    workspaces: [],
    apply: false,
    base: join(home, ".openclaw", "memory", "lancedb-namespaced"),
    agentsDir: join(home, ".openclaw", "agents"),
    stateDb: join(home, ".openclaw", "state", "openclaw.sqlite"),
    snapshot: "",
    includeNonChat: false,
    includeIndexOnly: false,
    turnHash: true,
    sensitivity: true,
    runMap: "",
    legacyTrajectories: false,
    compactIndex: false,
    json: false,
    allowRunningGateway: false,
  };
  const value = (index, flag) => {
    const v = argv[index];
    if (typeof v !== "string" || v === "" || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") {
      const key = value(++i, a);
      if (!WORKSPACE_KEY_RE.test(key)) throw new Error(`invalid workspace key: ${JSON.stringify(key).slice(0, 80)}`);
      if (!opts.workspaces.includes(key)) opts.workspaces.push(key);
    } else if (a === "--apply") opts.apply = true;
    else if (a === "--dry-run") opts.apply = false;
    else if (a === "--base") opts.base = resolve(value(++i, a));
    else if (a === "--agents-dir") opts.agentsDir = resolve(value(++i, a));
    else if (a === "--state-db") opts.stateDb = resolve(value(++i, a));
    else if (a === "--snapshot") opts.snapshot = resolve(value(++i, a));
    else if (a === "--include-non-chat") opts.includeNonChat = true;
    else if (a === "--include-index-only") opts.includeIndexOnly = true;
    else if (a === "--no-turn-hash") opts.turnHash = false;
    else if (a === "--no-sensitivity") opts.sensitivity = false;
    else if (a === "--run-map") opts.runMap = resolve(value(++i, a));
    else if (a === "--legacy-trajectories") opts.legacyTrajectories = true;
    else if (a === "--compact-index") opts.compactIndex = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--allow-running-gateway") opts.allowRunningGateway = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.workspaces.length === 0) throw new Error("--workspace <key> is required");
  return opts;
}

// A path that does not exist yet resolves through its nearest existing
// ancestor, so both sides of isInsideDir see the same symlinks (macOS:
// /var -> /private/var).
function realOrResolved(path) {
  const abs = resolve(path);
  const rest = [];
  let current = abs;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return abs;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `child` lies inside `parent` (both resolved through symlinks).
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInsideDir(parent, child) {
  const rel = relative(realOrResolved(parent), realOrResolved(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Whether one command line is the gateway or an embedded `openclaw agent`
 * run: the process title openclaw-gateway, an openclaw executable, or a
 * node/bun/deno interpreter running an openclaw script, each followed by the
 * argument "gateway" or "agent". Viewers such as
 * `journalctl --user -u openclaw-gateway` do not count.
 * @param {string[]} args /proc/<pid>/cmdline split at NUL
 * @returns {boolean}
 */
export function isGatewayProcessArgs(args) {
  let list = (Array.isArray(args) ? args : []).map((part) => String(part)).filter(Boolean);
  // Ein gesetzter Prozesstitel steht als ein Argument mit Leerzeichen da.
  if (list.length === 1) list = list[0].trim().split(/\s+/);
  if (list.length === 0) return false;
  const exe = basename(list[0]);
  if (exe === "openclaw-gateway") return true;
  const role = list.findIndex((part, i) => i > 0 && (part === "gateway" || part === "agent"));
  if (role < 0) return false;
  if (/openclaw/i.test(exe)) return true;
  return INTERPRETER_RE.test(exe) && list.slice(1, role).some((part) => /openclaw/i.test(part));
}

function describeCommand(args) {
  return args.slice(0, 4).map((part) => (part.length > 80 ? `${part.slice(0, 77)}...` : part)).join(" ");
}

/**
 * One line for a refusal: systemd state and the matched processes.
 * @param {boolean|{systemd?: string, processes?: Array<string|{pid: string, command: string}>, unreadable?: number}} gateway
 * @returns {string}
 */
export function describeGateway(gateway) {
  if (typeof gateway === "boolean") return gateway ? "running" : "stopped";
  const parts = [`systemd openclaw-gateway: ${gateway?.systemd || "unknown"}`];
  for (const proc of (gateway?.processes || []).slice(0, 5)) {
    parts.push(typeof proc === "object" ? `pid ${proc.pid}: ${proc.command}` : `pid ${proc}`);
  }
  if (gateway?.unreadable < 0) parts.push("process list unreadable");
  return parts.join("; ");
}

function gatewayIsRunning(gateway) {
  return typeof gateway === "boolean" ? gateway : gateway?.running !== false;
}

/**
 * Whether the gateway (or an embedded `openclaw agent` run) is up: systemd
 * user unit openclaw-gateway, plus every process isGatewayProcessArgs
 * accepts. An unreadable process list counts as running (fail-safe).
 * @returns {{running: boolean, systemd: string, processes: Array<{pid: string, command: string}>, unreadable: number}}
 */
export function detectGatewayRunning() {
  let systemd = "unknown";
  try {
    systemd = execFileSync("systemctl", ["--user", "is-active", "openclaw-gateway"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    // is-active exits non-zero for inactive/failed; the state is on stdout.
    systemd = String(error?.stdout || "").trim() || "unknown";
  }
  const processes = [];
  let unreadable = 0;
  let names;
  try {
    names = readdirSync("/proc");
  } catch (error) {
    warn(`process list unreadable (${describe(error)}); treating the gateway as running`);
    return { running: true, systemd, processes, unreadable: -1 };
  }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let args;
    try {
      args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch (error) {
      // ENOENT/ESRCH: the process ended between readdir and read.
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") unreadable++;
      continue;
    }
    if (isGatewayProcessArgs(args)) processes.push({ pid: name, command: describeCommand(args) });
  }
  const running = ["active", "activating", "reloading", "deactivating"].includes(systemd) || processes.length > 0;
  return { running, systemd, processes, unreadable };
}

function refuseRunningGateway(gateway) {
  throw new Error(`gateway is running (${describeGateway(gateway)}); stop it before --apply`);
}

/**
 * Preconditions of --apply: gateway stopped (or a copy outside ~/.openclaw
 * with --allow-running-gateway) and an existing snapshot directory. Whether
 * the snapshot holds each workspace is checked by checkSnapshotCovers once
 * the journal is read.
 * @param {{base: string, snapshot?: string, allowRunningGateway?: boolean}} opts
 * @param {{gatewayRunning?: () => (boolean|{running: boolean}), home?: string}} [deps]
 * @returns {{outsideOpenclaw: boolean, gateway: object|boolean}}
 */
export function checkApplyPreconditions(opts, deps = {}) {
  const home = deps.home || homedir();
  const outsideOpenclaw = !isInsideDir(join(home, ".openclaw"), opts.base);
  if (opts.allowRunningGateway && !outsideOpenclaw) {
    throw new Error("--allow-running-gateway is only allowed for a copy outside ~/.openclaw");
  }
  const gateway = (deps.gatewayRunning || detectGatewayRunning)();
  if (gatewayIsRunning(gateway) && !opts.allowRunningGateway) refuseRunningGateway(gateway);
  let snapshotOk = false;
  try {
    snapshotOk = Boolean(opts.snapshot) && statSync(opts.snapshot).isDirectory();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!snapshotOk) throw new Error("--apply needs --snapshot <existing snapshot dir> (scripts/backup-snapshot.sh)");
  return { outsideOpenclaw, gateway };
}

const SNAPSHOT_LAYOUTS = Object.freeze([
  ["memory", "lancedb-namespaced", "_neo", "workspaces"], // scripts/backup-snapshot.sh
  ["_neo", "workspaces"], // cp -r lancedb-namespaced <snapshot>
]);

/**
 * Check that the snapshot holds this workspace's journal (and the candidate
 * index, if there is one) at the sizes just read: a copy, not the live file
 * or a hard link to it, taken with the gateway stopped.
 * @param {string} snapshot snapshot directory
 * @param {{dir: string, candidates: string, candidateIndex: string, journalBytes: number, indexBytes: number, indexExists: boolean}} live
 * @returns {string} the workspace directory inside the snapshot
 */
export function checkSnapshotCovers(snapshot, live) {
  let snapDir = "";
  for (const layout of SNAPSHOT_LAYOUTS) {
    const dir = resolveInside(snapshot, ...layout, live.dir);
    if (existsSync(join(dir, "memory-candidates.jsonl"))) { snapDir = dir; break; }
  }
  if (!snapDir) throw new Error(`snapshot ${snapshot} holds no ${live.dir}/memory-candidates.jsonl; take one with scripts/backup-snapshot.sh`);
  const files = [["memory-candidates.jsonl", live.candidates, live.journalBytes]];
  if (live.indexExists) files.push(["candidate-index.jsonl", live.candidateIndex, live.indexBytes]);
  for (const [name, livePath, bytes] of files) {
    const copyPath = resolveInside(snapDir, name);
    let copy;
    try {
      copy = statSync(copyPath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`snapshot ${snapshot} holds no ${live.dir}/${name}`);
      throw error;
    }
    const current = statSync(livePath);
    if (copy.dev === current.dev && copy.ino === current.ino) {
      throw new Error(`snapshot ${live.dir}/${name} is the live file (or a hard link to it); --snapshot must be a copy`);
    }
    if (copy.size !== bytes) {
      throw new Error(`snapshot ${live.dir}/${name} has ${copy.size} bytes, the live file ${bytes}; take a fresh snapshot with the gateway stopped`);
    }
  }
  return snapDir;
}

// ---------------------------------------------------------------------------
// Host databases (read-only)
// ---------------------------------------------------------------------------

/**
 * Open a host SQLite DB without writing to it. With a -wal/-shm present (the
 * gateway runs or did not checkpoint) a normal read-only connection is needed
 * to see the WAL; without them the immutable URI reads the file as it is and
 * creates no -wal/-shm next to it.
 * @param {string} path
 * @returns {DatabaseSync}
 */
export function openReadOnlyDatabase(path) {
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) {
    return new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  }
  const url = pathToFileURL(path);
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url, { readOnly: true });
}

const AGENT_DB_TABLES = Object.freeze([
  "session_windows", "session_nodes", "session_transcript_archives", "session_pending_inputs",
  "session_input_completions", "transcript_events", "trajectory_runtime_events", "message_tool_run_outcomes",
]);
const STATE_DB_TABLES = Object.freeze(["audit_events", "session_state_events"]);

// Nur die gelesenen Tabellen: PRAGMA table_info auf einer virtuellen Tabelle
// (sqlite-vec, Modul vec0) scheitert ohne das Modul.
function tableColumns(db, names) {
  const tables = new Map();
  const exists = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'");
  for (const name of names) {
    if (!exists.get(name)) continue;
    tables.set(name, new Set(db.prepare(`PRAGMA table_info("${name}")`).all().map((column) => String(column.name))));
  }
  return tables;
}

function hasColumns(tables, table, columns) {
  const have = tables.get(table);
  return Boolean(have) && columns.every((column) => have.has(column));
}

function blobText(blob, encoding, stats) {
  try {
    const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    return encoding === "zstd" ? zstdDecompressSync(buf).toString("utf8") : buf.toString("utf8");
  } catch (error) {
    stats.failedBlobs++;
    if (stats.failedBlobs <= 3) warn(`cannot decode a ${encoding} blob: ${describe(error)}`);
    return "";
  }
}

/**
 * Run ids in a JSON or JSONL text: message.__openclaw.runId of every event
 * (an object, an array of events, or {events: [...]}).
 * @param {string} text
 * @returns {Set<string>}
 */
export function runIdsFromEventText(text) {
  const runs = new Set();
  if (!text || !text.includes("__openclaw")) return runs;
  for (const line of text.split("\n")) {
    if (!line.includes("__openclaw")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // Not every archive line is JSON (or the whole text is one document).
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    const events = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : [parsed];
    for (const event of events) {
      const runId = event?.message?.__openclaw?.runId;
      if (typeof runId === "string" && runId) runs.add(runId);
    }
  }
  return runs;
}

/**
 * Read run id → session key pairs from one agent DB and/or the state DB.
 * Agent DB, in this order: run id that is itself a session id (session_nodes,
 * session_windows, transcript archives, pending inputs, input completions),
 * transcript_events (message.__openclaw.runId, JSON and zstd rows) via
 * session_windows/session_nodes, trajectory_runtime_events, the archive
 * blobs, message_tool_run_outcomes/session_pending_inputs/
 * session_input_completions. State DB: audit_events, session_state_events.
 * Missing tables are skipped. Opens read-only.
 * @param {{agentDb?: string, stateDb?: string, wanted?: Set<string>|null}} args
 *   `wanted` keeps only these run ids (memory)
 * @returns {{runs: Map<string, Array<{sessionKey: string, source: string}>>, stats: object}}
 */
export function buildRunKeyMap({ agentDb = "", stateDb = "", wanted = null } = {}) {
  const want = wanted instanceof Set ? wanted : null;
  const runs = new Map();
  const stats = { pairs: 0, bySource: {}, missingTables: [], failedBlobs: 0 };
  const add = (run, key, source) => {
    const runId = nonEmptyString(run);
    const sessionKey = normalizeMemorySessionKey(key);
    if (!runId || !sessionKey || (want && !want.has(runId))) return;
    let list = runs.get(runId);
    if (!list) runs.set(runId, (list = []));
    if (list.some((hit) => hit.sessionKey === sessionKey && hit.source === source)) return;
    list.push({ sessionKey, source });
    stats.pairs++;
    increment(stats.bySource, source);
  };
  if (agentDb) readAgentDb(agentDb, add, stats);
  if (stateDb) readStateDb(stateDb, add, stats);
  return { runs, stats };
}

function readAgentDb(path, add, stats) {
  const db = openReadOnlyDatabase(path);
  try {
    const tables = tableColumns(db, AGENT_DB_TABLES);
    const need = (table, columns) => {
      if (hasColumns(tables, table, columns)) return true;
      stats.missingTables.push(table);
      return false;
    };
    const rows = (sql) => db.prepare(sql).iterate();
    // session id → key (windows first, as the host joins them)
    const keyBySession = new Map();
    const hasWindows = need("session_windows", ["session_id", "session_key"]);
    const hasNodes = need("session_nodes", ["current_session_id", "session_key"]);
    if (hasWindows) for (const row of rows("SELECT session_id AS sid, session_key AS key FROM session_windows")) if (row.sid && row.key) keyBySession.set(String(row.sid), String(row.key));
    if (hasNodes) for (const row of rows("SELECT current_session_id AS sid, session_key AS key FROM session_nodes")) if (row.sid && row.key && !keyBySession.has(String(row.sid))) keyBySession.set(String(row.sid), String(row.key));
    const hasArchives = need("session_transcript_archives", ["session_id", "session_key", "encoding", "archive_blob"]);
    const hasPending = need("session_pending_inputs", ["session_id", "session_key", "run_id"]);
    const hasCompletions = need("session_input_completions", ["session_id", "session_key", "run_id"]);

    // R0: the run id is itself a session id (old cron runs: runId == sessionId).
    const S0 = BACKFILL_SOURCES.sessionId;
    if (hasNodes) for (const row of rows("SELECT current_session_id AS sid, session_key AS key FROM session_nodes")) add(row.sid, row.key, S0);
    if (hasWindows) for (const row of rows("SELECT session_id AS sid, session_key AS key FROM session_windows")) add(row.sid, row.key, S0);
    if (hasArchives) for (const row of rows("SELECT DISTINCT session_id AS sid, session_key AS key FROM session_transcript_archives")) add(row.sid, row.key, S0);
    if (hasPending) for (const row of rows("SELECT DISTINCT session_id AS sid, session_key AS key FROM session_pending_inputs")) add(row.sid, row.key, S0);
    if (hasCompletions) for (const row of rows("SELECT DISTINCT session_id AS sid, session_key AS key FROM session_input_completions")) add(row.sid, row.key, S0);

    // R1: transcript_events message.__openclaw.runId → session key.
    const S1 = BACKFILL_SOURCES.transcriptEvents;
    if (need("transcript_events", ["session_id", "event_json"])) {
      const sql = "SELECT sid, run FROM (SELECT session_id AS sid, CASE WHEN json_valid(event_json) THEN json_extract(event_json, '$.message.__openclaw.runId') END AS run FROM transcript_events WHERE event_json IS NOT NULL AND instr(event_json, '__openclaw') > 0) WHERE run IS NOT NULL GROUP BY sid, run";
      for (const row of rows(sql)) if (typeof row.run === "string") add(row.run, keyBySession.get(String(row.sid)), S1);
      if (tables.get("transcript_events").has("event_zstd")) {
        for (const row of rows("SELECT session_id AS sid, event_zstd AS blob FROM transcript_events WHERE event_zstd IS NOT NULL")) {
          const key = keyBySession.get(String(row.sid));
          if (!key) continue;
          for (const run of runIdsFromEventText(blobText(row.blob, "zstd", stats))) add(run, key, S1);
        }
      }
    }

    // R2: trajectory_runtime_events.
    if (need("trajectory_runtime_events", ["session_id", "run_id"])) {
      for (const row of rows("SELECT DISTINCT session_id AS sid, run_id AS run FROM trajectory_runtime_events WHERE run_id IS NOT NULL AND run_id <> ''")) {
        add(row.run, keyBySession.get(String(row.sid)), BACKFILL_SOURCES.trajectoryRuntime);
      }
    }

    // R3: archived transcripts (zstd JSONL) → the archive row's key.
    if (hasArchives) {
      for (const row of rows("SELECT session_key AS key, encoding, archive_blob AS blob FROM session_transcript_archives")) {
        for (const run of runIdsFromEventText(blobText(row.blob, String(row.encoding), stats))) add(run, row.key, BACKFILL_SOURCES.transcriptArchive);
      }
    }

    // R4: tables that carry run_id and session_key directly.
    const S4 = BACKFILL_SOURCES.runTables;
    if (need("message_tool_run_outcomes", ["run_id", "session_key"])) for (const row of rows("SELECT DISTINCT run_id AS run, session_key AS key FROM message_tool_run_outcomes")) add(row.run, row.key, S4);
    if (hasPending) for (const row of rows("SELECT DISTINCT run_id AS run, session_key AS key FROM session_pending_inputs")) add(row.run, row.key, S4);
    if (hasCompletions) for (const row of rows("SELECT DISTINCT run_id AS run, session_key AS key FROM session_input_completions")) add(row.run, row.key, S4);
  } finally {
    db.close();
  }
}

function readStateDb(path, add, stats) {
  const db = openReadOnlyDatabase(path);
  try {
    const tables = tableColumns(db, STATE_DB_TABLES);
    const S5 = BACKFILL_SOURCES.stateEvents;
    for (const table of ["audit_events", "session_state_events"]) {
      if (!hasColumns(tables, table, ["run_id", "session_key"])) {
        stats.missingTables.push(table);
        continue;
      }
      for (const row of db.prepare(`SELECT DISTINCT run_id AS run, session_key AS key FROM ${table} WHERE run_id IS NOT NULL AND run_id <> '' AND session_key IS NOT NULL AND session_key <> ''`).iterate()) {
        add(row.run, row.key, S5);
      }
    }
  } finally {
    db.close();
  }
}

const SESSION_KEY_TABLES = Object.freeze([
  "session_windows", "session_nodes", "session_transcript_archives", "session_pending_inputs",
  "session_input_completions", "message_tool_run_outcomes", "audit_events", "session_state_events",
]);

/**
 * Every distinct session key a host DB knows (agent DB or state DB), as
 * stored, for the turn-id hash. Missing tables are skipped. Opens read-only.
 * @param {string} path
 * @returns {Set<string>}
 */
export function readSessionKeys(path) {
  const keys = new Set();
  const db = openReadOnlyDatabase(path);
  try {
    const tables = tableColumns(db, SESSION_KEY_TABLES);
    for (const table of SESSION_KEY_TABLES) {
      if (!hasColumns(tables, table, ["session_key"])) continue;
      for (const row of db.prepare(`SELECT DISTINCT session_key AS key FROM "${table}" WHERE session_key IS NOT NULL AND session_key <> ''`).iterate()) {
        if (typeof row.key === "string") keys.add(row.key);
      }
    }
  } finally {
    db.close();
  }
  return keys;
}

/**
 * Header fields of legacy trajectory files (agents/<id>/sessions and
 * session-sqlite-import-archive, *.trajectory.jsonl[.zst]): each line's first
 * 1500 bytes for sessionKey, runId, sessionId. One file in memory at a time.
 * @param {string[]} dirs
 * @param {Set<string>} wanted run ids to keep
 * @returns {{runs: Map<string, Array<{sessionKey: string, source: string}>>, stats: object}}
 */
export function scanLegacyTrajectories(dirs, wanted) {
  const runs = new Map();
  const stats = { files: 0, bytes: 0, failed: 0, pairs: 0 };
  const source = BACKFILL_SOURCES.legacyTrajectory;
  const add = (run, key) => {
    const sessionKey = normalizeMemorySessionKey(key);
    if (!run || !sessionKey || !wanted.has(run)) return;
    let list = runs.get(run);
    if (!list) runs.set(run, (list = []));
    if (list.some((hit) => hit.sessionKey === sessionKey)) return;
    list.push({ sessionKey, source });
    stats.pairs++;
  };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      stats.failed++;
      warn(`cannot list ${dir}: ${describe(error)}`);
      continue;
    }
    for (const name of names) {
      if (!name.includes("trajectory") || name.includes("trajectory-path")) continue;
      let buf;
      try {
        buf = readFileSync(join(dir, name));
        if (name.endsWith(".zst")) buf = zstdDecompressSync(buf);
      } catch (error) {
        stats.failed++;
        if (stats.failed <= 3) warn(`cannot read ${name}: ${describe(error)}`);
        continue;
      }
      stats.files++;
      stats.bytes += buf.length;
      let start = 0;
      while (start < buf.length) {
        let end = buf.indexOf(0x0a, start);
        if (end < 0) end = buf.length;
        const head = buf.toString("utf8", start, Math.min(end, start + TRAJECTORY_HEADER_BYTES));
        const key = TRAJ_KEY_RE.exec(head)?.[1];
        if (key) {
          const run = TRAJ_RUN_RE.exec(head)?.[1] || "";
          const sid = TRAJ_SID_RE.exec(head)?.[1] || "";
          add(run, key);
          if (sid && sid !== run) add(sid, key);
        }
        start = end + 1;
      }
    }
  }
  return { runs, stats };
}

/**
 * Read a TSV of "runId<TAB>sessionKey" lines (--run-map).
 * @param {string} path
 * @returns {Map<string, Array<{sessionKey: string, source: string}>>}
 */
export function readRunMap(path) {
  const runs = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [run, key] = line.replace(/\r$/, "").split("\t");
    const runId = nonEmptyString(run);
    const sessionKey = normalizeMemorySessionKey(key);
    if (!runId || !sessionKey) continue;
    let list = runs.get(runId);
    if (!list) runs.set(runId, (list = []));
    if (!list.some((hit) => hit.sessionKey === sessionKey)) list.push({ sessionKey, source: BACKFILL_SOURCES.runMap });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Journal and plan (pure)
// ---------------------------------------------------------------------------

/**
 * Read a JSONL journal completely; unparseable lines stay as null so line
 * positions are kept.
 * @param {string} path
 * @returns {{records: Array<object|null>, lines: number, bytes: number, parseErrors: number}}
 */
export function readJournalRecords(path) {
  if (!existsSync(path)) return { records: [], lines: 0, bytes: 0, parseErrors: 0 };
  const buf = readFileSync(path);
  const records = [];
  let parseErrors = 0;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      parseErrors++;
      records.push(null);
    }
  }
  return { records, lines: records.length, bytes: buf.length, parseErrors };
}

/**
 * Newest revision per id with the recall's rule (neoRevisionTimeMs, `>=`: on
 * a tie the later line wins) and its line position.
 * @param {Array<object|null>} records journal lines in file order
 * @returns {Map<string, {record: object, position: number}>}
 */
export function latestCandidateRevisions(records) {
  const latest = new Map();
  (Array.isArray(records) ? records : []).forEach((record, position) => {
    if (!record || typeof record !== "object" || record.__parseError || !record.id) return;
    const id = String(record.id);
    const prev = latest.get(id);
    if (!prev || neoRevisionTimeMs(record) >= neoRevisionTimeMs(prev.record)) latest.set(id, { record, position });
  });
  return latest;
}

function isKeyed(record) {
  return Boolean(normalizeMemorySessionKey(originOf(record)?.sessionKey) || normalizeMemorySessionKey(record?.sessionKey));
}

function isSkippedStatus(record) {
  return SKIP_STATUSES.has(String(record?.status || "candidate")) || record?.hardDeleted === true;
}

/**
 * Run ids that need a key, per agent id (newest revision unkeyed, live, with
 * origin and origin.sessionId).
 * @param {Array<object|null>} records
 * @returns {Map<string, Set<string>>}
 */
export function collectWantedRuns(records) {
  const wanted = new Map();
  for (const { record } of latestCandidateRevisions(records).values()) {
    if (isKeyed(record) || isSkippedStatus(record) || !originOf(record)) continue;
    const runId = nonEmptyString(originOf(record).sessionId);
    if (!runId) continue;
    const agentId = recordAgentId(record);
    if (!wanted.has(agentId)) wanted.set(agentId, new Set());
    wanted.get(agentId).add(runId);
  }
  return wanted;
}

/**
 * Neo-internal hints (R7): keys of keyed candidates and turns by run id, and
 * turn keys by turn id; `keys` holds every key seen (turn-id hash).
 * @param {Array<object|null>} candidates
 * @param {Array<object|null>} turns
 * @returns {{byRun: Map<string, Set<string>>, byTurn: Map<string, Set<string>>, keys: Set<string>}}
 */
export function buildNeoSiblingMap(candidates = [], turns = []) {
  const byRun = new Map();
  const byTurn = new Map();
  const keys = new Set();
  const add = (map, id, key) => {
    if (key) keys.add(key);
    if (!id || !key) return;
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(key);
  };
  for (const record of candidates) {
    if (!record || typeof record !== "object") continue;
    add(byRun, nonEmptyString(originOf(record)?.sessionId), normalizeMemorySessionKey(originOf(record)?.sessionKey));
  }
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const key = normalizeMemorySessionKey(originOf(turn)?.sessionKey) || normalizeMemorySessionKey(turn.sessionKey);
    if (!key) continue;
    add(byRun, nonEmptyString(turn.sessionId) || nonEmptyString(originOf(turn)?.sessionId), key);
    if (turn.id) add(byTurn, String(turn.id), key);
  }
  return { byRun, byTurn, keys };
}

// normalizeStatement in lib/neo-arch.js (Turn- und Kandidaten-IDs)
function normalizeTurnStatement(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

// Text vor und nach dem Sitzungsschluessel in JSON.stringify(["neo-stable-id-v1",
// "turn", ...]) ohne die Ordnungszahl und die schliessende Klammer.
function turnIdBody(workspaceKey, agentId, role, statement, sourceToolCallIds) {
  return [
    `["neo-stable-id-v1","turn",${JSON.stringify(String(workspaceKey || "default"))},${JSON.stringify(String(agentId || "default"))},`,
    `,${JSON.stringify(role)},${JSON.stringify(normalizeTurnStatement(statement))},${JSON.stringify(sourceToolCallIds)},`,
  ];
}

function turnIdHash(text) {
  return cryptoHash("sha256", text, "hex").slice(0, 20);
}

/**
 * The Neo turn id as turnEventsFromMessages builds it since 7.12.19
 * (stableId("turn", workspaceKey, agentId, sessionKey, role, statement,
 * toolCallIds, ordinal)). tests/neo-origin-backfill-7215.test.js pins it to
 * the library.
 * @param {{workspaceKey?: string, agentId?: string, sessionKey: string, role: string, statement: string, sourceToolCallIds?: string[], ordinal?: number}} params
 * @returns {string}
 */
export function neoTurnId({ workspaceKey, agentId, sessionKey, role, statement, sourceToolCallIds = [], ordinal = 0 }) {
  const [head, tail] = turnIdBody(workspaceKey, agentId, role, statement, sourceToolCallIds);
  return `turn_${turnIdHash(`${head}${JSON.stringify(sessionKey)}${tail}${ordinal}]`)}`;
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Resolver by turn id (exact): hashes up to three sourceTurnIds of a record
 * against the session keys of its agent(s), hint keys first, and stops at the
 * first match per turn id. Keys are hashed as stored by the host.
 * @param {{keysByAgent?: Map<string, Iterable<string>>, extraKeys?: Iterable<string>, maxOrdinal?: number}} [sources]
 *   extraKeys: further keys (Neo turn journal, keyed candidates), used for
 *   the agent their prefix names
 * @returns {(record: object, opts?: {agentIds?: string[], hintKeys?: string[]}) => Array<{sessionKey: string, source: string}>}
 */
export function createTurnHashResolver({ keysByAgent = new Map(), extraKeys = [], maxOrdinal = TURN_HASH_MAX_ORDINAL } = {}) {
  const extra = [...extraKeys].map(String);
  const keyLists = new Map();
  const keysFor = (agentId) => {
    let list = keyLists.get(agentId);
    if (!list) {
      const prefix = `agent:${agentId}:`.toLowerCase();
      const set = new Set(keysByAgent.get(agentId) || []);
      for (const key of extra) if (key.toLowerCase().startsWith(prefix)) set.add(key);
      list = [...set].map((key) => [key, JSON.stringify(key)]);
      keyLists.set(agentId, list);
    }
    return list;
  };
  return (record, { agentIds = [], hintKeys = [] } = {}) => {
    const origin = originOf(record);
    const role = nonEmptyString(origin?.role);
    if (!role) return [];
    const turnIds = [...new Set([...arrayOf(record?.sourceTurnIds), ...arrayOf(origin.sourceTurnIds)].map(String))]
      .filter((id) => TURN_ID_RE.test(id))
      .slice(0, 3);
    if (turnIds.length === 0) return [];
    const workspaceKey = record.workspaceKey || origin.workspaceKey;
    const tools = arrayOf(origin.sourceToolCallIds);
    const hits = [];
    for (const turnId of turnIds) {
      const want = turnId.slice(5);
      let found = "";
      for (const agentId of agentIds) {
        const [head, tail] = turnIdBody(workspaceKey, agentId, role, record.statement, tools);
        const matches = (json) => {
          const body = `${head}${json}${tail}`;
          for (let ordinal = 0; ordinal <= maxOrdinal; ordinal++) if (turnIdHash(`${body}${ordinal}]`) === want) return true;
          return false;
        };
        for (const key of hintKeys) if (matches(JSON.stringify(key))) { found = key; break; }
        if (!found) for (const [key, json] of keysFor(agentId)) if (matches(json)) { found = key; break; }
        if (found) break;
      }
      if (found) hits.push({ sessionKey: found, source: BACKFILL_SOURCES.turnHash });
    }
    return hits;
  };
}

/**
 * Resolver over all sources, in priority order (the first hit names the
 * source; the plan collects every hit for the ambiguity check). The turn-id
 * hash runs last and tries the keys the run ids named first.
 * @param {{agentRuns?: Map<string, Map>, globalRuns?: Map|null, runMap?: Map|null, legacyRuns?: Map<string, Map>, siblings?: object|null, turnHash?: Function|null, workspaceAgents?: string[]}} sources
 *   workspaceAgents: agent ids for records that name none (index entries)
 * @returns {(runId: string, record: object) => Array<{sessionKey: string, source: string}>}
 */
export function createRunKeyResolver({ agentRuns = new Map(), globalRuns = null, runMap = null, legacyRuns = new Map(), siblings = null, turnHash = null, workspaceAgents = [] } = {}) {
  return (runId, record) => {
    const agentId = recordAgentId(record);
    const hits = [];
    const push = (list) => { if (Array.isArray(list)) hits.push(...list); };
    if (runId) {
      push(agentRuns.get(agentId)?.get(runId));
      push(globalRuns?.get(runId));
      push(runMap?.get(runId));
      push(legacyRuns.get(agentId)?.get(runId));
    }
    if (siblings) {
      if (runId) for (const key of siblings.byRun?.get(runId) || []) hits.push({ sessionKey: key, source: BACKFILL_SOURCES.neoSibling });
      const turnIds = [...arrayOf(record?.sourceTurnIds), ...arrayOf(originOf(record)?.sourceTurnIds)];
      for (const turnId of new Set(turnIds.map(String))) {
        for (const key of siblings.byTurn?.get(turnId) || []) hits.push({ sessionKey: key, source: BACKFILL_SOURCES.neoSibling });
      }
    }
    if (typeof turnHash === "function") {
      const agentIds = agentId ? [agentId] : workspaceAgents;
      const hintKeys = [...new Set(hits.map((hit) => hit.sessionKey).filter(Boolean))];
      push(turnHash(record, { agentIds, hintKeys }));
    }
    return hits;
  };
}

function runIdShape(runId) {
  if (!runId) return "empty";
  if (UUID_PREFIX_RE.test(runId)) return "uuid";
  return (/^[A-Za-z]+/.exec(runId)?.[0] || "other").toLowerCase().slice(0, 24);
}

function nonChatFamily(sessionKey) {
  const rest = String(sessionKey).toLowerCase().replace(/^agent:[^:]+:/, "");
  return rest.split(":")[0].replace(/-[0-9a-f][0-9a-f-]{7,}$/, "") || "other";
}

function emptyResolutionStats() {
  return {
    resolved: 0, unresolved: 0, noRunId: 0, ambiguous: 0, chat: 0, nonChat: 0, wouldWrite: 0,
    turnHashConfirmed: 0, turnHashOnly: 0, turnHashConflicts: 0,
    bySource: {}, byKind: {}, nonChatByFamily: {}, unresolvedByShape: {}, writeBySource: {},
    sensitivity: { banal: 0, personal: 0, confidential: 0, kept: 0, off: 0 },
  };
}

// Ein Datensatz: alle Treffer sammeln, eindeutig? Chat? Liefert den Schlüssel
// oder null (gezählt in stats).
function resolveForWrite(record, runId, resolveFn, stats, includeNonChat) {
  const keys = new Map();
  let hashKey = "";
  for (const hit of (typeof resolveFn === "function" ? resolveFn(runId, record) : null) || []) {
    const key = normalizeMemorySessionKey(hit?.sessionKey);
    if (!key) continue;
    if (hit.source === BACKFILL_SOURCES.turnHash) hashKey = key;
    if (!keys.has(key)) keys.set(key, String(hit.source || "unknown"));
  }
  if (keys.size === 0) {
    if (runId) stats.unresolved++;
    else stats.noRunId++;
    increment(stats.unresolvedByShape, runIdShape(runId));
    return null;
  }
  if (keys.size > 1) {
    stats.ambiguous++;
    if (hashKey) stats.turnHashConflicts++;
    return null;
  }
  const [[sessionKey, source]] = keys;
  stats.resolved++;
  increment(stats.bySource, source);
  if (source === BACKFILL_SOURCES.turnHash) stats.turnHashOnly++;
  else if (hashKey === sessionKey) stats.turnHashConfirmed++;
  const { kind } = chatContextFromSessionKey(sessionKey);
  if (kind === "unknown") {
    stats.nonChat++;
    increment(stats.nonChatByFamily, nonChatFamily(sessionKey));
    if (!includeNonChat) return null;
  } else {
    stats.chat++;
    increment(stats.byKind, kind);
  }
  return { sessionKey, source, kind };
}

function keyedRevision(record, origin, { sessionKey, source }, { now, addSensitivity, stats }) {
  // Inline-Vektor nie mitschreiben (Sidecar haengt am Id); alles andere
  // woertlich, auch createdAt/updatedAt (Aufbewahrungsuhr) und status.
  const { embedding: _inlineVector, ...rest } = record;
  const next = { ...rest, origin: { ...origin, sessionKey, sessionKeySource: `backfill:${source}`, sessionKeyBackfilledAt: now } };
  if (!addSensitivity) stats.sensitivity.off++;
  else if (normalizeSensitivity(record.sensitivity)) stats.sensitivity.kept++;
  else {
    const level = classifySensitivityByRules(record.statement ?? "").sensitivity;
    next.sensitivity = level;
    next.sensitivitySource = "rules";
    stats.sensitivity[level]++;
  }
  return next;
}

function hasInlineVector(record) {
  const vector = record?.embedding;
  if (Array.isArray(vector)) return vector.length > 0;
  return Boolean(vector && typeof vector === "object" && Object.keys(vector).length > 0);
}

/**
 * Plan the backfill of one journal (pure; writes nothing).
 * @param {Array<object|null>} records journal lines in file order
 * @param {(runId: string, record: object) => Array<{sessionKey: string, source: string}>} resolveFn
 * @param {{includeNonChat?: boolean, sensitivity?: boolean, now?: string, hasSidecarVector?: (id: string) => boolean}} [opts]
 *   hasSidecarVector: a record whose newest revision carries an inline
 *   vector is written only if the sidecar has one for its id (the revision
 *   drops the inline copy); without the check such records are skipped
 * @returns {{stats: object, writes: object[], entries: Array<{id: string, position: number, sessionKey: string, source: string, kind: string}>, ambiguousIds: string[]}}
 */
export function planNeoOriginBackfill(records, resolveFn, opts = {}) {
  const includeNonChat = opts.includeNonChat === true;
  const addSensitivity = opts.sensitivity !== false;
  const now = nonEmptyString(opts.now) || new Date().toISOString();
  const hasSidecarVector = typeof opts.hasSidecarVector === "function" ? opts.hasSidecarVector : () => false;
  const list = Array.isArray(records) ? records : [];
  const latest = latestCandidateRevisions(list);
  const stats = {
    lines: list.length, ids: latest.size, keyed: 0, noKey: 0, skippedStatus: 0, live: 0, noOrigin: 0,
    inlineVectorNoSidecar: 0, ...emptyResolutionStats(),
  };
  const planned = [];
  const ambiguousIds = [];
  for (const [id, { record, position }] of latest) {
    if (isKeyed(record)) { stats.keyed++; continue; }
    stats.noKey++;
    if (isSkippedStatus(record)) { stats.skippedStatus++; continue; }
    stats.live++;
    const origin = originOf(record);
    if (!origin) { stats.noOrigin++; continue; }
    const ambiguousBefore = stats.ambiguous;
    const hit = resolveForWrite(record, nonEmptyString(origin.sessionId), resolveFn, stats, includeNonChat);
    if (stats.ambiguous > ambiguousBefore) ambiguousIds.push(id);
    if (!hit) continue;
    if (hasInlineVector(record) && !hasSidecarVector(id)) { stats.inlineVectorNoSidecar++; continue; }
    const next = keyedRevision(record, origin, hit, { now, addSensitivity, stats });
    increment(stats.writeBySource, hit.source);
    planned.push({ id, position, sessionKey: hit.sessionKey, source: hit.source, kind: hit.kind, record: next });
  }
  // Reihenfolge der alten juengsten Zeilen: das 500-Zeilen-Fenster bleibt so
  // chronologisch wie vorher.
  planned.sort((a, b) => a.position - b.position);
  stats.wouldWrite = planned.length;
  return {
    stats,
    writes: planned.map((entry) => entry.record),
    entries: planned.map(({ id, position, sessionKey, source, kind }) => ({ id, position, sessionKey, source, kind })),
    ambiguousIds,
  };
}

/**
 * Plan keys for candidate-index entries whose journal lines are gone (pure).
 * Only searchable, unkeyed entries with an origin; without a run id in the
 * index projection only the turn-id hash and Neo siblings can name the key.
 * The writes are index entries (they go to candidate-index.jsonl only).
 * @param {Map<string, object>} indexEntries newest index entry per id (readCandidateIndex)
 * @param {Set<string>} journalIds ids the journal still has
 * @param {(runId: string, record: object) => Array<{sessionKey: string, source: string}>} resolveFn
 * @param {{includeNonChat?: boolean, sensitivity?: boolean, now?: string}} [opts]
 * @returns {{stats: object, writes: object[], entries: Array<{id: string, sessionKey: string, source: string, kind: string}>}}
 */
export function planIndexOnlyBackfill(indexEntries, journalIds, resolveFn, opts = {}) {
  const includeNonChat = opts.includeNonChat === true;
  const addSensitivity = opts.sensitivity !== false;
  const now = nonEmptyString(opts.now) || new Date().toISOString();
  const entries = indexEntries instanceof Map ? indexEntries : new Map();
  const stats = { entries: entries.size, indexOnly: 0, searchable: 0, keyed: 0, noKey: 0, noOrigin: 0, ...emptyResolutionStats() };
  const writes = [];
  const report = [];
  for (const [id, entry] of entries) {
    if (journalIds?.has(id)) continue;
    stats.indexOnly++;
    if (!GLOBAL_SEARCH_STATUSES.has(String(entry?.status || "candidate")) || entry?.hardDeleted === true) continue;
    stats.searchable++;
    if (isKeyed(entry)) { stats.keyed++; continue; }
    stats.noKey++;
    const origin = originOf(entry);
    if (!origin) { stats.noOrigin++; continue; }
    const hit = resolveForWrite(entry, "", resolveFn, stats, includeNonChat);
    if (!hit) continue;
    writes.push(keyedRevision(entry, origin, hit, { now, addSensitivity, stats }));
    increment(stats.writeBySource, hit.source);
    report.push({ id, sessionKey: hit.sessionKey, source: hit.source, kind: hit.kind });
  }
  stats.wouldWrite = writes.length;
  return { stats, writes, entries: report };
}

/**
 * Index lines an interrupted earlier apply left out: the newest journal
 * revision carries a backfill key, the newest index entry for that id is not
 * newer and lacks the key (or the sensitivity the journal has). Entries the
 * index no longer holds stay out (compaction or the cap removed them).
 * @param {Array<object|null>} records journal lines in file order
 * @param {Map<string, object>} indexEntries newest index entry per id
 * @returns {object[]} journal revisions to append to the index
 */
export function planIndexRepair(records, indexEntries) {
  const repairs = [];
  if (!(indexEntries instanceof Map) || indexEntries.size === 0) return repairs;
  for (const [id, { record }] of latestCandidateRevisions(records)) {
    const origin = originOf(record);
    if (!String(origin?.sessionKeySource || "").startsWith("backfill:") || !isKeyed(record)) continue;
    const entry = indexEntries.get(id);
    if (!entry || neoRevisionTimeMs(entry) > neoRevisionTimeMs(record)) continue;
    const keyMissing = normalizeMemorySessionKey(originOf(entry)?.sessionKey) !== normalizeMemorySessionKey(origin.sessionKey);
    const sensitivityMissing = Boolean(normalizeSensitivity(record.sensitivity)) && !normalizeSensitivity(entry.sensitivity);
    if (keyMissing || sensitivityMissing) repairs.push(record);
  }
  return repairs;
}

/**
 * Append the planned revisions: journal revisions plus their index lines,
 * and index-only lines, in one lock. The expected byte sizes are checked
 * inside that lock.
 * @param {object} store Neo store from createNeoStore
 * @param {{writes?: object[], indexWrites?: object[]}} plan journal revisions (planNeoOriginBackfill) and index-only lines
 * @param {{compactIndex?: boolean, expectedJournalBytes?: number, expectedIndexBytes?: number}} [opts]
 * @returns {{written: number, indexWritten: number, compact: object|null}}
 */
export function applyNeoOriginBackfill(store, plan, opts = {}) {
  const writes = Array.isArray(plan?.writes) ? plan.writes : [];
  const indexWrites = Array.isArray(plan?.indexWrites) ? plan.indexWrites : [];
  if (writes.length === 0 && indexWrites.length === 0) return { written: 0, indexWritten: 0, compact: null };
  if (typeof store?.appendCandidateRevisions !== "function") throw new Error("store has no appendCandidateRevisions (needs PLUR1BUS 7.21.5)");
  const result = store.appendCandidateRevisions(writes, {
    indexEntries: indexWrites,
    expectedJournalBytes: opts.expectedJournalBytes,
    expectedIndexBytes: opts.expectedIndexBytes,
  });
  // Bewusst kein rebuildCandidateIndex: der baut nur aus dem Journal und
  // verlöre die Index-Einträge (und damit Vektoren), deren Zeilen das
  // Journal nicht mehr hat. Die Kompaktierung arbeitet auf dem Index selbst.
  const compact = opts.compactIndex === true ? store.compactCandidateIndex() : null;
  return { written: result.appended.length, indexWritten: result.indexOnly, compact };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function writeBackfillReport(store, lines, stamp) {
  const dir = resolveInside(store.paths.workspaceDir, "archive");
  mkdirSync(dir, { recursive: true });
  const file = resolveInside(dir, `origin-backfill.${stamp}.jsonl`);
  // Nur Ids, Schluessel, Quelle und Ziel; kein Statement-Text.
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
  return file;
}

function agentPath(agentsDir, agentId, ...parts) {
  safeAgentId(agentId);
  return resolveInside(agentsDir, agentId, ...parts);
}

// Agenten eines Workspace (Journal und Index), fuer Index-Eintraege ohne
// origin.agentId (die Index-Projektion fuehrt es nicht).
function workspaceAgentIds(records, indexEntries) {
  const agents = new Set();
  for (const record of records) {
    const agentId = record && typeof record === "object" ? recordAgentId(record) : "";
    if (agentId) agents.add(agentId);
  }
  for (const entry of indexEntries.values()) {
    const agentId = recordAgentId(entry);
    if (agentId) agents.add(agentId);
  }
  return [...agents];
}

/**
 * Run the backfill for the given options (dry run or apply).
 * @param {object} opts from parseArgs
 * @param {{gatewayRunning?: Function, home?: string, now?: string}} [deps]
 * @returns {{apply: boolean, includeIndexOnly: boolean, turnHash: boolean, sources: object, workspaces: object[], errors: string[]}}
 */
export function runNeoOriginBackfill(opts, deps = {}) {
  const home = deps.home || homedir();
  const now = nonEmptyString(deps.now) || new Date().toISOString();
  const gatewayCheck = deps.gatewayRunning || detectGatewayRunning;
  const useTurnHash = opts.turnHash !== false;
  const errors = [];
  if (opts.allowRunningGateway && isInsideDir(join(home, ".openclaw"), opts.base)) {
    throw new Error("--allow-running-gateway is only allowed for a copy outside ~/.openclaw");
  }
  if (opts.apply) checkApplyPreconditions(opts, { ...deps, home });
  const neoRoot = join(opts.base, "_neo");
  if (!existsSync(neoRoot)) throw new Error(`no Neo store under ${neoRoot}`);

  const workspaces = [];
  for (const key of opts.workspaces) {
    const store = createNeoStore(neoRoot, key, { readOnly: !opts.apply });
    const entry = { workspace: key, dir: basename(store.paths.workspaceDir), store };
    workspaces.push(entry);
    if (!existsSync(store.paths.workspaceDir)) { entry.error = "no workspace directory"; continue; }
    if (store.legacyPaths.candidates !== store.paths.candidates && existsSync(store.legacyPaths.candidates)) {
      entry.error = `legacy journal ${store.legacyPaths.candidates} exists; migrate it first (scripts/migrate-neo-workspace-generations.mjs)`;
      continue;
    }
    entry.journal = readJournalRecords(store.paths.candidates);
    entry.indexExists = existsSync(store.paths.candidateIndex);
    entry.indexBytes = fileSize(store.paths.candidateIndex);
    // Kopie: der Prozess-Cache von readCandidateIndex waechst beim naechsten Lesen.
    entry.index = entry.indexExists ? new Map(store.readCandidateIndex().entries) : new Map();
    if (opts.apply) {
      checkSnapshotCovers(opts.snapshot, {
        dir: entry.dir, candidates: store.paths.candidates, candidateIndex: store.paths.candidateIndex,
        journalBytes: entry.journal.bytes, indexBytes: entry.indexBytes, indexExists: entry.indexExists,
      });
    }
    const turns = readJournalRecords(store.paths.turns);
    entry.siblings = buildNeoSiblingMap(entry.journal.records, turns.records);
    entry.agents = workspaceAgentIds(entry.journal.records, entry.index);
  }

  const wantedByAgent = new Map();
  const wantedAll = new Set();
  const agentIds = new Set();
  for (const entry of workspaces) {
    if (!entry.journal) continue;
    for (const [agentId, runs] of collectWantedRuns(entry.journal.records)) {
      if (!wantedByAgent.has(agentId)) wantedByAgent.set(agentId, new Set());
      for (const run of runs) { wantedByAgent.get(agentId).add(run); wantedAll.add(run); }
      agentIds.add(agentId);
    }
    if (useTurnHash) for (const agentId of entry.agents) agentIds.add(agentId);
  }

  const sources = { agents: {}, state: null, runMap: null, legacy: {} };
  const agentRuns = new Map();
  const legacyRuns = new Map();
  const keysByAgent = new Map();
  for (const agentId of agentIds) {
    const label = agentId || "(none)";
    const runs = wantedByAgent.get(agentId) || new Set();
    let dbPath;
    try {
      dbPath = agentPath(opts.agentsDir, agentId, "agent", "openclaw-agent.sqlite");
    } catch (error) {
      sources.agents[label] = { wantedRuns: runs.size, error: describe(error) };
      continue;
    }
    if (!existsSync(dbPath)) { sources.agents[label] = { wantedRuns: runs.size, error: "no host DB" }; continue; }
    sources.agents[label] = { wantedRuns: runs.size };
    if (runs.size > 0) {
      const { runs: map, stats } = buildRunKeyMap({ agentDb: dbPath, wanted: runs });
      agentRuns.set(agentId, map);
      Object.assign(sources.agents[label], { resolvedRuns: map.size, ...stats });
    }
    if (useTurnHash) {
      const keys = readSessionKeys(dbPath);
      keysByAgent.set(agentId, keys);
      sources.agents[label].sessionKeys = keys.size;
    }
    if (opts.legacyTrajectories && runs.size > 0) {
      const dirs = [agentPath(opts.agentsDir, agentId, "sessions"), agentPath(opts.agentsDir, agentId, "session-sqlite-import-archive")];
      const legacy = scanLegacyTrajectories(dirs, runs);
      legacyRuns.set(agentId, legacy.runs);
      sources.legacy[label] = { resolvedRuns: legacy.runs.size, ...legacy.stats };
    }
  }
  let globalRuns = null;
  if (opts.stateDb && existsSync(opts.stateDb)) {
    const { runs: map, stats } = buildRunKeyMap({ stateDb: opts.stateDb, wanted: wantedAll });
    globalRuns = map;
    sources.state = { resolvedRuns: map.size, ...stats };
    if (useTurnHash) {
      // Schluessel aus dem State-DB dem Agenten zuordnen, den ihr Praefix nennt.
      const stateKeys = readSessionKeys(opts.stateDb);
      sources.state.sessionKeys = stateKeys.size;
      for (const agentId of agentIds) {
        const prefix = `agent:${agentId}:`.toLowerCase();
        const keys = keysByAgent.get(agentId) || new Set();
        for (const key of stateKeys) if (key.toLowerCase().startsWith(prefix)) keys.add(key);
        keysByAgent.set(agentId, keys);
      }
    }
  } else {
    sources.state = { error: "no state DB" };
  }
  let runMap = null;
  if (opts.runMap) {
    runMap = readRunMap(opts.runMap);
    sources.runMap = { runs: runMap.size };
  }

  const stamp = now.replace(/[:.]/g, "-");
  for (const entry of workspaces) {
    if (entry.error || !entry.journal) continue;
    const { store } = entry;
    const turnHash = useTurnHash ? createTurnHashResolver({ keysByAgent, extraKeys: entry.siblings.keys }) : null;
    const resolveFn = createRunKeyResolver({ agentRuns, globalRuns, runMap, legacyRuns, siblings: entry.siblings, turnHash, workspaceAgents: entry.agents });
    const planOpts = { includeNonChat: opts.includeNonChat, sensitivity: opts.sensitivity, now };
    const hasSidecarVector = (id) => {
      const vector = store.readVector(id);
      return Array.isArray(vector) ? vector.length > 0 : Boolean(vector);
    };
    const plan = planNeoOriginBackfill(entry.journal.records, resolveFn, { ...planOpts, hasSidecarVector });
    const journalIds = new Set(latestCandidateRevisions(entry.journal.records).keys());
    const indexPlan = planIndexOnlyBackfill(entry.index, journalIds, resolveFn, planOpts);
    const repairs = planIndexRepair(entry.journal.records, entry.index);
    entry.plan = plan;
    entry.indexPlan = indexPlan;
    entry.repairs = repairs;
    entry.parseErrors = entry.journal.parseErrors;
    const indexOnlyWrites = opts.includeIndexOnly ? indexPlan.writes : [];
    const indexWrites = [...repairs, ...indexOnlyWrites];
    if (!opts.apply || (plan.writes.length === 0 && indexWrites.length === 0)) continue;
    if (errors.length > 0) { entry.error = "not written: an earlier workspace failed"; continue; }
    const logDir = join(opts.base, "..");
    try {
      // Unmittelbar vor dem Schreiben noch einmal: der Schutz-Cron startet
      // einen gestoppten Gateway bei Deploy-Drift neu.
      if (!opts.allowRunningGateway) {
        const gateway = gatewayCheck();
        if (gatewayIsRunning(gateway)) refuseRunningGateway(gateway);
      }
      const journalBytesBefore = fileSize(store.paths.candidates);
      if (journalBytesBefore !== entry.journal.bytes) throw new Error("journal changed since it was read; nothing written, run again with the gateway stopped");
      const indexBytesBefore = fileSize(store.paths.candidateIndex);
      if (indexBytesBefore !== entry.indexBytes) throw new Error("candidate index changed since it was read; nothing written, run again with the gateway stopped");
      const indexExistedBefore = existsSync(store.paths.candidateIndex);
      const started = appendDestructiveOpLog(logDir, {
        timestamp: new Date().toISOString(), op: "neo-origin-backfill", phase: "started", workspace: entry.workspace, workspaceDir: entry.dir,
        snapshot: opts.snapshot, planned: plan.writes.length, indexOnlyPlanned: indexOnlyWrites.length, indexRepairPlanned: repairs.length,
        bySource: plan.stats.writeBySource, byKind: opts.includeNonChat ? { ...plan.stats.byKind, nonChat: plan.stats.nonChat } : plan.stats.byKind,
        includeNonChat: opts.includeNonChat, includeIndexOnly: opts.includeIndexOnly === true, turnHash: useTurnHash, sensitivity: opts.sensitivity,
        journalBytesBefore, indexBytesBefore, indexExistedBefore,
      });
      if (!started) throw new Error("cannot write destructive-ops.jsonl; nothing written");
      let result;
      try {
        result = applyNeoOriginBackfill(store, { writes: plan.writes, indexWrites }, {
          compactIndex: opts.compactIndex, expectedJournalBytes: journalBytesBefore, expectedIndexBytes: indexBytesBefore,
        });
      } catch (error) {
        // Halb geschrieben? Die Groessen danach zeigen es; ein zweiter Lauf
        // ergaenzt fehlende Indexzeilen (planIndexRepair).
        appendDestructiveOpLog(logDir, {
          timestamp: new Date().toISOString(), op: "neo-origin-backfill", phase: "failed", workspace: entry.workspace, workspaceDir: entry.dir,
          error: describe(error), journalBytesAfter: fileSize(store.paths.candidates), indexBytesAfter: fileSize(store.paths.candidateIndex),
        });
        throw error;
      }
      // Die Id-Liste ist Beiwerk: scheitert sie, steht der Backfill trotzdem
      // und der committed-Eintrag muss geschrieben werden.
      let report = "";
      try {
        const lines = [
          ...plan.entries.map(({ id, sessionKey, source, kind }) => ({ id, sessionKey, source, kind, target: "journal" })),
          ...(opts.includeIndexOnly ? indexPlan.entries.map(({ id, sessionKey, source, kind }) => ({ id, sessionKey, source, kind, target: "index-only" })) : []),
          ...repairs.map((record) => ({ id: String(record.id), sessionKey: record.origin.sessionKey, source: String(record.origin.sessionKeySource).replace(/^backfill:/, ""), target: "index-repair" })),
        ];
        report = basename(writeBackfillReport(store, lines, stamp));
      } catch (error) {
        warn(`${entry.workspace}: id report not written (${describe(error)}); the backfill itself is written`);
      }
      entry.applied = {
        ...result, indexOnlyWritten: indexOnlyWrites.length, indexRepaired: repairs.length,
        journalBytesBefore, indexBytesBefore, journalBytesAfter: fileSize(store.paths.candidates), indexBytesAfter: fileSize(store.paths.candidateIndex), report,
      };
      appendDestructiveOpLog(logDir, {
        timestamp: new Date().toISOString(), op: "neo-origin-backfill", phase: "committed", workspace: entry.workspace, workspaceDir: entry.dir,
        written: result.written, indexOnlyWritten: indexOnlyWrites.length, indexRepaired: repairs.length,
        journalBytesAfter: entry.applied.journalBytesAfter, indexBytesAfter: entry.applied.indexBytesAfter,
        compacted: Boolean(result.compact), report: entry.applied.report,
      });
    } catch (error) {
      entry.error = describe(error);
      errors.push(`${entry.workspace}: ${entry.error}`);
    }
  }
  for (const entry of workspaces) if (entry.error && !errors.some((e) => e.startsWith(`${entry.workspace}:`))) errors.push(`${entry.workspace}: ${entry.error}`);
  return {
    apply: opts.apply,
    includeIndexOnly: opts.includeIndexOnly === true,
    turnHash: useTurnHash,
    sources,
    errors,
    workspaces: workspaces.map(({ store: _store, journal, index: _index, siblings: _siblings, plan, indexPlan, repairs, ...rest }) => ({
      ...rest,
      journalLines: journal?.lines ?? 0,
      ...(plan ? { stats: plan.stats, ambiguousIds: plan.ambiguousIds } : {}),
      ...(indexPlan ? { indexStats: indexPlan.stats, indexRepair: repairs.length } : {}),
    })),
  };
}

function formatCounts(counter) {
  const parts = Object.entries(counter || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(", ") : "none";
}

function formatReport(report) {
  const lines = [];
  for (const ws of report.workspaces) {
    if (!ws.stats) { lines.push(`${ws.workspace} (${ws.dir}): ${ws.error || "skipped"}`); continue; }
    const s = ws.stats;
    lines.push(`${ws.workspace} (${ws.dir}): lines ${s.lines}, ids ${s.ids}, keyed ${s.keyed}, noKey ${s.noKey}, live ${s.live} (skipped status ${s.skippedStatus}, no origin ${s.noOrigin}${ws.parseErrors ? `, unparseable lines ${ws.parseErrors}` : ""})`);
    lines.push(`  resolved ${s.resolved}: chat ${s.chat} (${formatCounts(s.byKind)}), non-chat ${s.nonChat} (${formatCounts(s.nonChatByFamily)})`);
    lines.push(`  resolved by source: ${formatCounts(s.bySource)}`);
    if (report.turnHash) lines.push(`  turn-id hash: confirms ${s.turnHashConfirmed}, only source ${s.turnHashOnly}, conflicts ${s.turnHashConflicts}`);
    lines.push(`  unresolved ${s.unresolved + s.noRunId} (${formatCounts(s.unresolvedByShape)}), ambiguous ${s.ambiguous}`);
    if (s.inlineVectorNoSidecar > 0) lines.push(`  skipped ${s.inlineVectorNoSidecar}: vector only inline, none in the sidecar; run scripts/migrate-neo-vectors-sidecar.mjs first`);
    lines.push(`  ${report.apply ? "write" : "would write"} ${s.wouldWrite} (${formatCounts(s.writeBySource)}); sensitivity ${formatCounts(s.sensitivity)}`);
    const x = ws.indexStats;
    if (x) {
      lines.push(`  index: ${x.entries} entries, ${x.indexOnly} without journal lines (searchable ${x.searchable}, of these unkeyed ${x.noKey}); global recall still treats unkeyed ones as legacy "dm"`);
      lines.push(`    index-only resolved ${x.resolved}${report.turnHash ? "" : " (turn-id hash off)"}: chat ${x.chat} (${formatCounts(x.byKind)}), non-chat ${x.nonChat}; unresolved ${x.unresolved + x.noRunId}, ambiguous ${x.ambiguous}`);
      lines.push(`    ${report.includeIndexOnly ? (report.apply ? "write" : "would write") : "with --include-index-only would write"} ${x.wouldWrite} index lines; sensitivity ${formatCounts(x.sensitivity)}`);
      if (ws.indexRepair > 0) lines.push(`  index repair: ${ws.indexRepair} index lines an earlier, interrupted run left out`);
    }
    if (ws.applied) {
      lines.push(`  written ${ws.applied.written} journal revisions, ${ws.applied.indexOnlyWritten} index-only lines, ${ws.applied.indexRepaired} repaired index lines; journal ${ws.applied.journalBytesBefore} → ${ws.applied.journalBytesAfter} bytes, index ${ws.applied.indexBytesBefore} → ${ws.applied.indexBytesAfter} bytes${ws.applied.compact ? ", index compacted" : ""}${ws.applied.report ? `; report archive/${ws.applied.report}` : "; no id report"}`);
    }
    if (ws.error) lines.push(`  ERROR: ${ws.error}`);
  }
  if (!report.apply) lines.push("(dry run — nothing written)");
  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = runNeoOriginBackfill(opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  if (report.errors.length > 0) {
    for (const error of report.errors) warn(error);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(`neo-origin-backfill: ${describe(error)}`);
    process.exit(1);
  }
}

/**
 * lib/snapshot/store-snapshot.js — Node port of the store snapshot step
 * (spec A.3 step 6, ruling HM1-R8).
 *
 * A snapshot is a directory `<stateDir>/memory/.snapshots/plur1bus-<UTC
 * yyyymmddTHHMMSSZ>-<label>/` holding `store/` (the resolved baseDbPath),
 * `memory/_archive`, `memory/run-state.json`, `memory/merge-proposals.jsonl`
 * (each when present) and `snapshot.json` (schema `plur1bus.snapshot/1`, a
 * SHA-256 per file). Never the vault, never config or credentials.
 *
 * LanceDB tables are copied in the order data, `_indices`, `_deletions`,
 * `_transactions`, other entries, `_versions` last. Afterwards the newest
 * source manifest must be unchanged and every data/transaction file the copied
 * newest manifest names must exist in the copy; otherwise (or on `ENOENT`
 * mid-copy) the table is copied again, three tries, then `source-busy`.
 *
 * The module imports only `node:` builtins so the installer bundle can carry
 * it (HM1-R20). The bash installer's `*.tar.gz` snapshots are listed as
 * `legacy-tar` and never pruned or restored here.
 */

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const SNAPSHOT_SCHEMA = "plur1bus.snapshot/1";
export const MAX_SNAPSHOTS = 5;

const TABLE_TRIES = 3;
const DISK_FACTOR = 1.1;
const TABLE_ORDER = ["data", "_indices", "_deletions", "_transactions"];
const SNAPSHOT_PREFIX = "plur1bus-";
const STAGING_RE = /^plur1bus-.+\.tmp-(\d+)$/;
const U64_MAX = (1n << 64n) - 1n;
const WIN_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const WIN_RETRY_MS = 10_000;

/** A refusal the caller can act on; `reason` is machine-readable. */
export class SnapshotError extends Error {
  /**
   * @param {"source-busy"|"insufficient-disk"|"digest-mismatch"|"not-found"|"unsafe-path"} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = "SnapshotError";
    this.reason = reason;
  }
}

/** Internal: a table copy saw the source move under it. */
class TableMoved extends Error {}

// ─── small helpers ──────────────────────────────────────────────────────────

/** @param {number} ms @returns {string} UTC yyyymmddTHHMMSSZ */
function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** @param {unknown} label @returns {string} a filesystem-safe ASCII label */
function slugLabel(label) {
  const slug = String(label ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40)
    .replace(/[-.]+$/, "");
  return slug || "snapshot";
}

const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/** @returns {boolean} true when `child` is `parent` or lies inside it. */
function isWithin(child, parent) {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const toPosix = (p) => p.split(sep).join("/");

async function exists(fs, p) {
  try {
    await fs.lstat(p);
    return true;
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

/** Run `fn`, on Windows retrying EPERM/EBUSY/EACCES with backoff for up to 10 s (spec B.5). */
async function withWinRetry(fn) {
  const start = Date.now();
  let delay = 50;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (process.platform !== "win32" || !WIN_RETRY_CODES.has(e?.code) || Date.now() - start > WIN_RETRY_MS) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 1000);
    }
  }
}

async function removeTree(fs, p) {
  await withWinRetry(() => fs.rm(p, { recursive: true, force: true }));
}

async function fsyncDir(fs, p) {
  if (process.platform === "win32") return; // directories cannot be opened for fsync on Windows
  const fh = await fs.open(p, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Hash a file and fsync it in one pass. @returns {Promise<{bytes: number, sha256: string}>} */
async function hashAndSync(fs, p, { sync = true } = {}) {
  const fh = await fs.open(p, sync ? "r+" : "r");
  try {
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    if (sync) await fh.sync();
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await fh.close();
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** Remove staging dirs left by a create that was killed (its pid is gone). */
async function sweepStaleStaging(fs, root) {
  let names;
  try {
    names = await fs.readdir(root);
  } catch (e) {
    if (e?.code === "ENOENT") return;
    throw e;
  }
  for (const name of names) {
    const m = STAGING_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && !isPidAlive(pid)) await removeTree(fs, join(root, name));
  }
}

/** The snapshots directory: `snapshotsDir` when given (ruling F18, Hermes host mode keeps its own), else `<stateDir>/memory/.snapshots`. */
const snapshotsRoot = (stateDir, snapshotsDir) => (snapshotsDir ? resolve(snapshotsDir) : join(resolve(stateDir), "memory", ".snapshots"));

// ─── path safety ────────────────────────────────────────────────────────────

/**
 * Resolve a source path. A symlink is followed only when it resolves inside
 * its own parent directory; otherwise `unsafe-path`.
 * @returns {Promise<{path: string, isDir: boolean} | null>} null when absent
 */
async function resolveSource(fs, p) {
  let st;
  try {
    st = await fs.lstat(p);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  if (!st.isSymbolicLink()) return { path: p, isDir: st.isDirectory() };
  const real = await fs.realpath(p);
  const parentReal = await fs.realpath(dirname(p));
  if (!isWithin(real, parentReal) || norm(real) === norm(parentReal)) {
    throw new SnapshotError("unsafe-path", `${p} is a symlink that resolves outside its parent directory`);
  }
  const target = await fs.stat(real);
  return { path: real, isDir: target.isDirectory() };
}

/** Refuse a baseDbPath equal to or containing stateDir, inside the snapshots root, or containing it. */
async function assertSafeBase(fs, stateDir, baseDbPath, snapshotsDir) {
  const stateAbs = resolve(stateDir);
  const baseAbs = resolve(baseDbPath);
  const snapAbs = snapshotsDir ? resolve(snapshotsDir) : null;
  const pairs = [[stateAbs, baseAbs, snapAbs]];
  try {
    pairs.push([await fs.realpath(stateAbs), await fs.realpath(baseAbs), snapAbs ? await realOrSelf(fs, snapAbs) : null]);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  for (const [s, b, snap] of pairs) {
    if (isWithin(s, b)) throw new SnapshotError("unsafe-path", `baseDbPath ${baseDbPath} is or contains the state dir`);
    const snapRoot = snap ?? join(s, "memory", ".snapshots");
    if (isWithin(b, snapRoot)) throw new SnapshotError("unsafe-path", `baseDbPath ${baseDbPath} lies inside the snapshots directory`);
    if (isWithin(snapRoot, b)) throw new SnapshotError("unsafe-path", `baseDbPath ${baseDbPath} contains the snapshots directory`);
  }
  return { stateAbs, baseAbs };
}

/** realpath of `p`, or `p` itself while it does not exist yet (a snapshots dir created on first use). */
async function realOrSelf(fs, p) {
  try {
    return await fs.realpath(p);
  } catch (e) {
    if (e?.code === "ENOENT") return p;
    throw e;
  }
}

function assertSafeId(id) {
  if (typeof id !== "string" || !id.startsWith(SNAPSHOT_PREFIX) || basename(id) !== id || id.includes("..") || /[\\/]/.test(id) || STAGING_RE.test(id)) {
    throw new SnapshotError("unsafe-path", `invalid snapshot id ${JSON.stringify(id)}`);
  }
}

// ─── LanceDB manifest reading ───────────────────────────────────────────────

/** @returns {bigint | null} the table version a `_versions` file name stands for */
function manifestVersion(name) {
  const m = /^(\d+)\.manifest$/.exec(name);
  if (!m) return null;
  const n = BigInt(m[1]);
  // V2 naming scheme: zero-padded 20 digits holding u64::MAX - version.
  return m[1].length === 20 ? U64_MAX - n : n;
}

/** @returns {Promise<{name: string, sha256: string, bytes: Buffer} | null>} */
async function newestManifest(fs, tableDir) {
  let names;
  try {
    names = await fs.readdir(join(tableDir, "_versions"));
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  let best = null;
  let bestVersion = -1n;
  for (const name of names) {
    const v = manifestVersion(name);
    if (v !== null && v > bestVersion) {
      best = name;
      bestVersion = v;
    }
  }
  if (!best) return null;
  const bytes = await fs.readFile(join(tableDir, "_versions", best));
  return { name: best, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}

const REF_CHAR = new Uint8Array(256);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./") REF_CHAR[c.charCodeAt(0)] = 1;

/**
 * File names a manifest references, found as protobuf length-delimited strings
 * ending in `.lance` (data files, relative to `data/`) or `.txn` (relative to
 * `_transactions/`). Deletion and index files are named by numbers/UUID bytes;
 * they are covered by the unchanged-manifest check instead.
 * @param {Buffer} buf
 * @returns {Array<{dir: string, name: string}>}
 */
function manifestReferences(buf) {
  const out = new Map();
  for (const [ext, dir] of [[".lance", "data"], [".txn", "_transactions"]]) {
    let from = 0;
    for (;;) {
      const at = buf.indexOf(ext, from, "latin1");
      if (at < 0) break;
      from = at + 1;
      const end = at + ext.length;
      let found = null;
      for (let s = at - 1; s >= 1 && REF_CHAR[buf[s]]; s--) {
        const len = end - s;
        const one = buf[s - 1] === len && len < 128;
        const two = s >= 2 && len >= 128 && (buf[s - 2] & 0x80) !== 0 && ((buf[s - 2] & 0x7f) | (buf[s - 1] << 7)) === len;
        if (one || two) found = buf.toString("latin1", s, end);
      }
      if (found && !found.startsWith("/") && !found.split("/").includes("..")) out.set(`${dir}/${found}`, { dir, name: found });
    }
  }
  return [...out.values()];
}

// ─── copying ────────────────────────────────────────────────────────────────

/** Collect every regular file below `dir` (symlinks skipped). */
async function listTree(fs, dir, acc = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await listTree(fs, p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

async function sizeOf(fs, p) {
  let total = 0;
  for (const f of await listTree(fs, p)) {
    try {
      total += (await fs.stat(f)).size;
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
  return total;
}

class Copier {
  /** @param {typeof nodeFs} fs @param {string} stagingDir */
  constructor(fs, stagingDir) {
    this.fs = fs;
    this.stagingDir = stagingDir;
    /** @type {Map<string, {path: string, bytes: number, sha256: string}>} */
    this.files = new Map();
  }

  /** Copy one file to `dst` (absolute, inside staging) and record its hash. */
  async copyFile(src, dst) {
    await this.fs.mkdir(dirname(dst), { recursive: true });
    await this.fs.copyFile(src, dst);
    const { bytes, sha256 } = await hashAndSync(this.fs, dst);
    const rel = toPosix(relative(this.stagingDir, dst));
    this.files.set(rel, { path: rel, bytes, sha256 });
  }

  forget(dstPrefix) {
    const prefix = `${toPosix(relative(this.stagingDir, dstPrefix))}/`;
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
  }

  /** Copy a plain directory tree; LanceDB table directories get the consistent copy. */
  async copyDir(src, dst) {
    await this.fs.mkdir(dst, { recursive: true });
    let entries;
    try {
      entries = await this.fs.readdir(src, { withFileTypes: true });
    } catch (e) {
      if (e?.code === "ENOENT") return; // vanished, nothing to keep
      throw e;
    }
    for (const e of entries) {
      const s = join(src, e.name);
      const d = join(dst, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (await isTableDir(this.fs, s)) await this.copyTable(s, d);
        else await this.copyDir(s, d);
      } else if (e.isFile()) {
        try {
          await this.copyFile(s, d);
        } catch (err) {
          if (err?.code !== "ENOENT") throw err; // a plain file that vanished is simply not part of the snapshot
        }
      }
    }
  }

  /** Copy one entry of a table dir; ENOENT propagates so the table restarts. */
  async copyTableEntry(s, d) {
    const st = await this.fs.lstat(s);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      await this.fs.mkdir(d, { recursive: true });
      for (const name of await this.fs.readdir(s)) await this.copyTableEntry(join(s, name), join(d, name));
    } else if (st.isFile()) {
      await this.copyFile(s, d);
    }
  }

  /** LanceDB-consistent table copy with retry (HM1-R8, Review Focus 2). */
  async copyTable(src, dst) {
    let lastCause = "";
    for (let attempt = 1; attempt <= TABLE_TRIES; attempt++) {
      this.forget(dst);
      await removeTree(this.fs, dst);
      try {
        const head = await newestManifest(this.fs, src);
        await this.fs.mkdir(dst, { recursive: true });
        const names = await this.fs.readdir(src);
        const ordered = [
          ...TABLE_ORDER.filter((n) => names.includes(n)),
          ...names.filter((n) => !TABLE_ORDER.includes(n) && n !== "_versions").sort(),
          ...(names.includes("_versions") ? ["_versions"] : []),
        ];
        for (const name of ordered) await this.copyTableEntry(join(src, name), join(dst, name));
        const after = await newestManifest(this.fs, src);
        if (head?.name !== after?.name || head?.sha256 !== after?.sha256) throw new TableMoved("the newest manifest changed during the copy");
        const copied = await newestManifest(this.fs, dst);
        if (copied?.name !== head?.name || copied?.sha256 !== head?.sha256) throw new TableMoved("the copied newest manifest differs from the source");
        if (copied) {
          for (const ref of manifestReferences(copied.bytes)) {
            if (!(await exists(this.fs, join(dst, ref.dir, ...ref.name.split("/"))))) {
              throw new TableMoved(`${ref.dir}/${ref.name} named by the newest manifest is missing`);
            }
          }
        }
        return;
      } catch (e) {
        if (e instanceof TableMoved) lastCause = e.message;
        else if (e?.code === "ENOENT") lastCause = `a file vanished during the copy (${e.path ?? "unknown"})`;
        else throw e;
      }
    }
    this.forget(dst);
    await removeTree(this.fs, dst);
    throw new SnapshotError("source-busy", `table ${src} kept changing during ${TABLE_TRIES} copy attempts: ${lastCause}`);
  }
}

async function isTableDir(fs, dir) {
  try {
    return (await fs.stat(join(dir, "_versions"))).isDirectory();
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return false;
    throw e;
  }
}

async function nearestExistingDir(fs, dir) {
  let d = dir;
  for (;;) {
    if (await exists(fs, d)) return d;
    const up = dirname(d);
    if (up === d) return d;
    d = up;
  }
}

async function freeBytes(fs, dir) {
  const st = await fs.statfs(dir);
  return Number(st.bavail) * Number(st.bsize);
}

async function writeJsonAtomic(fs, path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fh = await fs.open(tmp, "w", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await withWinRetry(() => fs.rename(tmp, path));
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Take a verified snapshot of the store and the memory side files.
 * @param {{stateDir: string, baseDbPath: string, label?: string, pluginVersion?: string, now?: () => number, maxKeep?: number, fsImpl?: typeof nodeFs, snapshotsDir?: string}} opts
 *   `snapshotsDir` (ruling F18) replaces `<stateDir>/memory/.snapshots` in every function of this module.
 * A prune failure after the snapshot is in place does not fail the create; it
 * is returned in `warnings`.
 * @returns {Promise<{id: string, dir: string, bytes: number, files: number, pruned: string[], warnings: string[]}>}
 */
export async function createSnapshot({ stateDir, baseDbPath, label, pluginVersion, now = Date.now, maxKeep = MAX_SNAPSHOTS, fsImpl, snapshotsDir }) {
  const fs = fsImpl ?? nodeFs;
  assertMaxKeep(maxKeep);
  const { stateAbs, baseAbs } = await assertSafeBase(fs, stateDir, baseDbPath, snapshotsDir);
  const memoryDir = join(stateAbs, "memory");

  const store = await resolveSource(fs, baseAbs);
  if (!store || !store.isDir) throw new SnapshotError("not-found", `store directory ${baseAbs} does not exist`);
  const sources = [{ src: store.path, dest: "store", isDir: true }];
  for (const [rel, wantDir] of [["_archive", true], ["run-state.json", false], ["merge-proposals.jsonl", false]]) {
    const r = await resolveSource(fs, join(memoryDir, rel));
    if (r && r.isDir === wantDir) sources.push({ src: r.path, dest: `memory/${rel}`, isDir: wantDir });
  }

  const root = snapshotsRoot(stateAbs, snapshotsDir);
  await fs.mkdir(root, { recursive: true });
  await sweepStaleStaging(fs, root);

  let bytesToCopy = 0;
  for (const s of sources) bytesToCopy += s.isDir ? await sizeOf(fs, s.src) : (await fs.stat(s.src)).size;
  const free = await freeBytes(fs, root);
  if (free < DISK_FACTOR * bytesToCopy) {
    throw new SnapshotError("insufficient-disk", `need ${Math.ceil(DISK_FACTOR * bytesToCopy)} bytes free under ${root}, have ${free}`);
  }

  const createdMs = now();
  const baseId = `${SNAPSHOT_PREFIX}${utcStamp(createdMs)}-${slugLabel(label)}`;
  let id = baseId;
  for (let k = 2; (await exists(fs, join(root, id))) || (await exists(fs, join(root, `${id}.tmp-${process.pid}`))); k++) id = `${baseId}-${k}`;
  const finalDir = join(root, id);
  const staging = `${finalDir}.tmp-${process.pid}`;

  let result;
  try {
    await fs.mkdir(join(staging, "store"), { recursive: true });
    const copier = new Copier(fs, staging);
    for (const s of sources) {
      const dst = join(staging, ...s.dest.split("/"));
      if (s.isDir) {
        if (s.dest === "store" && (await isTableDir(fs, s.src))) await copier.copyTable(s.src, dst);
        else await copier.copyDir(s.src, dst);
      } else {
        try {
          await copier.copyFile(s.src, dst);
        } catch (e) {
          if (e?.code !== "ENOENT") throw e;
        }
      }
    }
    const files = [...copier.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const bytes = files.reduce((n, f) => n + f.bytes, 0);
    const manifest = {
      schema: SNAPSHOT_SCHEMA,
      id,
      createdAt: new Date(createdMs).toISOString(),
      label: label === undefined || label === null ? null : String(label),
      pluginVersion: pluginVersion ?? null,
      baseDbPath: baseAbs,
      contents: sources.map((s) => s.dest),
      bytes,
      fileCount: files.length,
      files,
    };
    await writeJsonAtomic(fs, join(staging, "snapshot.json"), manifest);
    await fsyncDir(fs, staging);
    await withWinRetry(() => fs.rename(staging, finalDir));
    result = { bytes, files: files.length };
  } catch (e) {
    await removeTree(fs, staging);
    throw e;
  }
  // The snapshot is complete from here on; nothing below may fail the create.
  const warnings = [];
  let pruned = [];
  try {
    await fsyncDir(fs, root);
  } catch (e) {
    warnings.push(`fsync of ${root} failed: ${e?.message ?? String(e)}`);
  }
  try {
    pruned = await pruneInternal(fs, stateAbs, maxKeep, id, snapshotsDir);
  } catch (e) {
    warnings.push(`pruning old snapshots failed: ${e?.message ?? String(e)}`);
  }
  return { id, dir: finalDir, bytes: result.bytes, files: result.files, pruned, warnings };
}

/**
 * List Node snapshots and the bash installer's legacy tarballs, newest first.
 * @param {{stateDir: string, snapshotsDir?: string}} opts
 * @returns {Promise<Array<{id: string, kind: "snapshot"|"legacy-tar", createdAt: string, label?: string, bytes: number}>>}
 */
export async function listSnapshots({ stateDir, snapshotsDir }) {
  return listInternal(nodeFs, resolve(stateDir), snapshotsDir);
}

async function listInternal(fs, stateAbs, snapshotsDir) {
  const root = snapshotsRoot(stateAbs, snapshotsDir);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(SNAPSHOT_PREFIX) && !STAGING_RE.test(e.name)) {
      let m;
      try {
        m = JSON.parse(await fs.readFile(join(root, e.name, "snapshot.json"), "utf8"));
      } catch (err) {
        if (err?.code === "ENOENT" || err instanceof SyntaxError) continue; // not a finished snapshot
        throw err;
      }
      if (m?.schema !== SNAPSHOT_SCHEMA) continue;
      const item = { id: e.name, kind: /** @type {const} */ ("snapshot"), createdAt: String(m.createdAt), bytes: Number(m.bytes) || 0 };
      if (typeof m.label === "string") item.label = m.label;
      out.push(item);
    } else if (e.isFile() && e.name.endsWith(".tar.gz")) {
      const st = await fs.stat(join(root, e.name));
      out.push({ id: e.name, kind: /** @type {const} */ ("legacy-tar"), createdAt: st.mtime.toISOString(), bytes: st.size });
    }
  }
  out.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/**
 * Re-hash every file against snapshot.json; extra, missing or changed files
 * are `digest-mismatch`.
 * @param {{dir: string}} opts
 * @returns {Promise<{id: string, files: number, bytes: number}>}
 */
export async function verifySnapshot({ dir }) {
  const fs = nodeFs;
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(join(dir, "snapshot.json"), "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") throw new SnapshotError("not-found", `no snapshot at ${dir}`);
    if (e instanceof SyntaxError) throw new SnapshotError("digest-mismatch", `snapshot.json in ${dir} is not valid JSON`);
    throw e;
  }
  if (manifest?.schema !== SNAPSHOT_SCHEMA || !Array.isArray(manifest.files)) {
    throw new SnapshotError("digest-mismatch", `snapshot.json in ${dir} is not a ${SNAPSHOT_SCHEMA} manifest`);
  }
  await verifyTree(fs, dir, manifest.files, (p) => p !== "snapshot.json");
  return { id: basename(dir), files: manifest.files.length, bytes: Number(manifest.bytes) || 0 };
}

/** Compare the files below `dir` (filtered) with manifest entries. */
async function verifyTree(fs, dir, entries, include, prefix = "") {
  const expected = new Map();
  for (const f of entries) {
    if (typeof f?.path !== "string" || !f.path.startsWith(prefix)) continue;
    expected.set(f.path.slice(prefix.length), f);
  }
  const actual = [];
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const rel = toPosix(relative(dir, p));
        if (!include(rel)) continue;
        if (!e.isFile()) throw new SnapshotError("digest-mismatch", `${rel} is not a regular file`);
        actual.push(rel);
      }
    }
  };
  await walk(dir);
  for (const rel of actual) if (!expected.has(rel)) throw new SnapshotError("digest-mismatch", `${prefix}${rel} is not listed in snapshot.json`);
  for (const [rel, f] of expected) {
    let got;
    try {
      got = await hashAndSync(fs, join(dir, ...rel.split("/")), { sync: false });
    } catch (e) {
      if (e?.code === "ENOENT") throw new SnapshotError("digest-mismatch", `${prefix}${rel} is missing`);
      throw e;
    }
    if (got.sha256 !== f.sha256 || got.bytes !== f.bytes) throw new SnapshotError("digest-mismatch", `${prefix}${rel} does not match its SHA-256`);
  }
}

/**
 * Compare the live store with a snapshot's `store/` manifest entries (HM1-R-F2): the same set of regular files
 * (symlinks are skipped, as the snapshot copy skips them), each with the recorded size and SHA-256. Read-only.
 * `unchanged: false` carries the first difference found in `detail`. Refusals (`not-found`, `unsafe-path`,
 * `digest-mismatch` for an unreadable manifest) throw a SnapshotError; the caller then restores as before.
 * @param {{stateDir: string, baseDbPath: string, id: string, fsImpl?: typeof nodeFs, snapshotsDir?: string}} opts
 * @returns {Promise<{unchanged: boolean, detail: string, files: number}>}
 */
export async function compareStoreWithSnapshot({ stateDir, baseDbPath, id, fsImpl, snapshotsDir }) {
  const fs = fsImpl ?? nodeFs;
  assertSafeId(id);
  const { stateAbs, baseAbs } = await assertSafeBase(fs, stateDir, baseDbPath, snapshotsDir);
  const dir = join(snapshotsRoot(stateAbs, snapshotsDir), id);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(join(dir, "snapshot.json"), "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") throw new SnapshotError("not-found", `snapshot ${id} not found`);
    if (e instanceof SyntaxError) throw new SnapshotError("digest-mismatch", `snapshot.json of ${id} is not valid JSON`);
    throw e;
  }
  if (manifest?.schema !== SNAPSHOT_SCHEMA || !Array.isArray(manifest.files)) {
    throw new SnapshotError("digest-mismatch", `snapshot.json of ${id} is not a ${SNAPSHOT_SCHEMA} manifest`);
  }
  const expected = new Map();
  for (const f of manifest.files) {
    if (typeof f?.path === "string" && f.path.startsWith("store/")) expected.set(f.path.slice("store/".length), f);
  }
  const differs = (detail) => ({ unchanged: false, detail, files: expected.size });
  const live = await resolveSource(fs, baseAbs);
  if (!live) return differs(`no store at ${baseAbs}`);
  if (!live.isDir) return differs(`${baseAbs} is not a directory`);
  const actual = (await listTree(fs, live.path)).map((p) => toPosix(relative(live.path, p)));
  for (const rel of actual) if (!expected.has(rel)) return differs(`store/${rel} is new since the snapshot`);
  if (actual.length !== expected.size) {
    const have = new Set(actual);
    const gone = [...expected.keys()].find((rel) => !have.has(rel));
    return differs(`store/${gone} is gone since the snapshot`);
  }
  for (const [rel, f] of expected) {
    let got;
    try {
      got = await hashAndSync(fs, join(live.path, ...rel.split("/")), { sync: false });
    } catch (e) {
      if (e?.code === "ENOENT") return differs(`store/${rel} is gone since the snapshot`);
      throw e;
    }
    if (got.bytes !== f.bytes || got.sha256 !== f.sha256) return differs(`store/${rel} changed since the snapshot`);
  }
  return { unchanged: true, detail: `all ${expected.size} store files match snapshot ${id}`, files: expected.size };
}

/**
 * Restore the store from a snapshot: verify, stage `<baseDbPath>.restore-<pid>`,
 * move the current store to `<baseDbPath>.pre-restore-<ts>` (kept: only an explicit purge
 * deletes it, HM1-R-F2), move the staged copy in. Needs free space
 * of at least 1.1 x the store bytes next to the store (`insufficient-disk`).
 * If moving the staged copy in fails and moving the old store back fails too,
 * the error thrown has `name` "RestoreRollbackError", `cause` (the first
 * error), `rollbackError`, and `preRestorePath` (where the old store now is).
 * @param {{stateDir: string, baseDbPath: string, id: string, fsImpl?: typeof nodeFs, snapshotsDir?: string}} opts
 * @returns {Promise<{id: string, baseDbPath: string, preRestorePath: string | null, files: number, bytes: number}>}
 */
export async function restoreSnapshot({ stateDir, baseDbPath, id, fsImpl, snapshotsDir }) {
  const fs = fsImpl ?? nodeFs;
  assertSafeId(id);
  const { stateAbs, baseAbs } = await assertSafeBase(fs, stateDir, baseDbPath, snapshotsDir);
  const dir = join(snapshotsRoot(stateAbs, snapshotsDir), id);
  if (!(await exists(fs, join(dir, "snapshot.json")))) throw new SnapshotError("not-found", `snapshot ${id} not found`);
  await verifySnapshot({ dir });
  const manifest = JSON.parse(await fs.readFile(join(dir, "snapshot.json"), "utf8"));

  const current = await resolveSource(fs, baseAbs);
  const target = current ? current.path : baseAbs;
  const staging = `${target}.restore-${process.pid}`;

  const storeBytes = manifest.files.filter((f) => typeof f?.path === "string" && f.path.startsWith("store/")).reduce((n, f) => n + (Number(f.bytes) || 0), 0);
  const spaceDir = await nearestExistingDir(fs, dirname(target));
  const free = await freeBytes(fs, spaceDir);
  if (free < DISK_FACTOR * storeBytes) {
    throw new SnapshotError("insufficient-disk", `need ${Math.ceil(DISK_FACTOR * storeBytes)} bytes free under ${spaceDir}, have ${free}`);
  }

  await removeTree(fs, staging);
  let preRestorePath = null;
  try {
    const copier = new Copier(fs, staging);
    await fs.mkdir(staging, { recursive: true });
    const storeSrc = join(dir, "store");
    if (await exists(fs, storeSrc)) {
      for (const f of await listTree(fs, storeSrc)) await copier.copyFile(f, join(staging, relative(storeSrc, f)));
    }
    await verifyTree(fs, staging, manifest.files, () => true, "store/");
    await fsyncDir(fs, staging);

    if (current) {
      const stamp = utcStamp(Date.now());
      preRestorePath = `${target}.pre-restore-${stamp}`;
      for (let k = 2; await exists(fs, preRestorePath); k++) preRestorePath = `${target}.pre-restore-${stamp}-${k}`;
      await withWinRetry(() => fs.rename(target, preRestorePath));
    }
    try {
      await withWinRetry(() => fs.rename(staging, target));
    } catch (e) {
      if (preRestorePath) {
        try {
          await withWinRetry(() => fs.rename(preRestorePath, target));
        } catch (rollbackError) {
          const err = new Error(
            `restore failed (${e?.message ?? String(e)}) and moving the previous store back failed too (${rollbackError?.message ?? String(rollbackError)}); the previous store is at ${preRestorePath}`,
            { cause: e },
          );
          err.name = "RestoreRollbackError";
          Object.assign(err, { rollbackError, preRestorePath });
          throw err;
        }
      }
      preRestorePath = null;
      throw e;
    }
    await fsyncDir(fs, dirname(target));
    return { id, baseDbPath: baseAbs, preRestorePath, files: manifest.files.length, bytes: Number(manifest.bytes) || 0 };
  } catch (e) {
    await removeTree(fs, staging);
    throw e;
  }
}

/**
 * Remove the oldest Node snapshots beyond `maxKeep`; legacy tarballs are never touched.
 * @param {{stateDir: string, maxKeep?: number, snapshotsDir?: string}} opts
 * @returns {Promise<string[]>} removed snapshot ids
 */
export async function pruneSnapshots({ stateDir, maxKeep = MAX_SNAPSHOTS, snapshotsDir }) {
  assertMaxKeep(maxKeep);
  const stateAbs = resolve(stateDir);
  await sweepStaleStaging(nodeFs, snapshotsRoot(stateAbs, snapshotsDir));
  return pruneInternal(nodeFs, stateAbs, maxKeep, null, snapshotsDir);
}

function assertMaxKeep(maxKeep) {
  if (!Number.isInteger(maxKeep) || maxKeep < 1) throw new RangeError(`maxKeep must be an integer >= 1, got ${maxKeep}`);
}

async function pruneInternal(fs, stateAbs, maxKeep, protectId, snapshotsDir) {
  assertMaxKeep(maxKeep);
  const node = (await listInternal(fs, stateAbs, snapshotsDir)).filter((s) => s.kind === "snapshot");
  const keep = new Set(node.slice(0, maxKeep).map((s) => s.id));
  if (protectId) keep.add(protectId);
  const removed = [];
  const root = snapshotsRoot(stateAbs, snapshotsDir);
  for (const s of node) {
    if (keep.has(s.id) || removed.length >= node.length - maxKeep) continue;
    await removeTree(fs, join(root, s.id));
    removed.push(s.id);
  }
  return removed;
}

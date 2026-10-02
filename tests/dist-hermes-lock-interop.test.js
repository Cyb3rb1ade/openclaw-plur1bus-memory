// tests/dist-hermes-lock-interop.test.js — the bindings-registry lock across languages (HM2 final review, harness
// cab7783): Node workers (binding.mjs withRegistryLock) and Python workers (the harness ExclusiveLockFile, a byte copy
// under tests/fixtures/hermes/python, listed in SOURCES.json) contend on one lock for about 10 s; holders of both
// languages die (SIGKILL; TerminateProcess on Windows) while holding it, so the other language must break their
// locks as stale.
//
// Every hold logs E (entered), then L (its verify refused: nothing written) or W (the guarded read-modify-write of a
// counter ran), then X (left), or D right before it kills itself. The protocol's guarantee is verify-before-write:
// a holder may be displaced only in the accepted put-back window (a waiter moved its live lock aside while a third
// process created a fresh one), and then its verify must refuse. So:
//   * a newcomer entering while others are inside is reported, and allowed only when every holder already inside
//     logs L before it leaves (as the harness stress test);
//   * no W while another holder that already wrote is still inside, and no W by a holder someone entered after;
//   * every section ends exactly once, and the counter equals the number of W (each completed section ran once).
// Skipped when no Python >= 3.11 is found, unless PLUR1BUS_REQUIRE_LOCK_INTEROP=1 (CI) makes that a failure.
// Never touches a real home: the lock lives in a temp dir.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { makeTempDir } from "./helpers/temp-dir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_DIR = join(HERE, "fixtures", "hermes", "python");
const NODE_WORKER = join(HERE, "helpers", "lock-interop-worker.mjs");
const PY_WORKER = join(HERE, "helpers", "lock-interop-worker.py");
const TARBALL = join(HERE, "fixtures", "hermes", "plur1bus-hermes-provider-0.1.0.tar.gz");
const RUN_MS = 10_000;

/** A Python >= 3.11 launcher as [command, ...prefixArgs], or null. */
function findPython() {
  const candidates = process.platform === "win32" ? [["python"], ["py", "-3"], ["python3"]] : [["python3"], ["python"]];
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys; print(int(sys.version_info >= (3, 11)))"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim() === "1") return [cmd, ...pre];
  }
  return null;
}

/** A file's bytes from a .tar.gz (plain ustar, as build-hermes-provider.mjs writes it). */
function tarMember(file, name) {
  const tar = gunzipSync(readFileSync(file));
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 500);
    const path = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    if (path === name) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Check the event log; returns { violations, overlaps, counts }. */
export function checkEvents(lines) {
  const violations = [];
  const overlaps = [];
  const inside = new Map(); // key -> { lost, wrote, mustLose }
  const ended = new Set();
  const counts = { E: 0, W: 0, L: 0, X: 0, D: 0 };
  for (const [i, line] of lines.entries()) {
    const [kind, id, seq] = line.split(" ");
    const key = `${id}#${seq}`;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (kind === "E") {
      if (inside.has(key) || ended.has(key)) violations.push(`line ${i + 1}: ${key} entered twice`);
      if (inside.size) {
        overlaps.push({ line: i + 1, newcomer: key, inside: [...inside.keys()] });
        for (const s of inside.values()) s.mustLose = true;
      }
      inside.set(key, { lost: false, wrote: false, mustLose: false });
      continue;
    }
    const s = inside.get(key);
    if (!s) {
      violations.push(`line ${i + 1}: ${kind} for ${key}, which is not inside`);
      continue;
    }
    if (kind === "L") s.lost = true;
    else if (kind === "W") {
      if (s.mustLose) violations.push(`line ${i + 1}: ${key} wrote although a newcomer entered after it (its verify should have refused)`);
      for (const [k, o] of inside) if (k !== key && o.wrote) violations.push(`line ${i + 1}: ${key} wrote while ${k}, which also wrote, was inside (double entry in the guarded section)`);
      s.wrote = true;
    } else if (kind === "X" || kind === "D") {
      if (s.mustLose && !s.lost) violations.push(`line ${i + 1}: ${key} was displaced (someone entered after it) but its verify did not refuse`);
      inside.delete(key);
      ended.add(key);
    } else violations.push(`line ${i + 1}: unknown event ${JSON.stringify(line)}`);
  }
  for (const k of inside.keys()) violations.push(`${k} never left (no X or D)`);
  return { violations, overlaps, counts };
}

describe("hermes registry lock: Node and Python on one lock", () => {
  const python = findPython();
  const required = process.env.PLUR1BUS_REQUIRE_LOCK_INTEROP === "1";

  it("finds Python >= 3.11 where CI requires it", { skip: !required && "PLUR1BUS_REQUIRE_LOCK_INTEROP is not set" }, () => {
    assert.ok(python, "PLUR1BUS_REQUIRE_LOCK_INTEROP=1 but no python3/python >= 3.11 was found");
  });

  it("the Python worker's _filelock.py is the provider tarball's (and so harness HEAD's) file", () => {
    const copy = readFileSync(join(PY_DIR, "_filelock.py"));
    const inTar = tarMember(TARBALL, "plur1bus/_filelock.py");
    assert.ok(inTar, "plur1bus/_filelock.py is in the provider fixture");
    assert.deepEqual(copy, inTar);
    const manifest = JSON.parse(tarMember(TARBALL, "plur1bus/MANIFEST.json").toString("utf8"));
    assert.equal(manifest.files["plur1bus/_filelock.py"], createHash("sha256").update(copy).digest("hex"));
  });

  it("the event checker accepts the documented displaced-holder case and rejects real double entries", () => {
    // accepted: a newcomer entered while a1 was inside, and a1's verify refused
    assert.deepEqual(checkEvents(["E a1 1", "E b1 1", "L a1 1", "X a1 1", "W b1 1", "X b1 1"]).violations, []);
    assert.equal(checkEvents(["E a1 1", "E b1 1", "L a1 1", "X a1 1", "W b1 1", "X b1 1"]).overlaps.length, 1);
    // rejected: the displaced holder wrote, or left without refusing, or two writers were inside together
    assert.equal(checkEvents(["E a1 1", "E b1 1", "W a1 1", "X a1 1", "W b1 1", "X b1 1"]).violations.length >= 1, true);
    assert.equal(checkEvents(["E a1 1", "W a1 1", "E b1 1", "W b1 1", "X b1 1", "X a1 1"]).violations.length >= 1, true);
    assert.equal(checkEvents(["E a1 1", "E b1 1", "X a1 1", "X b1 1"]).violations.length, 1);
    // a section that never ends, or ends twice
    assert.equal(checkEvents(["E a1 1"]).violations.length, 1);
    assert.equal(checkEvents(["E a1 1", "X a1 1", "X a1 1"]).violations.length, 1);
  });

  it(`2 Node and 2 Python holders for ${RUN_MS / 1000} s, dying while holding: never two writers, each section once`, { skip: !python && "no Python >= 3.11 (python3/python) on PATH", timeout: 180_000 }, async (t) => {
    const home = makeTempDir("hermes-lock-interop-");
    mkdirSync(join(home, "hosts"), { recursive: true });
    const until = Date.now() + RUN_MS;
    const spawned = { js: 0, py: 0 };
    const workers = [];
    const one = (lang, n, dieEvery) => new Promise((resolveRun) => {
      const loop = () => {
        if (Date.now() >= until) return resolveRun();
        const id = `${lang}${n}-${++spawned[lang]}`;
        const c = lang === "js"
          ? spawn(process.execPath, [NODE_WORKER, home, id, String(dieEvery), String(until)], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
          : spawn(python[0], [...python.slice(1), "-B", PY_WORKER, PY_DIR, home, id, String(dieEvery), String(until)], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
        let err = "";
        c.stderr.on("data", (d) => (err += d));
        c.on("exit", (code, signal) => {
          workers.push({ id, code, signal, err: err.trim() });
          loop(); // a worker that died holding the lock is replaced
        });
      };
      loop();
    });
    await Promise.all([one("js", 1, 6), one("js", 2, 9), one("py", 1, 6), one("py", 2, 9)]);

    const unexpected = workers.filter((w) => w.err);
    assert.deepEqual(unexpected.map((w) => `${w.id}: ${w.err}`), [], "workers raised errors");
    const lines = existsSync(join(home, "events.log")) ? readFileSync(join(home, "events.log"), "utf8").split("\n").filter(Boolean) : [];
    const { violations, overlaps, counts } = checkEvents(lines);
    const byLang = (kind, lang) => lines.filter((l) => l.startsWith(`${kind} ${lang}`)).length;
    const deaths = { js: byLang("D", "js"), py: byLang("D", "py") };
    t.diagnostic(`entries ${counts.E} (js ${byLang("E", "js")}, py ${byLang("E", "py")}), writes ${counts.W}, lost ${counts.L}, deaths js ${deaths.js} py ${deaths.py}, workers ${workers.length}`);
    for (const o of overlaps) t.diagnostic(`accepted overlap at line ${o.line}: ${o.newcomer} entered while ${o.inside.join(", ")} was inside; the displaced holder's verify refused`);
    assert.deepEqual(violations, []);
    const counter = existsSync(join(home, "counter")) ? Number(readFileSync(join(home, "counter"), "utf8")) : 0;
    assert.equal(counter, counts.W, "every completed section ran exactly once (no lost or doubled update)");
    assert.ok(deaths.js >= 1 && deaths.py >= 1, `holders of both languages died holding the lock (js ${deaths.js}, py ${deaths.py})`);
    assert.ok(byLang("W", "js") >= 3 && byLang("W", "py") >= 3, `both languages completed sections (js ${byLang("W", "js")}, py ${byLang("W", "py")})`);
    assert.ok(counts.L <= 4 * (deaths.js + deaths.py), `lost (${counts.L}) stays within 4 x deaths, as in the harness stress test`);
    const leftovers = existsSync(join(home, "hosts")) ? readdirSync(join(home, "hosts")).filter((n) => /\.(break|rel)-/.test(n)) : [];
    t.diagnostic(`moved-aside leftovers (swept after 60 s): ${leftovers.length}`);
  });
});

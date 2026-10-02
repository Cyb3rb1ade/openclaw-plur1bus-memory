// tests/dist-hermes-lock-interop.test.js — the bindings-registry lock across languages (HM2 final review, harness
// cab7783/c0e2575): Node workers (binding.mjs withRegistryLock) and Python workers (the harness ExclusiveLockFile, a
// byte copy under tests/fixtures/hermes/python, listed in SOURCES.json) on one lock, in two phases:
//   * contention: 3 Node and 3 Python holders for 8 s, dying (SIGKILL; TerminateProcess on Windows) every 3rd or 4th
//     hold while holding the lock, respawned in their own language, so concurrent breakers of both languages race;
//   * cross-language takeovers: 4 rounds in which only one language has live workers when a holder of the other
//     language dies holding the lock, so only the other language can break it (by the dead-pid rule; the 60 s rule
//     cannot fire in a round). Each direction must be seen in the log: a `py` holder entering right after a dead
//     `js` holder, and the reverse. A Node/Python stale-rule or hostname disagreement fails here, not by chance.
// Node's os.hostname() must equal Python's socket.gethostname() (the token's host field), checked up front.
//
// Every hold logs E (entered), then L (its verify refused: nothing written) or W (the guarded read-modify-write of a
// counter ran, a few ms after the verify), then X (left), or D right before it kills itself. The protocol's
// guarantee is verify-before-write: a holder may be displaced only in the accepted put-back window (a waiter moved
// its live lock aside while a third process created a fresh one), and then its verify must refuse. So:
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
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { RegistryLockLost, withRegistryLock } from "../scripts/dist/installer/hermes/binding.mjs";
import { checkEvents, takeovers } from "./helpers/lock-events.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_DIR = join(HERE, "fixtures", "hermes", "python");
const NODE_WORKER = join(HERE, "helpers", "lock-interop-worker.mjs");
const PY_WORKER = join(HERE, "helpers", "lock-interop-worker.py");
const PY_BREAK = join(HERE, "helpers", "lock-interop-break.py");
const TARBALL = join(HERE, "fixtures", "hermes", "plur1bus-hermes-provider-0.1.0.tar.gz");
const CONTENTION_MS = 8_000;
const CROSS_ROUNDS = [["py", "js"], ["js", "py"], ["py", "js"], ["js", "py"]]; // [breakers, victim]

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

describe("hermes registry lock: Node and Python on one lock", () => {
  const python = findPython();
  const required = process.env.PLUR1BUS_REQUIRE_LOCK_INTEROP === "1";

  it("finds Python >= 3.11 where CI requires it", { skip: !required && "PLUR1BUS_REQUIRE_LOCK_INTEROP is not set" }, () => {
    assert.ok(python, "PLUR1BUS_REQUIRE_LOCK_INTEROP=1 but no python3/python >= 3.11 was found");
  });

  it("Node's os.hostname() equals Python's socket.gethostname() (the lock token's host field)", { skip: !python && "no Python >= 3.11 (python3/python) on PATH" }, () => {
    const r = spawnSync(python[0], [...python.slice(1), "-B", "-c", "import socket; print(socket.gethostname())"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const py = r.stdout.replace(/\r?\n$/, "");
    assert.equal(py, hostname(), `Node os.hostname() ${JSON.stringify(hostname())} differs from Python socket.gethostname() ${JSON.stringify(py)}: neither side would judge the other's dead holder stale before 60 s`);
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

  it("a Python breaker whose stale judgement is overtaken never removes the live Node lock that replaced it (T8 double-break)", { skip: !python && "no Python >= 3.11 (python3/python) on PATH", timeout: 60_000 }, async () => {
    const home = makeTempDir("hermes-lock-break-");
    const sig = makeTempDir("hermes-lock-break-sig-");
    const lock = join(home, "hosts", ".hermes-bindings.lock");
    mkdirSync(join(home, "hosts"), { recursive: true });
    // a lock left by a holder long gone (stale by the 60 s rule on both sides)
    writeFileSync(lock, `999999 ${hostname()} 0 ${"d".repeat(32)}\n`);
    utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    let out = "";
    const child = spawn(python[0], [...python.slice(1), "-B", PY_BREAK, PY_DIR, lock, sig], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    child.stdout.on("data", (d) => (out += d));
    const exited = new Promise((r) => child.on("exit", r));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; !existsSync(join(sig, "judged")) && i < 400; i++) await sleep(25);
    assert.equal(readFileSync(join(sig, "judged"), "utf8"), "1", "Python judged the dead lock stale");
    // Node breaks the same stale lock and holds its own; then Python runs its break with the old judgement
    await withRegistryLock(home, async ({ assertHeld }) => {
      const mine = readFileSync(lock, "utf8");
      writeFileSync(join(sig, "go"), "");
      await exited;
      const r = JSON.parse(out.trim());
      assert.deepEqual(r, { judged: true, broke: false }, "the Python break saw another lock and put it back");
      assert.equal(readFileSync(lock, "utf8"), mine, "the live Node lock is in place");
      assert.doesNotThrow(() => assertHeld(), RegistryLockLost);
    });
    assert.equal(existsSync(lock), false, "released");
    assert.deepEqual(readdirSync(join(home, "hosts")).filter((n) => /\.(break|rel)-/.test(n)), []);
  });

  it("3+3 holders racing and dying, then cross-language takeovers both ways: never two writers, each section once", { skip: !python && "no Python >= 3.11 (python3/python) on PATH", timeout: 240_000 }, async (t) => {
    const home = makeTempDir("hermes-lock-interop-");
    mkdirSync(join(home, "hosts"), { recursive: true });
    const events = join(home, "events.log");
    const spawned = { js: 0, py: 0 };
    const workers = [];
    const start = (lang, n, dieEvery, until, stop) => {
      const id = `${lang}${n}-${++spawned[lang]}`;
      const c = lang === "js"
        ? spawn(process.execPath, [NODE_WORKER, home, id, String(dieEvery), String(until), stop], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
        : spawn(python[0], [...python.slice(1), "-B", PY_WORKER, PY_DIR, home, id, String(dieEvery), String(until), stop], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
      let err = "";
      c.stderr.on("data", (d) => (err += d));
      return new Promise((resolveExit) => c.on("exit", (code, signal) => {
        workers.push({ id, code, signal, err: err.trim() });
        resolveExit({ id, code, signal });
      }));
    };
    const readLines = () => (existsSync(events) ? readFileSync(events, "utf8").split("\n").filter(Boolean) : []);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // phase 1: contention, 3+3, frequent deaths, respawned in their own language
    const until = Date.now() + CONTENTION_MS;
    const noStop = join(home, "never-stop");
    const keep = (lang, n, dieEvery) => (async () => {
      while (Date.now() < until) await start(lang, n, dieEvery, until, noStop);
    })();
    await Promise.all([keep("js", 1, 3), keep("js", 2, 4), keep("js", 3, 3), keep("py", 1, 3), keep("py", 2, 4), keep("py", 3, 3)]);

    // phase 2: cross-language takeovers; in each round the victim's language has no other live worker
    for (const [k, [breaker, victim]] of CROSS_ROUNDS.entries()) {
      const stop = join(home, `stop-${k}`);
      const safety = Date.now() + 30_000;
      const breakers = [1, 2, 3].map((n) => start(breaker, 10 + n, 0, safety, stop));
      await sleep(200);
      const from = readLines().length;
      await start(victim, 20 + k, 1, safety, stop); // dies on its first hold, holding the lock
      // wait (bounded) until a breaker entered after the victim's death, then stop the round
      const deadline = Date.now() + 5_000;
      for (;;) {
        const after = readLines().slice(from);
        const d = after.findIndex((l) => l.startsWith(`D ${victim}`));
        if (d >= 0 && after.slice(d + 1).some((l) => l.startsWith("E "))) break;
        if (Date.now() > deadline) break;
        await sleep(50);
      }
      writeFileSync(stop, "");
      await Promise.all(breakers);
    }

    const unexpected = workers.filter((w) => w.err);
    assert.deepEqual(unexpected.map((w) => `${w.id}: ${w.err}`), [], "workers raised errors");
    const lines = readLines();
    const { violations, overlaps, counts } = checkEvents(lines);
    const byLang = (kind, lang) => lines.filter((l) => l.startsWith(`${kind} ${lang}`)).length;
    const deaths = { js: byLang("D", "js"), py: byLang("D", "py") };
    const took = takeovers(lines);
    t.diagnostic(`entries ${counts.E} (js ${byLang("E", "js")}, py ${byLang("E", "py")}), writes ${counts.W}, lost ${counts.L}, deaths js ${deaths.js} py ${deaths.py}, workers ${workers.length}`);
    t.diagnostic(`takeovers after a death: ${JSON.stringify(took)}`);
    for (const o of overlaps) t.diagnostic(`accepted overlap at line ${o.line}: ${o.newcomer} entered while ${o.inside.join(", ")} was inside; the displaced holder's verify refused`);
    assert.deepEqual(violations, []);
    const counter = existsSync(join(home, "counter")) ? Number(readFileSync(join(home, "counter"), "utf8")) : 0;
    assert.equal(counter, counts.W, "every completed section ran exactly once (no lost or doubled update)");
    assert.ok(took["js->py"] >= 1, `a Python holder broke a dead Node holder's lock (takeovers ${JSON.stringify(took)})`);
    assert.ok(took["py->js"] >= 1, `a Node holder broke a dead Python holder's lock (takeovers ${JSON.stringify(took)})`);
    // deaths are paced by the 1 s dead-pid rule (about one per second); the cross rounds add two per language
    assert.ok(deaths.js >= 2 && deaths.py >= 2 && deaths.js + deaths.py >= 8, `holders of both languages died holding the lock (js ${deaths.js}, py ${deaths.py})`);
    assert.ok(byLang("W", "js") >= 5 && byLang("W", "py") >= 5, `both languages completed sections (js ${byLang("W", "js")}, py ${byLang("W", "py")})`);
    assert.ok(counts.L <= 4 * (deaths.js + deaths.py), `lost (${counts.L}) stays within 4 x deaths, as in the harness stress test`);
    const leftovers = readdirSync(join(home, "hosts")).filter((n) => /\.(break|rel)-/.test(n));
    t.diagnostic(`moved-aside leftovers (swept after 60 s): ${leftovers.length}`);
  });
});

/**
 * tests/k2-lock-ceiling-deferred-release.test.js — K2.
 *
 *  1. Per-call `hardCeilingMs`: a lock from "another host" (pid not judgeable)
 *     is reclaimable after the ceiling instead of 10 × staleMs; the default is
 *     unchanged.
 *  2. Windows release that stays busy (EPERM/EBUSY) is retried on bounded,
 *     unref'd timers, and only ever removes a lock that still holds our nonce.
 *
 * Injected failures use the `platform` / `renameSync` / `releaseRetryDelaysMs`
 * seams, so no real Windows is needed. All waits are bounded.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acquireJobLock, JOB_LOCK_HARD_CEILING_FACTOR, releaseJobLock } from "../lib/job-lock.js";
import { tryAcquireOwnedLock, withRegistryLock } from "../lib/registry-lock.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const T = { timeout: 15_000 };
const STALE = 1_000;

function tempDir(t) {
  const dir = makeTempDir("k2-lock-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function age(p, ms) {
  const when = new Date(Date.now() - ms);
  utimesSync(p, when, when);
}

/** A lock written by a process on another host (e.g. the previous container). */
function foreignHostLock(dir, ageMs, name = "x.lock") {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({
    nonce: "old-container", pid: 4_000_001, host: `${hostname()}-old-container-id`, acquiredAt: "2026-10-05T00:00:00.000Z",
  }));
  age(p, ageMs);
  return p;
}

/** A lock held by a live process (our parent) on this host, no procStart info. */
function sameHostLiveLock(dir, ageMs, name = "live.lock") {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({
    nonce: "live-parent", pid: process.ppid, host: hostname(), acquiredAt: "2026-10-05T00:00:00.000Z",
  }));
  age(p, ageMs);
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 3_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

function busyError(code = "EPERM") {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe("K2 hardCeilingMs", T, () => {
  it("reclaims a foreign-host lock past the per-call ceiling, before 10 x staleMs", T, (t) => {
    const dir = tempDir(t);
    const p = foreignHostLock(dir, 3_500);
    const h = tryAcquireOwnedLock(p, { staleMs: STALE, hardCeilingMs: 3_000 });
    assert.ok(h, "lock past the ceiling must be reclaimed");
    h.release();
    assert.equal(existsSync(p), false);
  });

  it("does not reclaim a foreign-host lock that is under the ceiling", T, (t) => {
    const dir = tempDir(t);
    const p = foreignHostLock(dir, 2_000);
    assert.equal(tryAcquireOwnedLock(p, { staleMs: STALE, hardCeilingMs: 3_000 }), null);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).nonce, "old-container");
  });

  it("default is unchanged: 10 x staleMs", T, (t) => {
    const dir = tempDir(t);
    const young = foreignHostLock(dir, 9 * STALE, "young.lock");
    assert.equal(tryAcquireOwnedLock(young, { staleMs: STALE }), null);
    const old = foreignHostLock(dir, 11 * STALE, "old.lock");
    const h = tryAcquireOwnedLock(old, { staleMs: STALE });
    assert.ok(h);
    h.release();
  });

  it("an invalid hardCeilingMs falls back to the default", T, (t) => {
    const dir = tempDir(t);
    for (const bad of [0, -5, NaN, "abc"]) {
      const p = foreignHostLock(dir, 5 * STALE, `bad-${String(bad)}.lock`);
      assert.equal(tryAcquireOwnedLock(p, { staleMs: STALE, hardCeilingMs: bad }), null, String(bad));
    }
  });

  it("withRegistryLock honours it too", T, (t) => {
    const dir = tempDir(t);
    const p = foreignHostLock(dir, 3_500);
    assert.throws(
      () => withRegistryLock(p, () => "nie", { staleMs: STALE, timeoutMs: 100, retryMs: 10 }),
      /registry lock busy/,
    );
    assert.equal(withRegistryLock(p, () => "ok", { staleMs: STALE, hardCeilingMs: 3_000, timeoutMs: 500 }), "ok");
  });

  it("a ceiling never makes a live same-host holder stale before staleMs", T, (t) => {
    const dir = tempDir(t);
    const h = tryAcquireOwnedLock(join(dir, "own.lock"), { staleMs: 60_000, hardCeilingMs: 1 });
    assert.ok(h);
    // age is ~0 <= staleMs, so the ceiling is not even consulted
    assert.equal(tryAcquireOwnedLock(join(dir, "own.lock"), { staleMs: 60_000, hardCeilingMs: 1 }), null);
    h.release();
  });

  it("a live same-host holder at 5 x staleMs is NOT reaped by a 4 x ceiling (tryAcquireOwnedLock)", T, (t) => {
    const dir = tempDir(t);
    const p = sameHostLiveLock(dir, 5 * STALE);
    assert.equal(tryAcquireOwnedLock(p, { staleMs: STALE, hardCeilingMs: 4 * STALE }), null);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).nonce, "live-parent");
  });

  it("a live same-host holder at 5 x staleMs is NOT reaped by a 4 x ceiling (acquireJobLock)", T, (t) => {
    const dir = tempDir(t);
    const p = sameHostLiveLock(dir, 5 * STALE, "job-live.lock");
    assert.throws(
      () => acquireJobLock(p, { staleMs: STALE, hardCeilingMs: STALE * JOB_LOCK_HARD_CEILING_FACTOR }),
      /lock held/,
    );
    assert.equal(JSON.parse(readFileSync(p, "utf8")).nonce, "live-parent");
  });

  it("a live same-host holder is still reaped past 10 x staleMs (pid-reuse bound)", T, (t) => {
    const dir = tempDir(t);
    const p = sameHostLiveLock(dir, 11 * STALE);
    const h = tryAcquireOwnedLock(p, { staleMs: STALE, hardCeilingMs: 4 * STALE });
    assert.ok(h);
    h.release();
  });

  it("a foreign-host holder past the 4 x ceiling IS reaped (both entry points)", T, (t) => {
    const dir = tempDir(t);
    const a = foreignHostLock(dir, 5 * STALE, "a.lock");
    const h = tryAcquireOwnedLock(a, { staleMs: STALE, hardCeilingMs: 4 * STALE });
    assert.ok(h);
    h.release();
    const b = foreignHostLock(dir, 5 * STALE, "b.lock");
    assert.equal(acquireJobLock(b, { staleMs: STALE, hardCeilingMs: STALE * JOB_LOCK_HARD_CEILING_FACTOR }), b);
    releaseJobLock(b);
  });

  it("hardCeilingMs is clamped to >= staleMs and <= 10 x staleMs", T, (t) => {
    const dir = tempDir(t);
    // below staleMs: a foreign lock at 2 x staleMs must wait for staleMs, a lock at 0.5 x is never stale
    const young = foreignHostLock(dir, STALE / 2, "young.lock");
    assert.equal(tryAcquireOwnedLock(young, { staleMs: STALE, hardCeilingMs: 10 }), null);
    // clamped to staleMs: past staleMs it is reaped
    const mid = foreignHostLock(dir, 2 * STALE, "mid.lock");
    const h = tryAcquireOwnedLock(mid, { staleMs: STALE, hardCeilingMs: 10 });
    assert.ok(h);
    h.release();
    // above 10 x: cannot loosen the default bound
    const old = foreignHostLock(dir, 11 * STALE, "old.lock");
    const h2 = tryAcquireOwnedLock(old, { staleMs: STALE, hardCeilingMs: 100 * STALE });
    assert.ok(h2);
    h2.release();
  });

  it("acquireJobLock passes hardCeilingMs through; default unchanged", T, (t) => {
    const dir = tempDir(t);
    const p = foreignHostLock(dir, 4_500, "job.lock");
    assert.throws(() => acquireJobLock(p, { staleMs: STALE }), /lock held/);
    assert.equal(acquireJobLock(p, { staleMs: STALE, hardCeilingMs: STALE * JOB_LOCK_HARD_CEILING_FACTOR }), p);
    releaseJobLock(p);
    assert.equal(existsSync(p), false);
  });
});

describe("K2 deferred Windows release", T, () => {
  it("removes our own lock once the busy condition clears", T, async (t) => {
    const dir = tempDir(t);
    const p = join(dir, "own.lock");
    let busy = true;
    let calls = 0;
    const rename = (a, b) => {
      calls += 1;
      if (busy) throw busyError("EBUSY");
      return renameSync(a, b);
    };
    const h = tryAcquireOwnedLock(p, { platform: "win32", renameSync: rename, releaseRetryDelaysMs: [5, 10, 20, 40, 80] });
    assert.ok(h);
    h.release();
    assert.equal(existsSync(p), true, "still busy: lock remains after the synchronous settle window");
    busy = false;
    assert.ok(await waitFor(() => !existsSync(p)), "deferred retry must remove the lock");
    assert.deepEqual(readdirSync(dir), [], "no .rel- leftovers");
    assert.ok(calls > 1);
  });

  it("never removes a foreign lock that replaced ours while busy", T, async (t) => {
    const dir = tempDir(t);
    const p = join(dir, "own.lock");
    let busy = true;
    const rename = (a, b) => {
      if (busy) throw busyError("EPERM");
      return renameSync(a, b);
    };
    const h = tryAcquireOwnedLock(p, { platform: "win32", renameSync: rename, releaseRetryDelaysMs: [5, 10, 20] });
    assert.ok(h);
    h.release();
    // our lock is broken by someone else, who now holds a fresh one
    unlinkSync(p);
    writeFileSync(p, JSON.stringify({ nonce: "someone-else", pid: process.ppid, host: hostname(), acquiredAt: new Date().toISOString() }));
    busy = false;
    await sleep(300); // deferred schedule (5+10+20 ms) is long over
    assert.equal(JSON.parse(readFileSync(p, "utf8")).nonce, "someone-else", "foreign lock must survive");
    assert.deepEqual(readdirSync(dir), ["own.lock"], "foreign lock put back, nothing left over");
  });

  it("is bounded and does not keep retrying forever", T, async (t) => {
    const dir = tempDir(t);
    const p = join(dir, "own.lock");
    let calls = 0;
    const rename = () => { calls += 1; throw busyError("EPERM"); };
    const h = tryAcquireOwnedLock(p, { platform: "win32", renameSync: rename, releaseRetryDelaysMs: [5, 5, 5] });
    h.release();
    const afterSync = calls;
    await sleep(250);
    const settled = calls;
    assert.equal(settled - afterSync, 3, "exactly the configured number of deferred attempts");
    await sleep(100);
    assert.equal(calls, settled, "no further attempts");
    assert.equal(existsSync(p), true, "lock left for the stale rules");
    h.release(); // idempotent: no new schedule
    await sleep(50);
    assert.equal(calls, settled);
  });

  it("does not defer on non-Windows platforms", T, async (t) => {
    const dir = tempDir(t);
    const p = join(dir, "own.lock");
    let calls = 0;
    const rename = () => { calls += 1; throw busyError("EPERM"); };
    const h = tryAcquireOwnedLock(p, { platform: "linux", renameSync: rename, releaseRetryDelaysMs: [5, 5, 5] });
    h.release();
    assert.equal(calls, 1);
    await sleep(100);
    assert.equal(calls, 1);
  });

  it("withRegistryLock also defers a busy release", T, async (t) => {
    const dir = tempDir(t);
    const p = join(dir, "reg.lock");
    let busy = true;
    const rename = (a, b) => {
      if (busy) throw busyError("EPERM");
      return renameSync(a, b);
    };
    withRegistryLock(p, () => "x", { platform: "win32", renameSync: rename, releaseRetryDelaysMs: [5, 10, 20, 40] });
    assert.equal(existsSync(p), true);
    busy = false;
    assert.ok(await waitFor(() => !existsSync(p)));
  });
});

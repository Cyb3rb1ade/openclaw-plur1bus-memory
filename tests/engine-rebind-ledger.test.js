/**
 * tests/engine-rebind-ledger.test.js — torn-line repair and first-wins card lines.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { makeTempDir } from "./helpers/temp-dir.js";
import {
  createRebindLedger, rebindLedgerPath, rebindLockPath, rebindsRoot, repairTornLastLine,
} from "../engine/memory-ops/rebind-ledger.js";

const TIMEOUT = { timeout: 10_000 };

describe("rebind ledger", () => {
  it("repairs a torn last line before the next append", TIMEOUT, () => {
    // Production opens r+ (Windows cannot ftruncate an a+ handle).
    const baseDbPath = join(makeTempDir("rebind-ledger-"), "store");
    const ledger = createRebindLedger({ baseDbPath });
    const rebindId = "11111111-1111-4111-8111-111111111111";
    ledger.writeHeader(rebindId, {
      agentId: "agent-a",
      fromOwner: `user:v1:${"a".repeat(64)}`,
      toOwner: `user:v2:${"b".repeat(64)}`,
      createdAt: 1,
    });
    ledger.appendCard(rebindId, {
      cardId: "22222222-2222-4222-8222-222222222222",
      fromOwner: `user:v1:${"a".repeat(64)}`,
      toOwner: `user:v2:${"b".repeat(64)}`,
      fromUpdatedAt: 1,
    });
    const path = rebindLedgerPath(baseDbPath, rebindId);
    const fd = openSync(path, "a+", 0o600);
    writeSync(fd, '{"v":1,"kind":"card","torn":tru');
    closeSync(fd);
    assert.equal(readFileSync(path, "utf8").endsWith("\n"), false);

    ledger.appendCard(rebindId, {
      cardId: "33333333-3333-4333-8333-333333333333",
      fromOwner: `user:v1:${"a".repeat(64)}`,
      toOwner: `user:v2:${"b".repeat(64)}`,
      fromUpdatedAt: 2,
    });
    const rec = ledger.load(rebindId);
    assert.equal(rec.cards.length, 2);
    assert.equal(rec.cards[0].cardId, "22222222-2222-4222-8222-222222222222");
    assert.equal(rec.cards[1].cardId, "33333333-3333-4333-8333-333333333333");
    assert.equal(readFileSync(path, "utf8").includes("torn"), false);
  });

  it("duplicate card lines keep the first", TIMEOUT, () => {
    const baseDbPath = join(makeTempDir("rebind-ledger-dup-"), "store");
    const ledger = createRebindLedger({ baseDbPath });
    const rebindId = "44444444-4444-4444-8444-444444444444";
    const cardId = "55555555-5555-4555-8555-555555555555";
    ledger.writeHeader(rebindId, {
      agentId: "agent-a",
      fromOwner: `user:v1:${"c".repeat(64)}`,
      toOwner: `user:v2:${"d".repeat(64)}`,
      createdAt: 1,
    });
    ledger.appendCard(rebindId, { cardId, fromOwner: "x", toOwner: "y", fromUpdatedAt: 1 });
    ledger.appendCard(rebindId, { cardId, fromOwner: "x", toOwner: "y", fromUpdatedAt: 9 });
    const rec = ledger.load(rebindId);
    assert.equal(rec.cards.length, 1);
    assert.equal(rec.cards[0].fromUpdatedAt, 1);
  });

  it("repairTornLastLine truncates to the last newline", TIMEOUT, () => {
    const dir = makeTempDir("rebind-repair-");
    const file = join(dir, "x.jsonl");
    const fd = openSync(file, "w+", 0o600);
    writeSync(fd, "one\npartial");
    repairTornLastLine(fd);
    closeSync(fd);
    assert.equal(readFileSync(file, "utf8"), "one\n");
  });

  it("repairTornLastLine does not truncate a file with no newline to empty", TIMEOUT, () => {
    const dir = makeTempDir("rebind-repair-none-");
    const file = join(dir, "x.jsonl");
    const fd = openSync(file, "w+", 0o600);
    writeSync(fd, Buffer.alloc(100, 0x41));
    assert.throws(() => repairTornLastLine(fd), (e) => e.code === "LEDGER_CORRUPT");
    closeSync(fd);
    assert.equal(readFileSync(file).length, 100);
  });

  it("scans past 64 KiB of padding and keeps the header", TIMEOUT, () => {
    const baseDbPath = join(makeTempDir("rebind-ledger-pad-"), "store");
    mkdirSync(baseDbPath, { recursive: true });
    const ledger = createRebindLedger({ baseDbPath });
    const rebindId = "66666666-6666-4666-8666-666666666666";
    ledger.writeHeader(rebindId, {
      agentId: "agent-a",
      fromOwner: `user:v1:${"e".repeat(64)}`,
      toOwner: `user:v2:${"f".repeat(64)}`,
      createdAt: 1,
    });
    const path = rebindLedgerPath(baseDbPath, rebindId);
    const fd = openSync(path, "a+", 0o600);
    writeSync(fd, Buffer.alloc(70 * 1024, 0));
    closeSync(fd);
    ledger.appendCard(rebindId, {
      cardId: "77777777-7777-4777-8777-777777777777",
      fromOwner: `user:v1:${"e".repeat(64)}`,
      toOwner: `user:v2:${"f".repeat(64)}`,
      fromUpdatedAt: 1,
    });
    const rec = ledger.load(rebindId);
    assert.equal(rec.header.agentId, "agent-a");
    assert.equal(rec.cards.length, 1);
    assert.equal(existsSync(path), true);
  });

  it("quarantines a sidecar with no newline instead of truncating to empty", TIMEOUT, () => {
    const baseDbPath = join(makeTempDir("rebind-ledger-corr-"), "store");
    mkdirSync(join(baseDbPath, "_rebinds"), { recursive: true });
    const rebindId = "88888888-8888-4888-8888-888888888888";
    const path = rebindLedgerPath(baseDbPath, rebindId);
    writeFileSync(path, Buffer.alloc(70 * 1024, 0));
    const ledger = createRebindLedger({ baseDbPath });
    assert.throws(
      () => ledger.appendCard(rebindId, {
        cardId: "99999999-9999-4999-8999-999999999999",
        fromOwner: "x",
        toOwner: "y",
        fromUpdatedAt: 1,
      }),
      (e) => e.code === "ledger-corrupt",
    );
    assert.equal(existsSync(path), false);
    const names = readdirSync(join(baseDbPath, "_rebinds"));
    assert.ok(names.some((n) => n.includes(".corrupt-")));
  });

  it("fsyncs the parent directory once when a sidecar is created", TIMEOUT, () => {
    const baseDbPath = join(makeTempDir("rebind-ledger-fs-"), "store");
    mkdirSync(baseDbPath, { recursive: true });
    let n = 0;
    const ledger = createRebindLedger({
      baseDbPath,
      fsyncParent: () => { n += 1; },
    });
    const rebindId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    ledger.writeHeader(rebindId, {
      agentId: "agent-a",
      fromOwner: `user:v1:${"a".repeat(64)}`,
      toOwner: `user:v2:${"b".repeat(64)}`,
      createdAt: 1,
    });
    assert.equal(n, 1);
    ledger.appendCard(rebindId, {
      cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      fromOwner: `user:v1:${"a".repeat(64)}`,
      toOwner: `user:v2:${"b".repeat(64)}`,
      fromUpdatedAt: 1,
    });
    assert.equal(n, 1);
  });

  function deadPid() {
    for (let pid = 4_000_000; pid > 100_000; pid -= 7919) {
      try { process.kill(pid, 0); } catch (error) {
        if (error?.code === "ESRCH") return pid;
      }
    }
    throw new Error("no dead pid found");
  }

  function ageLock(path, ms) {
    const when = new Date(Date.now() - ms);
    utimesSync(path, when, when);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("does not steal a live holder's lock after staleMs", TIMEOUT, async () => {
    const baseDbPath = join(makeTempDir("rebind-lock-live-"), "store");
    const l1 = createRebindLedger({ baseDbPath });
    const l2 = createRebindLedger({ baseDbPath });
    let current = 0;
    let maxInside = 0;
    const hold = (ledger, ms) => ledger.withLock({ exclusive: true }, async () => {
      current += 1;
      maxInside = Math.max(maxInside, current);
      ageLock(rebindLockPath(baseDbPath), 120_000);
      await sleep(ms);
      current -= 1;
    });
    await Promise.all([hold(l1, 250), hold(l2, 50)]);
    assert.equal(maxInside, 1);
  });

  it("release does not delete a foreign lock", TIMEOUT, async () => {
    const baseDbPath = join(makeTempDir("rebind-lock-foreign-"), "store");
    const l1 = createRebindLedger({ baseDbPath });
    const lockPath = rebindLockPath(baseDbPath);
    await l1.withLock({ exclusive: true }, async () => {
      writeFileSync(lockPath, JSON.stringify({
        nonce: "foreign-nonce",
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
      }));
    });
    assert.equal(existsSync(lockPath), true);
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(raw.nonce, "foreign-nonce");
  });

  it("reaps a dead-pid lock older than staleMs", TIMEOUT, async () => {
    const baseDbPath = join(makeTempDir("rebind-lock-dead-"), "store");
    mkdirSync(rebindsRoot(baseDbPath), { recursive: true, mode: 0o700 });
    const lockPath = rebindLockPath(baseDbPath);
    writeFileSync(lockPath, JSON.stringify({
      nonce: "dead-nonce",
      pid: deadPid(),
      host: hostname(),
      acquiredAt: new Date().toISOString(),
    }));
    ageLock(lockPath, 70_000);
    const ledger = createRebindLedger({ baseDbPath });
    let entered = false;
    await ledger.withLock({ exclusive: true }, async () => { entered = true; });
    assert.equal(entered, true);
  });

  it("a clock 61s ahead does not grant entry while the holder is live", TIMEOUT, async () => {
    const baseDbPath = join(makeTempDir("rebind-lock-skew-"), "store");
    const l1 = createRebindLedger({ baseDbPath });
    const l2 = createRebindLedger({ baseDbPath, clock: () => Date.now() + 61_000 });
    let current = 0;
    let maxInside = 0;
    const hold = (ledger, ms) => ledger.withLock({ exclusive: true }, async () => {
      current += 1;
      maxInside = Math.max(maxInside, current);
      await sleep(ms);
      current -= 1;
    });
    await Promise.all([hold(l1, 250), hold(l2, 50)]);
    assert.equal(maxInside, 1);
  });

  it("writeClaim refuses a different toOwner and keeps the existing claim", TIMEOUT, () => {
    const baseDbPath = join(makeTempDir("rebind-claim-keep-"), "store");
    const ledger = createRebindLedger({ baseDbPath });
    const fromOwner = `user:v1:${"a".repeat(64)}`;
    const u1 = `user:v2:${"b".repeat(64)}`;
    const u2 = `user:v2:${"c".repeat(64)}`;
    ledger.writeClaim(fromOwner, u1);
    assert.throws(
      () => ledger.writeClaim(fromOwner, u2),
      (e) => e.code === "identity-already-bound",
    );
    assert.equal(ledger.readClaim(fromOwner).toOwner, u1);
  });

  it("a ledger write aborts with lock-lost when the nonce is gone", TIMEOUT, async () => {
    const baseDbPath = join(makeTempDir("rebind-lock-lost-"), "store");
    const ledger = createRebindLedger({ baseDbPath });
    const rebindId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await assert.rejects(
      () => ledger.withLock({ exclusive: true }, async () => {
        writeFileSync(rebindLockPath(baseDbPath), JSON.stringify({
          nonce: "stolen",
          pid: process.pid,
          host: hostname(),
          acquiredAt: new Date().toISOString(),
        }));
        ledger.writeHeader(rebindId, {
          agentId: "agent-a",
          fromOwner: `user:v1:${"a".repeat(64)}`,
          toOwner: `user:v2:${"b".repeat(64)}`,
          createdAt: 1,
        });
      }),
      (e) => e.code === "lock-lost",
    );
  });
});

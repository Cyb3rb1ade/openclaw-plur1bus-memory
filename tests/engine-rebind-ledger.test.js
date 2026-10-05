/**
 * tests/engine-rebind-ledger.test.js — torn-line repair and first-wins card lines.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { makeTempDir } from "./helpers/temp-dir.js";
import { createRebindLedger, rebindLedgerPath, repairTornLastLine } from "../engine/memory-ops/rebind-ledger.js";

const TIMEOUT = { timeout: 10_000 };

describe("rebind ledger", () => {
  it("repairs a torn last line before the next append", TIMEOUT, () => {
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
});

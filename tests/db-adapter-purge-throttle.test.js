/**
 * tests/db-adapter-purge-throttle.test.js
 *
 * Regression test for the hot-path purgeExpired throttle added in Scope C.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryDB } from "../index.js";

describe("MemoryDB.purgeExpiredThrottled", () => {
  it("calls purgeExpired only once within the throttle window", async () => {
    const db = new MemoryDB("/tmp/purge-throttle-test-db-a", 768);
    let calls = 0;
    db.purgeExpired = async () => {
      calls++;
    };

    await db.purgeExpiredThrottled();
    await db.purgeExpiredThrottled();
    await db.purgeExpiredThrottled();

    assert.strictEqual(calls, 1, "purgeExpired should be throttled to a single call");
  });

  it("calls purgeExpired again after the throttle window expires", async () => {
    const db = new MemoryDB("/tmp/purge-throttle-test-db-b", 768);
    let calls = 0;
    db.purgeExpired = async () => {
      calls++;
    };

    await db.purgeExpiredThrottled();

    // Advance time beyond the 5-minute throttle window.
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6 * 60 * 1000;
    try {
      await db.purgeExpiredThrottled();
    } finally {
      Date.now = originalNow;
    }

    assert.strictEqual(calls, 2, "purgeExpired should run again after throttle expires");
  });

  it("does not throw when purgeExpired fails", async () => {
    const db = new MemoryDB("/tmp/purge-throttle-test-db-c", 768);
    db.purgeExpired = async () => {
      throw new Error("db locked");
    };

    await assert.doesNotReject(() => db.purgeExpiredThrottled());
  });
});

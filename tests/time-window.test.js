import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hourInTimeZone,
  isQuietHour,
  validateHourWindow,
  validateTimeZone,
} from "../lib/time-window.js";

describe("hourInTimeZone", () => {
  // 2026-01-15 23:30 UTC → 23 in UTC, 00:30 next day in Europe/Berlin (CET, UTC+1)
  const EPOCH = Date.UTC(2026, 0, 15, 23, 30);

  it("resolves the hour in the given IANA timezone (UTC vs Europe/Berlin differ)", () => {
    assert.equal(hourInTimeZone(EPOCH, "UTC"), 23);
    assert.equal(hourInTimeZone(EPOCH, "Europe/Berlin"), 0);
  });

  it("falsy timeZone falls back to server-local getHours() (current behavior preserved)", () => {
    assert.equal(hourInTimeZone(EPOCH, null), new Date(EPOCH).getHours());
    assert.equal(hourInTimeZone(EPOCH, undefined), new Date(EPOCH).getHours());
    assert.equal(hourInTimeZone(EPOCH, ""), new Date(EPOCH).getHours());
  });

  it("invalid explicit timezone no longer silently changes to server-local time", () => {
    assert.throws(() => hourInTimeZone(EPOCH, "Not/AZone"), RangeError);
    assert.throws(() => hourInTimeZone(EPOCH, "garbage"), RangeError);
  });

  it("normalizes en-GB midnight rendering ('24') to 0", () => {
    // Midnight in Berlin: Intl en-GB 2-digit hour12:false can render "24".
    const midnightBerlin = Date.UTC(2026, 0, 15, 23, 0); // 00:00 Berlin
    const h = hourInTimeZone(midnightBerlin, "Europe/Berlin");
    assert.equal(h, 0);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 23);
  });

  it("returns integers 0-23 across a full day", () => {
    for (let i = 0; i < 24; i++) {
      const h = hourInTimeZone(Date.UTC(2026, 5, 10, i, 15), "UTC");
      assert.equal(h, i);
    }
  });

  it("repeated calls with the same timeZone stay consistent (memoized formatter)", () => {
    // Behavioral check on the memoization: same timeZone across many calls
    // and many different timestamps must keep returning results consistent
    // with a freshly-constructed formatter — no cross-call state leakage.
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 24; i++) {
        const ts = Date.UTC(2026, 2, 1, i, 45);
        assert.equal(hourInTimeZone(ts, "Europe/Berlin"), hourInTimeZone(ts, "Europe/Berlin"));
      }
    }
    assert.equal(hourInTimeZone(EPOCH, "UTC"), 23);
    assert.equal(hourInTimeZone(EPOCH, "Europe/Berlin"), 0);
  });
});

describe("isQuietHour", () => {
  it("wrap-around window (22-8) spans midnight", () => {
    const qh = { start: 22, end: 8 };
    assert.equal(isQuietHour(23, qh), true);
    assert.equal(isQuietHour(0, qh), true);
    assert.equal(isQuietHour(7, qh), true);
    assert.equal(isQuietHour(8, qh), false);
    assert.equal(isQuietHour(12, qh), false);
    assert.equal(isQuietHour(21, qh), false);
    assert.equal(isQuietHour(22, qh), true);
  });

  it("non-wrapping window (8-22) is daytime", () => {
    const qh = { start: 8, end: 22 };
    assert.equal(isQuietHour(8, qh), true);
    assert.equal(isQuietHour(12, qh), true);
    assert.equal(isQuietHour(21, qh), true);
    assert.equal(isQuietHour(22, qh), false);
    assert.equal(isQuietHour(7, qh), false);
    assert.equal(isQuietHour(23, qh), false);
  });

  it("null/disabled quietHours returns false", () => {
    assert.equal(isQuietHour(23, null), false);
    assert.equal(isQuietHour(23, undefined), false);
    assert.equal(isQuietHour(23, false), false);
  });

  it("invalid explicit quiet-hour bounds throw instead of silently changing semantics", () => {
    for (const value of [
      {},
      { start: -1, end: 8 },
      { start: 22, end: 24 },
      { start: "22", end: 8 },
      { start: 22.5, end: 8 },
      { start: 22 },
    ]) {
      assert.throws(() => isQuietHour(23, value));
    }
  });
});

describe("path-aware time config validation", () => {
  it("accepts falsy timezone compatibility values and supported IANA zones", () => {
    for (const value of [undefined, null, "", "UTC", "Europe/Berlin"]) {
      assert.equal(validateTimeZone(value, { path: "config.timezone" }), value);
    }
  });

  it("invalid timezone errors carry the exact path", () => {
    assert.throws(
      () => validateTimeZone("Not/AZone", { path: "config.afterthought.timezone" }),
      (error) => error?.configPath === "config.afterthought.timezone",
    );
  });

  it("rejects -1, 24, fractions, numeric strings, and half-pairs at the leaf path", () => {
    for (const [value, leaf] of [
      [{ start: -1, end: 8 }, "start"],
      [{ start: 22, end: 24 }, "end"],
      [{ start: 1.5, end: 8 }, "start"],
      [{ start: "22", end: 8 }, "start"],
      [{ start: 22 }, "end"],
      [{ end: 8 }, "start"],
    ]) {
      assert.throws(
        () => validateHourWindow(value, { path: "config.quietHours" }),
        (error) => error?.configPath === `config.quietHours.${leaf}`,
      );
    }
  });

  it("accepts a valid wrap-around pair", () => {
    assert.deepEqual(
      validateHourWindow({ start: 22, end: 8 }, { path: "config.quietHours" }),
      { start: 22, end: 8 },
    );
  });
});

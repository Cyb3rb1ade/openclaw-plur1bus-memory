import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hourInTimeZone, isQuietHour } from "../lib/time-window.js";

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

  it("invalid timezone fails open to server-local hour", () => {
    assert.equal(hourInTimeZone(EPOCH, "Not/AZone"), new Date(EPOCH).getHours());
    assert.equal(hourInTimeZone(EPOCH, "garbage"), new Date(EPOCH).getHours());
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

  it("null/invalid quietHours or non-integer bounds → false (fail-open)", () => {
    assert.equal(isQuietHour(23, null), false);
    assert.equal(isQuietHour(23, undefined), false);
    assert.equal(isQuietHour(23, false), false);
    assert.equal(isQuietHour(23, {}), false);
    assert.equal(isQuietHour(23, { start: "22", end: 8 }), false);
    assert.equal(isQuietHour(23, { start: 22.5, end: 8 }), false);
    assert.equal(isQuietHour(23, { start: 22 }), false);
  });
});

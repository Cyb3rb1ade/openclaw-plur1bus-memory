/**
 * Tests für lib/sql-safety.js — defense-in-depth helpers.
 * Run: node --test __tests__/sql-safety.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeUuid, safeUuidList, safeTimestamp } from "../lib/sql-safety.js";

const VALID = "a8925b50-0498-4e9f-acb6-855a2b7f9225";

test("safeUuid: valid UUID returns unchanged", () => {
  assert.equal(safeUuid(VALID), VALID);
});

test("safeUuid: rejects SQL injection attempt", () => {
  assert.throws(() => safeUuid("'; DROP TABLE memories;--"), /Invalid memory ID/);
});

test("safeUuid: rejects non-UUID string", () => {
  assert.throws(() => safeUuid("not-a-uuid"));
});

test("safeUuid: rejects null", () => {
  assert.throws(() => safeUuid(null));
});

test("safeUuid: rejects empty string", () => {
  assert.throws(() => safeUuid(""));
});

test("safeUuid: rejects too-long input", () => {
  assert.throws(() => safeUuid(VALID + "x"));
});

test("safeUuid: rejects too-short input", () => {
  assert.throws(() => safeUuid(VALID.slice(0, -1)));
});

test("safeUuid: case-insensitive (uppercase OK)", () => {
  const upper = VALID.toUpperCase();
  assert.equal(safeUuid(upper), upper);
});

test("safeTimestamp: current Date.now() is OK", () => {
  assert.ok(safeTimestamp(Date.now()) > 0);
});

test("safeTimestamp: rejects negative", () => {
  assert.throws(() => safeTimestamp(-1));
});

test("safeTimestamp: rejects NaN", () => {
  assert.throws(() => safeTimestamp(NaN));
});

test("safeTimestamp: rejects Infinity", () => {
  assert.throws(() => safeTimestamp(Infinity));
});

test("safeTimestamp: rejects unrealistically huge", () => {
  assert.throws(() => safeTimestamp(1e16));
});

test("safeTimestamp: floors decimals", () => {
  assert.equal(safeTimestamp(1234.56), 1234);
});

test("safeUuidList: mixed valid/invalid filters correctly", () => {
  const r = safeUuidList([VALID, "'; DROP--", VALID.replace("a", "b")]);
  assert.ok(r.includes(VALID));
  assert.ok(!r.includes("DROP"));
});

test("safeUuidList: empty array → null", () => {
  assert.equal(safeUuidList([]), null);
});

test("safeUuidList: all invalid → null", () => {
  assert.equal(safeUuidList(["x", "y", null]), null);
});

test("safeUuidList: respects maxItems cap", () => {
  const r = safeUuidList(Array(200).fill(VALID), 50);
  const count = (r.match(/'/g) || []).length / 2;
  assert.equal(count, 50);
});

test("safeUuidList: rejects non-array", () => {
  assert.throws(() => safeUuidList("not-an-array"));
});

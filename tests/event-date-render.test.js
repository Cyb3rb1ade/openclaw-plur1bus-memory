/**
 * tests/event-date-render.test.js
 *
 * V3a (recall.eventDateRender): event-date / event-ago attributes in the
 * <relevant-memories> block, only for records whose sidecar entry has a
 * resolved date, plus one instruction line. Off (absent or enabled: false)
 * renders byte-identically.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EVENT_DATE_INSTRUCTION, buildEventDateAttributes, formatEventDate } from "../lib/event-date-render.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0); // 2026-11-20
const day = (ymd) => ({ from: ymd, until: ymd, precision: "day" });

describe("formatEventDate", () => {
  it("days, weeks, months and years relative to today", () => {
    assert.deepEqual(formatEventDate(day("2026-11-20"), { now: NOW, timeZone: "UTC" }), { date: "2026-11-20", ago: "today" });
    assert.deepEqual(formatEventDate(day("2026-11-19"), { now: NOW, timeZone: "UTC" }), { date: "2026-11-19", ago: "yesterday" });
    assert.deepEqual(formatEventDate(day("2026-11-10"), { now: NOW, timeZone: "UTC" }), { date: "2026-11-10", ago: "10 days ago" });
    assert.deepEqual(formatEventDate(day("2026-10-20"), { now: NOW, timeZone: "UTC" }), { date: "2026-10-20", ago: "4 weeks ago" });
    assert.deepEqual(formatEventDate(day("2026-05-07"), { now: NOW, timeZone: "UTC" }), { date: "2026-05-07", ago: "6 months ago" });
    assert.deepEqual(formatEventDate(day("2023-11-01"), { now: NOW, timeZone: "UTC" }), { date: "2023-11-01", ago: "3 years ago" });
    assert.deepEqual(formatEventDate(day("2026-11-23"), { now: NOW, timeZone: "UTC" }), { date: "2026-11-23", ago: "in 3 days" });
  });

  it("month and year precision, spans and the current span", () => {
    assert.deepEqual(formatEventDate({ from: "2026-10-01", until: "2026-10-31", precision: "month" }, { now: NOW, timeZone: "UTC" }), { date: "2026-10", ago: "last month" });
    assert.deepEqual(formatEventDate({ from: "2027-06-01", until: "2027-06-30", precision: "month" }, { now: NOW, timeZone: "UTC" }), { date: "2027-06", ago: "in 7 months" });
    assert.deepEqual(formatEventDate({ from: "2024-01-01", until: "2024-12-31", precision: "year" }, { now: NOW, timeZone: "UTC" }), { date: "2024", ago: "2 years ago" });
    assert.deepEqual(formatEventDate({ from: "2026-11-09", until: "2026-11-15", precision: "week" }, { now: NOW, timeZone: "UTC" }), { date: "2026-11-09..2026-11-15", ago: "5 days ago" });
    assert.deepEqual(formatEventDate({ from: "2026-11-16", until: "2026-11-22", precision: "week" }, { now: NOW, timeZone: "UTC" }), { date: "2026-11-16..2026-11-22", ago: "current" });
  });

  it("today depends on the time zone", () => {
    const lateEvening = Date.UTC(2026, 10, 20, 23, 30); // 00:30 on the 21st in Berlin
    assert.equal(formatEventDate(day("2026-11-20"), { now: lateEvening, timeZone: "UTC" }).ago, "today");
    assert.equal(formatEventDate(day("2026-11-20"), { now: lateEvening, timeZone: "Europe/Berlin" }).ago, "yesterday");
  });

  it("an invalid zone is reported and today is taken in UTC", () => {
    const errors = [];
    assert.equal(formatEventDate(day("2026-11-19"), { now: NOW, timeZone: "Mars/Olympus", onError: (e) => errors.push(e) }).ago, "yesterday");
    assert.equal(errors.length, 1);
  });

  it("no attributes without a valid resolved date", () => {
    assert.equal(buildEventDateAttributes(null, { now: NOW }), "");
    assert.equal(buildEventDateAttributes({ from: "2026-13-01", until: "2026-13-01" }, { now: NOW }), "");
    assert.equal(buildEventDateAttributes({ from: "2026-11-02", until: "2026-11-01" }, { now: NOW }), "");
    assert.equal(buildEventDateAttributes(day("2026-11-19"), { now: NOW, timeZone: "UTC" }), ' event-date="2026-11-19" event-ago="yesterday"');
  });
});

describe("formatRelevantMemoriesContext with eventDateRender", () => {
  const items = () => [
    { id: "a", category: "fact", source: "memory", display: "Melanie went camping.", createdAt: NOW - 3 * 86_400_000, memoryStrength: 1, event: day("2026-11-15") },
    { id: "b", category: "fact", source: "memory", display: "Oscar is a retriever.", createdAt: NOW - 86_400_000, memoryStrength: 1 },
  ];

  it("adds the attributes after the temporal attributes and one instruction line", () => {
    const block = formatRelevantMemoriesContext(items(), { now: NOW, eventDateRender: { enabled: true, timeZone: "UTC" } });
    assert.match(block, /id="a"[^>]*created-at="[^"]+" age="3d ago" freshness="[a-z]+" event-date="2026-11-15" event-ago="5 days ago"/);
    assert.doesNotMatch(block.split("\n").find((l) => l.includes('id="b"')), /event-date/);
    assert.equal(block.split(EVENT_DATE_INSTRUCTION).length, 2, "instruction exactly once");
    assert.ok(block.indexOf("RELATIVE TIME:") < block.indexOf("EVENT DATE:"));
  });

  it("no instruction when no record has an event date", () => {
    const block = formatRelevantMemoriesContext(items().map(({ event: _event, ...rest }) => rest), { now: NOW, eventDateRender: { enabled: true, timeZone: "UTC" } });
    assert.doesNotMatch(block, /EVENT DATE|event-date/);
  });

  it("off renders byte-identically, even when items carry an event", () => {
    const plain = formatRelevantMemoriesContext(items().map(({ event: _event, ...rest }) => rest), { now: NOW });
    assert.equal(formatRelevantMemoriesContext(items(), { now: NOW }), plain);
    assert.equal(formatRelevantMemoriesContext(items(), { now: NOW, eventDateRender: { enabled: false } }), plain);
  });

  it("uses the block's time zone when the switch names none", () => {
    const lateEvening = Date.UTC(2026, 10, 20, 23, 30);
    const block = formatRelevantMemoriesContext([{ ...items()[0], event: day("2026-11-20") }], { now: lateEvening, timeZone: "Europe/Berlin", eventDateRender: { enabled: true } });
    assert.match(block, /event-ago="yesterday"/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { parseReminderIntent } from "../lib/reminder-parser.js";

describe("reminder-parser", () => {
  const now = 1_700_000_000_000;

  it("parses DE relative time: in 10 Minuten", () => {
    const r = parseReminderIntent("Gucken wir uns das in 10 Minuten an", { now });
    assert.strictEqual(r.timePrecision, "relative");
    assert.strictEqual(r.remindAt, now + 10 * 60_000);
    assert.strictEqual(r.requiresConfirmation, false);
  });

  it("parses DE vague: später", () => {
    const r = parseReminderIntent("Ich schaue das später an", { now });
    assert.strictEqual(r.timePrecision, "vague");
    assert.strictEqual(r.requiresConfirmation, true);
    assert.strictEqual(r.remindAt, now + 120 * 60_000);
  });

  it("parses EN relative time: in 30 minutes", () => {
    const r = parseReminderIntent("Let's check in 30 minutes", { now });
    assert.strictEqual(r.timePrecision, "relative");
    assert.strictEqual(r.remindAt, now + 30 * 60_000);
  });

  it("parses half an hour", () => {
    const r = parseReminderIntent("in half an hour", { now });
    assert.strictEqual(r.remindAt, now + 30 * 60_000);
  });

  it("parses einer halben Stunde", () => {
    const r = parseReminderIntent("in einer halben Stunde", { now });
    assert.strictEqual(r.remindAt, now + 30 * 60_000);
  });

  it("returns none for no temporal hint", () => {
    const r = parseReminderIntent("Das ist interessant", { now });
    assert.strictEqual(r.timePrecision, "none");
    assert.strictEqual(r.remindAt, null);
  });

  it("parses DE hours: in 2 Stunden", () => {
    const r = parseReminderIntent("in 2 Stunden", { now });
    assert.strictEqual(r.timePrecision, "relative");
    assert.strictEqual(r.remindAt, now + 2 * 60 * 60_000);
  });

  it("parses EN days: in 1 day", () => {
    const r = parseReminderIntent("in 1 day", { now });
    assert.strictEqual(r.timePrecision, "relative");
    assert.strictEqual(r.remindAt, now + 1440 * 60_000);
  });
});

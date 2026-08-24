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

  // Regression: vage Zeitangaben erzeugten inhaltslose Reminder ("später", "bald").
  // Der gespeicherte Text war nur die Floskel selbst, ohne Thema — der Agent
  // konfabulierte beim Nudge ein Thema dazu. Vager Zweig ist entfernt.
  it("ignores DE vague: später", () => {
    const r = parseReminderIntent("Ich schaue das später an", { now });
    assert.strictEqual(r.timePrecision, "none");
    assert.strictEqual(r.remindAt, null);
    assert.strictEqual(r.requiresConfirmation, false);
  });

  for (const vague of ["Ich schaue das später an", "Ich melde mich bald", "Machen wir nachher", "I will check later", "coming soon"]) {
    it(`ignores vague phrase: ${vague}`, () => {
      const r = parseReminderIntent(vague, { now });
      assert.strictEqual(r.timePrecision, "none");
      assert.strictEqual(r.remindAt, null);
    });
  }

  // Regression: "bald" wurde per lower.includes() als Substring gematcht.
  it("does not match vague words inside longer words", () => {
    for (const text of ["Eva nimmt abends Baldrian", "Die Mobilisation läuft", "Alsbald war es vorbei"]) {
      const r = parseReminderIntent(text, { now });
      assert.strictEqual(r.timePrecision, "none", text);
    }
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

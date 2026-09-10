import { describe, it } from "node:test";
import assert from "node:assert";
import { planReminderExtraction, buildReminderText } from "../lib/reminder-extraction.js";

describe("reminder-extraction gates", () => {
  const now = 1_700_000_000_000;
  const userItem = { role: "user", text: "Erinnere mich in 10 Minuten" };

  it("extracts from a user item with a relative time", () => {
    const r = planReminderExtraction(userItem, { now });
    assert.strictEqual(r.skip, false);
    assert.strictEqual(r.parsed.remindAt, now + 10 * 60_000);
  });

  // Regression: source = it.role === "user" ? "user" : "agent" — auch die eigenen
  // Nachrichten des Agenten erzeugten Reminder ("ich melde mich in einer halben
  // Stunde"), was eine selbstverstaerkende Schleife ergab.
  it("skips agent items", () => {
    const r = planReminderExtraction(
      { role: "assistant", text: "Ich melde mich in einer halben Stunde" },
      { now },
    );
    assert.strictEqual(r.skip, true);
    assert.strictEqual(r.reason, "not_user_role");
  });

  it("skips items with a missing or unknown role", () => {
    for (const role of [undefined, null, "", "system", "tool"]) {
      const r = planReminderExtraction({ role, text: "in 10 Minuten" }, { now });
      assert.strictEqual(r.skip, true, `role=${String(role)}`);
      assert.strictEqual(r.reason, "not_user_role");
    }
  });

  it("skips everything when the feature is disabled", () => {
    const r = planReminderExtraction(userItem, { now, enabled: false });
    assert.strictEqual(r.skip, true);
    assert.strictEqual(r.reason, "disabled");
  });

  it("is enabled by default", () => {
    assert.strictEqual(planReminderExtraction(userItem, { now }).skip, false);
    assert.strictEqual(planReminderExtraction(userItem, { now, enabled: true }).skip, false);
  });

  it("skips user items without a parsable time", () => {
    const r = planReminderExtraction({ role: "user", text: "Ich schaue das später an" }, { now });
    assert.strictEqual(r.skip, true);
    assert.strictEqual(r.reason, "no_time");
  });

  it("tolerates malformed items", () => {
    for (const item of [null, undefined, {}, { role: "user" }, { role: "user", text: null }]) {
      const r = planReminderExtraction(item, { now });
      assert.strictEqual(r.skip, true);
    }
  });
});

// Regression: gespeichert wurde nur parsed.evidence ("in 10 minuten"), also die
// Zeitfloskel ohne Thema. Beim faelligen Nudge fehlte dem Agenten der Gegenstand.
describe("reminder-extraction loop guards (7.12.24)", () => {
  const now = 1_700_000_000_000;

  // Regression 09.09.2026: die Reminder-Nudge zitiert den Reminder-Text samt
  // Zeitfloskel; im naechsten Capture wurde daraus wieder ein Reminder
  // ("in 1 minute" alle paar Minuten, 23 Stueck an einem Tag).
  it("ignores time phrases inside an embedded reminder nudge", () => {
    const text = "<reminder-nudge>\n⏰ Fällige Erinnerungen:\n  • \"in 1 minute\" (fällig seit 3m)\n</reminder-nudge>\n\nDanke, alles klar!";
    const r = planReminderExtraction({ role: "user", text }, { now });
    assert.strictEqual(r.skip, true);
    assert.strictEqual(r.reason, "no_time");
  });

  it("skips reminders that carry nothing but the time phrase", () => {
    for (const text of ["in 1 minute", "In 10 Minuten.", "  in 2 hours "]) {
      const r = planReminderExtraction({ role: "user", text }, { now });
      assert.strictEqual(r.skip, true, text);
      assert.strictEqual(r.reason, "no_topic", text);
    }
  });

  it("still extracts a reminder with a topic next to the phrase", () => {
    const r = planReminderExtraction({ role: "user", text: "Erinnere mich in 10 Minuten an den Tee" }, { now });
    assert.strictEqual(r.skip, false);
    assert.match(r.reminderText, /Tee/);
  });

  it("keeps the user's own request when a nudge precedes it", () => {
    const text = "<reminder-nudge>\n  • \"in 1 minute\" (due 3m ago)\n</reminder-nudge>\nErinnere mich in 5 Minuten an die Waschmaschine";
    const r = planReminderExtraction({ role: "user", text }, { now });
    assert.strictEqual(r.skip, false);
    assert.strictEqual(r.parsed.remindAt, now + 5 * 60_000);
    assert.match(r.reminderText, /Waschmaschine/);
    assert.doesNotMatch(r.reminderText, /reminder-nudge/);
  });
});

describe("buildReminderText", () => {
  it("keeps the sentence that carries the time phrase", () => {
    const t = buildReminderText("Erinnere mich in 10 Minuten an den Kuchen im Ofen", "in 10 minuten");
    assert.match(t, /Kuchen im Ofen/);
    assert.match(t, /in 10 Minuten/);
  });

  it("picks only the relevant sentence out of a longer message", () => {
    const full = "Guten Morgen! Ich gehe gleich einkaufen. Sag mir in 20 Minuten Bescheid wegen der Wäsche. Bis später.";
    const t = buildReminderText(full, "in 20 minuten");
    assert.match(t, /Wäsche/);
    assert.ok(!/Guten Morgen/.test(t), "andere Sätze bleiben draussen");
    assert.ok(!/einkaufen/.test(t), "andere Sätze bleiben draussen");
  });

  it("collapses whitespace and caps the length", () => {
    const long = "Bitte erinnere mich in 5 Minuten an " + "sehr wichtige Sache ".repeat(40);
    const t = buildReminderText(long, "in 5 minuten");
    assert.ok(t.length <= 200, `zu lang: ${t.length}`);
    assert.match(t, /erinnere mich in 5 Minuten/);
  });

  it("falls back to the evidence when the phrase is not found", () => {
    assert.strictEqual(buildReminderText("kein Treffer hier", "in 10 minuten"), "in 10 minuten");
    assert.strictEqual(buildReminderText("", "in 10 minuten"), "in 10 minuten");
    assert.strictEqual(buildReminderText(null, "in 10 minuten"), "in 10 minuten");
  });

  it("is wired into planReminderExtraction", () => {
    const r = planReminderExtraction(
      { role: "user", text: "Erinnere mich in 10 Minuten an den Kuchen" },
      { now: 1_700_000_000_000 },
    );
    assert.strictEqual(r.skip, false);
    assert.match(r.reminderText, /Kuchen/);
  });
});

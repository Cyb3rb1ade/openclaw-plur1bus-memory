import { describe, it } from "node:test";
import assert from "node:assert";
import { planReminderExtraction } from "../lib/reminder-extraction.js";

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

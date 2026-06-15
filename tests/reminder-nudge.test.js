import { describe, it } from "node:test";
import assert from "node:assert";
import { formatReminderNudge } from "../lib/reminder-nudge.js";

describe("reminder-nudge", () => {
  it("formats a basic due reminder", () => {
    const nudge = formatReminderNudge([
      { id: "r1", text: "test reminder", remindAt: Date.now() - 60_000 },
    ], { lang: "en" });

    assert.ok(nudge.includes("Due reminders"), "has English header");
    assert.ok(nudge.includes("test reminder"), "includes reminder text");
    assert.ok(nudge.includes("reminder-nudge"), "has reminder-nudge tag");
  });

  it("handles BigInt remindAt values returned from LanceDB", () => {
    const now = Date.now();
    const nudge = formatReminderNudge([
      { id: "r1", text: "bigint reminder", remindAt: BigInt(now - 120_000) },
    ], { lang: "en" });

    assert.ok(nudge.includes("Due reminders"), "has English header");
    assert.ok(nudge.includes("bigint reminder"), "includes reminder text");
    assert.ok(nudge.includes("reminder-nudge"), "has reminder-nudge tag");
  });
});

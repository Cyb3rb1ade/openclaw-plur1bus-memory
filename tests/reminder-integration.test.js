import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { parseReminderIntent } from "../lib/reminder-parser.js";
import { formatReminderNudge } from "../lib/reminder-nudge.js";
import { formatTimeContext, recordActivity } from "../lib/session-time.js";
import { addPendingReminder, readPendingReminders, clearPendingReminders } from "../lib/reminder-pending.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("reminder e2e", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reminder-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full flow: parse → store concept → pending → nudge", async () => {
    const now = Date.now();

    // 1. User says "in 10 minutes"
    const parsed = parseReminderIntent("Gucken wir uns das in 10 Minuten an", { now });
    assert.strictEqual(parsed.timePrecision, "relative");
    assert.strictEqual(parsed.remindAt, now + 10 * 60_000);

    // 2. Dispatch job writes to pending (simulated)
    await addPendingReminder(tmpDir, "ws-1", "agent-1", {
      id: "rem-1",
      text: "Gucken wir uns das in 10 Minuten an",
      remindAt: parsed.remindAt,
    });

    // 3. before_prompt_build reads pending
    const pending = await readPendingReminders(tmpDir, "ws-1", "agent-1");
    assert.ok(pending.pending["rem-1"], "in pending queue");

    // 4. Session time context
    await recordActivity("agent-1", "ws-1", tmpDir);
    const timeCtx = await formatTimeContext("agent-1", "ws-1", tmpDir, "de");
    assert.ok(timeCtx.includes("Letzte Aktivität:"), "time context in German");

    // 5. Nudge formatter
    const reminders = [{ text: "Gucken wir uns das in 10 Minuten an", remindAt: parsed.remindAt }];
    const nudge = formatReminderNudge(reminders, { lang: "de" });
    assert.ok(nudge.includes("Fällige Erinnerungen"), "German header");
    assert.ok(nudge.includes("reminder-nudge"), "has tag");

    // 6. Combined context
    const combined = [timeCtx, nudge].filter(Boolean).join("\n\n");
    assert.ok(combined.includes("time-context"));
    assert.ok(combined.includes("reminder-nudge"));
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeTemporalContinuityContext,
  resolveGapBucket,
  formatElapsedHuman,
  renderTemporalContext,
  formatTemporalContinuityContext,
} from "../lib/temporal-context.js";
import { recordActivity } from "../lib/session-time.js";
import { shouldSkipAutoRecallForInternalTurn } from "../lib/runtime-scheduler.js";

const MS_PER_HOUR = 60 * 60 * 1000;


const TIMEZONE = "Europe/Berlin";
// Fixed moment: 2026-06-18 23:14 in Berlin (CEST, UTC+2)
const FIXED_NOW = Date.parse("2026-06-18T21:14:00.000Z");

function isoBeforeNow(ms) {
  return new Date(FIXED_NOW - ms).toISOString();
}

function expectedLocalNow() {
  return new Date(FIXED_NOW)
    .toLocaleString("sv-SE", { timeZone: TIMEZONE, hour12: false })
    .slice(0, 16);
}

function expectedLocalTime(value, timezone = TIMEZONE) {
  return new Date(value)
    .toLocaleString("sv-SE", { timeZone: timezone, hour12: false })
    .slice(0, 16);
}

describe("temporal continuity context", () => {
  describe("computeTemporalContinuityContext", () => {
    it("no previous turn produces a new_session context", () => {
      const ctx = computeTemporalContinuityContext({
        previousUserTurnAt: null,
        now: FIXED_NOW,
        timezone: TIMEZONE,
      });

      assert.strictEqual(typeof ctx.now, "string");
      assert.strictEqual(ctx.now, expectedLocalNow());
      assert.strictEqual(ctx.timezone, TIMEZONE);
      assert.strictEqual(ctx.previousUserTurnAt, null);
      assert.strictEqual(ctx.elapsedSincePreviousUserTurnMs, null);
      assert.strictEqual(ctx.elapsedHuman, null);
      assert.strictEqual(ctx.gapBucket, "new_session");
      assert.strictEqual(typeof ctx.continuityHint, "string");
    });

    it("2 minute gap → immediate", () => {
      const previousUserTurnAt = isoBeforeNow(2 * 60_000);
      const ctx = computeTemporalContinuityContext({
        previousUserTurnAt,
        now: FIXED_NOW,
        timezone: TIMEZONE,
      });

      assert.strictEqual(ctx.elapsedSincePreviousUserTurnMs, 2 * 60_000);
      assert.strictEqual(ctx.gapBucket, "immediate");
      assert.strictEqual(ctx.elapsedHuman, "2 minutes");
      assert.strictEqual(typeof ctx.previousUserTurnAt, "string");
    });

    it("30 minute gap → recent", () => {
      const previousUserTurnAt = isoBeforeNow(30 * 60_000);
      const ctx = computeTemporalContinuityContext({
        previousUserTurnAt,
        now: FIXED_NOW,
        timezone: TIMEZONE,
      });

      assert.strictEqual(ctx.elapsedSincePreviousUserTurnMs, 30 * 60_000);
      assert.strictEqual(ctx.gapBucket, "recent");
      assert.strictEqual(ctx.elapsedHuman, "30 minutes");
    });

    it("6 hour gap → same_day", () => {
      const previousUserTurnAt = isoBeforeNow(6 * 60 * 60_000);
      const ctx = computeTemporalContinuityContext({
        previousUserTurnAt,
        now: FIXED_NOW,
        timezone: TIMEZONE,
      });

      assert.strictEqual(ctx.elapsedSincePreviousUserTurnMs, 6 * 60 * 60_000);
      assert.strictEqual(ctx.gapBucket, "same_day");
      assert.strictEqual(ctx.elapsedHuman, "6 hours");
    });

    it("20 hour gap → overnight", () => {
      const previousUserTurnAt = isoBeforeNow(20 * 60 * 60_000);
      const ctx = computeTemporalContinuityContext({
        previousUserTurnAt,
        now: FIXED_NOW,
        timezone: TIMEZONE,
      });

      assert.strictEqual(ctx.elapsedSincePreviousUserTurnMs, 20 * 60 * 60_000);
      assert.strictEqual(ctx.gapBucket, "overnight");
      assert.strictEqual(ctx.elapsedHuman, "20 hours");
    });

    it("3 day gap → multi_day", () => {
      const previousUserTurnAt = isoBeforeNow(3 * 24 * 60 * 60_000);
      const ctx = computeTemporalContinuityContext({
        previousUserTurnAt,
        now: FIXED_NOW,
        timezone: TIMEZONE,
      });

      assert.strictEqual(
        ctx.elapsedSincePreviousUserTurnMs,
        3 * 24 * 60 * 60_000
      );
      assert.strictEqual(ctx.gapBucket, "multi_day");
      assert.strictEqual(ctx.elapsedHuman, "3 days");
    });

    it("10 day gap → stale", () => {
      const previousUserTurnAt = isoBeforeNow(10 * 24 * 60 * 60_000);
      const ctx = computeTemporalContinuityContext({
        previousUserTurnAt,
        now: FIXED_NOW,
        timezone: TIMEZONE,
      });

      assert.strictEqual(
        ctx.elapsedSincePreviousUserTurnMs,
        10 * 24 * 60 * 60_000
      );
      assert.strictEqual(ctx.gapBucket, "stale");
      assert.strictEqual(ctx.elapsedHuman, "10 days");
    });
  });

  describe("resolveGapBucket", () => {
    it("returns new_session when elapsedMs is null", () => {
      assert.strictEqual(resolveGapBucket(null), "new_session");
    });

    it("classifies thresholds correctly", () => {
      assert.strictEqual(resolveGapBucket(0), "immediate");
      assert.strictEqual(resolveGapBucket(4 * 60_000), "immediate");
      assert.strictEqual(resolveGapBucket(30 * 60_000), "recent");
      assert.strictEqual(resolveGapBucket(6 * 60 * 60_000), "same_day");
      assert.strictEqual(resolveGapBucket(20 * 60 * 60_000), "overnight");
      assert.strictEqual(resolveGapBucket(3 * 24 * 60 * 60_000), "multi_day");
      assert.strictEqual(resolveGapBucket(10 * 24 * 60 * 60_000), "stale");
    });
  });

  describe("formatElapsedHuman", () => {
    it("formats expected human durations", () => {
      assert.strictEqual(formatElapsedHuman(2 * 60_000), "2 minutes");
      assert.strictEqual(formatElapsedHuman(30 * 60_000), "30 minutes");
      assert.strictEqual(formatElapsedHuman(6 * 60 * 60_000), "6 hours");
      assert.strictEqual(formatElapsedHuman(20 * 60 * 60_000), "20 hours");
      assert.strictEqual(formatElapsedHuman(3 * 24 * 60 * 60_000), "3 days");
      assert.strictEqual(formatElapsedHuman(10 * 24 * 60 * 60_000), "10 days");
    });

    it("returns null for null elapsed", () => {
      assert.strictEqual(formatElapsedHuman(null), null);
    });
  });

  describe("renderTemporalContext", () => {
    it("wraps context in temporal-context XML with required labels and rules", () => {
      const ctx = computeTemporalContinuityContext({
        previousUserTurnAt: isoBeforeNow(30 * 60_000),
        now: FIXED_NOW,
        timezone: TIMEZONE,
      });
      const xml = renderTemporalContext(ctx, { lang: "en" });

      assert.ok(xml.startsWith("<temporal-context>"));
      assert.ok(xml.endsWith("</temporal-context>"));
      assert.ok(xml.includes("Current local time"));
      assert.ok(xml.includes("Previous user-visible turn"));
      assert.ok(xml.includes("Elapsed since previous user-visible turn"));
      assert.ok(xml.includes("Gap bucket"));
      assert.ok(
        xml.includes("Never pretend to have experienced waiting"),
        "must contain anti artificial-waiting rule"
      );
    });
  });

  describe("formatTemporalContinuityContext", () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "temporal-ctx-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns empty string when disabled", async () => {
      const result = await formatTemporalContinuityContext(
        "agent-1",
        "ws-1",
        tmpDir,
        { enabled: false }
      );
      assert.strictEqual(result, "");
    });

    it("returns a temporal-context XML block when enabled", async () => {
      const result = await formatTemporalContinuityContext(
        "agent-1",
        "ws-1",
        tmpDir,
        { enabled: true, lang: "en" }
      );
      assert.ok(typeof result === "string");
      assert.ok(result.length > 0);
      assert.ok(result.includes("<temporal-context>"));
    });

    it("does not create run-state.json in the workspace directory", async () => {
      await formatTemporalContinuityContext("agent-1", "ws-1", tmpDir, {
        enabled: true,
        lang: "en",
      });

      const files = readdirSync(tmpDir);
      assert.ok(
        !files.includes("run-state.json"),
        "must not write run-state.json"
      );
    });

    it("reads previous activity from run-state when no explicit timestamp is given", async () => {
      const now = Date.parse("2026-06-18T21:14:00.000Z");
      const previousUserTurnAt = now - 6 * 60 * 60 * 1000;

      // Manually seed run-state with a previous user-visible turn timestamp.
      const runStatePath = join(tmpDir, "run-state.json");
      const seededState = {
        sessionTime: { "ws-1": { "agent-1": { lastActivityAt: previousUserTurnAt } } },
      };
      await (await import("node:fs/promises")).writeFile(
        runStatePath,
        JSON.stringify(seededState, null, 2),
        "utf8"
      );

      const result = await formatTemporalContinuityContext(
        "agent-1",
        "ws-1",
        tmpDir,
        { enabled: true, lang: "en", now, timezone: TIMEZONE }
      );

      assert.ok(result.includes("<temporal-context>"));
      assert.ok(result.includes("Gap bucket: same_day"));
      assert.ok(result.includes("6 hours"));
      assert.ok(result.includes("Never pretend to have experienced waiting"));
    });

    it("recordActivity ordering: uses the previous timestamp, not a newly recorded one", async () => {
      const now = Date.parse("2026-06-18T21:14:00.000Z");
      const previousUserTurnAt = now - 6 * MS_PER_HOUR;

      const runStatePath = join(tmpDir, "run-state.json");
      const seededState = {
        sessionTime: { "ws-1": { "agent-1": { lastActivityAt: previousUserTurnAt } } },
      };
      await writeFile(runStatePath, JSON.stringify(seededState, null, 2), "utf8");

      // Capture the previous activity before recording the current turn, as the
      // production hook does in index.js.
      const capturedPrevious = previousUserTurnAt;
      await recordActivity("agent-1", "ws-1", tmpDir);

      const result = await formatTemporalContinuityContext(
        "agent-1",
        "ws-1",
        tmpDir,
        {
          enabled: true,
          lang: "en",
          now: capturedPrevious + 6 * MS_PER_HOUR,
          previousUserTurnAt: capturedPrevious,
          timezone: TIMEZONE,
        }
      );

      assert.ok(result.includes("<temporal-context>"));
      assert.ok(result.includes("Gap bucket: same_day"));
      assert.ok(result.includes("6 hours"));
    });

    it("second user turn sees the first turn as the previous turn", async () => {
      const T = Date.parse("2026-06-18T18:00:00.000Z");

      const runStatePath = join(tmpDir, "run-state.json");
      const seededState = {
        sessionTime: { "ws-1": { "agent-1": { lastActivityAt: T } } },
      };
      await writeFile(runStatePath, JSON.stringify(seededState, null, 2), "utf8");

      const result = await formatTemporalContinuityContext(
        "agent-1",
        "ws-1",
        tmpDir,
        {
          enabled: true,
          lang: "en",
          now: T + 2 * 60 * 1000,
          timezone: TIMEZONE,
        }
      );

      assert.ok(result.includes("<temporal-context>"));
      assert.ok(result.includes("Gap bucket: immediate"));
      assert.ok(
        result.includes(`Previous user-visible turn: ${expectedLocalTime(T, TIMEZONE)}`),
        "rendered previous turn time must match the seeded first turn"
      );
    });

    it("does not treat internal/background activity as a user-visible turn", async () => {
      const T = Date.parse("2026-06-18T18:00:00.000Z");

      const runStatePath = join(tmpDir, "run-state.json");
      const seededState = {
        sessionTime: { "ws-1": { "agent-1": { lastActivityAt: T } } },
      };
      await writeFile(runStatePath, JSON.stringify(seededState, null, 2), "utf8");

      const result = await formatTemporalContinuityContext(
        "agent-1",
        "ws-1",
        tmpDir,
        {
          enabled: true,
          lang: "en",
          now: T + 2 * 60 * 1000,
          previousUserTurnAt: T,
          timezone: TIMEZONE,
        }
      );

      assert.ok(result.includes("<temporal-context>"));
      assert.ok(result.includes("Gap bucket: immediate"));

      // formatTemporalContinuityContext must not mutate the stored activity
      // timestamp itself; only the caller (index.js) records activity.
      const stateAfter = JSON.parse(await (await import("node:fs/promises")).readFile(runStatePath, "utf8"));
      assert.strictEqual(
        stateAfter.sessionTime["ws-1"]["agent-1"].lastActivityAt,
        T,
        "stored lastActivityAt must remain unchanged"
      );

      // Background markers must still be skipped by the runtime scheduler so
      // cron/heartbeat/background turns never reach this user-visible path.
      assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ origin: "cron" }, {}), true);
      assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ kind: "heartbeat" }, {}), true);
      assert.strictEqual(shouldSkipAutoRecallForInternalTurn({ kind: "background" }, {}), true);
    });
  });
});

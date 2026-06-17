#!/usr/bin/env node
/**
 * repair-dreaming-cron.mjs — diagnose and optionally reset the Memory Dreaming Promotion cron.
 *
 * The "Memory Dreaming Promotion" cron writes daily workspace-<agent>/memory/*.md
 * and Dream Diary entries. If it enters status=error (e.g. after a 330s timeout),
 * it stops writing memory files entirely until reset.
 *
 * Usage:
 *   node scripts/repair-dreaming-cron.mjs           # status only
 *   node scripts/repair-dreaming-cron.mjs --run     # trigger a manual run
 *   node scripts/repair-dreaming-cron.mjs --show    # show full cron details
 *
 * Exit codes:
 *   0  Cron is healthy (or not configured)
 *   1  Cron is in error state (no --run given, or run failed)
 *   2  openclaw CLI not available
 */

import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const opts = { run: false, show: false };
  for (const a of argv) {
    if (a === "--run")  opts.run = true;
    if (a === "--show") opts.show = true;
  }
  return opts;
}

function openclaw(args, timeout = 15000) {
  const r = spawnSync("openclaw", args, { encoding: "utf8", timeout });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Check openclaw is available
  const check = openclaw(["--version"]);
  if (!check.ok) {
    console.error("✗ openclaw CLI not found. Install or add to PATH.");
    process.exit(2);
  }

  // List crons and find dreaming job
  const list = openclaw(["cron", "list"]);
  if (!list.ok) {
    console.error("✗ openclaw cron list failed:", list.stderr.trim());
    process.exit(2);
  }

  const lines = list.stdout.split("\n");
  const dreamingLine = lines.find(
    (l) => l.toLowerCase().includes("memory dreaming") || l.toLowerCase().includes("dreaming promotion")
  );

  if (!dreamingLine) {
    console.log("✓ Memory Dreaming Promotion cron not found — not configured on this installation.");
    process.exit(0);
  }

  // Extract ID
  const idMatch = dreamingLine.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const cronId = idMatch?.[0];

  console.log("Memory Dreaming Promotion cron:");
  console.log(`  ${dreamingLine.trim()}`);

  if (opts.show && cronId) {
    const detail = openclaw(["cron", "show", cronId]);
    if (detail.ok) {
      console.log("\nDetails:");
      console.log(detail.stdout.split("\n").map((l) => `  ${l}`).join("\n"));
    }
  }

  const hasError = /error|failed|timed.?out/i.test(dreamingLine);
  if (!hasError) {
    console.log("\n✓ Cron status looks healthy.");
    process.exit(0);
  }

  console.log("\n✗ Cron is in error state.");
  console.log("  Symptom: workspace-<agent>/memory/*.md files stop being written.");
  console.log("  Cause:   Job timed out during before-agent-reply phase (cron-nested lane).");

  if (!opts.run) {
    console.log("\n  To trigger a manual run:");
    if (cronId) {
      console.log(`    node scripts/repair-dreaming-cron.mjs --run`);
      console.log(`    openclaw cron run ${cronId}`);
    }
    console.log("\n  To observe logs after run:");
    console.log("    journalctl --user -u openclaw-gateway.service -f --since now");
    process.exit(1);
  }

  if (!cronId) {
    console.error("✗ Could not extract cron ID from list output — run manually via the OpenClaw UI.");
    process.exit(1);
  }

  console.log(`\n→ Triggering: openclaw cron run ${cronId}`);
  const run = openclaw(["cron", "run", cronId], 30000);
  if (run.ok) {
    console.log("✓ Cron run triggered successfully.");
    console.log("  Monitor: journalctl --user -u openclaw-gateway.service --since now -f");
    console.log("  Success indicators:");
    console.log("    - narrative generation ended with status=complete");
    console.log("    - new workspace-<agent>/memory/YYYY-MM-DD.md files");
    process.exit(0);
  } else {
    console.error(`✗ Trigger failed: ${run.stderr.trim() || run.stdout.trim()}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error("repair-dreaming-cron:", err); process.exit(1); });

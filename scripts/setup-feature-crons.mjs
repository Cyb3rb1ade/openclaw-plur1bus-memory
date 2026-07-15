#!/usr/bin/env node
/**
 * setup-feature-crons.mjs — idempotent, best-effort setup of the PLUR1BUS
 * feature crons (persona-evolve, afterthought) for the current OpenClaw
 * installation.
 *
 * Runs entirely as the invoking user via the `openclaw` CLI (which talks to
 * the already-running gateway over its local socket/token) — no root, no
 * sudo, no system paths. Safe to run from `npm install` (postinstall), a
 * ClawHub update, or manually.
 *
 * Contract: this script must NEVER fail an install. If the `openclaw` CLI
 * is missing or the gateway is unreachable, it prints a friendly note and
 * exits 0. Partial failures during `cron add` are reported as warnings and
 * also exit 0 — the setup self-heals on the next run (idempotent planning).
 *
 * Usage:
 *   node scripts/setup-feature-crons.mjs [--dry-run] [--agent <id>] [--account <acct>] [--json]
 */

import { spawnSync } from "node:child_process";
import { planFeatureCrons, REQUIRED_FEATURE_CRONS, selectAgentsForCronSetup } from "../lib/setup/feature-cron-plan.js";

function parseArgs(argv) {
  const opts = { dryRun: false, agent: null, account: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--agent") opts.agent = argv[++i] ?? null;
    else if (a === "--account") opts.account = argv[++i] ?? null;
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

function openclaw(args, timeout = 15000) {
  const r = spawnSync("openclaw", args, { encoding: "utf8", timeout });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status, error: r.error };
}

function scheduleArgs(schedule) {
  if (schedule.kind === "cron") return ["--cron", schedule.expr];
  if (schedule.kind === "every") return ["--every", `${Math.round(schedule.everyMs / 1000)}s`];
  return [];
}

function buildAddArgs(job) {
  const args = ["cron", "add", "--name", job.name, "--message", job.message, ...scheduleArgs(job.schedule)];
  args.push("--session", "isolated");
  if (job.agent) args.push("--agent", job.agent);
  // Multi-agent mode: a derived delivery target (job.delivery, from
  // deriveAgentDelivery) always wins — it's the specific channel/to/account
  // this agent's other crons already deliver to. Legacy single-agent mode
  // has no job.delivery and falls back to the old --account + bare
  // --announce (gateway default channel/to for that account).
  if (job.delivery) {
    args.push("--announce");
    if (job.delivery.channel) args.push("--channel", job.delivery.channel);
    if (job.delivery.to) args.push("--to", job.delivery.to);
    if (job.delivery.accountId) args.push("--account", job.delivery.accountId);
  } else {
    if (job.account) args.push("--account", job.account);
    if (job.needsDelivery && job.agent) args.push("--announce");
  }
  if (!job.enabled) args.push("--disabled");
  args.push("--json");
  return args;
}

/**
 * Discover bound agents via `openclaw agents list --json` and reduce them
 * to the set that gets feature crons (see selectAgentsForCronSetup). On any
 * failure (CLI missing, non-zero exit, unparseable JSON, empty result) this
 * returns null — the caller falls back to the pre-multi-agent single
 * default-agent behavior, per the never-fail-an-install contract.
 *
 * @returns {Array<{id: string, isDefault: boolean}> | null}
 */
function discoverAgents() {
  const r = openclaw(["agents", "list", "--json"], 15000);
  if (!r.ok) return null;
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const agents = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.agents) ? parsed.agents : null;
  if (!agents) return null;
  const selected = selectAgentsForCronSetup(agents);
  return selected.length > 0 ? selected : null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const check = openclaw(["--version"], 5000);
  if (!check.ok) {
    console.log("[setup-feature-crons] openclaw CLI not found or gateway unreachable — skipping (best-effort, safe to ignore during install).");
    process.exit(0);
  }

  // --all ist Pflicht: ohne das Flag blendet die CLI disabled Jobs aus —
  // genau der delivery-sichere disabled-Default würde sonst bei jedem
  // Lauf erneut angelegt und stapelt Duplikate.
  const list = openclaw(["cron", "list", "--json", "--all"], 15000);
  if (!list.ok) {
    console.log("[setup-feature-crons] `openclaw cron list --json` failed — skipping (best-effort, safe to ignore during install).");
    if (list.stderr) console.log(`  ${list.stderr.trim()}`);
    process.exit(0);
  }

  let existingJobs = [];
  try {
    const parsed = JSON.parse(list.stdout);
    existingJobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch (err) {
    console.log(`[setup-feature-crons] could not parse cron list JSON — skipping (${err.message}).`);
    process.exit(0);
  }

  // Explicit --agent/--account always wins: single-agent mode, current
  // (pre-multi-agent) semantics — an operator who names an agent knows
  // exactly what they want, discovery would only get in the way.
  let plan;
  if (opts.agent || opts.account) {
    plan = planFeatureCrons(existingJobs, REQUIRED_FEATURE_CRONS, { agent: opts.agent, account: opts.account });
  } else {
    const agents = discoverAgents();
    if (agents) {
      plan = planFeatureCrons(existingJobs, REQUIRED_FEATURE_CRONS, { agents });
    } else {
      if (!opts.json) {
        console.log(
          "[setup-feature-crons] agent discovery unavailable (`openclaw agents list --json` failed, unparseable, or no bound agents) — " +
            "falling back to single-agent mode (no --agent/--account, delivery-gated crons created disabled).",
        );
      }
      plan = planFeatureCrons(existingJobs, REQUIRED_FEATURE_CRONS, { agent: opts.agent, account: opts.account });
    }
  }

  // Im --json-Modus darf stdout genau EIN JSON-Objekt enthalten: bei
  // dry-run/nichts-zu-tun dieses hier, sonst erst das Ergebnis-Objekt nach
  // den cron-add-Aufrufen (vorher wären es zwei konkatenierte Objekte, die
  // der /plur1bus-setup-crons-Parser nicht lesen kann).
  if (opts.json) {
    if (opts.dryRun || plan.create.length === 0) {
      console.log(JSON.stringify({ dryRun: opts.dryRun, plan }, null, 2));
    }
  } else {
    console.log("[setup-feature-crons] plan:");
    for (const s of plan.skip) {
      console.log(`  SKIP   ${s.spec.name}  (${s.reason}: "${s.existingJob?.name ?? ""}")`);
    }
    for (const c of plan.create) {
      console.log(`  ${opts.dryRun ? "WOULD-ADD" : "ADD"}  ${c.name}  enabled=${c.enabled}`);
      if (c.hint) console.log(`         hint: ${c.hint}`);
    }
    if (plan.create.length === 0) {
      console.log("  Nothing to do — all feature crons already present.");
    }
  }

  if (opts.dryRun || plan.create.length === 0) {
    process.exit(0);
  }

  const results = [];
  for (const job of plan.create) {
    const args = buildAddArgs(job);
    const r = openclaw(args, 15000);
    results.push({ job: job.name, ok: r.ok, stderr: r.ok ? undefined : r.stderr?.trim() });
    if (!opts.json) {
      if (r.ok) {
        console.log(`  ✓ created: ${job.name}`);
      } else {
        console.log(`  ⚠ failed to create: ${job.name} — ${r.stderr?.trim() || "unknown error"}`);
        console.log(`    (will retry automatically next run — safe to ignore)`);
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ dryRun: false, plan, results }, null, 2));
  }

  // Best-effort contract: never fail the caller (npm install, ClawHub update).
  process.exit(0);
}

main().catch((err) => {
  console.log(`[setup-feature-crons] unexpected error — skipping (best-effort): ${err.message}`);
  process.exit(0);
});

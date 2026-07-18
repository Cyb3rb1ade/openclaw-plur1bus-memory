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

import { planFeatureCrons, REQUIRED_FEATURE_CRONS, selectAgentsForCronSetup } from "../lib/setup/feature-cron-plan.js";
import { openclaw } from "./lib/openclaw-cli.mjs";
import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function scheduleArgs(schedule) {
  if (schedule.kind === "cron") return ["--cron", schedule.expr];
  if (schedule.kind === "every") return ["--every", `${Math.round(schedule.everyMs / 1000)}s`];
  return [];
}

function buildAddArgs(job) {
  const args = ["cron", "add", "--name", job.name, "--message", job.message, ...scheduleArgs(job.schedule)];
  args.push("--session", "isolated");
  if (job.agent) args.push("--agent", job.agent);
  // job.delivery is set whenever a live delivery target was derived (either
  // automatically from the agent's other crons — see deriveAgentDelivery —
  // or explicitly passed in). When present it's the authoritative source
  // for announce/channel/to/account; only the legacy explicit-operator
  // `--agent`/`--account` flow (no derivable delivery object) falls back to
  // the guessed --announce, and even there only for enabled jobs.
  if (job.delivery) {
    args.push("--announce");
    if (job.delivery.channel) args.push("--channel", job.delivery.channel);
    if (job.delivery.to) args.push("--to", job.delivery.to);
    if (job.delivery.accountId) args.push("--account", job.delivery.accountId);
  } else {
    if (job.account) args.push("--account", job.account);
    if (job.needsDelivery && job.agent && job.enabled) {
      args.push("--announce");
    } else {
      // No delivery target planned: pin delivery off. Without a flag,
      // `openclaw cron add` defaults to announce -> channel "last", which
      // fail-closes for isolated cron sessions (no "last active chat").
      args.push("--no-deliver");
    }
  }
  if (!job.enabled) args.push("--disabled");
  args.push("--json");
  return args;
}

function writeOutput(stream, line) {
  stream.write(`${line}\n`);
}

function countPendingCreates(plan) {
  if (!plan || !Array.isArray(plan.create)) return 0;
  const failedCreates = Array.isArray(plan.results)
    ? plan.results.filter((result) => !result?.ok).length
    : 0;
  const disabledDeliveryCreates = plan.create.filter((job) => job?.needsDelivery && job?.enabled === false).length;
  return failedCreates + disabledDeliveryCreates;
}

function buildJsonResult({ reason, message, dryRun = false, plan = null, results = null, lastPlanCreateCount = 0 }) {
  return {
    ok: false,
    dryRun,
    skipped: true,
    reason,
    ...(message ? { message } : {}),
    ...(plan ? { plan } : {}),
    ...(results ? { results } : {}),
    lastPlanCreateCount,
  };
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
/**
 * Best-effort read of the OpenClaw config (openclaw.json) for the channel-
 * config delivery fallback (see deriveDeliveryFromChannelConfig). Never
 * throws; returns null when unreadable — the planner then simply has no
 * config fallback.
 */
function loadChannelConfig() {
  try {
    const home = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
    return JSON.parse(readFileSync(join(home, "openclaw.json"), "utf8"));
  } catch {
    return null;
  }
}

function discoverAgents(openclawImpl = openclaw) {
  const r = openclawImpl(["agents", "list", "--json"], 15000);
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

/**
 * Run feature-cron setup with injectable I/O for tests.
 *
 * @param {{
 *   argv?: string[],
 *   openclawImpl?: (args: string[], timeout?: number) => {ok: boolean, stdout?: string, stderr?: string, status?: number|null, error?: Error|undefined},
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runSetupFeatureCrons(options = {}) {
  const {
    argv = process.argv.slice(2),
    openclawImpl = openclaw,
    stdout = process.stdout,
    loadChannelConfigImpl = loadChannelConfig,
  } = options;
  const opts = parseArgs(argv);
  const pendingByDefault = REQUIRED_FEATURE_CRONS.length;
  try {
    const check = openclawImpl(["--version"], 5000);
    if (!check.ok) {
      if (opts.json) {
        writeOutput(
          stdout,
          JSON.stringify(
            buildJsonResult({
              reason: "cli-unavailable",
              message: "openclaw CLI not found or gateway unreachable",
              lastPlanCreateCount: pendingByDefault,
            }),
            null,
            2,
          ),
        );
      } else {
        writeOutput(stdout, "[setup-feature-crons] openclaw CLI not found or gateway unreachable — skipping (best-effort, safe to ignore during install).");
      }
      return 0;
    }

    // --all ist Pflicht: ohne das Flag blendet die CLI disabled Jobs aus —
    // genau der delivery-sichere disabled-Default würde sonst bei jedem
    // Lauf erneut angelegt und stapelt Duplikate.
    const list = openclawImpl(["cron", "list", "--json", "--all"], 15000);
    if (!list.ok) {
      if (opts.json) {
        writeOutput(
          stdout,
          JSON.stringify(
            buildJsonResult({
              reason: "cron-list-failed",
              message: list.stderr?.trim() || "`openclaw cron list --json` failed",
              lastPlanCreateCount: pendingByDefault,
            }),
            null,
            2,
          ),
        );
      } else {
        writeOutput(stdout, "[setup-feature-crons] `openclaw cron list --json` failed — skipping (best-effort, safe to ignore during install).");
        if (list.stderr) writeOutput(stdout, `  ${list.stderr.trim()}`);
      }
      return 0;
    }

    let existingJobs = [];
    try {
      const parsed = JSON.parse(list.stdout);
      existingJobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    } catch (err) {
      if (opts.json) {
        writeOutput(
          stdout,
          JSON.stringify(
            buildJsonResult({
              reason: "cron-list-parse-failed",
              message: err.message,
              lastPlanCreateCount: pendingByDefault,
            }),
            null,
            2,
          ),
        );
      } else {
        writeOutput(stdout, `[setup-feature-crons] could not parse cron list JSON — skipping (${err.message}).`);
      }
      return 0;
    }

    // Explicit --agent/--account always wins: single-agent mode, current
    // (pre-multi-agent) semantics — an operator who names an agent knows
    // exactly what they want, discovery would only get in the way.
    let plan;
    if (opts.agent || opts.account) {
      plan = planFeatureCrons(existingJobs, REQUIRED_FEATURE_CRONS, { agent: opts.agent, account: opts.account });
    } else {
      const agents = discoverAgents(openclawImpl);
      if (agents) {
        plan = planFeatureCrons(existingJobs, REQUIRED_FEATURE_CRONS, { agents, channelConfig: loadChannelConfigImpl() });
      } else {
        if (!opts.json) {
          writeOutput(
            stdout,
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
    const updates = Array.isArray(plan.update) ? plan.update : [];
    const nothingToDo = plan.create.length === 0 && updates.length === 0;

    if (opts.json) {
      if (opts.dryRun || nothingToDo) {
        writeOutput(stdout, JSON.stringify({ dryRun: opts.dryRun, plan, lastPlanCreateCount: countPendingCreates(plan) }, null, 2));
      }
    } else {
      writeOutput(stdout, "[setup-feature-crons] plan:");
      for (const s of plan.skip) {
        writeOutput(stdout, `  SKIP   ${s.spec.name}  (${s.reason}: "${s.existingJob?.name ?? ""}")`);
      }
      for (const c of plan.create) {
        writeOutput(stdout, `  ${opts.dryRun ? "WOULD-ADD" : "ADD"}  ${c.name}  enabled=${c.enabled}`);
        if (c.hint) writeOutput(stdout, `         hint: ${c.hint}`);
      }
      for (const u of updates) {
        writeOutput(stdout, `  ${opts.dryRun ? "WOULD-UPDATE" : "UPDATE"}  ${u.name}  (contract migration)`);
      }
      if (nothingToDo) {
        writeOutput(stdout, "  Nothing to do — all feature crons already present.");
      }
    }

    if (opts.dryRun || nothingToDo) {
      return 0;
    }

    const results = [];
    for (const job of plan.create) {
      const args = buildAddArgs(job);
      const r = openclawImpl(args, 15000);
      results.push({ job: job.name, ok: r.ok, stderr: r.ok ? undefined : r.stderr?.trim() });
      if (!opts.json) {
        if (r.ok) {
          writeOutput(stdout, `  ✓ created: ${job.name}`);
        } else {
          writeOutput(stdout, `  ⚠ failed to create: ${job.name} — ${r.stderr?.trim() || "unknown error"}`);
          writeOutput(stdout, "    (will retry automatically next run — safe to ignore)");
        }
      }
    }

    // Message-Contract-Migrationen (siehe MESSAGE_CONTRACT_MIGRATIONS):
    // bestehende Jobs mit bekanntem Alt-Contract bekommen die korrigierte
    // Message per `cron edit`. Fehlschläge zählen wie failed creates in
    // lastPlanCreateCount, damit der nächste Bootstrap-Lauf sie erneut
    // versucht.
    for (const u of updates) {
      const editArgs = ["cron", "edit", u.id];
      if (typeof u.message === "string") editArgs.push("--message", u.message);
      if (u.noDeliver) editArgs.push("--no-deliver");
      const r = openclawImpl(editArgs, 15000);
      results.push({ job: u.name, action: "update", ok: r.ok, stderr: r.ok ? undefined : r.stderr?.trim() });
      if (!opts.json) {
        if (r.ok) {
          writeOutput(stdout, `  ✓ updated: ${u.name} (contract migration)`);
        } else {
          writeOutput(stdout, `  ⚠ failed to update: ${u.name} — ${r.stderr?.trim() || "unknown error"}`);
          writeOutput(stdout, "    (will retry automatically next run — safe to ignore)");
        }
      }
    }

    if (opts.json) {
      writeOutput(
        stdout,
        JSON.stringify({ dryRun: false, plan, results, lastPlanCreateCount: countPendingCreates({ ...plan, results }) }, null, 2),
      );
    }

    // Best-effort contract: never fail the caller (npm install, ClawHub update).
    return 0;
  } catch (err) {
    if (opts.json) {
      writeOutput(
        stdout,
        JSON.stringify(
          buildJsonResult({
            reason: "unexpected-error",
            message: err.message,
            lastPlanCreateCount: pendingByDefault,
          }),
          null,
          2,
        ),
      );
    } else {
      writeOutput(stdout, `[setup-feature-crons] unexpected error — skipping (best-effort): ${err.message}`);
    }
    return 0;
  }
}

// process.argv[1] === fileURLToPath(import.meta.url) is false through
// symlinked dirs AND symlinked files (pnpm, npm link, symlinked extensions
// dir) — comparing realpaths survives those. Without this, postinstall,
// bootstrap, and `/plur1bus setup crons` all become silent no-ops when the
// package is reached through a symlink.
const IS_MAIN = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (IS_MAIN) {
  runSetupFeatureCrons().then((code) => {
    process.exit(code);
  });
}

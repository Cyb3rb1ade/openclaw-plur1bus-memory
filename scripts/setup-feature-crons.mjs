#!/usr/bin/env node
/**
 * setup-feature-crons.mjs — idempotent, best-effort setup of the PLUR1BUS
 * explicitly enabled PLUR1BUS feature crons for the current OpenClaw
 * installation.
 *
 * Runs as the invoking user. Before any cron read or mutation it installs or
 * verifies the shipped OpenClaw host dispatcher patch, then uses the
 * `openclaw` CLI over its local socket/token. If the runtime path is not
 * writable, setup remains fail-closed by disabling only active jobs with an
 * exact PLUR1BUS direct-feature identity and payload.
 *
 * Contract: this script must NEVER fail an install. If the `openclaw` CLI
 * is missing or the gateway is unreachable, it prints a friendly note and
 * exits 0. Partial failures during `cron add` are reported as warnings and
 * also exit 0 — the setup self-heals on the next run (idempotent planning).
 *
 * Usage:
 *   node scripts/setup-feature-crons.mjs [--dry-run] [--agent <id>] [--account <acct>] [--json]
 */

import {
  planFeatureCrons,
  planSafetyDisabledCronRecoveries,
  planUnsafeDirectCronDisables,
  REQUIRED_FEATURE_CRONS,
  selectAgentsForCronSetup,
  selectEnabledFeatureCronSpecs,
} from "../lib/setup/feature-cron-plan.js";
import { openclaw } from "./lib/openclaw-cli.mjs";
import { validateInput } from "../lib/input-limits.js";
import { safeAgentId } from "../lib/sql-safety.js";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  applyCronPluginDirectDispatchPatch,
  isCronPluginDirectDispatchReady,
  resolveOpenClawDistDir,
} from "../patches/apply-cron-plugin-direct-dispatch.mjs";

function ensureCronDirectDispatch({ apply }) {
  const distDir = resolveOpenClawDistDir();
  if (apply) return applyCronPluginDirectDispatchPatch(distDir);
  if (!isCronPluginDirectDispatchReady(distDir)) {
    throw new Error("PLUR1BUS cron direct dispatch is not installed");
  }
  return { status: "already-patched" };
}

function parseArgs(argv) {
  const opts = { dryRun: false, agent: null, account: null, json: false, inputError: false };
  const readValue = (index) => {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      opts.inputError = true;
      return { value: null, nextIndex: index };
    }
    return { value, nextIndex: index + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--agent") {
      const parsed = readValue(i);
      opts.agent = parsed.value;
      i = parsed.nextIndex;
    } else if (a === "--account") {
      const parsed = readValue(i);
      opts.account = parsed.value;
      i = parsed.nextIndex;
    }
    else if (a === "--json") opts.json = true;
  }
  if (opts.agent !== null) {
    try {
      opts.agent = safeAgentId(opts.agent);
    } catch (_error) {
      opts.inputError = true;
    }
  }
  if (opts.account !== null) {
    const validation = validateInput(opts.account, {
      maxLength: 128,
      name: "account ID",
      required: true,
      allowedPattern: /^[A-Za-z0-9_.:@-]+$/,
    });
    const unsafeAccount = ["last", "none", "null", "undefined", "auto", "__openclaw_redacted__"]
      .includes(opts.account.toLowerCase());
    if (!validation.ok || unsafeAccount) {
      opts.inputError = true;
    }
  }
  return opts;
}

function scheduleArgs(schedule) {
  if (schedule.kind === "cron") return ["--cron", schedule.expr];
  if (schedule.kind === "every") return ["--every", `${Math.round(schedule.everyMs / 1000)}s`];
  return [];
}

/**
 * Build one fail-closed `cron add` invocation from a validated planner job.
 *
 * @param {object} job
 * @returns {string[]}
 */
export function buildAddArgs(job) {
  const args = ["cron", "add", "--name", job.name, "--message", job.message, ...scheduleArgs(job.schedule)];
  args.push("--session", "isolated");
  if (job.schedule?.kind === "cron" && typeof job.timezone === "string" && job.timezone.length > 0) {
    args.push("--tz", job.timezone);
  }
  if (job.description) args.push("--description", job.description);
  if (job.agent) args.push("--agent", job.agent);
  if (job.delivery) {
    args.push("--announce");
    if (job.delivery.channel) args.push("--channel", job.delivery.channel);
    if (job.delivery.to) args.push("--to", job.delivery.to);
    if (job.delivery.accountId) args.push("--account", job.delivery.accountId);
  } else {
    // Missing validated delivery always pins delivery off. Without this flag,
    // `openclaw cron add` defaults to announce -> channel "last".
    args.push("--no-deliver");
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

function mergeCronUpdates(updates, recoveries) {
  const merged = [];
  const indexes = new Map();
  for (const update of [...updates, ...recoveries]) {
    if (!update?.id) continue;
    const existingIndex = indexes.get(update.id);
    if (existingIndex === undefined) {
      indexes.set(update.id, merged.length);
      merged.push({ ...update });
      continue;
    }
    const existing = merged[existingIndex];
    const combined = { ...existing, ...update };
    if (existing.disable || existing.noDeliver || update.disable || update.noDeliver) {
      delete combined.enable;
      delete combined.rename;
    }
    merged[existingIndex] = combined;
  }
  return merged;
}

function buildJsonResult({
  reason,
  message,
  configError = null,
  dryRun = false,
  plan = null,
  results = null,
  disabledJobs = null,
  wouldDisableJobs = null,
  failedDisables = null,
  lastPlanCreateCount = 0,
}) {
  return {
    ok: false,
    dryRun,
    skipped: true,
    reason,
    ...(message ? { message } : {}),
    ...(configError ? { configError } : {}),
    ...(plan ? { plan } : {}),
    ...(results ? { results } : {}),
    ...(disabledJobs ? { disabledJobs } : {}),
    ...(wouldDisableJobs ? { wouldDisableJobs } : {}),
    ...(failedDisables !== null ? { failedDisables } : {}),
    lastPlanCreateCount,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Load OpenClaw's redacted effective configuration snapshot through the
 * gateway. The gateway owns JSON5, include/env, path and default resolution.
 * Returned errors are deliberately metadata-only so configuration material can
 * never be reflected into install or chat output.
 *
 * @param {(args: string[], timeout?: number) => object} openclawImpl
 * @returns {{ok: true, sourceConfig: object, runtimeConfig: object} | {ok: false, error: {code: string, status?: number}}}
 */
export function loadFeatureCronConfig(openclawImpl = openclaw) {
  let result;
  try {
    result = openclawImpl(["gateway", "call", "config.get", "--json"], 30000);
  } catch (_error) {
    return { ok: false, error: { code: "config-call-failed" } };
  }
  if (!result?.ok) {
    const status = Number.isInteger(result?.status) ? result.status : undefined;
    return { ok: false, error: { code: "config-call-failed", ...(status === undefined ? {} : { status }) } };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(result.stdout);
  } catch (_error) {
    return { ok: false, error: { code: "config-json-invalid" } };
  }
  if (!isPlainObject(snapshot)) return { ok: false, error: { code: "config-snapshot-shape-invalid" } };
  if (snapshot.valid !== true) return { ok: false, error: { code: "config-snapshot-invalid" } };
  if (!isPlainObject(snapshot.sourceConfig) || !isPlainObject(snapshot.runtimeConfig)) {
    return { ok: false, error: { code: "config-snapshot-shape-invalid" } };
  }
  return { ok: true, sourceConfig: snapshot.sourceConfig, runtimeConfig: snapshot.runtimeConfig };
}

/**
 * Discover bound agents via `openclaw agents list --json` and reduce them
 * to the set that gets feature crons (see selectAgentsForCronSetup).
 *
 * @returns {Array<{id: string, isDefault: boolean}> | null}
 */
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
 *   ensureCronDirectDispatchImpl?: (options: {apply: boolean}) => object,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runSetupFeatureCrons(options = {}) {
  const {
    argv = process.argv.slice(2),
    openclawImpl = openclaw,
    ensureCronDirectDispatchImpl = ensureCronDirectDispatch,
    stdout = process.stdout,
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

    if (opts.inputError) {
      if (opts.json) {
        writeOutput(
          stdout,
          JSON.stringify(
            buildJsonResult({
              reason: "invalid-arguments",
              message: "invalid or missing --agent/--account value; no cron jobs changed",
              lastPlanCreateCount: pendingByDefault,
            }),
            null,
            2,
          ),
        );
      } else {
        writeOutput(stdout, "[setup-feature-crons] invalid or missing --agent/--account value — no cron jobs changed.");
      }
      return 0;
    }

    let hostDispatchReady = true;
    try {
      ensureCronDirectDispatchImpl({ apply: !opts.dryRun });
    } catch {
      hostDispatchReady = false;
    }

    if (!hostDispatchReady) {
      const list = openclawImpl(["cron", "list", "--json", "--all"], 15000);
      let existingJobs = null;
      if (list.ok) {
        try {
          const parsed = JSON.parse(list.stdout);
          existingJobs = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.jobs)
              ? parsed.jobs
              : [];
        } catch {
          existingJobs = null;
        }
      }

      if (!existingJobs) {
        const reason = list.ok ? "cron-list-parse-failed" : "cron-list-failed";
        const payload = buildJsonResult({
          reason,
          message: "host dispatcher unavailable and cron state could not be inspected safely",
          lastPlanCreateCount: pendingByDefault,
        });
        if (opts.json) {
          writeOutput(stdout, JSON.stringify(payload, null, 2));
        } else {
          writeOutput(
            stdout,
            "[setup-feature-crons] host dispatcher unavailable and cron state could not be inspected — safety retry required.",
          );
        }
        return 0;
      }

      const unsafeJobs = planUnsafeDirectCronDisables(existingJobs);
      const results = [];
      if (!opts.dryRun) {
        for (const job of unsafeJobs) {
          const result = openclawImpl(
            ["cron", "edit", job.id, "--disable", "--name", job.safetyName],
            15000,
          );
          results.push({
            job: job.name,
            action: "disable",
            ok: result.ok,
            stderr: result.ok ? undefined : result.stderr?.trim(),
          });
        }
      }
      const disabledJobs = opts.dryRun
        ? []
        : results.filter((result) => result.ok).map((result) => result.job);
      const failedDisables = opts.dryRun
        ? unsafeJobs.length
        : results.filter((result) => !result.ok).length;
      const payload = buildJsonResult({
        reason: "host-direct-dispatch-unavailable",
        message: "required OpenClaw cron direct-dispatch patch unavailable; active exact direct jobs were safety-disabled",
        disabledJobs,
        wouldDisableJobs: opts.dryRun ? unsafeJobs.map((job) => job.name) : [],
        failedDisables,
        lastPlanCreateCount: pendingByDefault + failedDisables,
      });
      if (opts.json) {
        writeOutput(stdout, JSON.stringify(payload, null, 2));
      } else {
        writeOutput(
          stdout,
          `[setup-feature-crons] required host dispatcher unavailable — safety-disabled ${disabledJobs.length} exact direct job(s); ${failedDisables} remain unsafe.`,
        );
      }
      return 0;
    }

    const configLoad = loadFeatureCronConfig(openclawImpl);
    if (!configLoad.ok) {
      if (opts.json) {
        writeOutput(
          stdout,
          JSON.stringify(
            buildJsonResult({
              reason: "config-load-failed",
              message: "OpenClaw configuration snapshot unavailable or invalid",
              configError: configLoad.error,
              lastPlanCreateCount: pendingByDefault,
            }),
            null,
            2,
          ),
        );
      } else {
        writeOutput(
          stdout,
          `[setup-feature-crons] OpenClaw configuration snapshot unavailable or invalid (${configLoad.error.code}) — no cron jobs changed.`,
        );
      }
      return 0;
    }

    const enabledSpecs = selectEnabledFeatureCronSpecs(configLoad.sourceConfig);
    if (opts.account && !opts.agent) {
      if (opts.json) {
        writeOutput(
          stdout,
          JSON.stringify(
            buildJsonResult({
              reason: "agent-required",
              message: "--account requires --agent; no cron jobs changed",
              lastPlanCreateCount: enabledSpecs.length,
            }),
            null,
            2,
          ),
        );
      } else {
        writeOutput(stdout, "[setup-feature-crons] --account requires --agent — no cron jobs changed.");
      }
      return 0;
    }

    if (enabledSpecs.length === 0) {
      const emptyPlan = { create: [], skip: [], update: [] };
      if (opts.json) {
        writeOutput(stdout, JSON.stringify({ dryRun: opts.dryRun, plan: emptyPlan, lastPlanCreateCount: 0 }, null, 2));
      } else {
        writeOutput(stdout, "[setup-feature-crons] no explicitly enabled feature owns a cron job — nothing to do.");
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
              message: "cron list unavailable",
              lastPlanCreateCount: enabledSpecs.length,
            }),
            null,
            2,
          ),
        );
      } else {
        writeOutput(stdout, "[setup-feature-crons] `openclaw cron list --json` failed — skipping (best-effort, safe to ignore during install).");
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
              message: "cron list response was not valid JSON",
              lastPlanCreateCount: enabledSpecs.length,
            }),
            null,
            2,
          ),
        );
      } else {
        writeOutput(stdout, "[setup-feature-crons] could not parse cron list JSON — skipping.");
      }
      return 0;
    }

    let plan;
    if (opts.agent) {
      plan = planFeatureCrons(existingJobs, enabledSpecs, {
        agents: [{ id: opts.agent, isDefault: true }],
        account: opts.account,
        channelConfig: configLoad.runtimeConfig,
      });
    } else {
      const agents = discoverAgents(openclawImpl);
      if (agents) {
        plan = planFeatureCrons(existingJobs, enabledSpecs, { agents, channelConfig: configLoad.runtimeConfig });
      } else {
        if (opts.json) {
          writeOutput(
            stdout,
            JSON.stringify(
              buildJsonResult({
                reason: "agent-discovery-failed",
                message: "bound-agent discovery unavailable; no cron jobs changed",
                lastPlanCreateCount: enabledSpecs.length,
              }),
              null,
              2,
            ),
          );
        } else {
          writeOutput(stdout, "[setup-feature-crons] bound-agent discovery unavailable — no cron jobs changed.");
        }
        return 0;
      }
    }

    // Im --json-Modus darf stdout genau EIN JSON-Objekt enthalten: bei
    // dry-run/nichts-zu-tun dieses hier, sonst erst das Ergebnis-Objekt nach
    // den cron-add-Aufrufen (vorher wären es zwei konkatenierte Objekte, die
    // der /plur1bus-setup-crons-Parser nicht lesen kann).
    const recoveries = planSafetyDisabledCronRecoveries(plan.skip);
    const updates = mergeCronUpdates(
      Array.isArray(plan.update) ? plan.update : [],
      recoveries,
    );
    plan = { ...plan, update: updates };
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
        const reason = u.enable ? "safety recovery" : "contract migration";
        writeOutput(stdout, `  ${opts.dryRun ? "WOULD-UPDATE" : "UPDATE"}  ${u.name}  (${reason})`);
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
      if (typeof u.rename === "string") editArgs.push("--name", u.rename);
      if (typeof u.message === "string") editArgs.push("--message", u.message);
      if (u.schedule) editArgs.push(...scheduleArgs(u.schedule));
      if (u.schedule?.kind === "cron" && typeof u.timezone === "string" && u.timezone.length > 0) {
        editArgs.push("--tz", u.timezone);
      }
      if (u.enable) editArgs.push("--enable");
      if (u.disable) editArgs.push("--disable");
      if (u.noDeliver) editArgs.push("--no-deliver");
      const r = openclawImpl(editArgs, 15000);
      results.push({
        job: u.name,
        action: u.enable ? "safety-recovery" : "update",
        ok: r.ok,
        stderr: r.ok ? undefined : r.stderr?.trim(),
      });
      if (!opts.json) {
        const reason = u.enable ? "safety recovery" : "contract migration";
        if (r.ok) {
          writeOutput(stdout, `  ✓ updated: ${u.name} (${reason})`);
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
            message: "unexpected setup failure",
            lastPlanCreateCount: pendingByDefault,
          }),
          null,
          2,
        ),
      );
    } else {
      writeOutput(stdout, "[setup-feature-crons] unexpected error — skipping (best-effort).");
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
    return process.argv[1]
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (IS_MAIN) {
  runSetupFeatureCrons().then((code) => {
    process.exit(code);
  });
}

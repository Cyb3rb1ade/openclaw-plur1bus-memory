import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve as resolvePath } from "node:path";

/**
 * Canonical list of files that must be present and byte-identical in the
 * deployed extension directory. Shared by verify-plugin-deploy.mjs and
 * repair-installed-plugin.mjs so both always check the same set.
 *
 * Coverage rule: all direct lib/ imports from index.js plus critical
 * transitive provider modules. If you add a new lib/ import to index.js,
 * add it here. Tests enforce this.
 */
export const DEPLOY_FILES = [
  "index.js",
  "openclaw.plugin.json",
  // ── core runtime ──────────────────────────────────────────────────────────
  "lib/neo-arch.js",
  "lib/neo-worker-runner.js",
  "lib/neo-worker-runtime.js",
  "lib/relevant-memory-context.js",
  "lib/memory-merge-safety.js",
  "lib/contradiction-detector.js",
  "lib/recall-pipeline.js",
  "lib/runtime-scheduler.js",
  "lib/recall-budget.js",
  "lib/with-timeout.js",
  "lib/llm-call.js",
  "lib/runtime-pressure-gate.js",
  // ── memory capture / recall ────────────────────────────────────────────────
  "lib/bounded-cache.js",
  "lib/bounded-operation-queue.js",
  "lib/categorize.js",
  "lib/continuity-gate.js",
  "lib/conversation-reactivation-recall.js",
  "lib/db-adapter.js",
  "lib/embedding-cache.js",
  "lib/event-loop-lag-snapshot.js",
  "lib/explainability.js",
  "lib/feedback-log.js",
  "lib/frontmatter.js",
  "lib/reply-outcome-tracking.js",
  "lib/input-limits.js",
  "lib/memory-context-sanitize.js",
  "lib/memory-doctor.js",
  "lib/memory-dynamics.js",
  "lib/memory-fact-quality.js",
  "lib/memory-graph.js",
  "lib/memory-merge-safety.js",
  "lib/memory-text-contradiction.js",
  "lib/recall-decision-trace.js",
  "lib/recall-phase-timer.js",
  "lib/retroactive-interference.js",
  "lib/safe-update.js",
  "lib/score.js",
  "lib/semantic-input.js",
  "lib/semantic-lens-index.js",
  "lib/sql-safety.js",
  "lib/text-utils.js",
  // ── Full Experience + temporal (v6.7.0) ────────────────────────────────────
  "lib/session-time.js",
  "lib/setup/feature-profiles.js",
  "lib/temporal-context.js",
  "lib/temporal-provenance.js",
  // ── multi-namespace + provider system (v6.7.0) ────────────────────────────
  "lib/multi-namespace-pool.js",
  "lib/namespace-config.js",
  "lib/providers/config-normalize.js",
  "lib/providers/dimension-guard.js",
  "lib/providers/dimensions.js",
  "lib/providers/embedding-local-transformers.js",
  "lib/providers/embedding-openai.js",
  "lib/providers/env.js",
  "lib/providers/factory.js",
  "lib/providers/legacy-provider-migration.js",
  "lib/providers/openclaw-memory-embedding-adapters.js",
  "lib/providers/reranker-chained.js",
  "lib/providers/reranker-cohere.js",
  "lib/providers/reranker-local-transformers.js",
  // ── emotion / meta-cognition ──────────────────────────────────────────────
  "lib/emotion.js",
  "lib/emotional-state.js",
  "lib/temperament-command.js",
  "lib/i18n.js",
  "lib/meta-cognition.js",
  // ── obsidian / workspace ──────────────────────────────────────────────────
  "lib/interpretation-overlay.js",
  "lib/obsidian-bridge.js",
  "lib/obsidian-control-room.js",
  "lib/obsidian/link-index.js",
  "lib/obsidian/memory-note-writer.js",
  "lib/obsidian/semantic-link-discoverer.js",
  "lib/overlay-commands.js",
  "lib/overlay-generator.js",
  "lib/pattern-surface.js",
  // ── humanization features ──────────────────────────────────────────────────
  "lib/jsonl-utils.js",
  "lib/mood-style-directive.js",
  "lib/review-narrative-lead.js",
  "lib/open-threads.js",
  "lib/contradiction-disclosure.js",
  "lib/recall-confidence-framing.js",
  "lib/proactive-governor.js",
  "lib/dream-echo.js",
  "lib/afterthought.js",
  "lib/time-window.js",
  "lib/persona-voice.js",
  "lib/reaction-directive.js",
  // ── background jobs ────────────────────────────────────────────────────────
  "lib/dreaming/light-dream.js",
  "lib/dreaming/rem-dream.js",
  "lib/episodes.js",
  "lib/jobs/auto-accept-stale-criticals.js",
  "lib/jobs/critical-classifier.js",
  "lib/jobs/daily-consolidation.js",
  "lib/jobs/feedback-analyzer.js",
  "lib/jobs/gc-job.js",
  "lib/jobs/proactive-check.js",
  "lib/jobs/reflection-job.js",
  "lib/jobs/reminder-dispatch.js",
  "lib/jobs/schicht15-tracker.js",
  "lib/jobs/skill-miner.js",
  "lib/jobs/skill-miner/nudge-renderer.js",
  "lib/jobs/skill-miner/proposal-writer.js",
  "lib/metrics.js",
  // ── reminders / nudges ────────────────────────────────────────────────────
  "lib/reminder-nudge.js",
  "lib/reminder-parser.js",
  "lib/reminder-pending.js",
  "lib/reminder-store.js",
  // ── security / ACL / i18n ─────────────────────────────────────────────────
  "lib/acl-middleware.js",
  "lib/security.js",
  // ── Telegram commands ─────────────────────────────────────────────────────
  "lib/telegram-commands/feature-toggle.js",
  "lib/telegram-commands/memory-edit.js",
  "lib/telegram-commands/memory-query.js",
  "lib/telegram-commands/skill-commands.js",
  "lib/telegram-commands/speaker-mapping.js",
  "lib/telegram-commands/status-data.js",
  "lib/telegram-commands/status.js",
  "lib/wiki-command.js",
  // ── speaker diarization / naming (D1–D4) ───────────────────────────────────
  "lib/speaker-segment-schema.js",
  "lib/speaker-mapping-store.js",
  "lib/speaker-proposer.js",
];

const REEXPORT_LINE_RE = /^\s*export\s+(?:\*|\{[^}]*\})\s*(?:as\s+[A-Za-z0-9_$]+\s*)?from\s*["']([^"']+)["']\s*;?\s*$/;

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Detects whether a file is a pure re-export shim (only `export * from "..."`
 * or `export { ... } from "..."` lines, no other code) and whether any of its
 * re-export targets fail to resolve on disk. A re-export shim is only valid
 * relative to the directory tree it was written for (e.g. inside a repo) —
 * copied verbatim into an unrelated deploy directory, its relative target
 * almost always stops resolving. That's the exact failure mode this guards.
 */
export function detectBrokenStub(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const targets = [];
  let nonReexportLines = 0;

  for (const line of lines) {
    const match = line.match(REEXPORT_LINE_RE);
    if (match) {
      const spec = match[1];
      const resolved = resolvePath(dirname(filePath), spec);
      targets.push({ spec, resolved, exists: existsSync(resolved) });
    } else {
      nonReexportLines++;
    }
  }

  const isReexportOnly = targets.length > 0 && nonReexportLines === 0;
  const isBroken = isReexportOnly && targets.some((t) => !t.exists);

  return { isReexportOnly, isBroken, targets };
}

/**
 * Validates one deployed file against its repo source-of-truth: existence,
 * not-a-broken-stub, and byte-identical checksum.
 */
export function validateFile({ deployPath, repoPath }) {
  const reasons = [];

  if (!existsSync(deployPath)) {
    return { ok: false, reasons: ["missing-deploy-file"] };
  }

  const stub = detectBrokenStub(deployPath);
  if (stub.isBroken) {
    reasons.push("broken-stub");
  }

  if (repoPath && existsSync(repoPath)) {
    if (sha256(deployPath) !== sha256(repoPath)) {
      reasons.push("checksum-mismatch");
    }
  } else if (repoPath) {
    reasons.push("missing-repo-source");
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Copies the repo source over the deployed file. No-op (reports only) in
 * dry-run mode.
 */
export function repairFile({ deployPath, repoPath, dryRun = false }) {
  if (!existsSync(repoPath)) {
    return { repaired: false, dryRun, reason: "missing-repo-source" };
  }
  if (dryRun) {
    return { repaired: false, dryRun, reason: "dry-run" };
  }
  mkdirSync(dirname(deployPath), { recursive: true });
  copyFileSync(repoPath, deployPath);
  return { repaired: true, dryRun };
}

/**
 * Validates a list of repo-relative file paths between a repo directory and
 * a deployed directory. With repair=true, broken/mismatched files are
 * restored from the repo source (skipped entirely in dry-run mode).
 */
export function validateDeployment({ deployDir, repoDir, files, repair = false, dryRun = false }) {
  const results = files.map((file) => {
    const deployPath = join(deployDir, file);
    const repoPath = join(repoDir, file);
    let { ok, reasons } = validateFile({ deployPath, repoPath });
    let repaired = false;

    if (!ok && repair) {
      const outcome = repairFile({ deployPath, repoPath, dryRun });
      repaired = outcome.repaired;
      if (repaired) {
        const revalidated = validateFile({ deployPath, repoPath });
        ok = revalidated.ok;
        reasons = revalidated.reasons;
      }
    }

    return { file, ok, reasons, repaired };
  });

  return { ok: results.every((r) => r.ok), results };
}

/**
 * Imports each deployed file for real and checks that the expected named
 * exports exist. This is what actually caught the neo-arch.js incident:
 * checksum/stub checks can be fooled by a file that "looks like code" but a
 * real import proves whether the runtime can use it.
 */
export async function smokeTestExports(expectations) {
  const results = [];
  for (const { filePath, exports: expectedExports } of expectations) {
    let mod;
    let importError = false;
    try {
      mod = await import(`${filePath}?smokeTest=${Date.now()}-${Math.random()}`);
    } catch {
      importError = true;
    }

    const missing = importError
      ? [...expectedExports]
      : expectedExports.filter((name) => mod[name] === undefined);

    results.push({ filePath, importError, missing, ok: !importError && missing.length === 0 });
  }

  return { ok: results.every((r) => r.ok), results };
}

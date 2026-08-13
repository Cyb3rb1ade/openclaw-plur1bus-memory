import { existsSync, readFileSync, copyFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";

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
  // package.json wurde bis 7.2.1 nur fuer die Versionspruefung GELESEN, aber
  // nie ausgeliefert (es stand in snapshotFiles, nicht in dieser Liste).
  // Folge: die deployte package.json blieb auf dem Stand, den irgendein
  // frueherer Installationsweg hinterlassen hatte — beim 7.2.1-Deploy stand
  // dort 7.1.7, waehrend openclaw.plugin.json korrekt 7.2.1 auswies. Die
  // Laufzeit nimmt zwar das Plugin-Manifest, aber zwei widersprechende
  // Versionsangaben im selben Verzeichnis fuehren jede Diagnose in die Irre.
  "package.json",
  // ── core runtime ──────────────────────────────────────────────────────────
  "lib/neo-arch.js",
  "lib/neo-worker-runner.js",
  "lib/neo-worker-runtime.js",
  "lib/abort.js",
  "lib/relevant-memory-context.js",
  "lib/memory-merge-safety.js",
  "lib/contradiction-detector.js",
  "lib/recall-pipeline.js",
  "lib/runtime-scheduler.js",
  "lib/runtime-shutdown.js",
  "lib/recall-budget.js",
  "lib/with-timeout.js",
  "lib/safe-logging.js",
  "lib/llm-call.js",
  "lib/llm-failure.js",
  "lib/llm-router.js",
  "lib/llm-result-cache.js",
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
  "lib/memory-request-context.js",
  "lib/shared-memory.js",
  "lib/shared-memory-migration.js",
  "lib/shared-memory-pool.js",
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
  // ── setup/config contract + temporal (v6.7.0+) ─────────────────────────────
  "lib/session-time.js",
  "lib/setup/config-contract.js",
  "lib/setup/feature-profiles.js",
  "lib/setup/feature-cron-plan.js",
  "lib/setup/feature-cron-bootstrap.js",
  "lib/temporal-context.js",
  "lib/temporal-filter.js",
  "lib/temporal-provenance.js",
  // ── multi-namespace + provider system (v6.7.0) ────────────────────────────
  "lib/multi-namespace-pool.js",
  "lib/directory-capability.js",
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
  "lib/emotion-engine.js",
  "lib/emotion-score.js",
  "lib/emotion-blends.js",
  "lib/tier1-lexicon.js",
  "lib/tier2-transformer.js",
  "lib/tier3-llm.js",
  "lib/emotional-state.js",
  "lib/temperament-command.js",
  "lib/i18n.js",
  "lib/meta-cognition.js",
  // ── obsidian / workspace ──────────────────────────────────────────────────
  "lib/interpretation-overlay.js",
  "lib/obsidian-bridge.js",
  "lib/obsidian-control-room.js",
  "lib/obsidian-mutation-policy.js",
  "lib/obsidian-vault-authority.js",
  "lib/obsidian/link-index.js",
  "lib/obsidian/memory-note-writer.js",
  "lib/obsidian/semantic-link-discoverer.js",
  "lib/overlay-commands.js",
  "lib/overlay-generator.js",
  "lib/pattern-surface.js",
  // ── humanization features ──────────────────────────────────────────────────
  "lib/jsonl-utils.js",
  "lib/atomic-file.js",
  "lib/mood-style-directive.js",
  "lib/review-narrative-lead.js",
  "lib/open-threads.js",
  "lib/contradiction-disclosure.js",
  "lib/recall-confidence-framing.js",
  "lib/proactive-governor.js",
  "lib/dream-echo.js",
  "lib/afterthought.js",
  "lib/internal-cron-reply.js",
  "lib/time-window.js",
  "lib/persona-voice.js",
  "lib/reaction-directive.js",
  // ── background jobs ────────────────────────────────────────────────────────
  "lib/dreaming/dream-narrative.js",
  "lib/dreaming/light-dream.js",
  "lib/dreaming/rem-dream.js",
  "lib/episode-watermark.js",
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
  "patches/apply-cron-plugin-direct-dispatch.mjs",
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
  "scripts/setup-feature-crons.mjs",
  "scripts/lib/openclaw-cli.mjs",
  "scripts/lib/find-deploy-dir.mjs",
  // ── speaker diarization / naming (D1–D4) ───────────────────────────────────
  "lib/speaker-segment-schema.js",
  "lib/speaker-mapping-store.js",
  "lib/speaker-proposer.js",
  "lib/promoted-memory-reindex.js",
  "scripts/embed-promoted-memories.mjs",
  // ── transitive index.js runtime closure ───────────────────────────────────
  "lib/atomic-json.js",
  "lib/critical-push-classifier.js",
  "lib/critical-push-state.js",
  "lib/critical-review.js",
  "lib/fetch-with-timeout.js",
  "lib/filter-parser.js",
  "lib/garbage-collector.js",
  "lib/graph-index.js",
  "lib/i18n-dictionary.js",
  "lib/install/soul-patcher.js",
  "lib/job-lock.js",
  "lib/job-rate-limit.js",
  "lib/jobs/conflict-resolver.js",
  "lib/jobs/consolidation-report.js",
  "lib/jobs/memory-compaction.js",
  "lib/jobs/memory-dynamics-maintenance.js",
  "lib/jobs/skill-miner/evidence-aggregator.js",
  "lib/jobs/skill-miner/llm-extractor.js",
  "lib/jobs/skill-miner/skill-md-renderer.js",
  "lib/metrics-debounce.js",
  "lib/obsidian-review-authority.js",
  "lib/obsidian-semantic-discovery-flow.js",
  "lib/obsidian-vault-confirmation-flow.js",
  "lib/obsidian/adversarial-deep.js",
  "lib/obsidian/archive-rotation.js",
  "lib/obsidian/bases-generator.js",
  "lib/obsidian/conflict-collector.js",
  "lib/obsidian/conflict-report.js",
  "lib/obsidian/dashboard-generator.js",
  "lib/obsidian/dataview-generator.js",
  "lib/obsidian/evidence-scorer.js",
  "lib/obsidian/frontmatter.js",
  "lib/obsidian/graph-link-writer.js",
  "lib/obsidian/impact-analysis.js",
  "lib/obsidian/link-hygiene.js",
  "lib/obsidian/link-suggestions.js",
  "lib/obsidian/maintenance-deep.js",
  "lib/obsidian/managed-blocks.js",
  "lib/obsidian/memory-explain-builder.js",
  "lib/obsidian/project-hub-builder.js",
  "lib/obsidian/property-normalizer.js",
  "lib/obsidian/provenance-graph.js",
  "lib/obsidian/record-index.js",
  "lib/obsidian/record-schema.js",
  "lib/obsidian/record-writer.js",
  "lib/obsidian/safe-paths.js",
  "lib/obsidian/semantic-conflict-graph.js",
  "lib/obsidian/semantic-duplicate-scan.js",
  "lib/obsidian/tasks-generator.js",
  "lib/obsidian/weekly-synthesis.js",
  "lib/pattern-detector-embedding.js",
  "lib/pattern-detector.js",
  "lib/proactive-nudge.js",
  "lib/query-refiner.js",
  "lib/temporal-parser.js",
  // ── Operator- und Wartungsskripte ─────────────────────────────────────────
  // Das Paket liefert `scripts/` vollständig aus, das Manifest deckte davon
  // aber nur die vier Laufzeit-nahen Einträge oben ab. Alles andere blieb im
  // Deploy auf dem Stand der letzten Paket-Installation stehen und veraltete
  // still: am 2026-08-11 war `maintain-lancedb.mjs` im Deploy zwei Wochen alt
  // (231 statt 276 Zeilen) und enthielt den 7.2.5-Fix nicht, obwohl das Deploy
  // sich als 7.2.5 auswies. Manifest-Einträge werden nur kopiert und per
  // Prüfsumme verglichen — der Smoke-Test importiert ausschließlich Dateien
  // aus EXPORT_EXPECTATIONS, diese Skripte werden also nicht ausgeführt.
  "scripts/auto-capture-lancedb.mjs",
  "scripts/build-code-index.mjs",
  "scripts/cleanup-vault-missing-tasks.mjs",
  "scripts/maintain-lancedb.mjs",
  "scripts/migrate-missing-columns.mjs",
  "scripts/migrate-neo-workspace-generations.mjs",
  "scripts/provider-wizard.mjs",
  "scripts/reindex-provider.mjs",
  "scripts/repair-dreaming-cron.mjs",
  "scripts/repair-installed-plugin.mjs",
  "scripts/run-graph-links-once.mjs",
  "scripts/run-semantic-discover-once.mjs",
  "scripts/run-semantic-link-index-phase43c.mjs",
  "scripts/verify-plugin-deploy.mjs",
  "scripts/verify-workspace-writer.mjs",
  "scripts/lib/deploy-integrity.mjs",
  "scripts/lib/installer-config.mjs",
  "scripts/lib/patch-agents-memory-instructions.mjs",
];

const REEXPORT_LINE_RE = /^\s*export\s+(?:\*|\{[^}]*\})\s*(?:as\s+[A-Za-z0-9_$]+\s*)?from\s*["']([^"']+)["']\s*;?\s*$/;
const RELATIVE_IMPORT_RE = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;
const RELATIVE_DYNAMIC_IMPORT_RE = /import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

function resolveRelativeModule(fromDir, specifier) {
  const base = resolvePath(fromDir, specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, join(base, "index.js")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Returns the deterministic static relative-import closure for an entry file.
 * Paths are repository-relative POSIX strings and may never escape repoDir.
 *
 * @param {string} entryRelativePath
 * @param {string} repoDir
 * @returns {string[]}
 */
export function collectRelativeImports(entryRelativePath, repoDir) {
  const root = resolvePath(repoDir);
  const pending = [entryRelativePath];
  const seen = new Set();

  while (pending.length > 0) {
    const relativePath = pending.shift();
    if (seen.has(relativePath)) continue;
    const absolutePath = resolvePath(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
      throw new Error(`deploy-integrity import escapes repository: ${relativePath}`);
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`deploy-integrity import is missing: ${relativePath}`);
    }

    seen.add(relativePath);
    const source = readFileSync(absolutePath, "utf8");
    const importMatches = [
      ...source.matchAll(RELATIVE_IMPORT_RE),
      ...source.matchAll(RELATIVE_DYNAMIC_IMPORT_RE),
    ];
    for (const match of importMatches) {
      if (match[1].includes("${")) continue;
      const resolved = resolveRelativeModule(dirname(absolutePath), match[1]);
      if (!resolved) {
        throw new Error(`deploy-integrity cannot resolve ${match[1]} from ${relativePath}`);
      }
      const importedRelative = relative(root, resolved).split(sep).join("/");
      if (!seen.has(importedRelative)) pending.push(importedRelative);
    }
  }

  return [...seen].sort();
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256Content(content) {
  return createHash("sha256").update(content).digest("hex");
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
 *
 * @param {{deployPath: string, repoPath: string, dryRun?: boolean, copyFile?: Function}} options
 * @returns {{repaired: boolean, dryRun: boolean, reason?: string}}
 */
export function repairFile({ deployPath, repoPath, dryRun = false, copyFile = copyFileSync }) {
  if (!existsSync(repoPath)) {
    return { repaired: false, dryRun, reason: "missing-repo-source" };
  }
  if (dryRun) {
    return { repaired: false, dryRun, reason: "dry-run" };
  }
  mkdirSync(dirname(deployPath), { recursive: true });
  copyFile(repoPath, deployPath);
  return { repaired: true, dryRun };
}

/**
 * Validates a list of repo-relative file paths between a repo directory and
 * a deployed directory. With repair=true, broken/mismatched files are
 * restored from the repo source (skipped entirely in dry-run mode).
 *
 * @param {{deployDir: string, repoDir: string, files: string[], repair?: boolean, dryRun?: boolean, expectedVersion?: string|null, copyFile?: Function, readSourceFile?: Function}} options
 * @returns {{ok: boolean, preflight: object, results: object[]}}
 */
export function validateDeployment({
  deployDir,
  repoDir,
  files,
  repair = false,
  dryRun = false,
  expectedVersion = null,
  copyFile = copyFileSync,
  readSourceFile = readFileSync,
}) {
  const preflightReasons = [];
  const missingSources = files.filter((file) => !existsSync(join(repoDir, file)));
  if (missingSources.length > 0) preflightReasons.push("missing-repo-source");

  const packagePath = join(repoDir, "package.json");
  const manifestPath = join(repoDir, "openclaw.plugin.json");
  const isVersionedRepair = files.includes("openclaw.plugin.json") && (repair || Boolean(expectedVersion));
  const hasReleaseMetadata = existsSync(packagePath) && existsSync(manifestPath);
  const snapshotFiles = new Set(files);
  if (isVersionedRepair || hasReleaseMetadata) {
    snapshotFiles.add("package.json");
    snapshotFiles.add("openclaw.plugin.json");
  }
  const sourceBuffers = new Map();
  const sourceDigests = new Map();
  if (missingSources.length === 0 && (!isVersionedRepair || hasReleaseMetadata)) {
    try {
      for (const file of snapshotFiles) {
        const content = readSourceFile(join(repoDir, file));
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        sourceBuffers.set(file, buffer);
        sourceDigests.set(file, sha256Content(buffer));
      }
    } catch {
      preflightReasons.push("source-snapshot-failed");
    }
  }
  let sourceVersion = null;
  if (isVersionedRepair && !hasReleaseMetadata) {
    preflightReasons.push("source-release-metadata-missing");
  } else if (hasReleaseMetadata && sourceBuffers.has("package.json") && sourceBuffers.has("openclaw.plugin.json")) {
    try {
      const packageVersion = JSON.parse(sourceBuffers.get("package.json").toString("utf8"))?.version;
      const manifestVersion = JSON.parse(sourceBuffers.get("openclaw.plugin.json").toString("utf8"))?.version;
      sourceVersion = manifestVersion;
      if (!packageVersion || !manifestVersion || packageVersion !== manifestVersion) {
        preflightReasons.push("source-version-mismatch");
      }
    } catch {
      preflightReasons.push("source-version-invalid");
    }
  }
  if (isVersionedRepair && sourceVersion) {
    let selectedVersion = expectedVersion;
    const deployedManifestPath = join(deployDir, "openclaw.plugin.json");
    if (!selectedVersion && existsSync(deployedManifestPath)) {
      try {
        selectedVersion = JSON.parse(readFileSync(deployedManifestPath, "utf8"))?.version || null;
      } catch {
        preflightReasons.push("deployed-version-invalid");
      }
    }
    if (!selectedVersion) preflightReasons.push("expected-source-version-missing");
    else if (sourceVersion !== selectedVersion) preflightReasons.push("unexpected-source-version");
  }
  const preflight = {
    ok: preflightReasons.length === 0,
    reasons: [...new Set(preflightReasons)],
    missingSources,
  };
  const sourceSnapshotMatches = () => {
    try {
      for (const [file, digest] of sourceDigests) {
        const sourcePath = join(repoDir, file);
        if (!existsSync(sourcePath) || sha256(sourcePath) !== digest) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  const mayRepair = repair && preflight.ok;
  const snapshots = new Map();
  if (mayRepair && !dryRun) {
    for (const file of files) {
      const deployPath = join(deployDir, file);
      snapshots.set(file, existsSync(deployPath) ? readFileSync(deployPath) : null);
    }
  }
  let transactionFailed = false;
  const results = files.map((file) => {
    const deployPath = join(deployDir, file);
    const repoPath = join(repoDir, file);
    let { ok, reasons } = validateFile({ deployPath, repoPath });
    let repaired = false;

    if (!ok && mayRepair && !transactionFailed) {
      try {
        if (!dryRun && !sourceSnapshotMatches()) {
          transactionFailed = true;
          ok = false;
          reasons = ["source-snapshot-changed"];
        } else {
          const outcome = repairFile({ deployPath, repoPath, dryRun, copyFile });
          repaired = outcome.repaired;
          if (!repaired && !dryRun) {
            transactionFailed = true;
            ok = false;
            reasons = [outcome.reason || "repair-incomplete"];
          } else if (repaired) {
            const revalidated = validateFile({ deployPath, repoPath });
            ok = revalidated.ok;
            reasons = revalidated.reasons;
            if (!ok || !sourceSnapshotMatches()) {
              transactionFailed = true;
              ok = false;
              if (revalidated.ok) reasons = ["source-snapshot-changed"];
            }
          }
        }
      } catch {
        transactionFailed = true;
        ok = false;
        repaired = false;
        reasons = ["repair-copy-failed"];
      }
    }

    return { file, ok, reasons, repaired };
  });

  if (mayRepair && !dryRun && !transactionFailed) {
    const finalValidation = files.map((file) => validateFile({
      deployPath: join(deployDir, file),
      repoPath: join(repoDir, file),
    }));
    if (!sourceSnapshotMatches() || finalValidation.some((result) => !result.ok)) {
      transactionFailed = true;
    }
  }

  if (transactionFailed) {
    for (const [file, content] of snapshots) {
      const deployPath = join(deployDir, file);
      if (content === null) {
        if (existsSync(deployPath)) unlinkSync(deployPath);
      } else {
        mkdirSync(dirname(deployPath), { recursive: true });
        writeFileSync(deployPath, content);
      }
    }
    preflight.ok = false;
    preflight.reasons.push("repair-transaction-rolled-back");
    for (const result of results) {
      if (result.repaired) {
        result.repaired = false;
        result.ok = false;
        result.reasons = ["repair-transaction-rolled-back"];
      }
    }
  }

  return { ok: preflight.ok && results.every((r) => r.ok), preflight, results };
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

import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve as resolvePath } from "node:path";

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

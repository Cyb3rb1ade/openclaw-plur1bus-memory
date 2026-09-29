/**
 * scripts/dist/installer/artefacts.mjs — verified copies of installed tarballs (ruling T8-b).
 *
 * For the `tarball` and `offline` sources the installer installs from
 * `<stateDir>/plur1bus-installer/artefacts/<version>.tgz` (mode 0600, atomic write), a copy
 * whose SHA-256 matched the signed feed. OpenClaw then records that path as
 * /install/sourcePath, so a rollback or a later `--offline` update always finds the
 * previous version's tarball; before, the record pointed at a temp copy the installer had
 * already deleted (no-rollback-artefact). The installer state file lists them
 * (`artefacts: { <version>: { file, sha256 } }`); after each finished operation only the
 * current and the previous version are kept. Never hard-links (R-S8).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { rmTree, withWinRetry, writeFileAtomic } from "./fsutil.mjs";
import { readState, writeState } from "./state.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const VERSION_FILE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

export function artefactsDir(stateDir) {
  return join(stateDir, "plur1bus-installer", "artefacts");
}

function safeState(stateDir) {
  try {
    return readState(stateDir);
  } catch {
    return null;
  }
}

/**
 * Copy `sourceFile` (whose SHA-256 must equal `expectedSha256`) to the artefact store and
 * record it in the installer state. Returns { file, sha256 }.
 */
export function keepArtefact(stateDir, version, sourceFile, expectedSha256) {
  if (!VERSION_FILE.test(String(version))) throw new Error(`invalid version for an artefact name: ${JSON.stringify(version)}`);
  const bytes = readFileSync(sourceFile);
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== expectedSha256) throw new Error(`SHA-256 of ${sourceFile} (${digest.slice(0, 12)}…) does not match the feed (${String(expectedSha256).slice(0, 12)}…)`);
  const file = join(artefactsDir(stateDir), `${version}.tgz`);
  let present = false;
  try {
    present = existsSync(file) && sha256(readFileSync(file)) === digest;
  } catch {
    present = false;
  }
  if (!present) writeFileAtomic(file, bytes);
  const state = safeState(stateDir) ?? { previousSlot: null, installedVersion: null, source: null };
  writeState(stateDir, { ...state, artefacts: { ...(state.artefacts ?? {}), [version]: { file, sha256: digest } } });
  return { file, sha256: digest };
}

/**
 * The kept tarball of `version`, when it is recorded, present and intact (and, if given,
 * matches `expectedSha256` from the feed); else null.
 */
export function keptArtefact(stateDir, version, expectedSha256 = null) {
  const rec = safeState(stateDir)?.artefacts?.[version];
  if (!rec || typeof rec.file !== "string" || typeof rec.sha256 !== "string") return null;
  if (expectedSha256 && rec.sha256 !== expectedSha256) return null;
  try {
    if (!existsSync(rec.file) || sha256(readFileSync(rec.file)) !== rec.sha256) return null;
  } catch {
    return null;
  }
  return { file: rec.file, sha256: rec.sha256 };
}

/** Keep only the artefacts of `keepVersions` (current and previous); delete the rest. */
export function pruneArtefacts(stateDir, keepVersions) {
  const keep = new Set(keepVersions.filter(Boolean).map((v) => `${v}.tgz`));
  const dir = artefactsDir(stateDir);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  for (const n of names) {
    if (!keep.has(n)) withWinRetry(() => rmSync(join(dir, n), { force: true }));
  }
  const state = safeState(stateDir);
  if (state?.artefacts) {
    const artefacts = Object.fromEntries(Object.entries(state.artefacts).filter(([v]) => keep.has(`${v}.tgz`)));
    writeState(stateDir, { ...state, artefacts });
  }
}

/** Remove the artefact store (after a finished uninstall). */
export function removeArtefacts(stateDir) {
  rmTree(join(stateDir, "plur1bus-installer"));
}

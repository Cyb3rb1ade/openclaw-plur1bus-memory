/**
 * 7.3.1 repair binding regressions:
 * - archivePath darf den erwarteten Archivroot nicht verlassen;
 * - eine Archivkarte darf nicht an einen fremden Agenten gebunden werden;
 * - die vollstaendige Ownership-Bindung muss zum Delete-Event passen;
 * - Symlink-Escapes muessen wie normale Path-Escapes behandelt werden.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPAIR_SCRIPT = fileURLToPath(new URL("../scripts/repair-tombstones.mjs", import.meta.url));
const AGENT_A = "release731-agent-a";
const AGENT_B = "release731-agent-b";
const MEMORY_ID = "00000000-0000-4000-8000-000000000731";

function runRepair(args) {
  const result = spawnSync(process.execPath, [REPAIR_SCRIPT, ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
  });
  let report = {};
  try {
    report = JSON.parse(result.stdout || "{}");
  } catch {
    report = {};
  }
  return { ...result, report };
}

function snapshotBytes(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push([relative(root, full), readFileSync(full)]);
    }
  };
  visit(root);
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function seedCase(t, kind) {
  const root = mkdtempSync(join(tmpdir(), `release-731-repair-binding-${kind}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspace = join(root, "workspace");
  const archiveDir = join(root, "archive");
  const baseDbPath = join(root, "lancedb-namespaced");
  const archiveAgentDir = join(archiveDir, AGENT_A);
  const archivePath = join(archiveAgentDir, `${MEMORY_ID}.json`);
  const externalDir = join(root, "external");
  const externalPath = join(externalDir, `${MEMORY_ID}.json`);
  mkdirSync(join(workspace, ".adaptive-learning"), { recursive: true });
  mkdirSync(archiveAgentDir, { recursive: true });
  mkdirSync(externalDir, { recursive: true });

  const event = {
    event: "memory.deleted",
    result: "committed",
    memoryId: MEMORY_ID,
    canonicalOriginId: MEMORY_ID,
    agentId: AGENT_A,
    storedBy: AGENT_A,
    scope: "workspace",
    workspaceId: "workspace-a",
    workspaceKey: "workspace-a",
    ownerUserId: "",
    archivePath,
  };
  const card = {
    id: MEMORY_ID,
    canonicalOriginId: MEMORY_ID,
    text: "must never be combined into agent-a",
    scope: "workspace",
    agentId: AGENT_A,
    storedBy: AGENT_A,
    workspaceId: "workspace-a",
    workspaceKey: "workspace-a",
    ownerUserId: "",
  };

  if (kind === "outside") {
    writeFileSync(externalPath, JSON.stringify(card), "utf8");
    event.archivePath = externalPath;
  } else if (kind === "agent-mismatch") {
    writeFileSync(archivePath, JSON.stringify({ ...card, agentId: AGENT_B, storedBy: AGENT_B }), "utf8");
  } else if (kind === "ownership-mismatch") {
    writeFileSync(archivePath, JSON.stringify({ ...card, workspaceId: "workspace-b", workspaceKey: "workspace-b" }), "utf8");
  } else if (kind === "symlink") {
    writeFileSync(externalPath, JSON.stringify(card), "utf8");
    rmSync(archivePath, { force: true });
    symlinkSync(externalPath, archivePath);
  } else {
    throw new Error(`unknown repair binding case: ${kind}`);
  }

  writeFileSync(
    join(workspace, ".adaptive-learning", "destructive-ops.jsonl"),
    `${JSON.stringify(event)}\n`,
    "utf8",
  );
  return { workspace, archiveDir, baseDbPath };
}

describe("7.3.1 repair archive/event binding security", () => {
  for (const kind of ["outside", "agent-mismatch", "ownership-mismatch", "symlink"]) {
    it(`rejects ${kind} archive evidence in a real subprocess`, (t) => {
      const { workspace, archiveDir, baseDbPath } = seedCase(t, kind);
      const registryDir = join(baseDbPath, "_tombstones");
      mkdirSync(registryDir, { recursive: true });
      const before = snapshotBytes(registryDir);

      const result = runRepair([
        "--apply",
        "--workspace", workspace,
        "--base-db-path", baseDbPath,
        "--archive-dir", archiveDir,
      ]);

      assert.notEqual(result.status, 0, `${kind} must fail closed`);
      assert.equal(result.report.reconstructed, 0);
      assert.ok(result.report.conflicted > 0, `${kind} must be visible as a conflict`);
      assert.deepEqual(snapshotBytes(registryDir), before, `${kind} must not mutate the registry`);
    });
  }
});

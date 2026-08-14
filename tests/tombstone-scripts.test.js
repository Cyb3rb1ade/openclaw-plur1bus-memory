/**
 * tests/tombstone-scripts.test.js
 *
 * Subprozess-Tests für repair-tombstones.mjs und reapply-tombstones.mjs:
 * Exit-Codes, fail-closed Verhalten bei korrupter/unlesbarer Registry,
 * Whitelist der rekonstruierbaren Ergebnisse, Namenskollisionen.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));

function run(script, args, env = {}) {
  const result = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  let report = null;
  try { report = JSON.parse(result.stdout || "{}"); } catch { /* non-JSON output */ }
  return { status: result.status, report, stdout: result.stdout, stderr: result.stderr };
}

describe("reapply-tombstones.mjs fail-closed", () => {
  it("beschädigte Registry-Zeile → Exit 1 (nicht fail-open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-reapply-corrupt-"));
    try {
      const baseDbPath = join(dir, "lancedb-namespaced");
      mkdirSync(join(dir, "_tombstones"), { recursive: true });
      writeFileSync(join(dir, "_tombstones", "agent-a.jsonl"), "NOT JSON\n", "utf8");

      const { status, report } = run("reapply-tombstones.mjs", ["--apply", "--base-db-path", baseDbPath]);
      assert.notEqual(status, 0, "beschädigte Registry muss mit Exit != 0 enden");
      assert.ok(report.registryErrors.length > 0, "Registry-Fehler muss gemeldet werden");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unlesbare Registry → Exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-reapply-readerr-"));
    try {
      const baseDbPath = join(dir, "lancedb-namespaced");
      mkdirSync(join(dir, "_tombstones", "agent-a.jsonl"), { recursive: true });

      const { status, report } = run("reapply-tombstones.mjs", ["--apply", "--base-db-path", baseDbPath]);
      assert.notEqual(status, 0, "Lesefehler muss mit Exit != 0 enden");
      assert.ok(report.registryErrors.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("repair-tombstones.mjs Whitelist + Kollision", () => {
  function makeWorkspace() {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-repair-ws-"));
    mkdirSync(join(dir, ".adaptive-learning"), { recursive: true });
    return dir;
  }

  function writeEvent(ws, event) {
    writeFileSync(join(ws, ".adaptive-learning", "destructive-ops.jsonl"), JSON.stringify(event) + "\n", "utf8");
  }

  const MEMORY_ID = "a4563cc9-7611-4528-992a-075f8889a018";

  it("result=failed wird nie rekonstruiert", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-repair-failed-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    const archiveDir = join(dir, "archive");
    try {
      const ws = makeWorkspace();
      writeEvent(ws, { event: "memory.deleted", result: "failed", memoryId: MEMORY_ID, agentId: "agent-a" });
      const { report } = run("repair-tombstones.mjs", ["--workspace", ws, "--base-db-path", baseDbPath, "--archive-dir", archiveDir]);
      assert.equal(report.reconstructed, 0);
      assert.equal(report.failedEventsSkipped, 1);
      rmSync(ws, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attempted/unbekannte Ergebnisse werden übersprungen", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-repair-unconf-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    const archiveDir = join(dir, "archive");
    try {
      const ws = makeWorkspace();
      writeFileSync(join(ws, ".adaptive-learning", "destructive-ops.jsonl"),
        [
          JSON.stringify({ event: "memory.deleted", result: "attempted", memoryId: MEMORY_ID, agentId: "agent-a" }),
          JSON.stringify({ event: "memory.deleted", result: "weird-state", memoryId: "b4563cc9-7611-4528-992a-075f8889a019", agentId: "agent-a" }),
        ].join("\n") + "\n", "utf8");

      const { report } = run("repair-tombstones.mjs", ["--workspace", ws, "--base-db-path", baseDbPath, "--archive-dir", archiveDir]);
      assert.equal(report.reconstructed, 0, "attempted/unbekannt darf nicht rekonstruiert werden");
      assert.equal(report.unconfirmedEventsSkipped, 2);
      rmSync(ws, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("historisches Event ohne result wird konservativ rekonstruiert", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-repair-noresult-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    const archiveDir = join(dir, "archive");
    try {
      const ws = makeWorkspace();
      const archivePath = join(archiveDir, "agent-a", `${MEMORY_ID}.json`);
      mkdirSync(join(archiveDir, "agent-a"), { recursive: true });
      writeFileSync(archivePath, JSON.stringify({ id: MEMORY_ID, text: "Gelöschter Fakt", scope: "agent-private" }), "utf8");
      writeEvent(ws, { event: "memory.deleted", memoryId: MEMORY_ID, agentId: "agent-a", archivePath });

      const { report } = run("repair-tombstones.mjs", ["--workspace", ws, "--base-db-path", baseDbPath, "--archive-dir", archiveDir]);
      assert.equal(report.reconstructed, 1, "Event ohne result muss konservativ rekonstruiert werden");
      rmSync(ws, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("korrupte JSONL-Zeilen erscheinen im Report", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-repair-corruptline-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    const archiveDir = join(dir, "archive");
    try {
      const ws = makeWorkspace();
      writeFileSync(join(ws, ".adaptive-learning", "destructive-ops.jsonl"), "NOT JSON\n", "utf8");
      const { report } = run("repair-tombstones.mjs", ["--workspace", ws, "--base-db-path", baseDbPath, "--archive-dir", archiveDir]);
      assert.equal(report.corruptLines, 1, "korrupte Zeile muss gezählt werden");
      rmSync(ws, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("repair --apply Idempotenz + semantisch invalider Tombstone", () => {
  const MEMORY_ID = "a4563cc9-7611-4528-992a-075f8889a018";

  it("--apply ist idempotent (zweiter Lauf rekonstruiert nichts erneut)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-repair-apply-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    const archiveDir = join(dir, "archive");
    try {
      const ws = mkdtempSync(join(tmpdir(), "plur1bus-repair-apply-ws-"));
      mkdirSync(join(ws, ".adaptive-learning"), { recursive: true });
      const archivePath = join(archiveDir, "agent-a", `${MEMORY_ID}.json`);
      mkdirSync(join(archiveDir, "agent-a"), { recursive: true });
      writeFileSync(archivePath, JSON.stringify({ id: MEMORY_ID, text: "Gelöschter Fakt", scope: "agent-private" }), "utf8");
      writeFileSync(join(ws, ".adaptive-learning", "destructive-ops.jsonl"),
        JSON.stringify({ event: "memory.deleted", result: "committed", memoryId: MEMORY_ID, agentId: "agent-a", archivePath }) + "\n", "utf8");

      const first = run("repair-tombstones.mjs", ["--apply", "--workspace", ws, "--base-db-path", baseDbPath, "--archive-dir", archiveDir]);
      assert.equal(first.report.reconstructed, 1);

      const second = run("repair-tombstones.mjs", ["--apply", "--workspace", ws, "--base-db-path", baseDbPath, "--archive-dir", archiveDir]);
      assert.equal(second.report.reconstructed, 0, "zweiter Lauf darf nicht erneut rekonstruieren");
      assert.equal(second.report.skipped, 1);
      rmSync(ws, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("semantisch invalider Tombstone (valid JSON ohne memoryId) → Exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-reapply-invalid-"));
    try {
      const baseDbPath = join(dir, "lancedb-namespaced");
      mkdirSync(join(dir, "_tombstones"), { recursive: true });
      writeFileSync(join(dir, "_tombstones", "agent-a.jsonl"), '{"schemaVersion":1,"status":"committed"}\n', "utf8");

      const { status, report } = run("reapply-tombstones.mjs", ["--apply", "--base-db-path", baseDbPath]);
      assert.notEqual(status, 0, "semantisch invalider Tombstone muss zu Exit != 0 führen");
      assert.ok(report.registryErrors.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ungültiger Registry-Dateiname (bad agent.jsonl) → Exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-reapply-badname-"));
    try {
      const baseDbPath = join(dir, "lancedb-namespaced");
      mkdirSync(join(dir, "_tombstones"), { recursive: true });
      writeFileSync(join(dir, "_tombstones", "bad agent.jsonl"), "ignored\n", "utf8");

      const { status, report } = run("reapply-tombstones.mjs", ["--apply", "--base-db-path", baseDbPath]);
      assert.notEqual(status, 0, "ungültiger Dateiname muss zu Exit != 0 führen");
      assert.ok(report.registryErrors.some((e) => /invalid registry filename/.test(e.error)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

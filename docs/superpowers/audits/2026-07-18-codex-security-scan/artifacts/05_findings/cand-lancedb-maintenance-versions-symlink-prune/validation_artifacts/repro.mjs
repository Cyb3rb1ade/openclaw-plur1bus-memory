#!/usr/bin/env node
/**
 * Bounded CLI reproduction: only a disposable `_versions` symlink is pruned;
 * HOME is redirected to the same output directory so the backup is contained.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [outputDir] = process.argv.slice(2);
const script = process.env.PLUR1BUS_MAINTAIN_LANCEDB;
if (!outputDir || !script) throw new Error("usage: PLUR1BUS_MAINTAIN_LANCEDB=/immutable/maintain-lancedb.mjs node repro.mjs <output-dir>");

const root = resolve(outputDir);
rmSync(root, { recursive: true, force: true });
const base = join(root, "base");
const outside = join(root, "outside-versions");
const linkedVersions = join(base, "agent-a", "memories", "_versions");
const home = join(root, "home");
mkdirSync(outside, { recursive: true });
mkdirSync(join(base, "agent-a", "memories"), { recursive: true });
mkdirSync(home, { recursive: true });
const oldest = join(outside, "manifest-00.json");
for (let i = 0; i < 51; i++) {
  const file = join(outside, `manifest-${String(i).padStart(2, "0")}.json`);
  writeFileSync(file, JSON.stringify({ i }));
  const t = new Date(1_700_000_000_000 + i * 1000);
  utimesSync(file, t, t);
}
symlinkSync(outside, linkedVersions);

const run = spawnSync("node", [script, "--db-path", base, "--apply", "--keep", "50"], {
  encoding: "utf8",
  timeout: 20_000,
  env: { ...process.env, HOME: home },
});
const remaining = readdirSync(outside).filter((name) => name.endsWith(".json"));
const backupDir = join(home, ".openclaw-backups");
const result = {
  run: { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr },
  base,
  linkedVersions,
  outside,
  oldest,
  oldestWasRemoved: !existsSync(oldest),
  remainingManifestCount: remaining.length,
  containedBackupCreated: existsSync(backupDir),
};
writeFileSync(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: run.status, oldestWasRemoved: result.oldestWasRemoved, remainingManifestCount: result.remainingManifestCount, containedBackupCreated: result.containedBackupCreated }, null, 2)}\n`);

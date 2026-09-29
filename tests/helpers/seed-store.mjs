#!/usr/bin/env node
/**
 * tests/helpers/seed-store.mjs — write synthetic memories into an installed plugin's store (HM1 Task 8, D89).
 *
 * node tests/helpers/seed-store.mjs --state-dir <OpenClaw state dir> --base-db-path <dir> --plugin-dir <plugin dir>
 *   [--count 50] [--agent ci-seed]
 *
 * Opens `<baseDbPath>/<agent>` with the installed plugin's own MemoryDB (engine/store/memory-db.js, which loads the
 * plugin's own @lancedb/lancedb), so the table has exactly the schema that plugin version creates, and stores
 * `count` TEST ONLY rows with ids `<agent>-000…` and deterministic unit vectors (384 dimensions, the E5 profile the
 * installer chooses non-interactively). The store must lie strictly inside the given (disposable) state dir, and an
 * agent table that already has rows is refused, so a real store can never be written to by accident.
 * Prints { rows, agent, baseDbPath } as one JSON line; exit 0, 2 when refused, 1 on any other failure.
 */

import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { strictlyInside } from "./assert-disposable.mjs";

export const DIMENSIONS = 384;

export class SeedRefused extends Error {}

/** Throws unless baseDbPath lies strictly inside stateDir (symlinks of the existing prefix resolved). */
export function assertStoreInsideStateDir(stateDir, baseDbPath, platform = process.platform) {
  if (!stateDir || !baseDbPath) throw new SeedRefused("--state-dir and --base-db-path are required");
  if (!strictlyInside(baseDbPath, stateDir, platform)) {
    throw new SeedRefused(`refusing to seed ${resolve(baseDbPath)}: it lies outside the state dir ${resolve(stateDir)}`);
  }
}

/** A deterministic unit vector for row `i`. */
function vectorFor(i) {
  const v = Array.from({ length: DIMENSIONS }, (_, k) => Math.sin((i + 1) * (k + 1) * 0.37));
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @param {{ stateDir: string, baseDbPath: string, pluginDir: string, count?: number, agent?: string, now?: () => number }} o
 * @returns {Promise<{ rows: number, agent: string, baseDbPath: string }>}
 */
export async function seedStore({ stateDir, baseDbPath, pluginDir, count = 50, agent = "ci-seed", now = Date.now }) {
  assertStoreInsideStateDir(stateDir, baseDbPath);
  if (!/^[a-z0-9-]+$/.test(agent)) throw new SeedRefused(`invalid agent id ${JSON.stringify(agent)}`);
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new SeedRefused(`invalid --count ${count}`);
  const moduleFile = join(resolve(pluginDir), "engine", "store", "memory-db.js");
  if (!existsSync(moduleFile)) throw new Error(`${moduleFile} not found: --plugin-dir must be the installed plugin dir`);
  const { MemoryDB } = await import(pathToFileURL(realpathSync(moduleFile)).href);
  const dbPath = resolve(baseDbPath, agent);
  const db = new MemoryDB(dbPath, DIMENSIONS, SILENT);
  try {
    await db.init();
    const existing = await db.table.countRows();
    if (existing > 0) throw new SeedRefused(`refusing to seed ${dbPath}: it already has ${existing} row(s)`);
    const t0 = now();
    for (let i = 0; i < count; i++) {
      const n = String(i).padStart(3, "0");
      await db.store({
        id: `${agent}-${n}`,
        text: `TEST ONLY synthetic memory ${n} written by the plugin-dist workflow to prove an upgrade keeps every row.`,
        vector: vectorFor(i),
        agentId: agent,
        storedBy: agent,
        category: "fact",
        importance: 0.5,
        scope: "agent-private",
        createdAt: t0 + i,
        updatedAt: t0 + i,
      });
    }
    const rows = await db.table.countRows();
    return { rows, agent, baseDbPath: resolve(baseDbPath) };
  } finally {
    await db.shutdown();
  }
}

if (import.meta.filename && resolve(process.argv[1] ?? "") === import.meta.filename) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        "state-dir": { type: "string" },
        "base-db-path": { type: "string" },
        "plugin-dir": { type: "string" },
        count: { type: "string", default: "50" },
        agent: { type: "string", default: "ci-seed" },
      },
    });
    if (!values["plugin-dir"]) throw new SeedRefused("--plugin-dir is required");
    const r = await seedStore({ stateDir: values["state-dir"], baseDbPath: values["base-db-path"], pluginDir: values["plugin-dir"], count: Number(values.count), agent: values.agent });
    process.stdout.write(`${JSON.stringify(r)}\n`);
  } catch (err) {
    process.stderr.write(`seed-store: ${err?.message ?? err}\n`);
    process.exitCode = err instanceof SeedRefused ? 2 : 1;
  }
}

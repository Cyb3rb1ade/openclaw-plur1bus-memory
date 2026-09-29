#!/usr/bin/env node
/**
 * tests/helpers/store-digest.mjs — a row-order independent digest of a plugin store (HM1 Task 8, D89 "no data loss").
 *
 * node tests/helpers/store-digest.mjs --base-db-path <dir> [--plugin-dir <installed plugin dir>] [--out <json>]
 *
 * Every direct subdirectory of baseDbPath that holds a `memories.lance` table is one agent database (the plugin
 * opens `<baseDbPath>/<agentId>`, table `memories`). The digest is the row count and the SHA-256 of the sorted
 * `<agent>/<id>` lines, so compaction, a new LanceDB version or a restored copy with the same rows give the same
 * digest while a lost or added row does not. With --plugin-dir the store is read with that plugin's own
 * @lancedb/lancedb (the one that wrote it); otherwise with this repository's. Only ids are read, never text.
 * Prints { rows, sha256, tables } as one JSON line (and to --out); exit 0, or 1 with the reason on stderr.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const TABLE = "memories";

/** Row count and SHA-256 over the sorted id lines. */
export function digestIds(ids) {
  const sorted = [...ids].map(String).sort();
  return { rows: sorted.length, sha256: createHash("sha256").update(sorted.join("\n")).digest("hex") };
}

/** The @lancedb/lancedb module a plugin dir resolves (or this repository's). */
export async function loadLancedb(pluginDir) {
  if (!pluginDir) return import("@lancedb/lancedb");
  const req = createRequire(join(resolve(pluginDir), "package.json"));
  const mod = await import(pathToFileURL(req.resolve("@lancedb/lancedb")).href);
  return typeof mod.connect === "function" ? mod : mod.default;
}

/**
 * @param {{ baseDbPath: string, pluginDir?: string }} o
 * @returns {Promise<{ rows: number, sha256: string, tables: string[] }>}
 */
export async function storeDigest({ baseDbPath, pluginDir }) {
  const base = resolve(baseDbPath);
  if (!existsSync(base)) throw new Error(`no store at ${base}`);
  const lancedb = await loadLancedb(pluginDir);
  const ids = [];
  const tables = [];
  const agents = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(base, e.name, `${TABLE}.lance`)))
    .map((e) => e.name)
    .sort();
  for (const agent of agents) {
    const db = await lancedb.connect(join(base, agent));
    try {
      const table = await db.openTable(TABLE);
      try {
        const rows = await table.query().select(["id"]).toArray();
        for (const r of rows) ids.push(`${agent}/${r.id}`);
      } finally {
        table.close();
      }
    } finally {
      db.close?.();
    }
    tables.push(agent);
  }
  return { ...digestIds(ids), tables };
}

if (import.meta.filename && resolve(process.argv[1] ?? "") === import.meta.filename) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: { "base-db-path": { type: "string" }, "plugin-dir": { type: "string" }, out: { type: "string" } },
    });
    if (!values["base-db-path"]) throw new Error("--base-db-path is required");
    const d = await storeDigest({ baseDbPath: values["base-db-path"], pluginDir: values["plugin-dir"] });
    const line = JSON.stringify(d);
    if (values.out) writeFileSync(values.out, `${line}\n`);
    process.stdout.write(`${line}\n`);
  } catch (err) {
    process.stderr.write(`store-digest: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
/**
 * scripts/snapshot-store.mjs — CLI for the store snapshot step (HM1-R8).
 *
 *   node scripts/snapshot-store.mjs <create|list|verify|restore|prune>
 *     --state-dir <d> [--base-db-path <p>] [--label <l>] [--id <id>] [--json]
 *
 * Exit 0 ok, 1 SnapshotError (reason printed) or other failure, 2 usage.
 * With --json one document (schema plur1bus.snapshot/1) goes to stdout and
 * human lines to stderr.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SNAPSHOT_SCHEMA,
  SnapshotError,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  verifySnapshot,
} from "../lib/snapshot/store-snapshot.js";

const COMMANDS = new Set(["create", "list", "verify", "restore", "prune"]);
const VALUE_OPTS = new Map([
  ["--state-dir", "stateDir"],
  ["--base-db-path", "baseDbPath"],
  ["--label", "label"],
  ["--id", "id"],
]);
const REQUIRED = {
  create: ["stateDir", "baseDbPath"],
  list: ["stateDir"],
  verify: ["stateDir", "id"],
  restore: ["stateDir", "baseDbPath", "id"],
  prune: ["stateDir"],
};
const USAGE = "usage: snapshot-store.mjs <create|list|verify|restore|prune> --state-dir <d> [--base-db-path <p>] [--label <l>] [--id <id>] [--json]";

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) throw new UsageError(command ? `unknown command ${command}` : "missing command");
  const opts = { json: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") opts.json = true;
    else if (VALUE_OPTS.has(arg)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      opts[VALUE_OPTS.get(arg)] = value;
    } else throw new UsageError(`unknown option ${arg}`);
  }
  for (const key of REQUIRED[command]) {
    if (!opts[key]) throw new UsageError(`${command} needs --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return { command, opts };
}

function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined; // bundled or relocated: the version is optional metadata
  }
}

async function run(command, o) {
  switch (command) {
    case "create":
      return createSnapshot({ stateDir: o.stateDir, baseDbPath: o.baseDbPath, label: o.label, pluginVersion: pluginVersion() });
    case "list":
      return listSnapshots({ stateDir: o.stateDir });
    case "verify":
      if (!/^plur1bus-[A-Za-z0-9._-]+$/.test(o.id) || o.id.includes("..")) throw new SnapshotError("unsafe-path", `invalid snapshot id ${JSON.stringify(o.id)}`);
      return verifySnapshot({ dir: join(o.stateDir, "memory", ".snapshots", o.id) });
    case "restore":
      return restoreSnapshot({ stateDir: o.stateDir, baseDbPath: o.baseDbPath, id: o.id });
    case "prune":
      return { removed: await pruneSnapshots({ stateDir: o.stateDir }) };
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

function describe(command, result) {
  switch (command) {
    case "create":
      return [
        `snapshot ${result.id} created: ${result.files} files, ${result.bytes} bytes in ${result.dir}`,
        result.pruned.length ? `pruned ${result.pruned.join(", ")}` : "pruned nothing",
      ].join("\n");
    case "list":
      return result.length === 0 ? "no snapshots" : result.map((s) => `${s.id}\t${s.kind}\t${s.createdAt}\t${s.bytes}`).join("\n");
    case "verify":
      return `snapshot ${result.id} verified: ${result.files} files`;
    case "restore":
      return `store restored from ${result.id}${result.preRestorePath ? `; previous store kept at ${result.preRestorePath}` : ""}`;
    case "prune":
      return result.removed.length ? `removed ${result.removed.join(", ")}` : "nothing to prune";
    default:
      return "";
  }
}

async function main(argv) {
  const json = argv.includes("--json");
  const emit = (doc) => process.stdout.write(`${JSON.stringify(doc)}\n`);
  let command;
  try {
    const parsed = parseArgs(argv);
    command = parsed.command;
    const result = await run(command, parsed.opts);
    for (const w of result?.warnings ?? []) process.stderr.write(`snapshot-store: warning: ${w}\n`);
    if (json) emit({ schema: SNAPSHOT_SCHEMA, ok: true, command, result });
    else process.stdout.write(`${describe(command, result)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`snapshot-store: ${e.message}\n${USAGE}\n`);
      if (json) emit({ schema: SNAPSHOT_SCHEMA, ok: false, command: command ?? null, error: { reason: "usage", message: e.message } });
      return 2;
    }
    const reason = e instanceof SnapshotError ? e.reason : "error";
    process.stderr.write(`snapshot-store: ${reason}: ${e?.message ?? String(e)}\n`);
    if (json) emit({ schema: SNAPSHOT_SCHEMA, ok: false, command: command ?? null, error: { reason, message: e?.message ?? String(e) } });
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));

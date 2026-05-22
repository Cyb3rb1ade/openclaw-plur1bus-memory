#!/usr/bin/env node
/**
 * Workspace vault bridge CLI.
 *
 * Defaults are intentionally conservative: dry-run is on unless --live is
 * passed or obsidianBridge.dryRun=false is configured.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverObsidianWorkspaces,
  doctorObsidianBridge,
  initWorkspace,
  normalizeObsidianBridgeConfig,
  scanWorkspace,
  syncWorkspace,
  watchObsidianBridge,
} from "../extensions/memory-lancedb-namespaced/lib/obsidian-bridge.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

function usage() {
  console.log(`Usage:
  node scripts/workspace-vault-bridge.mjs init [--dry-run|--live] [--workspace main]
  node scripts/workspace-vault-bridge.mjs scan [--json] [--workspace main]
  node scripts/workspace-vault-bridge.mjs sync [--dry-run|--live] [--workspace main] [--json]
  node scripts/workspace-vault-bridge.mjs watch [--dry-run|--live] [--workspace main] [--interval-ms 5000]
  node scripts/workspace-vault-bridge.mjs doctor [--json] [--workspace main]

Notes:
  --dry-run is the default unless obsidianBridge.dryRun=false is configured.
  --live may create vault folders, write .obsidian files, update card frontmatter,
  append bridge state/logs, and enqueue memory_store requests. It never writes
  LanceDB directly.
`);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const args = { cmd, dryRun: null, workspace: null, json: false, intervalMs: null };
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === "--help" || value === "-h") {
      usage();
      process.exit(0);
    } else if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--live") {
      args.dryRun = false;
    } else if (value === "--workspace") {
      args.workspace = rest[++i];
      if (!args.workspace) throw new Error("--workspace requires a value");
    } else if (value === "--json") {
      args.json = true;
    } else if (value === "--interval-ms") {
      args.intervalMs = Number(rest[++i]);
      if (!Number.isFinite(args.intervalMs) || args.intervalMs <= 0) throw new Error("--interval-ms requires a positive number");
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return raw?.plugins?.entries?.["memory-lancedb-namespaced"]?.config || {};
}

function runtimeConfig(args) {
  const cfg = normalizeObsidianBridgeConfig(loadConfig(), { intervalMs: args.intervalMs });
  if (args.dryRun !== null) cfg.dryRun = args.dryRun;
  if (args.intervalMs) cfg.intervalMs = args.intervalMs;
  return cfg;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printActions(title, results) {
  console.log(`\n${title}\n`);
  for (const result of results) {
    const workspace = result.workspace;
    console.log(`- ${workspace.workspaceId} (${workspace.path})`);
    const actions = result.actions || [];
    const issues = result.issues || [];
    if (actions.length === 0) console.log("  actions: none");
    for (const action of actions) {
      console.log(`  action: ${action.action}${action.path ? ` ${action.path}` : ""}${action.reason ? ` (${action.reason})` : ""}`);
    }
    if (issues.length === 0) console.log("  issues: none");
    for (const issue of issues) {
      console.log(`  ${issue.severity || "info"}: ${issue.code}${issue.path ? ` ${issue.path}` : ""} - ${issue.message}`);
    }
  }
}

function printScan(results) {
  console.log("\nObsidian bridge scan\n");
  for (const result of results) {
    console.log(`- ${result.workspace.workspaceId} (${result.workspace.path})`);
    console.log(`  files: ${result.files.length}`);
    const invalid = result.files.filter((file) => file.validation.errors.length > 0);
    const unsynced = result.files.filter((file) => ["memory_card", "decision"].includes(file.kind) && !["synced", "queued", "validated"].includes(String(file.frontmatter.sync_status || "")));
    console.log(`  invalid: ${invalid.length}`);
    console.log(`  unsynced: ${unsynced.length}`);
  }
}

function printDoctor(report) {
  console.log("\nObsidian bridge doctor\n");
  console.log(`enabled: ${report.enabled}`);
  console.log(`dryRun:  ${report.dryRun}`);
  console.log(`status:  ${report.ok ? "ok" : "needs attention"}`);
  for (const item of report.reports) {
    console.log(`\n- ${item.workspace.workspaceId} (${item.workspace.path})`);
    if (item.issues.length === 0) {
      console.log("  issues: none");
      continue;
    }
    for (const issue of item.issues) {
      console.log(`  ${issue.severity}: ${issue.code}${issue.path ? ` ${issue.path}` : ""} - ${issue.message}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || args.cmd === "help") {
    usage();
    process.exit(args.cmd ? 0 : 1);
  }

  const cfg = runtimeConfig(args);
  const workspaceOptions = { workspace: args.workspace };

  if (args.cmd === "init") {
    const workspaces = discoverObsidianWorkspaces(cfg, workspaceOptions);
    const results = workspaces.map((workspace) => initWorkspace(workspace, { dryRun: cfg.dryRun }));
    args.json ? printJson(results) : printActions(`Obsidian bridge init (${cfg.dryRun ? "dry-run" : "live"})`, results);
    return;
  }

  if (args.cmd === "scan") {
    const workspaces = discoverObsidianWorkspaces(cfg, workspaceOptions);
    const results = workspaces.map((workspace) => scanWorkspace(workspace, cfg));
    args.json ? printJson(results) : printScan(results);
    return;
  }

  if (args.cmd === "sync") {
    const workspaces = discoverObsidianWorkspaces(cfg, workspaceOptions);
    const results = [];
    for (const workspace of workspaces) results.push(await syncWorkspace(workspace, cfg));
    args.json ? printJson(results) : printActions(`Obsidian bridge sync (${cfg.dryRun ? "dry-run" : "live"})`, results);
    return;
  }

  if (args.cmd === "doctor") {
    const report = await doctorObsidianBridge(cfg, workspaceOptions);
    args.json ? printJson(report) : printDoctor(report);
    process.exit(report.ok ? 0 : 1);
  }

  if (args.cmd === "watch") {
    const service = await watchObsidianBridge({ ...cfg, watch: true }, {
      ...workspaceOptions,
      logger: console,
    });
    console.log(`Obsidian bridge watch running from ${__dir}; dryRun=${cfg.dryRun}. Ctrl+C stops it.`);
    process.on("SIGINT", async () => {
      await service.stop();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await service.stop();
      process.exit(0);
    });
    return;
  }

  throw new Error(`Unknown command: ${args.cmd}`);
}

main().catch((err) => {
  console.error(`workspace-vault-bridge failed: ${err.message}`);
  process.exit(1);
});

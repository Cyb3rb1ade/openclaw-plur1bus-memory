#!/usr/bin/env node
// One-shot: run writeGraphLinks against the default workspace vault
import { readRecords } from "../lib/obsidian/record-index.js";
import { writeGraphLinks } from "../lib/obsidian/graph-link-writer.js";

import { homedir } from "node:os";
import { join } from "node:path";

const rawConfig = {
  vaultPath: process.env.PLUR1BUS_VAULT_PATH || join(homedir(), ".openclaw", "workspace"),
  reviewRoot: "plur1bus",
};

console.log("Reading records...");
const records = readRecords(rawConfig);
console.log(`Found ${records.length} records. Running writeGraphLinks...`);

const result = await writeGraphLinks(rawConfig, records, {
  logger: { info: console.log, warn: console.warn },
});

console.log("\n=== Result ===");
console.log(`  updated:   ${result.updated}`);
console.log(`  unchanged: ${result.unchanged}`);
console.log(`  skipped:   ${result.skipped}`);
console.log(`  conflicts: ${result.conflicts.length}`);
console.log(`  tiersUsed: ${result.tiersUsed.join(", ") || "(none)"}`);
if (result.conflicts.length > 0) {
  console.log(`  conflict IDs: ${result.conflicts.slice(0, 10).join(", ")}${result.conflicts.length > 10 ? "..." : ""}`);
}

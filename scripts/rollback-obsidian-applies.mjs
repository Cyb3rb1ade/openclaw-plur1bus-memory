#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function expandHome(value) {
  const raw = String(value || "");
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function walkReviewBundleFiles(openclawHome) {
  const roots = readdirSync(openclawHome, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === "workspace" || entry.name.startsWith("workspace-")))
    .map((entry) => join(openclawHome, entry.name, "plur1bus", "review-bundles"))
    .filter((path) => existsSync(path));
  const files = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".items.json")) files.push(join(root, entry.name));
    }
  }
  return files.sort();
}

function isObsidianAppliedMemory(item) {
  if (!["applied"].includes(item?.status)) return false;
  if (!["note_import_candidate", "memory_promotion"].includes(item?.type)) return false;
  if (!item.appliedMemoryId) return false;
  const source = [
    item.sourceTrustLevel,
    item.sourceTrust,
    item.applyPreview?.payload?.origin,
    item.applyPreview?.payload?.sourceUrl,
    ...(Array.isArray(item.sourceRefs) ? item.sourceRefs : []),
  ].join(" ");
  return /obsidian/i.test(source) || item.type === "note_import_candidate";
}

function collectRollbackCandidates({ openclawHome, sinceMs }) {
  const byId = new Map();
  const files = walkReviewBundleFiles(openclawHome);
  for (const file of files) {
    const record = readJson(file, null);
    if (!record || !Array.isArray(record.items)) continue;
    const bundle = record.bundle || {};
    for (const item of record.items) {
      if (!isObsidianAppliedMemory(item)) continue;
      const appliedAt = Date.parse(item.appliedAt || bundle.updatedAt || bundle.createdAt || "");
      if (!Number.isFinite(appliedAt) || appliedAt < sinceMs) continue;
      const previous = byId.get(item.appliedMemoryId);
      const sourcePath = item.preconditions?.sourcePath || item.sourcePath || item.target || item.sourceRefs?.[0] || "";
      const candidate = {
        memoryId: item.appliedMemoryId,
        bundleId: bundle.bundleId || "",
        bundleFile: file,
        workspaceKey: bundle.workspaceKey || "",
        createdByAgent: bundle.createdByAgent || "",
        itemId: item.id || "",
        type: item.type,
        target: item.target || "",
        sourcePath,
        appliedAt: item.appliedAt || "",
      };
      if (previous) previous.items.push(candidate);
      else byId.set(item.appliedMemoryId, { memoryId: item.appliedMemoryId, items: [candidate] });
    }
  }
  return [...byId.values()];
}

async function importLanceDb() {
  return await import("@lancedb/lancedb");
}

async function findAndMaybeDelete({ dbRoot, candidates, apply, namespaceFilter }) {
  const lancedb = await importLanceDb();
  const allowedNamespaces = namespaceFilter ? new Set(namespaceFilter.split(",").map((item) => item.trim()).filter(Boolean)) : null;
  const namespaces = readdirSync(dbRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dbRoot, entry.name, "memories.lance")))
    .filter((entry) => !allowedNamespaces || allowedNamespaces.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const hits = [];
  const ids = new Set(candidates.map((candidate) => candidate.memoryId));
  for (const namespace of namespaces) {
    const db = await lancedb.connect(join(dbRoot, namespace));
    const table = await db.openTable("memories");
    const count = await table.countRows();
    if (count === 0) continue;
    const rows = await table.query()
      .select(["id", "storedBy", "origin", "sourceUrl", "createdAt", "text"])
      .limit(count)
      .toArray();
    const idsToDelete = new Set();
    for (const row of rows) {
      const memoryId = row.id || "";
      if (ids.has(memoryId)) {
        idsToDelete.add(memoryId);
        hits.push({
          namespace,
          memoryId,
          storedBy: row.storedBy || "",
          origin: row.origin || "",
          sourceUrl: row.sourceUrl || "",
          createdAt: row.createdAt || null,
          textPreview: String(row.text || "").slice(0, 180),
          deleted: false,
        });
      }
    }
    if (apply) {
      for (const memoryId of idsToDelete) {
        await table.delete(`id = "${memoryId}"`);
        for (const hit of hits.filter((hit) => hit.namespace === namespace && hit.memoryId === memoryId)) {
          hit.deleted = true;
        }
      }
    }
  }
  return hits;
}

const openclawHome = expandHome(argValue("--openclaw-home", process.env.OPENCLAW_HOME || "~/.openclaw"));
const dbRoot = expandHome(argValue("--db-root", join(openclawHome, "memory", "lancedb-namespaced")));
const hours = Number(argValue("--hours", "56"));
const apply = hasArg("--apply");
const namespaceFilter = argValue("--namespaces", "");
const sinceMs = Date.now() - hours * 60 * 60 * 1000;
const reportPath = expandHome(argValue("--report", join(dbRoot, `obsidian-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)));

if (!existsSync(openclawHome)) throw new Error(`OPENCLAW_HOME not found: ${openclawHome}`);
if (!existsSync(dbRoot)) throw new Error(`LanceDB root not found: ${dbRoot}`);

const candidates = collectRollbackCandidates({ openclawHome, sinceMs });
const hits = await findAndMaybeDelete({ dbRoot, candidates, apply, namespaceFilter });
const report = {
  mode: apply ? "apply" : "dry-run",
  createdAt: new Date().toISOString(),
  hours,
  since: new Date(sinceMs).toISOString(),
  openclawHome,
  dbRoot,
  namespaces: namespaceFilter || "all",
  candidateMemoryIds: candidates.length,
  foundRows: hits.length,
  deletedRows: hits.filter((hit) => hit.deleted).length,
  candidates,
  hits,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  mode: report.mode,
  hours: report.hours,
  since: report.since,
  candidateMemoryIds: report.candidateMemoryIds,
  foundRows: report.foundRows,
  deletedRows: report.deletedRows,
  namespaces: report.namespaces,
  reportPath,
}, null, 2));

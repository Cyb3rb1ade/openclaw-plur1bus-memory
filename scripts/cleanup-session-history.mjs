#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_ROOT = path.join(os.homedir(), ".openclaw", "agents");

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage: cleanup-session-history.mjs [options]

Rewrites OpenClaw session transcript JSONL files to the active parentId branch.
This removes append-only branch garbage created by older transcript/history handling.

Options:
  --root <dir>          Agents root. Default: ~/.openclaw/agents
  --agent <id>          Agent id to scan. Repeatable. Default: all agents under root
  --file <path>         Single transcript file. Repeatable. Overrides --agent scan
  --write               Rewrite files. Without this, only dry-run analysis is printed
  --backup-dir <dir>    Backup directory. Default: <sessions-dir>/.history-cleanup-backups
  --include-deleted     Include *.deleted.* archived transcripts
  --include-trajectory  Include *.trajectory.jsonl transcripts
  --json                Print machine-readable JSON summary
  --help                Show this help

Examples:
  node scripts/cleanup-session-history.mjs --agent main --agent bernhardine --agent heisenberg
  node scripts/cleanup-session-history.mjs --agent main --write
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    root: DEFAULT_ROOT,
    agents: [],
    files: [],
    write: false,
    backupDir: null,
    includeDeleted: false,
    includeTrajectory: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--write") { opts.write = true; continue; }
    if (arg === "--include-deleted") { opts.includeDeleted = true; continue; }
    if (arg === "--include-trajectory") { opts.includeTrajectory = true; continue; }
    if (arg === "--json") { opts.json = true; continue; }
    if (["--root", "--agent", "--file", "--backup-dir"].includes(arg)) {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      i += 1;
      if (arg === "--root") opts.root = path.resolve(value);
      if (arg === "--agent") opts.agents.push(value);
      if (arg === "--file") opts.files.push(path.resolve(value));
      if (arg === "--backup-dir") opts.backupDir = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function isCandidate(file, opts) {
  if (!file.endsWith(".jsonl") && !file.includes(".jsonl.deleted.")) return false;
  if (!opts.includeDeleted && file.includes(".deleted.")) return false;
  if (!opts.includeTrajectory && file.includes(".trajectory.jsonl")) return false;
  return true;
}

function listTranscriptFiles(opts) {
  if (opts.files.length > 0) return [...new Set(opts.files)];
  const agents = opts.agents.length > 0
    ? opts.agents
    : fs.readdirSync(opts.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

  const files = [];
  for (const agent of agents) {
    const sessionsDir = path.join(opts.root, agent, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (isCandidate(entry.name, opts)) files.push(path.join(sessionsDir, entry.name));
    }
  }
  return files.sort();
}

function parseJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const rawLines = text.split(/\r?\n/);
  if (rawLines.at(-1) === "") rawLines.pop();

  const records = [];
  let invalidLines = 0;
  for (const line of rawLines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push({ entry: parsed, line, index: records.length });
      } else {
        invalidLines += 1;
      }
    } catch {
      invalidLines += 1;
    }
  }
  return { text, rawLines, records, entries: records.map((record) => record.entry), invalidLines };
}

function activeBranch(records) {
  const byId = new Map();
  let leafId;
  for (const record of records) {
    const entry = record.entry;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    byId.set(entry.id, record);
    leafId = entry.id;
  }
  if (!leafId) return { active: records, idCount: byId.size, leafId: null, cycle: false };

  const active = [];
  const seen = new Set();
  let currentId = leafId;
  let cycle = false;
  while (currentId) {
    if (seen.has(currentId)) { cycle = true; break; }
    seen.add(currentId);
    const record = byId.get(currentId);
    if (!record) break;
    active.push(record);
    currentId = typeof record.entry.parentId === "string" ? record.entry.parentId : undefined;
  }
  active.reverse();
  return { active, idCount: byId.size, leafId, cycle };
}

function isPreludeMetadata(record) {
  const entry = record.entry;
  if (entry.message || entry.type === "compaction") return false;
  return true;
}

function keptRecords(records, active) {
  if (active.length === 0) return records;
  const firstActiveIndex = active[0].index;
  const prelude = records.filter((record) => record.index < firstActiveIndex && isPreludeMetadata(record));
  return [...prelude, ...active];
}

function analyzeFile(filePath) {
  const parsed = parseJsonl(filePath);
  const branch = activeBranch(parsed.records);
  const kept = keptRecords(parsed.records, branch.active);
  const activeLines = kept.map((record) => record.line);
  const nextText = activeLines.length > 0 ? `${activeLines.join("\n")}\n` : "";
  const changed = parsed.text !== nextText;
  return {
    file: filePath,
    rawLines: parsed.rawLines.length,
    parsedEntries: parsed.entries.length,
    invalidLines: parsed.invalidLines,
    idCount: branch.idCount,
    leafId: branch.leafId,
    activeEntries: activeLines.length,
    branchEntries: branch.active.length,
    preservedPreludeEntries: activeLines.length - branch.active.length,
    removedEntries: Math.max(0, parsed.entries.length - activeLines.length),
    removedRawLines: Math.max(0, parsed.rawLines.length - activeLines.length),
    cycle: branch.cycle,
    changed,
    nextText,
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeCleaned(result, opts) {
  const backupDir = opts.backupDir ?? path.join(path.dirname(result.file), ".history-cleanup-backups");
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, `${path.basename(result.file)}.${timestamp()}.bak`);
  fs.copyFileSync(result.file, backupPath);
  const tmpPath = `${result.file}.cleanup-${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, result.nextText, { mode: fs.statSync(result.file).mode & 0o777 });
  fs.renameSync(tmpPath, result.file);
  return backupPath;
}

function summarize(results) {
  return {
    scannedFiles: results.length,
    changedFiles: results.filter((r) => r.changed).length,
    filesWithInvalidLines: results.filter((r) => r.invalidLines > 0).length,
    totalRawLines: results.reduce((sum, r) => sum + r.rawLines, 0),
    totalParsedEntries: results.reduce((sum, r) => sum + r.parsedEntries, 0),
    totalActiveEntries: results.reduce((sum, r) => sum + r.activeEntries, 0),
    totalRemovedEntries: results.reduce((sum, r) => sum + r.removedEntries, 0),
    totalRemovedRawLines: results.reduce((sum, r) => sum + r.removedRawLines, 0),
  };
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const files = listTranscriptFiles(opts);
  const results = files.map(analyzeFile);

  if (opts.write) {
    for (const result of results) {
      if (!result.changed) continue;
      result.backupPath = writeCleaned(result, opts);
    }
  }

  const printable = results.map(({ nextText, ...rest }) => rest);
  const summary = summarize(printable);
  if (opts.json) {
    console.log(JSON.stringify({ mode: opts.write ? "write" : "dry-run", summary, files: printable }, null, 2));
  } else {
    console.log(`${opts.write ? "write" : "dry-run"}: scanned=${summary.scannedFiles} changed=${summary.changedFiles} removedEntries=${summary.totalRemovedEntries} removedRawLines=${summary.totalRemovedRawLines} invalidFiles=${summary.filesWithInvalidLines}`);
    for (const result of printable.filter((r) => r.changed || r.invalidLines > 0)) {
      const backup = result.backupPath ? ` backup=${result.backupPath}` : "";
      console.log(`- ${result.file}: lines ${result.rawLines}->${result.activeEntries}, entries ${result.parsedEntries}->${result.activeEntries}, invalid=${result.invalidLines}${backup}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

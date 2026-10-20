/**
 * tests/obsidian-audit-fixes.test.js
 *
 * Obsidian-Audit 20.10.2026 (Fund 1-4). Jeder Test war vor dem Fix rot.
 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { rotateOldArchives } from "../lib/obsidian/archive-rotation.js";
import { formatFrontmatter, mergeFrontmatterKeys, parseFrontmatter } from "../lib/obsidian/frontmatter.js";
import { writeMemoryNotes } from "../lib/obsidian/memory-note-writer.js";
import { writeRecordNote } from "../lib/obsidian/record-writer.js";
import { stableContentHash, syncWorkspace } from "../lib/obsidian-bridge.js";
import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const DAY = 86_400_000;

function policyFor(tokens, baseDbPath, workspaceIdentity = "workspace:v1:test") {
  return parseObsidianCommandPlan(tokens, {
    memoryCtx: { agentId: "test-agent", workspaceIdentity },
    baseDbPath,
    mode: "apply",
    allowWrite: true,
    vaultConfirmed: true,
    actionConfirmed: true,
  }).mutationPolicy;
}

// ─── 1: Archivrotation überschreibt nichts ─────────────────────────────────

describe("1: archive-rotation überschreibt gleichnamige Archive nicht", () => {
  it("archiviert zwei Versionen derselben Datei unter eindeutigen Namen", () => {
    const dir = makeTempDir("obs-rot-");
    const policy = policyFor(["rotate", "--apply"], dir);
    const put = (content) => {
      const p = join(dir, "notes.md");
      writeFileSync(p, content);
      utimesSync(p, (Date.now() - 40 * DAY) / 1000, (Date.now() - 40 * DAY) / 1000);
    };
    put("VERSION A");
    rotateOldArchives(dir, { dryRun: false, action: "move", maxAgeDays: 30, mutationPolicy: policy });
    put("VERSION B");
    const second = rotateOldArchives(dir, { dryRun: false, action: "move", maxAgeDays: 30, mutationPolicy: policy });
    assert.equal(second.moved, 1);
    const stale = readdirSync(join(dir, "stale"));
    assert.equal(stale.length, 2, stale.join(","));
    const contents = stale.map((name) => readFileSync(join(dir, "stale", name), "utf8")).sort();
    assert.deepEqual(contents, ["VERSION A", "VERSION B"]);
    assert.ok(stale.includes("notes.md"), "der erste Name bleibt unverändert");
    assert.ok(second.files[0].dest.startsWith("stale/notes"), second.files[0].dest);
    assert.notEqual(second.files[0].dest, "stale/notes.md");
  });
});

// ─── 3: Front-Matter-Rewrite erhält Unbekanntes ────────────────────────────

const USER_KEYS = [
  "Projekt Status: aktiv",
  "review:",
  "  owner: christian",
  "  due: 2026-11-01",
  "notes: |",
  "  Zeile eins",
  "  Zeile zwei",
  "tags:",
  "- alpha",
  "- beta",
  "# Kommentar des Nutzers",
  "aliases: [a, b]",
];

describe("3: Front-Matter-Rewrite verändert nur die eigenen Schlüssel", () => {
  it("mergeFrontmatterKeys ersetzt eigene Blöcke und lässt alles andere byte-genau stehen", () => {
    const raw = ["a: 1", ...USER_KEYS, "status: pending", "list:", "  - x", "  - y"].join("\n");
    const out = mergeFrontmatterKeys(raw, { status: "done", list: ["p", "q"], fresh: "neu" });
    const lines = out.split("\n");
    for (const line of USER_KEYS) assert.ok(lines.includes(line), `fehlt: ${line}`);
    assert.ok(lines.includes("status: done"));
    assert.ok(!out.includes("status: pending"));
    assert.ok(!out.includes("  - x"));
    assert.ok(out.includes("list:\n  - p\n  - q"));
    assert.ok(lines.includes("fresh: neu"));
    assert.ok(lines.includes("a: 1"));
  });

  it("record-writer erhält Nutzerschlüssel bei einer Statusänderung", () => {
    const vault = makeTempDir("obs-rec-");
    const cfg = { vaultPath: vault, reviewRoot: "plur1bus" };
    const policy = policyFor(["review", "apply"], vault);
    const record = { id: "task-1", type: "task", title: "T", summary: "Eins", status: "pending" };
    const first = writeRecordNote(cfg, record, { mutationPolicy: policy });
    assert.equal(first.ok, true, JSON.stringify(first));
    const file = join(vault, "plur1bus", first.path.replace(/^plur1bus\//, ""));
    const target = existsSync(file) ? file : join(vault, first.path);
    const text = readFileSync(target, "utf8");
    const end = text.indexOf("\n---\n", 4);
    writeFileSync(target, `${text.slice(0, end)}\n${USER_KEYS.join("\n")}${text.slice(end)}`);
    const second = writeRecordNote(cfg, { ...record, summary: "Zwei", status: "done" }, { mutationPolicy: policy });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.changed, true);
    const fm = parseFrontmatter(readFileSync(target, "utf8")).rawFrontmatter.split("\n");
    for (const line of USER_KEYS) assert.ok(fm.includes(line), `fehlt: ${line}\n${fm.join("\n")}`);
  });
});

function bridgeWorkspace(dir) {
  return { workspaceId: "test-ws", agentId: "test-agent", path: dir, includeGlobs: ["**/*.md"], ignoreGlobs: [".git/**", ".obsidian/**"] };
}

function cardWith(extraLines = [], body = "Test memory content.") {
  return [
    "---",
    "plur1bus_type: memory_card",
    "workspace_id: test-ws",
    "agent_id: test-agent",
    "category: fact",
    "importance: 0.7",
    "scope: workspace",
    "source_kind: obsidian",
    "sync_status: validated",
    `content_hash: ${stableContentHash(body)}`,
    ...extraLines,
    "---",
    "",
    body,
  ].join("\n");
}

function applyOptions(dir, memoryStore) {
  return {
    dryRun: false,
    requireVaultPathConfirmation: true,
    backupBeforeApply: true,
    auditLog: true,
    applyApproved: true,
    approvedPaths: "all",
    mutationPolicy: policyFor(["review", "apply"], dir, "workspace:v1:test-ws"),
    memoryStore,
  };
}

describe("3: Bridge-Write-back erhält Nutzerschlüssel", () => {
  it("unbekannte, verschachtelte und Block-Schlüssel bleiben nach Apply erhalten", async () => {
    const dir = makeTempDir("obs-bridge-fm-");
    mkdirSync(join(dir, "memory", "cards"), { recursive: true });
    const note = join(dir, "memory", "cards", "test.md");
    writeFileSync(note, cardWith(USER_KEYS));
    const result = await syncWorkspace(bridgeWorkspace(dir), applyOptions(dir, async () => ({ details: { id: "mem-123" } })));
    assert.ok(result.actions.some((a) => a.action === "memory_stored"), JSON.stringify(result.actions));
    const after = readFileSync(note, "utf8");
    const fm = parseFrontmatter(after).rawFrontmatter.split("\n");
    for (const line of USER_KEYS) assert.ok(fm.includes(line), `fehlt: ${line}\n${after}`);
    assert.ok(fm.includes("sync_status: synced"));
    assert.ok(fm.includes("memory_id: mem-123"));
    assert.ok(after.endsWith("Test memory content."));
  });
});

// ─── 2: Nutzeränderung während des Write-back ──────────────────────────────

describe("2: Bridge überschreibt keine Nutzeränderung während des Apply", () => {
  it("erkennt die Änderung zwischen Scan und Write-back und lässt die Datei unberührt", async () => {
    const dir = makeTempDir("obs-bridge-race-");
    mkdirSync(join(dir, "memory", "cards"), { recursive: true });
    const note = join(dir, "memory", "cards", "test.md");
    writeFileSync(note, cardWith());
    const result = await syncWorkspace(bridgeWorkspace(dir), applyOptions(dir, async () => {
      appendFileSync(note, "\n\nNachtrag des Nutzers während des Syncs.\n");
      return { details: { id: "mem-race" } };
    }));
    const after = readFileSync(note, "utf8");
    assert.ok(after.includes("Nachtrag des Nutzers"), after);
    assert.ok(after.includes("sync_status: validated"), "die Datei wurde nicht neu geschrieben");
    const skipped = result.actions.find((a) => a.path?.endsWith("test.md") && a.action === "write_back_skipped_user_edit");
    assert.ok(skipped, JSON.stringify(result.actions));
    assert.equal(skipped.memoryId, "mem-race");
  });

  it("ohne Änderung wird weiter normal zurückgeschrieben", async () => {
    const dir = makeTempDir("obs-bridge-norace-");
    mkdirSync(join(dir, "memory", "cards"), { recursive: true });
    const note = join(dir, "memory", "cards", "test.md");
    writeFileSync(note, cardWith());
    await syncWorkspace(bridgeWorkspace(dir), applyOptions(dir, async () => ({ details: { id: "mem-ok" } })));
    assert.match(readFileSync(note, "utf8"), /sync_status: synced/);
  });
});

// ─── 4: Mirror-Notizen erhalten Nutzeranmerkungen ──────────────────────────

describe("4: Mirror-Notizen erhalten Nutzeranmerkungen", () => {
  const record = (text, extra = {}) => ({
    id: "11111111-2222-4333-8444-555555555555",
    text,
    summary: "Kurzfassung",
    category: "fact",
    importance: 0.5,
    scope: "agent-private",
    createdAt: 1_700_000_000_000,
    agentId: "agent-a",
    ...extra,
  });

  function setup() {
    const vault = makeTempDir("obs-mirror-");
    const cfg = { vaultPath: vault, reviewRoot: "plur1bus", agentId: "agent-a", workspaceKey: "ws" };
    const mutationPolicy = policyFor(["review", "apply"], vault);
    const file = join(vault, "plur1bus", "memories", "11111111-2222-4333-8444-555555555555.md");
    return { vault, cfg, mutationPolicy, file };
  }

  it("ein Update ersetzt nur den verwalteten Block, Anmerkungen davor und danach bleiben", () => {
    const { cfg, mutationPolicy, file } = setup();
    assert.equal(writeMemoryNotes(cfg, [record("Erster Text")], { mutationPolicy }).written, 1);
    const v1 = readFileSync(file, "utf8");
    const edited = v1.replace("---\n\n", "---\n\nMeine Vorbemerkung.\n\n") + "\n## Meine Anmerkungen\n\n- wichtig: Frage an Eva\n";
    writeFileSync(file, edited);
    const result = writeMemoryNotes(cfg, [record("Zweiter Text, geändert")], { mutationPolicy });
    assert.equal(result.written, 1);
    const v2 = readFileSync(file, "utf8");
    assert.ok(v2.includes("Zweiter Text, geändert"));
    assert.ok(!v2.includes("Erster Text"));
    assert.ok(v2.includes("Meine Vorbemerkung."));
    assert.ok(v2.includes("- wichtig: Frage an Eva"));
    assert.match(v2, /content_hash: sha256:/);
    assert.equal(parseFrontmatter(v2).frontmatter.memory_id, "11111111-2222-4333-8444-555555555555");
  });

  it("unveränderter Record: Datei bleibt byte-gleich, Anmerkungen sowieso", () => {
    const { cfg, mutationPolicy, file } = setup();
    writeMemoryNotes(cfg, [record("Text")], { mutationPolicy });
    appendFileSync(file, "\nAnmerkung\n");
    const before = readFileSync(file, "utf8");
    const result = writeMemoryNotes(cfg, [record("Text")], { mutationPolicy });
    assert.equal(result.skipped, 1);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  it("Nutzerbearbeitung INNERHALB des verwalteten Blocks wird nicht überschrieben", () => {
    const { cfg, mutationPolicy, file } = setup();
    writeMemoryNotes(cfg, [record("Erster Text")], { mutationPolicy });
    writeFileSync(file, readFileSync(file, "utf8").replace("Erster Text", "Erster Text, vom Nutzer umgeschrieben"));
    const warnings = [];
    const result = writeMemoryNotes(cfg, [record("Zweiter Text")], { mutationPolicy, logger: { warn: (m) => warnings.push(String(m)) } });
    assert.equal(result.written, 0);
    assert.equal(result.skipped, 1);
    assert.ok(readFileSync(file, "utf8").includes("vom Nutzer umgeschrieben"));
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes("Zweiter Text"));
  });

  it("eine ältere Notiz ohne Marker behält ihren bisherigen Inhalt beim ersten Update", () => {
    const { cfg, mutationPolicy, file } = setup();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, [
      "---",
      "memory_id: 11111111-2222-4333-8444-555555555555",
      "plur1bus_type: memory",
      "category: fact",
      "importance: 0.5",
      "scope: agent-private",
      "created_at: 1700000000000",
      "content_hash: sha256:alt",
      "---",
      "",
      "# Kurzfassung",
      "",
      "Alter Text",
      "",
      "Meine alte Anmerkung",
    ].join("\n"));
    const result = writeMemoryNotes(cfg, [record("Neuer Text")], { mutationPolicy });
    assert.equal(result.written, 1);
    const after = readFileSync(file, "utf8");
    assert.ok(after.includes("Neuer Text"));
    assert.ok(after.includes("Meine alte Anmerkung"), "nichts geht verloren");
  });
});

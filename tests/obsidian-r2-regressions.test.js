import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { describe, it, mock } from "node:test";
import { formatMarkdownFrontmatter, parseMarkdownFrontmatter, scanWorkspace, stableContentHash, syncWorkspace } from "../lib/obsidian-bridge.js";
import { resolveReviewPath } from "../lib/obsidian/safe-paths.js";
import { writeMemoryNotes, backfillMemoryNoteScope } from "../lib/obsidian/memory-note-writer.js";
import { writeRecordNote } from "../lib/obsidian/record-writer.js";
import { safeBridgePath } from "../lib/obsidian-control-room.js";
import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";
import { resolveInside } from "../lib/sql-safety.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function workspace(dir) {
  return { path: dir, workspaceId: "r2", agentId: "agent", includeGlobs: ["**/*.md"], ignoreGlobs: [".git/**", ".obsidian/**"] };
}
function policy(dir) {
  return parseObsidianCommandPlan(["review", "apply"], {
    memoryCtx: { agentId: "agent", workspaceIdentity: "workspace:v1:r2" },
    baseDbPath: dir, mode: "apply", allowWrite: true, vaultConfirmed: true, actionConfirmed: true,
  }).mutationPolicy;
}

describe("R2 scan exclusions preserve existing notes", () => {
  it("apply-all does not tombstone a synchronized note that grows too large", async () => {
    const dir = makeTempDir("obs-r2-large-");
    const ws = workspace(dir);
    const body = "# original\n";
    writeFileSync(join(dir, "note.md"), formatMarkdownFrontmatter({
      plur1bus_type: "memory_card", workspace_id: "r2", agent_id: "agent",
      category: "fact", importance: 0.7, scope: "workspace", source_kind: "obsidian",
      sync_status: "validated", content_hash: stableContentHash(body),
    }, body));
    // The real bridge persists sync state; only the external memory-store boundary is a fake.
    const options = { dryRun: false, tombstoneOnDelete: true, backupBeforeApply: false, auditLog: false, requireVaultPathConfirmation: false, applyApproved: true, approvedPaths: "all", mutationPolicy: policy(dir), memoryStore: async () => ({ details: { id: "memory-1" } }) };
    const first = await syncWorkspace(ws, options);
    assert.ok(first.actions.some((action) => action.action === "memory_stored" && action.memoryId === "memory-1"));
    writeFileSync(join(dir, "note.md"), "x".repeat(262145));
    const second = await syncWorkspace(ws, options);
    assert.ok(second.issues.some((issue) => issue.code === "file_too_large"));
    assert.deepEqual(second.actions.filter((action) => /tombstone/.test(action.action)), []);
    assert.ok(second.scan.skippedPaths.includes("note.md"));
  });

  it("records matching paths beyond the file count cap as skipped", () => {
    const dir = makeTempDir("obs-r2-count-");
    for (let n = 0; n < 5002; n++) writeFileSync(join(dir, `${String(n).padStart(5, "0")}.md`), "x");
    writeFileSync(join(dir, "ignored.txt"), "x");
    const scan = scanWorkspace(workspace(dir));
    assert.equal(scan.files.length, 5000);
    assert.equal(scan.skippedPaths.length, 2);
    assert.equal(new Set([...scan.files.map((file) => file.relPath), ...scan.skippedPaths]).size, 5002);
    assert.ok(!scan.skippedPaths.includes("ignored.txt"));
  });

  it("records matching paths beyond the total byte cap as skipped", () => {
    const dir = makeTempDir("obs-r2-bytes-");
    for (let n = 0; n < 402; n++) {
      const file = join(dir, `${String(n).padStart(3, "0")}.md`);
      writeFileSync(file, "");
      truncateSync(file, 262144);
    }
    const scan = scanWorkspace(workspace(dir));
    assert.equal(scan.files.length, 400);
    assert.equal(scan.skippedPaths.length, 2);
    assert.equal(new Set([...scan.files.map((file) => file.relPath), ...scan.skippedPaths]).size, 402);
  });

  it("records paths whose read fails as skipped", () => {
    const dir = makeTempDir("obs-r2-read-");
    const target = join(dir, "unreadable.md");
    writeFileSync(target, "x");
    const original = fs.readFileSync;
    const read = mock.method(fs, "readFileSync", (file, ...args) => {
      if (file === target) throw new Error("injected read failure");
      return original(file, ...args);
    });
    syncBuiltinESMExports();
    let scan;
    try { scan = scanWorkspace(workspace(dir)); }
    finally { read.mock.restore(); syncBuiltinESMExports(); }
    assert.ok(scan.issues.some((issue) => issue.code === "read_failed"));
    assert.deepEqual(scan.skippedPaths, ["unreadable.md"]);
  });
});

describe("R2 symmetric bridge front matter", () => {
  for (const [label, value] of [
    ["quotes", 'a: "quoted" value'],
    ["newlines", "first\nsecond\r\nthird"],
    ["quoted string", '"quoted"'],
    ["backslashes", "C:\\notes\\new"],
    ["boolean-like string", "true"],
    ["number-like string", "001"],
  ]) {
    it(`preserves ${label} through five write-backs`, () => {
      let text = formatMarkdownFrontmatter({ title: value, aliases: [value] }, "body\n");
      const first = text;
      for (let n = 0; n < 5; n++) {
        const parsed = parseMarkdownFrontmatter(text);
        assert.equal(parsed.frontmatter.title, value);
        assert.deepEqual(parsed.frontmatter.aliases, [value]);
        text = formatMarkdownFrontmatter(parsed.frontmatter, parsed.body);
        assert.equal(text, first);
      }
    });
  }
  it("decodes YAML single-quoted apostrophes without JSON unescaping", () => {
    assert.equal(parseMarkdownFrontmatter("---\ntitle: 'it''s C:\\notes'\n---\n").frontmatter.title, "it's C:\\notes");
  });
});

describe("R2 vault writes refuse symlink escapes", () => {
  function fixture(linkName = "escape") {
    const vault = makeTempDir("obs-r2-vault-");
    const outside = makeTempDir("obs-r2-out-");
    mkdirSync(join(vault, "plur1bus"));
    mkdirSync(dirname(join(vault, "plur1bus", linkName)), { recursive: true });
    symlinkSync(outside, join(vault, "plur1bus", linkName), process.platform === "win32" ? "junction" : "dir");
    return { vault, outside, config: { vaultPath: vault, reviewRoot: "plur1bus" } };
  }
  it("resolveInside refuses a symlink above missing parent directories", () => {
    const { vault } = fixture();
    assert.throws(() => resolveInside(vault, "plur1bus/escape/new/file.md"), /Path traversal blocked/);
  });
  it("resolveReviewPath refuses a nested symlink before creating a new directory", () => {
    const { config } = fixture();
    assert.throws(() => resolveReviewPath(config, "escape/new/file.md"), /Path traversal blocked/);
  });
  it("resolveReviewPath refuses a review root that points out of the vault", () => {
    const vault = makeTempDir("obs-r2-root-");
    const outside = makeTempDir("obs-r2-root-out-");
    symlinkSync(outside, join(vault, "plur1bus"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => resolveReviewPath({ vaultPath: vault }, "file.md"), /Path traversal blocked/);
  });
  it("control-room safeBridgePath refuses a nested symlink", () => {
    const { config } = fixture();
    assert.throws(() => safeBridgePath({ obsidianBridge: config }, "escape/new/file.md"), /Path traversal blocked/);
  });
  it("memory note writer refuses a symlinked memories folder", () => {
    const { config, vault, outside } = fixture("memories");
    assert.throws(() => writeMemoryNotes(config, [{ id: "memory-1", text: "must stay inside" }], { mutationPolicy: policy(vault) }), /Path traversal blocked/);
    assert.equal(existsSync(join(outside, "memory-1.md")), false);
  });
  it("memory note writer refuses a symlinked note before inspecting its hash", () => {
    const vault = makeTempDir("obs-r2-file-");
    const outside = makeTempDir("obs-r2-file-out-");
    mkdirSync(join(vault, "plur1bus", "memories"), { recursive: true });
    const foreign = join(outside, "foreign.md");
    writeFileSync(foreign, "private outside data");
    symlinkSync(foreign, join(vault, "plur1bus", "memories", "memory-1.md"));
    assert.throws(() => writeMemoryNotes({ vaultPath: vault }, [{ id: "memory-1", text: "new" }], { mutationPolicy: policy(vault) }), /Path traversal blocked/);
    assert.equal(readFileSync(foreign, "utf8"), "private outside data");
  });
  it("scope backfill refuses a symlinked memories folder", () => {
    const { config, outside } = fixture("memories");
    const foreign = join(outside, "note.md");
    writeFileSync(foreign, "---\nplur1bus_type: memory\n---\ntext\n");
    const before = readFileSync(foreign, "utf8");
    assert.throws(() => backfillMemoryNoteScope({ ...config, agentId: "agent" }), /Path traversal blocked/);
    assert.equal(readFileSync(foreign, "utf8"), before);
  });
  it("record writer refuses a symlinked records folder", () => {
    const { config, vault, outside } = fixture("records/tasks");
    assert.throws(() => writeRecordNote(config, { id: "task-1", type: "task", title: "Task" }, { mutationPolicy: policy(vault) }), /Path traversal blocked/);
    assert.equal(existsSync(join(outside, "task-1.md")), false);
  });
  it("allows writes through a symlink that stays inside the review root", () => {
    const vault = makeTempDir("obs-r2-inside-");
    mkdirSync(join(vault, "plur1bus", "actual"), { recursive: true });
    mkdirSync(join(vault, "plur1bus", "records"));
    symlinkSync(join(vault, "plur1bus", "actual"), join(vault, "plur1bus", "records", "tasks"), process.platform === "win32" ? "junction" : "dir");
    const result = writeRecordNote({ vaultPath: vault }, { id: "task-1", type: "task", title: "Task" }, { mutationPolicy: policy(vault) });
    assert.ok(result.ok);
    assert.equal(existsSync(join(realpathSync(vault), "plur1bus", "actual", "task-1.md")), true);
  });
});

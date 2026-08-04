import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_PATH = join(process.cwd(), "scripts", "auto-capture-lancedb.mjs");
const AGENT_ID = "agent-a";
const SESSION_NAME = "session.jsonl";
const tempDirs = [];

const LIVE_ROTATION_PRELOAD = `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const targetPath = process.env.CAPTURE_ROTATE_AFTER_IDENTITY_PATH || "";
const replacementPath = process.env.CAPTURE_ROTATION_REPLACEMENT_PATH || "";

if (targetPath && replacementPath) {
  const originalOpenSync = fs.openSync;
  const originalStatSync = fs.statSync;
  const originalFstatSync = fs.fstatSync;
  const originalRenameSync = fs.renameSync;
  const targetDescriptors = new Set();
  let rotated = false;

  function rotateAfterIdentityCapture() {
    if (rotated) return;
    originalRenameSync.call(fs, replacementPath, targetPath);
    rotated = true;
  }

  fs.openSync = function patchedOpenSync(path, ...args) {
    const descriptor = originalOpenSync.call(this, path, ...args);
    if (String(path) === targetPath) targetDescriptors.add(descriptor);
    return descriptor;
  };

  fs.statSync = function patchedStatSync(path, ...args) {
    const stats = originalStatSync.call(this, path, ...args);
    if (String(path) === targetPath) rotateAfterIdentityCapture();
    return stats;
  };

  fs.fstatSync = function patchedFstatSync(descriptor, ...args) {
    const stats = originalFstatSync.call(this, descriptor, ...args);
    if (targetDescriptors.has(descriptor)) rotateAfterIdentityCapture();
    return stats;
  };

  syncBuiltinESMExports();
}
`;

function jsonlMessage(role, content, id) {
  return JSON.stringify({
    id,
    timestamp: "2026-07-19T08:00:00.000Z",
    message: { role, content },
  }) + "\n";
}

function checkpointOffset(state, fileName = SESSION_NAME) {
  const entry = state?.files?.[fileName];
  return typeof entry === "number" ? entry : Number(entry?.offset || 0);
}

function writeModule(path, source) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source, "utf8");
}

function createPluginFixture(pluginDir) {
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");

  writeModule(join(pluginDir, "lib", "providers", "config-normalize.js"), `
export function normalizeEmbeddingConfig(config = {}) {
  return { dimensions: 3, ...config };
}
`);

  writeModule(join(pluginDir, "lib", "providers", "factory.js"), `
function vectorFor(text) {
  let hash = 0;
  for (const char of String(text)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return [hash % 97, (hash >>> 7) % 89, (hash >>> 15) % 83];
}

export function createEmbeddingProvider() {
  return {
    dimensions() { return 3; },
    async embedBatch(texts) {
      if (!Array.isArray(texts) || texts.length === 0) {
        throw new Error("fixture rejects an empty embedding batch");
      }
      const failText = process.env.CAPTURE_FAIL_EMBED_TEXT || "";
      if (failText && texts.some((text) => String(text).includes(failText))) {
        throw new Error(\`injected embed failure for \${failText}\`);
      }
      const badVectorText = process.env.CAPTURE_BAD_VECTOR_TEXT || "";
      return texts.map((text) => badVectorText && String(text).includes(badVectorText) ? [1] : vectorFor(text));
    },
  };
}
`);

  writeModule(join(pluginDir, "lib", "score.js"), `
export function distanceToScore(distance) {
  return 1 / (1 + Number(distance || 0));
}
`);

  writeModule(join(pluginDir, "lib", "categorize.js"), `
export function categorizeMemory() {
  return "fact";
}
`);

  writeModule(join(pluginDir, "node_modules", "@lancedb", "lancedb", "package.json"), `
{"type":"module","exports":"./dist/index.js"}
`);

  writeModule(join(pluginDir, "node_modules", "@lancedb", "lancedb", "dist", "index.js"), `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function rowsPath(dbPath) {
  return join(dbPath, "memories.fixture.json");
}

function readRows(dbPath) {
  const path = rowsPath(dbPath);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

function saveRows(dbPath, rows) {
  mkdirSync(dbPath, { recursive: true });
  writeFileSync(rowsPath(dbPath), JSON.stringify(rows), "utf8");
}

function vectorsEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function createTable(dbPath) {
  return {
    async schema() {
      const row = readRows(dbPath)[0] || {};
      return { fields: Object.keys(row).map((name) => ({ name })) };
    },
    async addColumns() {},
    query() {
      const vectors = [];
      let whereExpression = "";
      let resultLimit = Infinity;
      const builder = {
        nearestTo(vector) { vectors.push(vector); return builder; },
        addQueryVector(vector) { vectors.push(vector); return builder; },
        where(expression) { whereExpression = String(expression); return builder; },
        limit(value) { resultLimit = Number(value); return builder; },
        async toArray() {
          const rows = readRows(dbPath);
          if (whereExpression) {
            const match = whereExpression.match(/id\\s*=\\s*["']([^"']+)["']/i);
            const hiddenText = process.env.CAPTURE_HIDE_READBACK_TEXT || "";
            return (match ? rows.filter((row) => row.id === match[1]) : [])
              .filter((row) => !hiddenText || !String(row.text).includes(hiddenText))
              .slice(0, resultLimit);
          }
          if (process.env.CAPTURE_FAIL_DUPLICATE_QUERY === "1") {
            throw new Error("injected duplicate query failure");
          }
          if (process.env.CAPTURE_DISABLE_SEMANTIC_DEDUP === "1") return [];
          const results = [];
          for (let index = 0; index < vectors.length; index++) {
            const row = rows.find((candidate) => candidate.id !== "init" && vectorsEqual(candidate.vector, vectors[index]));
            if (row) results.push({ query_index: index, _distance: 0 });
          }
          return results.slice(0, resultLimit);
        },
      };
      return builder;
    },
    search(vector) {
      return {
        limit() { return this; },
        async toArray() {
          if (process.env.CAPTURE_FAIL_DUPLICATE_QUERY === "1") {
            throw new Error("injected duplicate search failure");
          }
          if (process.env.CAPTURE_DISABLE_SEMANTIC_DEDUP === "1") return [];
          const row = readRows(dbPath).find((candidate) => candidate.id !== "init" && vectorsEqual(candidate.vector, vector));
          return row ? [{ ...row, _distance: 0 }] : [];
        },
      };
    },
    async add(rows) {
      const failText = process.env.CAPTURE_FAIL_INSERT_TEXT || "";
      if (failText && rows.some((row) => String(row.text).includes(failText))) {
        throw new Error(\`injected insert failure for \${failText}\`);
      }
      saveRows(dbPath, [...readRows(dbPath), ...rows]);
      if (process.env.CAPTURE_CRASH_AFTER_ADD === "1") {
        process.exit(86);
      }
    },
  };
}

export async function connect(dbPath) {
  return {
    async tableNames() {
      return existsSync(rowsPath(dbPath)) ? ["memories"] : [];
    },
    async openTable() {
      return createTable(dbPath);
    },
    async createTable(_name, rows) {
      saveRows(dbPath, rows);
      return createTable(dbPath);
    },
  };
}
`);
}

function createFixture(sessionText) {
  // realpathSync: macOS tmpdir is a symlink (/var -> /private/var) and the
  // production code resolves real paths (resolveInside -> realpathSync), so
  // the preload's path comparison must see the resolved path too.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-auto-capture-checkpoint-")));
  tempDirs.push(root);
  const homeDir = join(root, "home");
  const pluginDir = join(root, "plugin");
  const openClawDir = join(homeDir, ".openclaw");
  const sessionsDir = join(openClawDir, "agents", AGENT_ID, "sessions");
  const sessionPath = join(sessionsDir, SESSION_NAME);
  const statePath = join(openClawDir, ".auto-capture-state", `${AGENT_ID}.json`);
  const rowsPath = join(openClawDir, "memory", "lancedb-namespaced", AGENT_ID, "memories.fixture.json");
  const liveRotationPreloadPath = join(root, "live-rotation-preload.cjs");

  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });
  createPluginFixture(pluginDir);
  writeFileSync(liveRotationPreloadPath, LIVE_ROTATION_PRELOAD, "utf8");
  writeFileSync(join(openClawDir, "openclaw.json"), JSON.stringify({
    agents: { list: [{ id: AGENT_ID }] },
    plugins: {
      entries: {
        "memory-lancedb-namespaced": {
          config: { embedding: { provider: "fixture", dimensions: 3 } },
        },
      },
    },
  }), "utf8");
  writeFileSync(sessionPath, sessionText, "utf8");

  return {
    sessionPath,
    statePath,
    readState() {
      return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { files: {} };
    },
    readMemories() {
      if (!existsSync(rowsPath)) return [];
      return JSON.parse(readFileSync(rowsPath, "utf8")).filter((row) => row.id !== "init");
    },
    mutateMemories(mutator) {
      const rows = JSON.parse(readFileSync(rowsPath, "utf8"));
      writeFileSync(rowsPath, JSON.stringify(mutator(rows)), "utf8");
    },
    replaceSession(text) {
      const replacementPath = join(sessionsDir, "replacement.jsonl");
      writeFileSync(replacementPath, text, "utf8");
      renameSync(replacementPath, sessionPath);
    },
    truncateSession(text) {
      writeFileSync(sessionPath, text, { encoding: "utf8", flag: "w" });
    },
    appendSession(text) {
      writeFileSync(sessionPath, text, { encoding: "utf8", flag: "a" });
    },
    stageReplacement(text) {
      const replacementPath = join(root, "live-replacement.jsonl");
      writeFileSync(replacementPath, text, "utf8");
      return replacementPath;
    },
    run(overrides = {}) {
      const nodeArgs = overrides.CAPTURE_ROTATE_AFTER_IDENTITY_PATH
        ? ["--require", liveRotationPreloadPath]
        : [];
      return spawnSync(process.execPath, [...nodeArgs, SCRIPT_PATH, AGENT_ID], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: homeDir,
          PLUR1BUS_PLUGIN_DIR: pluginDir,
          ...overrides,
        },
      });
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("auto-capture durable checkpointing", () => {
  it("reports correct counters and checkpoints a normal successful capture", () => {
    const first = jsonlMessage("user", "My normal positive-control preference is midnight blue.", "turn-1");
    const second = jsonlMessage("assistant", "I will retain that normal positive-control preference.", "turn-2");
    const fixture = createFixture(first + second);

    const result = fixture.run();

    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /\[main\] done — stored=2, candidates=2, errors=0/,
      `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)} error=${String(result.error || "")}`,
    );
    assert.strictEqual(fixture.readMemories().length, 2);
    const state = fixture.readState();
    assert.strictEqual(checkpointOffset(state), Buffer.byteLength(first + second));
    assert.strictEqual(typeof state.files[SESSION_NAME].fingerprint, "string");
  });

  it("does not acknowledge an item whose embedding is unavailable", () => {
    const line = jsonlMessage("user", "This EMBED-BLOCKED memory must remain retryable.", "turn-embed");
    const fixture = createFixture(line);

    const result = fixture.run({ CAPTURE_FAIL_EMBED_TEXT: "EMBED-BLOCKED" });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(fixture.readMemories().length, 0);
    assert.strictEqual(checkpointOffset(fixture.readState()), 0);
  });

  it("persists partial embed progress and resumes without skipping or duplicating", () => {
    const first = jsonlMessage("user", "First durable memory before the embedding fault.", "turn-a");
    const second = jsonlMessage("user", "Second EMBED-BLOCKED memory after the durable prefix.", "turn-b");
    const fixture = createFixture(first + second);

    fixture.run({ CAPTURE_FAIL_EMBED_TEXT: "EMBED-BLOCKED" });

    assert.deepStrictEqual(fixture.readMemories().map((row) => row.text), ["User: First durable memory before the embedding fault."]);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(first));

    const retry = fixture.run();

    assert.match(retry.stdout, /\[main\] done — stored=1, candidates=1, errors=0/);
    assert.deepStrictEqual(fixture.readMemories().map((row) => row.text).sort(), [
      "User: First durable memory before the embedding fault.",
      "User: Second EMBED-BLOCKED memory after the durable prefix.",
    ]);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(first + second));
  });

  it("does not acknowledge an embedding with the wrong dimensions", () => {
    const line = jsonlMessage("user", "This BAD-VECTOR memory must remain retryable.", "turn-bad-vector");
    const fixture = createFixture(line);

    const result = fixture.run({ CAPTURE_BAD_VECTOR_TEXT: "BAD-VECTOR" });

    assert.match(result.stderr, /invalid embedding vector/);
    assert.strictEqual(fixture.readMemories().length, 0);
    assert.strictEqual(checkpointOffset(fixture.readState()), 0);
  });

  it("does not acknowledge a candidate when every duplicate check fails", () => {
    const line = jsonlMessage("user", "Duplicate-check failure must not become an acknowledgement.", "turn-dedup-fail");
    const fixture = createFixture(line);

    const result = fixture.run({ CAPTURE_FAIL_DUPLICATE_QUERY: "1" });

    assert.match(result.stderr, /duplicate query failure|duplicate search failure/);
    assert.strictEqual(fixture.readMemories().length, 0);
    assert.strictEqual(checkpointOffset(fixture.readState()), 0);
  });

  it("does not acknowledge an item whose insert is not durable", () => {
    const line = jsonlMessage("user", "This INSERT-BLOCKED memory must remain retryable.", "turn-insert");
    const fixture = createFixture(line);

    fixture.run({ CAPTURE_FAIL_INSERT_TEXT: "INSERT-BLOCKED" });

    assert.strictEqual(fixture.readMemories().length, 0);
    assert.strictEqual(checkpointOffset(fixture.readState()), 0);
  });

  it("persists partial insert progress and resumes without skipped acknowledgement", () => {
    const first = jsonlMessage("user", "First durable memory before the insert fault.", "turn-c");
    const second = jsonlMessage("user", "Second INSERT-BLOCKED memory after the durable prefix.", "turn-d");
    const fixture = createFixture(first + second);

    fixture.run({ CAPTURE_FAIL_INSERT_TEXT: "INSERT-BLOCKED" });

    assert.deepStrictEqual(fixture.readMemories().map((row) => row.text), ["User: First durable memory before the insert fault."]);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(first));

    fixture.run();

    assert.strictEqual(fixture.readMemories().length, 2);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(first + second));
  });

  it("retries a store-before-checkpoint crash with the same durable row identity", () => {
    const line = jsonlMessage("user", "Crash-boundary memory must be inserted exactly once.", "turn-crash");
    const fixture = createFixture(line);

    const crashed = fixture.run({
      CAPTURE_CRASH_AFTER_ADD: "1",
      CAPTURE_DISABLE_SEMANTIC_DEDUP: "1",
    });

    assert.strictEqual(crashed.status, 86);
    assert.strictEqual(fixture.readMemories().length, 1);
    assert.strictEqual(checkpointOffset(fixture.readState()), 0);

    const retry = fixture.run({ CAPTURE_DISABLE_SEMANTIC_DEDUP: "1" });

    assert.match(retry.stdout, /\[main\] done — stored=0, candidates=1, errors=0/);
    assert.doesNotMatch(retry.stderr, /empty embedding batch/);
    assert.strictEqual(fixture.readMemories().length, 1);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(line));
  });

  it("detects a smaller replacement file and captures it from byte zero", () => {
    const original = jsonlMessage("user", "Original rotation memory with deliberately extended content for a larger checkpoint.", "turn-old");
    const replacement = jsonlMessage("user", "New rotation memory.", "turn-new");
    const fixture = createFixture(original);
    fixture.run();
    const originalFingerprint = fixture.readState().files[SESSION_NAME].fingerprint;

    fixture.replaceSession(replacement);
    fixture.run();

    assert.deepStrictEqual(fixture.readMemories().map((row) => row.text).sort(), [
      "User: New rotation memory.",
      "User: Original rotation memory with deliberately extended content for a larger checkpoint.",
    ]);
    const state = fixture.readState();
    assert.strictEqual(checkpointOffset(state), Buffer.byteLength(replacement));
    assert.notStrictEqual(state.files[SESSION_NAME].fingerprint, originalFingerprint);
  });

  it("binds live-rotation bytes to their opened file identity", () => {
    const original = jsonlMessage("user", "Opened predecessor memory must retain its own source identity.", "turn-live-old");
    const replacement = jsonlMessage("user", "Live replacement memory must be captured exactly once.", "turn-live-new");
    const fixture = createFixture(original);
    const replacementPath = fixture.stageReplacement(replacement);

    const rotated = fixture.run({
      CAPTURE_DISABLE_SEMANTIC_DEDUP: "1",
      CAPTURE_ROTATE_AFTER_IDENTITY_PATH: fixture.sessionPath,
      CAPTURE_ROTATION_REPLACEMENT_PATH: replacementPath,
    });

    assert.strictEqual(rotated.status, 0, rotated.stderr);
    const firstRunRows = fixture.readMemories();
    assert.deepStrictEqual(firstRunRows.map((row) => row.text), [
      "User: Opened predecessor memory must retain its own source identity.",
    ]);
    assert.strictEqual(checkpointOffset(fixture.readState()), 0);

    const retry = fixture.run({ CAPTURE_DISABLE_SEMANTIC_DEDUP: "1" });

    assert.strictEqual(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /\[main\] done — stored=1, candidates=1, errors=0/);
    assert.deepStrictEqual(fixture.readMemories().map((row) => row.text).sort(), [
      "User: Live replacement memory must be captured exactly once.",
      "User: Opened predecessor memory must retain its own source identity.",
    ]);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(replacement));
  });

  it("does not acknowledge a crash-recovered row whose vector is not durable", () => {
    const line = jsonlMessage("user", "A crash-recovered row requires its durable vector.", "turn-vector");
    const fixture = createFixture(line);
    const crashed = fixture.run({ CAPTURE_CRASH_AFTER_ADD: "1" });
    assert.strictEqual(crashed.status, 86);

    fixture.mutateMemories((rows) => rows.map((row) => row.id === "init" ? row : { ...row, vector: [] }));
    const retry = fixture.run({ CAPTURE_DISABLE_SEMANTIC_DEDUP: "1" });

    assert.match(retry.stderr, /capture durability verification mismatch/);
    assert.strictEqual(checkpointOffset(fixture.readState()), 0);
    assert.strictEqual(fixture.readMemories().length, 1);
  });

  it("waits for insert readback before acknowledging and reuses the durable row on retry", () => {
    const line = jsonlMessage("user", "This READBACK-HIDDEN row must be verified before acknowledgement.", "turn-readback");
    const fixture = createFixture(line);

    const hidden = fixture.run({ CAPTURE_HIDE_READBACK_TEXT: "READBACK-HIDDEN" });

    assert.match(hidden.stderr, /was not readable after insert/);
    assert.strictEqual(fixture.readMemories().length, 1);
    assert.strictEqual(checkpointOffset(fixture.readState()), 0);

    const retry = fixture.run({ CAPTURE_DISABLE_SEMANTIC_DEDUP: "1" });

    assert.match(retry.stdout, /\[main\] done — stored=0, candidates=1, errors=0/);
    assert.strictEqual(fixture.readMemories().length, 1);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(line));
  });

  it("detects in-place truncation and captures the rewritten file from byte zero", () => {
    const original = jsonlMessage("assistant", "Original truncation memory with deliberately extended content for a larger checkpoint.", "turn-truncate-old");
    const rewritten = jsonlMessage("assistant", "Rewritten memory.", "turn-truncate-new");
    const fixture = createFixture(original);
    fixture.run();

    fixture.truncateSession(rewritten);
    fixture.run();

    assert.deepStrictEqual(fixture.readMemories().map((row) => row.text).sort(), [
      "Assistant: Original truncation memory with deliberately extended content for a larger checkpoint.",
      "Assistant: Rewritten memory.",
    ]);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(rewritten));
  });

  it("does not duplicate an already acknowledged file on an unchanged restart", () => {
    const line = jsonlMessage("user", "An unchanged acknowledged session must remain exactly-once.", "turn-stable");
    const fixture = createFixture(line);

    fixture.run();
    const restart = fixture.run({ CAPTURE_DISABLE_SEMANTIC_DEDUP: "1" });

    assert.match(restart.stdout, /\[main\] done — stored=0, candidates=0, errors=0/);
    assert.strictEqual(fixture.readMemories().length, 1);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(line));
  });

  it("keeps the same file identity while capturing a normal append", () => {
    const first = jsonlMessage("user", "First message in a normally growing session.", "turn-append-a");
    const second = jsonlMessage("assistant", "Second message appended to the same session.", "turn-append-b");
    const fixture = createFixture(first);
    fixture.run();
    const firstState = fixture.readState().files[SESSION_NAME];

    fixture.appendSession(second);
    const appended = fixture.run();

    assert.doesNotMatch(appended.stderr, /rotation detected|truncation detected|fingerprint changed/);
    assert.match(appended.stdout, /\[main\] done — stored=1, candidates=1, errors=0/);
    const secondState = fixture.readState().files[SESSION_NAME];
    assert.strictEqual(secondState.identity, firstState.identity);
    assert.notStrictEqual(secondState.fingerprint, firstState.fingerprint);
    assert.strictEqual(checkpointOffset(fixture.readState()), Buffer.byteLength(first + second));
    assert.strictEqual(fixture.readMemories().length, 2);
  });
});

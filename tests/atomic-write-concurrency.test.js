/**
 * F1 — fixed temp filenames (`<target>.tmp`) next to a shared target are a
 * cross-process race: two writers share one temp path and the loser's rename
 * fails with ENOENT. These tests pin the unique-temp-name fix: concurrent
 * child processes initialising the same NEW store (and writing the same
 * file) all succeed, the result is valid, and no temp file is left behind.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  uniqueTmpPath,
  writeFileAtomic,
  writeFileAtomicSync,
  writeTextAtomic,
} from "../lib/atomic-file.js";
import { writeTextFsync } from "../lib/fsync-atomic.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { readStoreSchemaVersion, schemaMarkerPath } from "../engine/store/schema-version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = () => makeTempDir("atomic-conc-");

const CHILD_TIMEOUT_MS = 20_000;

/** Run `body` (ESM source) in N children that all start at the same instant. */
function runConcurrently(n, body, args = []) {
  const startAt = Date.now() + 600;
  const src = `
    const startAt = Number(process.argv[1]);
    const rest = process.argv.slice(2);
    while (Date.now() < startAt) { /* barrier: spin until the shared start instant */ }
    ${body}
  `;
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push(new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", src, String(startAt), ...args, String(i)], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c) => { stderr += c; });
      const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stderr });
      });
    }));
  }
  return Promise.all(jobs);
}

function leftoverTmp(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.name.endsWith(".tmp")) found.push(relative(dir, join(entry.parentPath ?? entry.path, entry.name)));
  }
  return found;
}

describe("unique temp names (F1)", () => {
  it("uniqueTmpPath is unique per call, same directory, ends .tmp", () => {
    const a = uniqueTmpPath("/x/y/file.json");
    const b = uniqueTmpPath("/x/y/file.json");
    assert.notStrictEqual(a, b);
    assert.strictEqual(dirname(a), "/x/y");
    assert.match(a, /file\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
    assert.match(uniqueTmpPath("/x/y/file.json", { hidden: true }), /\/\.file\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
  });

  it("two child processes initialising the same brand-new store both succeed", { timeout: 60_000 }, async () => {
    for (let round = 0; round < 3; round++) {
      const base = join(tmpDir(), "fresh-store");
      const schemaUrl = pathToFileURL(join(ROOT, "engine/store/schema-version.js")).href;
      const results = await runConcurrently(
        2,
        `const { writeStoreSchemaMarker } = await import(${JSON.stringify(schemaUrl)});
         writeStoreSchemaMarker(rest[0], "1", { engineVersion: "test" });`,
        [base],
      );
      for (const r of results) assert.strictEqual(r.code, 0, `child failed: ${r.signal || ""} ${r.stderr}`);
      assert.strictEqual(readStoreSchemaVersion(base), "1");
      const marker = JSON.parse(readFileSync(schemaMarkerPath(base), "utf8"));
      assert.strictEqual(marker.schemaVersion, "1");
      assert.deepStrictEqual(readdirSync(base), ["_schema.json"], "no leftover temp files");
    }
  });

  it("many concurrent writers of one file via writeTextAtomic all succeed", { timeout: 60_000 }, async () => {
    const dir = tmpDir();
    const target = join(dir, "state", "shared.json");
    const atomicUrl = pathToFileURL(join(ROOT, "lib/atomic-file.js")).href;
    const results = await runConcurrently(
      6,
      `const { writeTextAtomic } = await import(${JSON.stringify(atomicUrl)});
       for (let i = 0; i < 20; i++) writeTextAtomic(rest[0], JSON.stringify({ writer: rest[1], i }));`,
      [target],
    );
    for (const r of results) assert.strictEqual(r.code, 0, `child failed: ${r.signal || ""} ${r.stderr}`);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    assert.strictEqual(parsed.i, 19);
    assert.deepStrictEqual(leftoverTmp(dir), []);
  });

  it("a failed rename removes the temp file and rethrows", () => {
    const dir = tmpDir();
    const target = join(dir, "a-directory");
    mkdirSync(target);
    assert.throws(() => writeFileAtomicSync(target, "x"));
    assert.deepStrictEqual(leftoverTmp(dir), []);
  });

  it("async variant: failed rename cleans up; success leaves no temp", async () => {
    const dir = tmpDir();
    const target = join(dir, "a-directory");
    mkdirSync(target);
    await assert.rejects(() => writeFileAtomic(target, "x"));
    const ok = join(dir, "ok.txt");
    assert.strictEqual(await writeFileAtomic(ok, "hello"), true);
    assert.strictEqual(readFileSync(ok, "utf8"), "hello");
    assert.deepStrictEqual(leftoverTmp(dir), []);
  });

  it("lost race is idempotent: acceptExisting forgives a failed write when the target is valid", () => {
    const dir = tmpDir();
    const target = join(dir, "_schema.json");
    writeFileSync(target, JSON.stringify({ schemaVersion: "1" }));
    const boom = () => { throw Object.assign(new Error("injected"), { code: "EIO" }); };
    // Without the predicate the failure surfaces; with it the existing valid content wins.
    assert.throws(() => writeTextFsync(target, "{}", { fsync: boom }), /injected/);
    assert.doesNotThrow(() => writeTextFsync(target, "{}", {
      fsync: boom,
      acceptExisting: (t) => JSON.parse(t).schemaVersion === "1",
    }));
    assert.throws(() => writeTextFsync(target, "{}", { fsync: boom, acceptExisting: () => false }), /injected/);
    assert.strictEqual(JSON.parse(readFileSync(target, "utf8")).schemaVersion, "1");
    assert.deepStrictEqual(leftoverTmp(dir), []);
  });

  it("writeTextAtomic still creates parent dirs and overwrites", () => {
    const dir = tmpDir();
    const p = join(dir, "n", "m", "f.txt");
    writeTextAtomic(p, "one");
    writeTextAtomic(p, "two");
    assert.strictEqual(readFileSync(p, "utf8"), "two");
  });
});

describe("regression guard: no fixed `.tmp` sibling names", () => {
  it("source files do not build a shared `<target>.tmp` path", () => {
    const offenders = [];
    const FIXED = /(\+ ?["'`]\.tmp["'`]|\}\.tmp`|["'`]\.tmp["'`])/;
    const SAFE = /pid|random|uuid|Date\.now|mkstemp|mktemp/i;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(m?js|cjs|sh)$/.test(entry.name)) {
          readFileSync(full, "utf8").split("\n").forEach((line, i) => {
            if (FIXED.test(line) && !SAFE.test(line) && !/^\s*(\/\/|\*|#)/.test(line)) {
              offenders.push(`${relative(ROOT, full)}:${i + 1}: ${line.trim()}`);
            }
          });
        }
      }
    };
    for (const d of ["lib", "engine", "adapter", "scripts", "tools", ".openclaw"]) {
      try { walk(join(ROOT, d)); } catch { /* directory absent */ }
    }
    assert.deepStrictEqual(offenders, []);
  });
});

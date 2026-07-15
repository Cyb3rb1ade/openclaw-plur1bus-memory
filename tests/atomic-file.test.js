import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic, writeTextAtomic } from "../lib/atomic-file.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "atomic-file-"));
}

describe("atomic-file", () => {
  it("writeJsonAtomic + readJsonSafe roundtrip (compact)", () => {
    const dir = tmpDir();
    const path = join(dir, "state.json");
    writeJsonAtomic(path, { a: 1, b: "x" });
    assert.deepStrictEqual(readJsonSafe(path, null), { a: 1, b: "x" });
    assert.strictEqual(readFileSync(path, "utf8").includes("\n"), false);
  });

  it("writeJsonAtomic pretty=true produces indented JSON", () => {
    const dir = tmpDir();
    const path = join(dir, "state.json");
    writeJsonAtomic(path, { a: 1 }, { pretty: true });
    const raw = readFileSync(path, "utf8");
    assert.match(raw, /\n {2}"a": 1/);
    assert.deepStrictEqual(readJsonSafe(path, null), { a: 1 });
  });

  it("readJsonSafe returns fallback when file is missing", () => {
    const dir = tmpDir();
    const path = join(dir, "missing.json");
    assert.deepStrictEqual(readJsonSafe(path, { fallback: true }), { fallback: true });
  });

  it("readJsonSafe returns fallback on corrupt JSON", () => {
    const dir = tmpDir();
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json", "utf8");
    assert.strictEqual(readJsonSafe(path, "fb"), "fb");
  });

  it("writeJsonAtomic creates missing parent dir", () => {
    const dir = tmpDir();
    const path = join(dir, "nested", "deeper", "state.json");
    writeJsonAtomic(path, { ok: true });
    assert.strictEqual(existsSync(path), true);
    assert.deepStrictEqual(readJsonSafe(path, null), { ok: true });
  });

  it("writeTextAtomic writes plain text and creates parent dir", () => {
    const dir = tmpDir();
    const path = join(dir, "nested", "notes.md");
    writeTextAtomic(path, "hello world\n");
    assert.strictEqual(readFileSync(path, "utf8"), "hello world\n");
  });

  it("writeJsonAtomic does not leave tmp files behind", () => {
    const dir = tmpDir();
    const path = join(dir, "state.json");
    writeJsonAtomic(path, { a: 1 });
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepStrictEqual(leftovers, []);
  });
});

/**
 * tests/atomic-json.test.js — lib/atomic-json.js (audit store #3, #7):
 *   - a missing file starts as {}, but a corrupt file is never silently
 *     overwritten with {} (it is set aside as `<file>.corrupt-<ts>` and logged)
 *     and an IO error is thrown, not swallowed;
 *   - the data is fsynced before the rename;
 *   - a nested update of the same file rejects instead of deadlocking.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { atomicJsonUpdate } from "../lib/atomic-json.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const within = (ms, promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms (deadlock)`)), ms).unref()),
]);

describe("atomicJsonUpdate: reading", () => {
  it("a missing file starts as {} and is created", async () => {
    const file = join(makeTempDir("atomic-json-"), "state.json");
    let seen;
    const out = await atomicJsonUpdate(file, (data) => { seen = data; return { n: 1 }; });
    assert.deepEqual(seen, {});
    assert.deepEqual(out, { n: 1 });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { n: 1 });
  });

  it("a corrupt file is set aside as .corrupt-<ts> with its bytes, logged, and the update starts from {}", async () => {
    const dir = makeTempDir("atomic-json-");
    const file = join(dir, "state.json");
    writeFileSync(file, "{\"important\": tru");
    const warn = mock.method(console, "warn", () => {});
    try {
      let seen;
      await atomicJsonUpdate(file, (data) => { seen = data; return { fresh: true }; });
      assert.deepEqual(seen, {});
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { fresh: true });
      const aside = readdirSync(dir).filter((n) => /^state\.json\.corrupt-/.test(n));
      assert.equal(aside.length, 1, readdirSync(dir).join(","));
      assert.equal(readFileSync(join(dir, aside[0]), "utf8"), "{\"important\": tru", "the unreadable original is preserved byte for byte");
      assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes("state.json") && String(c.arguments[0]).includes(aside[0])), "the quarantine is logged");
    } finally {
      warn.mock.restore();
    }
  });

  it("an IO error is thrown and nothing is overwritten (the updater never runs)", async () => {
    const dir = makeTempDir("atomic-json-");
    const file = join(dir, "state.json");
    mkdirSync(file); // reading a directory fails with EISDIR, not ENOENT
    let called = false;
    await assert.rejects(atomicJsonUpdate(file, () => { called = true; return {}; }), (e) => e.code === "EISDIR");
    assert.equal(called, false);
    assert.ok(existsSync(file) && readdirSync(dir).join(",") === "state.json", "still the directory, no tmp or corrupt leftovers");
  });

  it("the queue keeps working after a rejected update", async () => {
    const file = join(makeTempDir("atomic-json-"), "state.json");
    await assert.rejects(atomicJsonUpdate(file, () => { throw new Error("boom"); }), /boom/);
    assert.deepEqual(await atomicJsonUpdate(file, () => ({ ok: 1 })), { ok: 1 });
  });
});

describe("atomicJsonUpdate: durability", () => {
  it("fsyncs the temp file before the rename lands on the target", async () => {
    const dir = makeTempDir("atomic-json-");
    const file = join(dir, "state.json");
    writeFileSync(file, "{\"v\":1}");
    const probe = await open(file);
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const original = proto.sync;
    const syncs = [];
    const spy = mock.method(proto, "sync", async function patched(...args) {
      syncs.push(readFileSync(file, "utf8")); // the target as it is while the temp is synced
      return original.apply(this, args);
    });
    try {
      await atomicJsonUpdate(file, () => ({ v: 2 }));
    } finally {
      spy.mock.restore();
    }
    assert.deepEqual(syncs, ["{\"v\":1}"], "exactly one fsync, and the target still held the old content");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { v: 2 });
  });
});

describe("atomicJsonUpdate: nesting", () => {
  it("a nested update of the same file rejects instead of deadlocking", async () => {
    const file = join(makeTempDir("atomic-json-"), "state.json");
    let inner;
    const outer = atomicJsonUpdate(file, async () => {
      inner = atomicJsonUpdate(file, () => ({ inner: true })).then(() => "resolved", (e) => e);
      return { outer: true, innerSettled: await within(2_000, inner) };
    });
    const result = await within(5_000, outer);
    assert.match(String(result.innerSettled?.message), /Nested atomicJsonUpdate for same file is not allowed/);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).outer, true, "the outer update is unaffected");
    assert.deepEqual(await atomicJsonUpdate(file, (d) => ({ ...d, after: 1 })).then((d) => d.after), 1, "the file is usable afterwards");
  });

  it("the guard also sees through different spellings of the path", async () => {
    const dir = makeTempDir("atomic-json-");
    const file = join(dir, "state.json");
    const result = await within(5_000, atomicJsonUpdate(file, async () => {
      const e = await within(2_000, atomicJsonUpdate(join(dir, ".", "state.json"), () => ({})).then(() => null, (err) => err));
      return { sawGuard: Boolean(e) };
    }));
    assert.equal(result.sawGuard, true);
  });

  it("nesting a different file is fine", async () => {
    const dir = makeTempDir("atomic-json-");
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    await within(5_000, atomicJsonUpdate(a, async () => {
      await atomicJsonUpdate(b, () => ({ b: 1 }));
      return { a: 1 };
    }));
    assert.deepEqual(JSON.parse(readFileSync(b, "utf8")), { b: 1 });
  });
});

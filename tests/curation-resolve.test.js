import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNeoStore } from "../lib/neo-arch.js";
import { resolveCurationRecord } from "../lib/curation-resolve.js";

describe("resolveCurationRecord", () => {
  it("keep promotes a conflict record", () => {
    const dir = mkdtempSync(join(tmpdir(), "curation-"));
    const store = createNeoStore(dir, "default");
    const rec = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "conflict",
      statement: "x",
      category: "workflow_preference",
    };
    store.appendCandidates([rec]);
    const out = resolveCurationRecord(store, rec, "keep", { authorized: true });
    assert.equal(resolveCurationRecord(store, rec, "keep", { authorized: false }).ok, false);
    assert.equal(out.ok, true);
    const newest = store.readCandidates(50).filter((row) => row.id === rec.id).at(-1);
    assert.equal(newest.status, "promoted");
    rmSync(dir, { recursive: true, force: true });
  });
});

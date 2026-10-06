import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sha256TextVector } from "./helpers/text-vector.js";

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("sha256TextVector", () => {
  it("is deterministic, unit length and has the requested dimension", () => {
    const v = sha256TextVector("same", 384);
    assert.equal(v.length, 384);
    assert.deepEqual(v, sha256TextVector("same", 384));
    assert.ok(Math.abs(Math.sqrt(dot(v, v)) - 1) < 1e-9);
  });

  it("distinct texts are near-orthogonal (no single-hash sawtooth collisions)", { timeout: 60_000 }, () => {
    const base = sha256TextVector("deleted card 0000-0000", 384);
    let max = 0;
    for (let i = 0; i < 20_000; i += 1) {
      max = Math.max(max, dot(base, sha256TextVector(`unrelated query ${i}`, 384)));
    }
    assert.ok(max < 0.4, `max cosine ${max}`);
  });
});

// tests/dist-node-pins.test.js — scripts/dist/node-pins.json, the pinned portable Node the bootstraps fall back to
// for --host hermes (HM2-R16): five targets from nodejs.org's SHASUMS256.txt for one version, the same version the
// harness sidecar pins (F33: equal to scripts/dist/hermes-sidecar.lock.json nodeVersion).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkNodePins, NODE_TARGETS } from "../scripts/dist/render-bootstraps.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(readFileSync(join(ROOT, "scripts", "dist", "node-pins.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(ROOT, "scripts", "dist", "hermes-sidecar.lock.json"), "utf8"));

describe("scripts/dist/node-pins.json", () => {
  it("five targets, version equals 24.21.0, sha256 format", () => {
    assert.equal(pins.version, "24.21.0");
    assert.deepEqual(Object.keys(pins.targets).sort(), [...NODE_TARGETS].sort());
    for (const t of NODE_TARGETS) {
      const p = pins.targets[t];
      assert.match(p.sha256, /^[0-9a-f]{64}$/, t);
      assert.equal(p.archive, t.startsWith("win-") ? "zip" : "tar.gz", t);
      assert.equal(p.url, `https://nodejs.org/dist/v24.21.0/node-v24.21.0-${t}.${p.archive}`, t);
    }
    assert.doesNotThrow(() => checkNodePins(pins));
    // the values from SHASUMS256.txt (equal to the harness's crates/plur1bus/src/install/pins.rs)
    assert.equal(pins.targets["linux-x64"].sha256, "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff");
    assert.equal(pins.targets["win-x64"].sha256, "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541");
  });

  it("the bootstrap Node pin equals the sidecar lock's nodeVersion (F33)", () => {
    assert.equal(pins.version, lock.nodeVersion);
  });

  it("checkNodePins refuses a missing target, a foreign URL, a bad hash or a wrong archive type", () => {
    const clone = () => structuredClone(pins);
    const bad = (mutate, re) => {
      const p = clone();
      mutate(p);
      assert.throws(() => checkNodePins(p), re);
    };
    bad((p) => { delete p.targets["win-arm64"]; }, /no target win-arm64/);
    bad((p) => { p.targets["linux-x64"].url = "http://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz"; }, /url/);
    bad((p) => { p.targets["darwin-arm64"].sha256 = "A".repeat(64); }, /sha256/);
    bad((p) => { p.targets["win-x64"].archive = "tar.gz"; }, /zip/);
    bad((p) => { p.version = "24.21"; }, /invalid version/);
  });
});

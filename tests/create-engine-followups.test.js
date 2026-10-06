/**
 * tests/create-engine-followups.test.js — small create-engine.js follow-ups:
 * orphan temp files do not make a store "legacy", result details are redacted,
 * merge logs carry fixed reason codes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { isUniqueTmpName } from "../lib/atomic-file.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const TIMEOUT = { timeout: 30_000 };
const MARKER = "zzDetailLeakMarker_91C2_oat";

function config(baseDbPath) {
  return {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: 384 } },
    autoCapture: false, autoRecall: true,
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  };
}

describe("fresh-store detection ignores orphaned unique temp files", () => {
  it("isUniqueTmpName matches only the unique-temp shape", () => {
    assert.equal(isUniqueTmpName("_schema.json.123.0123456789ab.tmp", "_schema.json"), true);
    assert.equal(isUniqueTmpName("._schema.json.123.0123456789ab.tmp", "_schema.json"), true);
    assert.equal(isUniqueTmpName("_schema.json", "_schema.json"), false);
    assert.equal(isUniqueTmpName("other.123.0123456789ab.tmp", "_schema.json"), false);
    assert.equal(isUniqueTmpName("_schema.json.tmp", "_schema.json"), false);
  });

  it("a dir holding only an orphan temp is fresh: marker written, stale temp swept", TIMEOUT, async () => {
    const baseDbPath = makeTempDir("ce-orphan-");
    const orphan = join(baseDbPath, "._schema.json.4242.0123456789ab.tmp");
    writeFileSync(orphan, "{");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(orphan, old, old);
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ce-orphan-state-") }), config(baseDbPath));
    const marker = JSON.parse(readFileSync(join(baseDbPath, "_schema.json"), "utf8"));
    assert.match(marker.schemaVersion, /^[1-9]\d*$/, "current schema version, not legacy 0");
    assert.equal(existsSync(orphan), false, `orphan swept: ${readdirSync(baseDbPath)}`);
    await engine.close({ budgetMs: 5_000 });
  });

  it("a dir with a real foreign file stays legacy (no marker)", TIMEOUT, async () => {
    const baseDbPath = makeTempDir("ce-legacy-");
    writeFileSync(join(baseDbPath, "something.lance"), "x");
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ce-legacy-state-") }), config(baseDbPath));
    assert.equal(existsSync(join(baseDbPath, "_schema.json")), false);
    await engine.close({ budgetMs: 5_000 });
  });
});

describe("engine results carry no raw error text", () => {
  it("recall degraded.detail is bounded and redacted", TIMEOUT, async () => {
    const host = createStubHost({
      stateDir: makeTempDir("ce-detail-state-"),
      workspaceDir: async () => { throw new Error(`workspace boom ${MARKER} /Users/someone/secret`); },
    });
    const engine = createEngine(host, config(makeTempDir("ce-detail-db-")));
    const result = await engine.recall({
      query: "hello",
      signal: new AbortController().signal,
      principal: { agentId: "agent-a" },
    });
    const dump = JSON.stringify(result);
    assert.ok(result.degraded, dump);
    assert.equal(dump.includes(MARKER), false, dump);
    assert.equal(dump.includes("/Users/someone"), false, dump);
    assert.match(result.degraded.detail, /sha=[0-9a-f]{12}/, dump);
    await engine.close({ budgetMs: 5_000 });
  });

  it("fixed internal codes stay readable", TIMEOUT, async () => {
    const host = createStubHost({
      stateDir: makeTempDir("ce-detail2-state-"),
      workspaceDir: async () => { throw new Error("E_WORKSPACE_GONE"); },
    });
    const engine = createEngine(host, config(makeTempDir("ce-detail2-db-")));
    const result = await engine.recall({ query: "hello", signal: new AbortController().signal, principal: { agentId: "agent-a" } });
    assert.match(result.degraded.detail, /E_WORKSPACE_GONE/);
    await engine.close({ budgetMs: 5_000 });
  });
});

describe("durable-merge stale/verification logs use fixed reason codes", () => {
  it("source logs reason codes and hashes no fixed literal", () => {
    const src = readFileSync(new URL("../engine/create-engine.js", import.meta.url), "utf8");
    assert.equal(/describeError\((staleErr|verificationErr)\)/.test(src.split("\n").filter((l) => /staleErr|verificationErr/.test(l) && !/read failed/.test(l)).join("\n")) , false);
    for (const code of ["reason=stale-candidate", "reason=stale-candidate-post-prepare", "reason=stale-candidate-pre-delete", "reason=verification-failed"]) {
      assert.ok(src.includes(code), code);
    }
  });
});

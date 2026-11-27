/**
 * tests/log-error-messages-callsites.test.js — call-site guards for the log redaction (PR #236 review).
 *
 * Each test fails when one redaction call is reverted at its call site: the helper tests in
 * log-error-messages.test.js and log-no-content-jobs.test.js prove the helpers, these prove the
 * callers still use them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ChainedRerankerProvider } from "../lib/providers/reranker-chained.js";
import { ContradictionDetector } from "../lib/contradiction-detector.js";
import { normalizeCapturedValidityWindow } from "../lib/valid-time.js";
import { describeText, summarizeJobResultForLog } from "../lib/log-redact.js";
import { describeErrorForLog } from "../lib/safe-logging.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const T = { timeout: 20_000 };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

function captureLogger() {
  const calls = [];
  const rec = (level) => (...args) => {
    calls.push({ level, text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
  };
  return { calls, logger: { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") } };
}
const dump = (calls) => calls.map((c) => `${c.level}: ${c.text}`).join("\n");

describe("ChainedRerankerProvider logs the primary failure without its message", () => {
  const MARK = "zzchainedrerankzz";
  const failing = { id: "primary", async rerank() { throw new Error(`cohere said ${MARK} sk-live-abcdefgh12345678`); } };

  it("with a fallback", T, async () => {
    const { calls, logger } = captureLogger();
    const fallback = { id: "fb", async rerank() { return [{ index: 0, score: 1 }]; } };
    const out = await new ChainedRerankerProvider(failing, fallback, logger).rerank("q", ["d"], 1, {});
    assert.equal(out.length, 1);
    const all = dump(calls);
    assert.match(all, /reranker primary \(primary\) failed: Error textLen=\d+ sha=[0-9a-f]{12}\. Trying fallback/);
    assert.ok(!all.includes(MARK), all);
  });

  it("without a fallback", T, async () => {
    const { calls, logger } = captureLogger();
    const out = await new ChainedRerankerProvider(failing, null, logger).rerank("q", ["d"], 1, {});
    assert.deepEqual(out, []);
    const all = dump(calls);
    assert.match(all, /reranker primary \(primary\) failed: Error textLen=\d+ sha=[0-9a-f]{12}\. No fallback/);
    assert.ok(!all.includes(MARK), all);
  });
});

describe("job bodies log through the summarizer", () => {
  const src = read("engine/jobs/internal-job-bodies.js");
  const jobs = [
    "consolidate-daily", "classify-recent", "auto-accept-stale", "rem-dream", "skill-miner",
    "episodes-rebuild", "gc-run", "embedding-drain", "feedback-report", "meta-reflect",
  ];
  for (const job of jobs) {
    it(`${job} result log goes through summarizeJobResultForLog`, T, () => {
      const lines = src.split("\n").filter((l) => l.includes(`plur1bus internal ${job}[`) && l.includes("logger.info"));
      assert.ok(lines.length >= 1, `no result log line found for ${job}`);
      for (const line of lines) {
        assert.match(line, /JSON\.stringify\(summarizeJobResultForLog\(/, `${job}: raw result in log line: ${line.trim()}`);
      }
    });
  }
});

describe("fixed reasons stay readable at call sites", () => {
  it("ContradictionDetector missing-fields warning", T, async () => {
    const { calls, logger } = captureLogger();
    const dir = makeTempDir("contradiction-callsite-");
    try {
      const detector = new ContradictionDetector({ logger, workspaceDir: dir });
      await detector.persistContradiction({ targetMemoryId: "m-1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const all = dump(calls);
    assert.match(all, /persistContradiction\] failed: missing required fields/);
    assert.ok(!/textLen=/.test(all), `fixed reason must not be hashed:\n${all}`);
  });

  it("valid-time inverted window debug line", T, () => {
    const { calls, logger } = captureLogger();
    normalizeCapturedValidityWindow({ validFrom: 2_000_000, validUntil: 1_000_000 }, { logger });
    const all = dump(calls);
    assert.match(all, /inverted or empty validity window/);
    assert.ok(!/textLen=/.test(all), all);
  });

  it("describeErrorForLog keeps a string reason readable", T, () => {
    assert.equal(describeErrorForLog("cold-start host call failed"), "cold-start host call failed");
  });

  // Fixed, content-free messages are passed as strings; `new Error("...")` would be hashed (textLen/sha).
  const sites = [
    ["lib/llm-router.js", /safe(?:Warn|Debug)\([^;]*?new Error\("cold-start/s],
    ["lib/contradiction-detector.js", /safe(?:Warn|Debug)\([^;]*?new Error\("missing required fields/s],
    ["lib/valid-time.js", /safe(?:Warn|Debug)\([^;]*?new Error\("inverted/s],
    ["lib/shared-memory-pool.js", /safe(?:Warn|Debug)\([^;]*?new Error\(/s],
    ["engine/identity/principal.js", /safe(?:Warn|Debug)\([^;]*?new Error\("proved principal/s],
  ];
  for (const [file, re] of sites) {
    it(`${file} passes fixed reasons as strings`, T, () => {
      assert.doesNotMatch(read(file), re);
    });
  }
});

describe("edited log lines no longer carry paths or note content", () => {
  const cases = [
    ["engine/store/memory-db.js", "migration error for column", /\$\{this\.dbPath\}/, /db=\$\{shortHash\(this\.dbPath\)\}/],
    ["lib/neo-arch.js", "verwaistes Write-Lock", /\$\{lockPath\}/, /lock=\$\{shortHash\(lockPath\)\}/],
    ["lib/recall-pipeline.js", "knowledge embed failed", /\$\{sec\.heading\}/, /heading=\$\{shortHash\(sec\.heading\)\}/],
    ["lib/obsidian/memory-note-writer.js", "failed to backfill scope", /\$\{entry\.name\}/, /note=\$\{shortHash\(entry\.name\)\}/],
  ];
  for (const [file, needle, bad, good] of cases) {
    it(`${file}: "${needle}"`, T, () => {
      const lines = read(file).split("\n").filter((l) => l.includes(needle));
      assert.equal(lines.length, 1, `expected one line for ${needle}`);
      assert.doesNotMatch(lines[0], bad);
      assert.match(lines[0], good);
    });
  }
});

describe("summarizeJobResultForLog: session keys and numeric chat ids", () => {
  it("a session key under an id key is described, not kept", T, () => {
    const out = JSON.stringify(summarizeJobResultForLog({
      agentId: "agent:main:telegram:acc1:direct:987654321", id: "agent:main", memoryId: "user:v1:abcdef0123",
    }));
    assert.ok(!out.includes("987654321"), out);
    assert.match(out, /agent=main channel=telegram kind=direct peer=[0-9a-f]{12}/);
    assert.match(out, /"id":"agent:main"/);
    assert.match(out, /"memoryId":"user:v1:abcdef0123"/);
  });

  it("an id value with an all-digit segment is hashed", T, () => {
    const out = JSON.stringify(summarizeJobResultForLog({ agent: "thread:topic:123456789" }));
    assert.ok(!out.includes("123456789"), out);
    assert.ok(out.includes(describeText("thread:topic:123456789")), out);
  });

  it("numbers under chat/peer/user/sender keys are hashed; counts stay", T, () => {
    const out = JSON.stringify(summarizeJobResultForLog({
      chatId: 987654321, targets: [1], senderId: 555666777, peers: [444333222], userCount: 3, processed: 7,
    }));
    for (const m of ["987654321", "555666777", "444333222"]) assert.ok(!out.includes(m), `${m} in ${out}`);
    assert.match(out, /"userCount":3/);
    assert.match(out, /"processed":7/);
    const chat = JSON.stringify(summarizeJobResultForLog({ chatId: 987654321 }));
    assert.ok(chat.includes(describeText("987654321")), chat);
  });
});

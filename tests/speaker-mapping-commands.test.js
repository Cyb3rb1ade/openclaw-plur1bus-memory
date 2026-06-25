/**
 * tests/speaker-mapping-commands.test.js
 *
 * Tests for the /speaker chat command handlers.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runSpeakerListCommand,
  runSpeakerNameCommand,
  runSpeakerProposalsCommand,
  runSpeakerConfirmCommand,
  runSpeakerRejectCommand,
  runSpeakerClearCommand,
} from "../lib/telegram-commands/speaker-mapping.js";
import {
  recordSpeakerProposal,
  resetSpeakerMappingDbForTests,
} from "../lib/speaker-mapping-store.js";

let originalStateDir;
let tmpDir;

const allowAuth = () => null;
const denyAuth = () => ({ text: "denied" });

describe("speaker-mapping commands", () => {
  beforeEach(async () => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plur1bus-speaker-cmd-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    resetSpeakerMappingDbForTests();
  });

  afterEach(async () => {
    resetSpeakerMappingDbForTests();
    if (originalStateDir !== undefined) {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    } else {
      delete process.env.OPENCLAW_STATE_DIR;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists confirmed mappings", () => {
    runSpeakerNameCommand({ args: "speaker_0 Nina" }, "agent-1", allowAuth);
    const result = runSpeakerListCommand("agent-1");
    assert.ok(result.text.includes("Nina"));
  });

  it("requires auth for name command", () => {
    const result = runSpeakerNameCommand({ args: "speaker_0 Nina" }, "agent-1", denyAuth);
    assert.strictEqual(result.text, "denied");
  });

  it("shows pending proposals", () => {
    recordSpeakerProposal("agent-1", "speaker_1", "Paul", 0.7);
    const result = runSpeakerProposalsCommand("agent-1");
    assert.ok(result.text.includes("Paul"));
  });

  it("confirms a proposal", () => {
    recordSpeakerProposal("agent-1", "speaker_1", "Paul", 0.7);
    const result = runSpeakerConfirmCommand({ args: "speaker_1" }, "agent-1", allowAuth);
    assert.ok(result.text.includes("bestätigt") || result.text.includes("Confirmed"));
  });

  it("rejects a proposal", () => {
    recordSpeakerProposal("agent-1", "speaker_1", "Paul", 0.7);
    const result = runSpeakerRejectCommand({ args: "speaker_1" }, "agent-1", allowAuth);
    assert.ok(result.text.includes("abgelehnt") || result.text.includes("Rejected"));
  });

  it("clears a mapping", () => {
    runSpeakerNameCommand({ args: "speaker_0 Nina" }, "agent-1", allowAuth);
    const result = runSpeakerClearCommand({ args: "speaker_0" }, "agent-1", allowAuth);
    assert.ok(result.text.includes("entfernt") || result.text.includes("Cleared"));
  });
});

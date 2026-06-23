/**
 * tests/speaker-proposer.test.js
 *
 * Tests for the contextual speaker-name proposer.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { proposeSpeakerNames, storeNewProposals } from "../lib/speaker-proposer.js";
import { resetSpeakerMappingDbForTests, setManualSpeakerMapping } from "../lib/speaker-mapping-store.js";

let originalStateDir;
let tmpDir;

describe("speaker-proposer", () => {
  beforeEach(async () => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plur1bus-speaker-proposer-"));
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

  it("proposes a name from direct address in German", async () => {
    const proposals = await proposeSpeakerNames(
      [
        {
          source: "unknown",
          sourceId: null,
          speakerLabel: "speaker_0",
          speakerDisplayName: null,
          speakerConfidence: null,
          startMs: 0,
          endMs: 1000,
          text: "Hallo Nina, wie geht es dir?",
          words: null,
          attributionSource: "asr_diarize",
          diarizationModel: "mock",
          asrModel: null,
        },
      ],
      "agent-1",
    );
    assert.strictEqual(proposals.length, 1);
    assert.strictEqual(proposals[0].speakerLabel, "speaker_0");
    assert.strictEqual(proposals[0].displayName, "Nina");
  });

  it("proposes a name from direct address in English", async () => {
    const proposals = await proposeSpeakerNames(
      [
        {
          source: "unknown",
          sourceId: null,
          speakerLabel: "speaker_1",
          speakerDisplayName: null,
          speakerConfidence: null,
          startMs: 0,
          endMs: 1000,
          text: "Hi Paul, thanks for joining.",
          words: null,
          attributionSource: "asr_diarize",
          diarizationModel: "mock",
          asrModel: null,
        },
      ],
      "agent-1",
    );
    assert.strictEqual(proposals.length, 1);
    assert.strictEqual(proposals[0].displayName, "Paul");
  });

  it("does not propose for already-confirmed labels", async () => {
    setManualSpeakerMapping("agent-1", "speaker_0", "Nina");
    const proposals = await proposeSpeakerNames(
      [
        {
          source: "unknown",
          sourceId: null,
          speakerLabel: "speaker_0",
          speakerDisplayName: null,
          speakerConfidence: null,
          startMs: 0,
          endMs: 1000,
          text: "Hallo Paul",
          words: null,
          attributionSource: "asr_diarize",
          diarizationModel: "mock",
          asrModel: null,
        },
      ],
      "agent-1",
    );
    assert.strictEqual(proposals.length, 0);
  });

  it("stores only new proposals", () => {
    const proposals = [
      { speakerLabel: "speaker_0", displayName: "Nina", confidence: 0.7, contextHint: "Hallo Nina" },
      { speakerLabel: "speaker_1", displayName: "Paul", confidence: 0.7, contextHint: "Hi Paul" },
    ];
    const first = storeNewProposals("agent-1", proposals);
    assert.strictEqual(first.stored, 2);
    const second = storeNewProposals("agent-1", proposals);
    assert.strictEqual(second.stored, 0);
    assert.strictEqual(second.skipped, 2);
  });
});

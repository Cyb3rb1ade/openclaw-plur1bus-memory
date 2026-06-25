/**
 * tests/speaker-mapping-store.test.js
 *
 * Tests for the PLUR1BUS speaker-mapping store bridge to OpenClaw's
 * diarization SQLite DB.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  confirmSpeakerProposal,
  deleteSpeakerMapping,
  getConfirmedMappings,
  getPendingProposals,
  getSpeakerMapping,
  recordSpeakerProposal,
  rejectSpeakerProposal,
  resetSpeakerMappingDbForTests,
  setManualSpeakerMapping,
} from "../lib/speaker-mapping-store.js";

let originalStateDir;
let tmpDir;

describe("speaker-mapping-store", () => {
  beforeEach(async () => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plur1bus-speaker-mapping-"));
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

  it("stores and retrieves a manual mapping", () => {
    setManualSpeakerMapping("agent-1", "speaker_0", "Nina");
    const mapping = getSpeakerMapping("agent-1", "speaker_0");
    assert.strictEqual(mapping.speakerDisplayName, "Nina");
    assert.strictEqual(mapping.attributionSource, "manual");
    assert.strictEqual(mapping.confirmed, 1);
  });

  it("records a proposal as unconfirmed", () => {
    recordSpeakerProposal("agent-1", "speaker_1", "Paul", 0.7, "Hi Paul");
    const mapping = getSpeakerMapping("agent-1", "speaker_1");
    assert.strictEqual(mapping.confirmed, 0);
    assert.strictEqual(mapping.attributionSource, "contextual_proposal");
  });

  it("does not overwrite a confirmed mapping with a proposal", () => {
    setManualSpeakerMapping("agent-1", "speaker_0", "Nina");
    const stored = recordSpeakerProposal("agent-1", "speaker_0", "Eva", 0.9);
    assert.strictEqual(stored, false);
    const mapping = getSpeakerMapping("agent-1", "speaker_0");
    assert.strictEqual(mapping.speakerDisplayName, "Nina");
  });

  it("lists confirmed mappings and pending proposals separately", () => {
    setManualSpeakerMapping("agent-1", "speaker_0", "Nina");
    recordSpeakerProposal("agent-1", "speaker_1", "Paul", 0.7);
    assert.strictEqual(getConfirmedMappings("agent-1").length, 1);
    assert.strictEqual(getPendingProposals("agent-1").length, 1);
  });

  it("confirms a proposal", () => {
    recordSpeakerProposal("agent-1", "speaker_1", "Paul", 0.7);
    assert.ok(confirmSpeakerProposal("agent-1", "speaker_1"));
    const mapping = getSpeakerMapping("agent-1", "speaker_1");
    assert.strictEqual(mapping.confirmed, 1);
    assert.ok(mapping.confirmedAt);
  });

  it("rejects a proposal", () => {
    recordSpeakerProposal("agent-1", "speaker_1", "Paul", 0.7);
    assert.ok(rejectSpeakerProposal("agent-1", "speaker_1"));
    assert.strictEqual(getSpeakerMapping("agent-1", "speaker_1"), null);
  });

  it("clears a mapping", () => {
    setManualSpeakerMapping("agent-1", "speaker_0", "Nina");
    deleteSpeakerMapping("agent-1", "speaker_0");
    assert.strictEqual(getSpeakerMapping("agent-1", "speaker_0"), null);
  });

  it("falls back to in-memory mappings when node:sqlite is unavailable", () => {
    const originalForceMemory = process.env.PLUR1BUS_SPEAKER_MAPPING_FORCE_MEMORY;
    process.env.PLUR1BUS_SPEAKER_MAPPING_FORCE_MEMORY = "1";
    resetSpeakerMappingDbForTests();
    try {
      setManualSpeakerMapping("agent-1", "speaker_0", "Nina");
      const mapping = getSpeakerMapping("agent-1", "speaker_0");
      assert.strictEqual(mapping.speakerDisplayName, "Nina");
      assert.strictEqual(getConfirmedMappings("agent-1").length, 1);
    } finally {
      resetSpeakerMappingDbForTests();
      if (originalForceMemory === undefined) {
        delete process.env.PLUR1BUS_SPEAKER_MAPPING_FORCE_MEMORY;
      } else {
        process.env.PLUR1BUS_SPEAKER_MAPPING_FORCE_MEMORY = originalForceMemory;
      }
    }
  });
});

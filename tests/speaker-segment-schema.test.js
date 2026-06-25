/**
 * tests/speaker-segment-schema.test.js
 *
 * Regression tests for the canonical speaker-segment schema used by universal
 * audio speaker attribution / diarization.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  applySpeakerMappings,
  createDiscordSpeakerSegment,
  createSpeakerSegment,
  createUnknownSpeakerSegment,
  extractMediaOutputIds,
  formatSpeakerSegments,
  normalizeSpeakerSegment,
  normalizeSpeakerSegments,
  stripMediaOutputIdToken,
} from "../lib/speaker-segment-schema.js";

describe("speaker-segment schema", () => {
  it("normalizes a minimal segment to safe defaults", () => {
    const segment = normalizeSpeakerSegment({});
    assert.strictEqual(segment.source, "unknown");
    assert.strictEqual(segment.sourceId, null);
    assert.strictEqual(segment.speakerLabel, "unknown");
    assert.strictEqual(segment.speakerDisplayName, null);
    assert.strictEqual(segment.speakerConfidence, null);
    assert.strictEqual(segment.startMs, 0);
    assert.strictEqual(segment.endMs, 0);
    assert.strictEqual(segment.text, "");
    assert.strictEqual(segment.words, null);
    assert.strictEqual(segment.attributionSource, "unknown");
    assert.strictEqual(segment.diarizationModel, null);
    assert.strictEqual(segment.asrModel, null);
  });

  it("rejects invalid source and attribution values", () => {
    const segment = normalizeSpeakerSegment({
      source: "not-a-source",
      attributionSource: "not-an-attribution",
      speakerLabel: "speaker_1",
    });
    assert.strictEqual(segment.source, "unknown");
    assert.strictEqual(segment.attributionSource, "unknown");
    assert.strictEqual(segment.speakerLabel, "speaker_1");
  });

  it("keeps valid source and attribution values", () => {
    const segment = normalizeSpeakerSegment({
      source: "telegram_voice",
      attributionSource: "sortformer",
      speakerLabel: "speaker_0",
      startMs: 1200,
      endMs: 5600,
      text: "hello world",
    });
    assert.strictEqual(segment.source, "telegram_voice");
    assert.strictEqual(segment.attributionSource, "sortformer");
    assert.strictEqual(segment.speakerLabel, "speaker_0");
    assert.strictEqual(segment.startMs, 1200);
    assert.strictEqual(segment.endMs, 5600);
    assert.strictEqual(segment.text, "hello world");
  });

  it("ensures endMs is not before startMs", () => {
    const segment = normalizeSpeakerSegment({ startMs: 5000, endMs: 1000 });
    assert.strictEqual(segment.startMs, 5000);
    assert.strictEqual(segment.endMs, 5000);
  });

  it("normalizes an array of segments", () => {
    const segments = normalizeSpeakerSegments([
      { speakerLabel: "speaker_0", text: "hello" },
      { speakerLabel: "speaker_1", text: "world" },
    ]);
    assert.strictEqual(segments.length, 2);
    assert.strictEqual(segments[0].text, "hello");
    assert.strictEqual(segments[1].text, "world");
  });

  it("turns non-array input into an empty array", () => {
    assert.deepStrictEqual(normalizeSpeakerSegments(null), []);
    assert.deepStrictEqual(normalizeSpeakerSegments(undefined), []);
    assert.deepStrictEqual(normalizeSpeakerSegments({}), []);
  });
});

describe("discord speaker segment", () => {
  it("uses the discord user id as speaker label", () => {
    const segment = createDiscordSpeakerSegment({
      userId: "123456789",
      displayName: "Eva",
      text: "hello",
      startMs: 0,
      endMs: 1000,
    });
    assert.strictEqual(segment.source, "discord_voice");
    assert.strictEqual(segment.sourceId, "123456789");
    assert.strictEqual(segment.speakerLabel, "discord:123456789");
    assert.strictEqual(segment.speakerDisplayName, "Eva");
    assert.strictEqual(segment.attributionSource, "discord_user_stream");
    assert.strictEqual(segment.diarizationModel, null);
  });

  it("does not perform biometric identification", () => {
    const segment = createDiscordSpeakerSegment({
      userId: "123456789",
      text: "hello",
      startMs: 0,
      endMs: 1000,
    });
    assert.strictEqual(segment.speakerConfidence, null);
    assert.ok(!segment.speakerLabel.toLowerCase().includes("christian"));
    assert.ok(!segment.speakerLabel.toLowerCase().includes("eva"));
  });
});

describe("unknown speaker fallback", () => {
  it("does not assume single speaker for mixed audio sources", () => {
    const segment = createUnknownSpeakerSegment({
      source: "telegram_voice",
      text: "hello world",
      startMs: 0,
      endMs: 2000,
    });
    assert.strictEqual(segment.source, "telegram_voice");
    assert.strictEqual(segment.speakerLabel, "speaker_0");
    assert.strictEqual(segment.attributionSource, "unknown");
    assert.strictEqual(segment.speakerDisplayName, null);
  });
});

describe("speaker segment formatter", () => {
  it("renders segments without assuming identities", () => {
    const formatted = formatSpeakerSegments([
      createSpeakerSegment({ speakerLabel: "speaker_0", text: "hello" }),
      createSpeakerSegment({ speakerLabel: "speaker_1", text: "world" }),
    ]);
    assert.strictEqual(formatted, "[speaker_0]: hello\n[speaker_1]: world");
  });

  it("renders confirmed display names when present", () => {
    const formatted = formatSpeakerSegments([
      createSpeakerSegment({ speakerLabel: "speaker_0", speakerDisplayName: "Nina", text: "hello" }),
      createSpeakerSegment({ speakerLabel: "speaker_1", text: "world" }),
    ]);
    assert.strictEqual(formatted, "[Nina]: hello\n[speaker_1]: world");
  });

  it("renders discord segments with display name when present", () => {
    const formatted = formatSpeakerSegments([
      createDiscordSpeakerSegment({
        userId: "123456789",
        displayName: "Eva",
        text: "hello",
        startMs: 0,
        endMs: 1000,
      }),
    ]);
    assert.strictEqual(formatted, "[Eva]: hello");
  });

  it("renders discord segments with user-id label when no display name", () => {
    const formatted = formatSpeakerSegments([
      createDiscordSpeakerSegment({
        userId: "123456789",
        text: "hello",
        startMs: 0,
        endMs: 1000,
      }),
    ]);
    assert.strictEqual(formatted, "[discord:123456789]: hello");
  });

  it("returns an empty string for empty segments", () => {
    assert.strictEqual(formatSpeakerSegments([]), "");
    assert.strictEqual(formatSpeakerSegments(null), "");
  });
});

describe("media-output-id token helpers", () => {
  it("strips the hidden media-output-id token", () => {
    const cleaned = stripMediaOutputIdToken("<!-- media-output-id: abc-123 -->\n[speaker_0]: hello");
    assert.strictEqual(cleaned, "[speaker_0]: hello");
  });

  it("extracts media-output-id values from text", () => {
    const ids = extractMediaOutputIds("<!-- media-output-id: abc-123 -->\n<!-- media-output-id: def-456 -->");
    assert.deepStrictEqual(ids, ["abc-123", "def-456"]);
  });
});

describe("applySpeakerMappings", () => {
  it("applies confirmed display names to matching labels", () => {
    const segments = [
      createSpeakerSegment({ speakerLabel: "speaker_0", text: "hello" }),
      createSpeakerSegment({ speakerLabel: "speaker_1", text: "world" }),
    ];
    const result = applySpeakerMappings(segments, new Map([["speaker_0", "Nina"]]));
    assert.strictEqual(result[0].speakerDisplayName, "Nina");
    assert.strictEqual(result[1].speakerDisplayName, null);
  });
});

describe("speaker segment safety", () => {
  it("never auto-sets Christian or Eva as speaker labels", () => {
    const labels = [
      createSpeakerSegment({}).speakerLabel,
      createDiscordSpeakerSegment({ userId: "1", text: "x", startMs: 0, endMs: 1 }).speakerLabel,
      createUnknownSpeakerSegment({ text: "x", startMs: 0, endMs: 1 }).speakerLabel,
    ];
    for (const label of labels) {
      assert.ok(
        !/\bchristian\b/i.test(label),
        `label "${label}" must not contain Christian`,
      );
      assert.ok(
        !/\beva\b/i.test(label),
        `label "${label}" must not contain Eva`,
      );
    }
  });
});

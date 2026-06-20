/**
 * Unit tests for ByteAccumulator.
 * Uses Node's built-in test runner (node:test + node:assert).
 *
 * Run: node --test tests/audioframe.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register mock loader for discord.js and related packages so that importing
// discord-voice-stt.mjs does not attempt a real Discord login (process.exit).
register(
  new URL("./helpers/discord-mock-loader.mjs", import.meta.url).href,
  pathToFileURL("./")
);

process.env.DISCORD_TOKEN = "test-token";

const { ByteAccumulator } = await import("../discord-voice-stt.mjs");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a 3840-byte stereo s16le buffer.
 * leftSamples and rightSamples are arrays of 960 int16 values.
 */
function makeStereoFrame(leftSamples, rightSamples) {
  const buf = Buffer.allocUnsafe(3840);
  for (let i = 0; i < 960; i++) {
    buf.writeInt16LE(leftSamples[i], i * 4);
    buf.writeInt16LE(rightSamples[i], i * 4 + 2);
  }
  return buf;
}

/**
 * Build an accumulator that collects emitted frames into an array.
 * Returns { acc, frames }.
 */
function makeAcc() {
  const frames = [];
  const acc = new ByteAccumulator((frame) => frames.push(frame));
  return { acc, frames };
}

// ── Exact frame emission ──────────────────────────────────────────────────────

describe("ByteAccumulator — exact frame emission", () => {
  test("push exactly 3840 bytes → one frame of exactly 640 bytes emitted", () => {
    const { acc, frames } = makeAcc();
    acc.push(Buffer.alloc(3840));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].length, 640);
  });

  test("push 7680 bytes → two frames of 640 bytes emitted", () => {
    const { acc, frames } = makeAcc();
    acc.push(Buffer.alloc(7680));
    assert.equal(frames.length, 2);
    assert.equal(frames[0].length, 640);
    assert.equal(frames[1].length, 640);
  });

  test("push 3839 bytes → no frame emitted (not enough data)", () => {
    const { acc, frames } = makeAcc();
    acc.push(Buffer.alloc(3839));
    assert.equal(frames.length, 0);
  });

  test("push 3839 bytes then 1 more byte → exactly one frame emitted", () => {
    const { acc, frames } = makeAcc();
    acc.push(Buffer.alloc(3839));
    assert.equal(frames.length, 0, "no frame yet after 3839 bytes");
    acc.push(Buffer.alloc(1));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].length, 640);
  });
});

// ── Arbitrary chunk sizes ─────────────────────────────────────────────────────

describe("ByteAccumulator — arbitrary chunk sizes", () => {
  test("push 1 byte × 3840 → exactly one frame emitted", () => {
    const { acc, frames } = makeAcc();
    const oneByte = Buffer.alloc(1);
    for (let i = 0; i < 3840; i++) {
      acc.push(oneByte);
    }
    assert.equal(frames.length, 1);
    assert.equal(frames[0].length, 640);
  });

  test("push 100 bytes × 39 = 3900 → one frame emitted, 60 bytes remain (not emitted)", () => {
    const { acc, frames } = makeAcc();
    const chunk = Buffer.alloc(100);
    for (let i = 0; i < 39; i++) {
      acc.push(chunk);
    }
    // 3900 bytes total: one full 3840-byte frame consumed, 60 bytes buffered
    assert.equal(frames.length, 1);
    assert.equal(frames[0].length, 640);
  });
});

// ── Frame content verification ────────────────────────────────────────────────

describe("ByteAccumulator — frame content (downmix + decimate math)", () => {
  test("all samples = 0 (silence) → output frame is all zeros", () => {
    const { acc, frames } = makeAcc();
    const left = new Array(960).fill(0);
    const right = new Array(960).fill(0);
    acc.push(makeStereoFrame(left, right));

    assert.equal(frames.length, 1);
    const out = frames[0];
    assert.equal(out.length, 640);
    for (let i = 0; i < 640; i++) {
      assert.equal(out[i], 0, `byte ${i} should be 0`);
    }
  });

  test("left=1000, right=1000 → mono = 1000 for every output sample", () => {
    const { acc, frames } = makeAcc();
    const left = new Array(960).fill(1000);
    const right = new Array(960).fill(1000);
    acc.push(makeStereoFrame(left, right));

    assert.equal(frames.length, 1);
    const out = frames[0];
    assert.equal(out.length, 640);

    // Every int16 sample should be 1000
    for (let i = 0; i < 320; i++) {
      const sample = out.readInt16LE(i * 2);
      assert.equal(sample, 1000, `sample ${i} should be 1000`);
    }
  });

  test("left=32767, right=-32768 → mono ≈ 0 (average rounds to 0, clamped)", () => {
    const { acc, frames } = makeAcc();
    const left = new Array(960).fill(32767);
    const right = new Array(960).fill(-32768);
    acc.push(makeStereoFrame(left, right));

    assert.equal(frames.length, 1);
    const out = frames[0];
    assert.equal(out.length, 640);

    // (32767 + (-32768)) / 2 = -0.5 → Math.round(-0.5) = -0 → writeInt16LE reads back as 0
    for (let i = 0; i < 320; i++) {
      const sample = out.readInt16LE(i * 2);
      assert.equal(sample, 0, `sample ${i} should be 0 (clamped average)`);
    }
  });

  test("output frame is 640 bytes (320 int16 samples = every 3rd of 960 mono samples)", () => {
    const { acc, frames } = makeAcc();
    acc.push(Buffer.alloc(3840)); // silence
    assert.equal(frames[0].length, 640);
    // 640 bytes / 2 bytes per int16 = 320 samples
    assert.equal(640 / 2, 320);
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────

describe("ByteAccumulator — reset", () => {
  test("push 3839 bytes, reset(), push 3840 bytes → exactly one frame emitted", () => {
    const { acc, frames } = makeAcc();
    acc.push(Buffer.alloc(3839));
    assert.equal(frames.length, 0, "no frame before reset");
    acc.reset();
    acc.push(Buffer.alloc(3840));
    assert.equal(frames.length, 1, "exactly one frame after reset + 3840 bytes");
    assert.equal(frames[0].length, 640);
  });

  test("frame count after reset: only frames from post-reset pushes are counted", () => {
    const { acc, frames } = makeAcc();
    // Pre-reset: push enough for two frames
    acc.push(Buffer.alloc(7680));
    assert.equal(frames.length, 2, "two frames before reset");

    // Reset and push less than a full frame
    acc.reset();
    acc.push(Buffer.alloc(100));
    // No new frame — total should still be 2
    const framesBeforeNewFull = frames.length;
    acc.push(Buffer.alloc(3740)); // 3740 + 100 = 3840 → one new frame
    assert.equal(frames.length, framesBeforeNewFull + 1, "one additional frame after completing 3840 post-reset bytes");
    assert.equal(frames[frames.length - 1].length, 640);
  });
});

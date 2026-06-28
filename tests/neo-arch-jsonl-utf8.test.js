/**
 * tests/neo-arch-jsonl-utf8.test.js
 *
 * Regression: readJsonlTailLines reads the file backward in 64KB chunks. The
 * old code decoded each chunk independently (buf.toString per chunk), so a
 * multibyte UTF-8 character straddling a chunk boundary was corrupted to U+FFFD
 * and then persisted verbatim by capJsonl. This test places a German "ü"
 * exactly across the 64KB boundary and asserts it survives intact.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonlTailLines } from "../lib/neo-arch.js";

describe("readJsonlTailLines — UTF-8 across chunk boundary", () => {
  it("does not corrupt a multibyte char straddling the 64KB read boundary", () => {
    const CHUNK = 64 * 1024;
    const size = CHUNK + 50;            // forces two backward chunks
    const boundary = size - CHUNK;      // = 50; first backward chunk starts here
    const buf = Buffer.alloc(size, 0x61); // all 'a'

    // Line break before the ü-line, and the ü split across `boundary`.
    buf[boundary - 2] = 0x0a;           // newline ends line 1
    buf[boundary - 1] = 0xc3;           // lead byte of 'ü'  → last byte of chunk 2
    buf[boundary] = 0xbc;               // cont byte of 'ü'  → first byte of chunk 1
    buf[size - 1] = 0x0a;               // terminate the last line

    const dir = mkdtempSync(join(tmpdir(), "neo-jsonl-utf8-"));
    const path = join(dir, "test.jsonl");
    try {
      writeFileSync(path, buf);
      const lines = readJsonlTailLines(path, 10000); // large limit → read whole file
      const joined = lines.join("\n");
      assert.ok(joined.includes("ü"), "the 'ü' must be preserved across the chunk boundary");
      assert.ok(!joined.includes("�"), "no U+FFFD replacement char may appear");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

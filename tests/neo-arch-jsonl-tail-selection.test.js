import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { describe, it, mock } from "node:test";
import { readJsonlTailLines } from "../lib/neo-arch.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function withJournal(text, operation) {
  const directory = makeTempDir("plur1bus-tail-selection-");
  const path = join(directory, "journal.jsonl");
  try {
    fs.writeFileSync(path, text);
    operation(path);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("Neo JSONL tail selection", () => {
  it("selects the last nonempty lines despite a multi-chunk blank suffix", () => {
    const text = Array.from({ length: 100 }, (_, id) => JSON.stringify({ id })).join("\n") + "\n".repeat(150_000);
    withJournal(text, (path) => assert.deepEqual(readJsonlTailLines(path, 25), text.split("\n").filter(Boolean).slice(-25)));
  });

  it("preserves chronology, whitespace lines, CRLF and valid EOF lines across blank runs", () => {
    const text = `${"old\n".repeat(20_000)}alpha\n${"\n".repeat(90_000)} \n\r\nbravo\ncharlie`;
    for (const limit of [1, 3, 5, 8]) {
      withJournal(text, (path) => assert.deepEqual(readJsonlTailLines(path, limit), text.split("\n").filter(Boolean).slice(-limit)));
    }
  });

  it("keeps long UTF-8 records intact and does not return a partial first line", () => {
    const text = `${"old\n".repeat(30_000)}${JSON.stringify({ content: "🌍ä".repeat(30_000) })}\nlast`;
    withJournal(text, (path) => {
      for (const limit of [1, 2, 3]) assert.deepEqual(readJsonlTailLines(path, limit), text.split("\n").filter(Boolean).slice(-limit));
    });
  });

  it("still reads only one 64 KiB chunk for a dense journal's small suffix", () => {
    withJournal("{\"id\":1}\n".repeat(150_000), (path) => {
      const original = fs.readSync;
      let bytes = 0;
      mock.method(fs, "readSync", (...args) => { const count = original(...args); bytes += count; return count; });
      syncBuiltinESMExports();
      try {
        assert.equal(readJsonlTailLines(path, 25).length, 25);
        assert.equal(bytes, 64 * 1024);
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });

  it("fails visibly on a short read instead of returning an incomplete suffix", () => {
    withJournal("{\"id\":1}\n".repeat(10_000), (path) => {
      const original = fs.readSync;
      mock.method(fs, "readSync", (...args) => original(...args) - 1);
      syncBuiltinESMExports();
      try {
        assert.throws(() => readJsonlTailLines(path, 25), /journal changed during tail read/);
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });
});

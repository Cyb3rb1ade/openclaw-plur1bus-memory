/**
 * 7.19.3 — Die Notbremse beim Append (NEO_MAX_RECORDS) verwirft nichts mehr:
 * abgeschnittene Zeilen landen im Monatsarchiv des Workspaces.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { makeTempDir } from "./helpers/temp-dir.js";

const MAX_RECORDS = 500; // Untergrenze der Konstante (Math.max(500, ...))

process.env.PLUR1BUS_NEO_MAX_RECORDS = String(MAX_RECORDS);
process.env.PLUR1BUS_NEO_CAP_CHECK_BYTES = String(256 * 1024);

let createNeoStore;
before(async () => {
  ({ createNeoStore } = await import("../lib/neo-arch.js"));
});

describe("appendJsonl hard cap archives evicted lines", () => {
  it("keeps the newest MAX_RECORDS lines and archives the rest", () => {
    const root = makeTempDir("neo-cap-archive-");
    try {
      const store = createNeoStore(root, "ws");
      const turns = Array.from({ length: MAX_RECORDS + 200 }, (_, i) => ({
        id: `turn-${i}`,
        role: "user",
        text: `turn ${i} `.padEnd(800, "x"),
        createdAt: new Date(1_700_000_000_000 + i).toISOString(),
      }));
      for (const turn of turns) store.appendTurns([turn]);
      const live = readFileSync(store.paths.turns, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id);
      assert.ok(live.length <= MAX_RECORDS + Math.ceil(MAX_RECORDS * 0.1), `live file stays bounded (${live.length})`);
      assert.strictEqual(live.at(-1), `turn-${turns.length - 1}`);
      const archiveDir = join(store.paths.workspaceDir, "archive");
      const archived = readdirSync(archiveDir)
        .filter((name) => name.startsWith("turn-journal."))
        .flatMap((name) => gunzipSync(readFileSync(join(archiveDir, name))).toString("utf8").split("\n").filter(Boolean))
        .map((l) => JSON.parse(l).id);
      assert.ok(archived.length > 0, "evicted lines were archived");
      const all = new Set([...live, ...archived]);
      assert.strictEqual(all.size, turns.length, "every appended turn is either live or archived");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

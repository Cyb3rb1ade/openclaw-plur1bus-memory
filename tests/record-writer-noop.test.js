import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRecordNote } from "../lib/obsidian/record-writer.js";
import { confirmedObsidianPolicy } from "./helpers/obsidian-mutation-policy.js";

function makeConfig(tmp) {
  return {
    vaultPath: tmp,
    reviewRoot: "plur1bus",
    allowDotObsidianWrite: false,
  };
}

test("unchanged managed block does not rewrite the file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-record-writer-"));
  try {
    const cfg = makeConfig(tmp);
    const options = {
      mutationPolicy: confirmedObsidianPolicy({
        baseDbPath: tmp,
        command: ["records", "rebuild"],
      }),
    };
    const record = {
      plur1bus_id: "rec-1",
      plur1bus_type: "review_item",
      title: "Test Record",
      summary: "Summary text",
      status: "pending",
      risk: "low",
      scope: "dashboard_only",
    };

    // Erstes Schreiben erzeugt die Datei.
    const first = writeRecordNote(cfg, record, options);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.changed, true);

    const path = join(tmp, "plur1bus", "records", "review-items", "rec-1.md");
    const firstMtime = statSync(path).mtimeMs;

    // Kleine Pause, damit mtime sich ändern würde, wenn geschrieben wird.
    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait for mtime granularity */ }

    // Zweites Schreiben mit identischem Inhalt sollte überspringen.
    const second = writeRecordNote(cfg, record, options);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.changed, false);

    const secondMtime = statSync(path).mtimeMs;
    assert.strictEqual(firstMtime, secondMtime, "mtime must not change for unchanged note");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("changed managed block still rewrites the file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-record-writer-"));
  try {
    const cfg = makeConfig(tmp);
    const options = {
      mutationPolicy: confirmedObsidianPolicy({
        baseDbPath: tmp,
        command: ["records", "rebuild"],
      }),
    };
    const record = {
      plur1bus_id: "rec-2",
      plur1bus_type: "review_item",
      title: "Test Record",
      summary: "Summary text",
      status: "pending",
      risk: "low",
      scope: "dashboard_only",
    };

    const first = writeRecordNote(cfg, record, options);
    assert.strictEqual(first.changed, true);

    const path = join(tmp, "plur1bus", "records", "review-items", "rec-2.md");
    const firstMtime = statSync(path).mtimeMs;

    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait */ }

    record.summary = "Updated summary";
    const second = writeRecordNote(cfg, record, options);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.changed, true);

    const secondMtime = statSync(path).mtimeMs;
    assert.ok(secondMtime > firstMtime, "mtime must change for changed note");
    const content = readFileSync(path, "utf8");
    assert.ok(content.includes("Updated summary"), "updated content must be written");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("existing file content remains identical on unchanged rewrite", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plur1bus-record-writer-"));
  try {
    const cfg = makeConfig(tmp);
    const options = {
      mutationPolicy: confirmedObsidianPolicy({
        baseDbPath: tmp,
        command: ["records", "rebuild"],
      }),
    };
    const record = {
      plur1bus_id: "rec-3",
      plur1bus_type: "review_item",
      title: "Test Record",
      summary: "Summary text",
      status: "pending",
      risk: "low",
      scope: "dashboard_only",
    };

    writeRecordNote(cfg, record, options);
    const path = join(tmp, "plur1bus", "records", "review-items", "rec-3.md");
    const before = readFileSync(path, "utf8");

    writeRecordNote(cfg, record, options);
    const after = readFileSync(path, "utf8");

    assert.strictEqual(before, after, "file content must remain identical");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

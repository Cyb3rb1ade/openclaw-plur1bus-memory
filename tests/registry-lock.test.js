/**
 * tests/registry-lock.test.js
 *
 * Vertrag des synchronen Registry-Locks: Freigabe im Normal- und Fehlerfall,
 * Übernahme veralteter Locks, Timeout bei einem frischen fremden Lock und
 * echte prozessübergreifende Serialisierung.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { withRegistryLock } from "../lib/registry-lock.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// A file: URL: the worker imports it, and a bare Windows path is no ESM specifier.
const LOCK_MODULE = new URL("../lib/registry-lock.js", import.meta.url).href;

function tempDir(t) {
  const dir = makeTempDir("registry-lock-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("withRegistryLock", () => {
  it("liefert den Rückgabewert von fn und entfernt die Lockdatei", (t) => {
    const lockPath = join(tempDir(t), "registry.lock");

    const result = withRegistryLock(lockPath, () => "fertig");

    assert.equal(result, "fertig");
    assert.equal(existsSync(lockPath), false, "Lockdatei muss nach dem Block weg sein");
  });

  it("gibt den Lock auch frei, wenn fn wirft", (t) => {
    const lockPath = join(tempDir(t), "registry.lock");

    assert.throws(() => withRegistryLock(lockPath, () => { throw new Error("boom"); }), /boom/);

    assert.equal(existsSync(lockPath), false, "Lockdatei darf nach einer Exception nicht liegen bleiben");
  });

  it("übernimmt einen veralteten Lock", (t) => {
    const lockPath = join(tempDir(t), "registry.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
    const ancient = new Date(Date.now() - 60_000);
    utimesSync(lockPath, ancient, ancient);

    const result = withRegistryLock(lockPath, () => "übernommen", { staleMs: 1000, timeoutMs: 500 });

    assert.equal(result, "übernommen");
  });

  it("läuft in einen Timeout, wenn ein frischer fremder Lock liegt", (t) => {
    const lockPath = join(tempDir(t), "registry.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));

    assert.throws(
      () => withRegistryLock(lockPath, () => "nie", { staleMs: 60_000, timeoutMs: 150, retryMs: 10 }),
      /lock/i,
    );
    // fn darf nicht gelaufen sein; der fremde Lock bleibt unangetastet.
    assert.equal(existsSync(lockPath), true);
  });

  it("serialisiert konkurrierende Prozesse (kein verschränktes Schreiben)", (t) => {
    const dir = tempDir(t);
    const lockPath = join(dir, "registry.lock");
    const outPath = join(dir, "out.log");
    writeFileSync(outPath, "");

    // Jeder Prozess schreibt unter Lock "start-N", wartet, dann "end-N".
    // Ohne echte Serialisierung verschränken sich die Marker.
    const script = `
      import { appendFileSync } from "node:fs";
      import { withRegistryLock } from ${JSON.stringify(LOCK_MODULE)};
      const [lockPath, outPath, id] = process.argv.slice(2);
      withRegistryLock(lockPath, () => {
        appendFileSync(outPath, "start-" + id + "\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
        appendFileSync(outPath, "end-" + id + "\\n");
      }, { timeoutMs: 5000, retryMs: 5 });
    `;
    const scriptPath = join(dir, "worker.mjs");
    writeFileSync(scriptPath, script);

    // ECHT gleichzeitig starten — sequentielles execFileSync würde auch ohne
    // Lock bestehen und wäre damit kein Test.
    return Promise.all(["a", "b", "c"].map((id) => new Promise((resolve, reject) => {
      execFile(process.execPath, [scriptPath, lockPath, outPath, id], { timeout: 20_000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    }))).then(() => {

      const lines = readFileSync(outPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 6);
      for (let i = 0; i < lines.length; i += 2) {
        const [phase, id] = lines[i].split("-");
        assert.equal(phase, "start");
        assert.equal(lines[i + 1], `end-${id}`, `Prozess ${id} wurde von einem anderen unterbrochen`);
      }
    });
  });

  describe("Windows delete-pending (EPERM beim wx-Open)", () => {
    function flakyOpen(failures, code) {
      let calls = 0;
      const open = (path, flags) => {
        calls += 1;
        if (calls <= failures) {
          throw Object.assign(new Error(`${code}: operation not permitted, open '${path}'`), { code });
        }
        return openSync(path, flags);
      };
      return { open, calls: () => calls };
    }

    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      it(`wiederholt ${code} unter win32, bis der Lock frei ist`, (t) => {
        const lockPath = join(tempDir(t), "registry.lock");
        const flaky = flakyOpen(3, code);

        const result = withRegistryLock(lockPath, () => "erworben", {
          platform: "win32", openSync: flaky.open, retryMs: 1, timeoutMs: 2000,
        });

        assert.equal(result, "erworben");
        assert.equal(flaky.calls(), 4);
        assert.equal(existsSync(lockPath), false);
      });
    }

    it("reapt bei EPERM unter win32 nicht (Datei kann mitten im Löschen sein)", (t) => {
      const lockPath = join(tempDir(t), "registry.lock");
      writeFileSync(lockPath, "fremd");
      const ancient = new Date(Date.now() - 60_000);
      utimesSync(lockPath, ancient, ancient);
      const flaky = flakyOpen(Infinity, "EPERM");

      assert.throws(
        () => withRegistryLock(lockPath, () => "nie", {
          platform: "win32", openSync: flaky.open, staleMs: 1000, retryMs: 1, timeoutMs: 50,
        }),
        /lock busy/,
      );
      assert.equal(existsSync(lockPath), true, "veralteter Lock darf bei EPERM nicht gelöscht werden");
    });

    it("wirft EPERM außerhalb von win32 unverändert", (t) => {
      const lockPath = join(tempDir(t), "registry.lock");
      const flaky = flakyOpen(1, "EPERM");

      assert.throws(
        () => withRegistryLock(lockPath, () => "nie", { platform: "linux", openSync: flaky.open }),
        { code: "EPERM" },
      );
      assert.equal(flaky.calls(), 1);
    });
  });
});

/**
 * tests/tombstone-torn-write.test.js
 *
 * B1: Eine einzelne beschädigte Registry-Zeile darf die Erfassung eines Agenten
 * nicht dauerhaft stilllegen — aber toleriert wird ausschließlich ein echter
 * „torn write": die LETZTE physische Zeile, ohne abschließendes \n, syntaktisch
 * unvollständiges JSON, und alle vorherigen Zeilen vollständig valide.
 *
 * Alles andere (beschädigte Zeile in der Mitte, vollständiges JSON das die
 * Validierung nicht besteht, beschädigter Tail MIT Newline, Fehler beim
 * Quarantänieren/Kürzen) bleibt fail-closed.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  TOMBSTONE_SCHEMA_VERSION,
  appendTombstoneToRegistry,
  contentFingerprint,
  findBlockingTombstoneForCapture,
  quarantineFileForRegistry,
  readTombstoneRegistry,
  tombstoneRegistryDir,
} from "../lib/tombstone.js";

const TOMBSTONE_MODULE = fileURLToPath(new URL("../lib/tombstone.js", import.meta.url));
const AGENT = "torn-agent";

function tempBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "torn-write-"));
  t.after(() => {
    try { chmodSync(tombstoneRegistryDir(join(dir, "lancedb-namespaced")), 0o700); } catch { /* egal */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, "lancedb-namespaced");
}

function validLine(text, overrides = {}) {
  return JSON.stringify({
    schemaVersion: TOMBSTONE_SCHEMA_VERSION,
    tombstoneId: "11111111-2222-3333-4444-555555555555",
    memoryId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    canonicalOriginId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    agentId: AGENT,
    scope: "agent-private",
    status: "committed",
    contentFingerprint: contentFingerprint(text),
    ...overrides,
  });
}

/** Schreibt die Registry-Datei mit exakt dem übergebenen Rohinhalt. */
function writeRegistry(baseDbPath, raw) {
  const dir = tombstoneRegistryDir(baseDbPath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${AGENT}.jsonl`);
  writeFileSync(file, raw, "utf8");
  return file;
}

function quarantineFile(baseDbPath) {
  return quarantineFileForRegistry(join(tombstoneRegistryDir(baseDbPath), `${AGENT}.jsonl`));
}

describe("B1 torn write — Toleranz genau für den abgebrochenen Append", () => {
  it("quarantäniert einen abgeschnittenen Tail und lässt die Erfassung weiterlaufen", (t) => {
    const base = tempBase(t);
    // Unverwechselbares Fragment: `{"schemaVersi` wäre ein Präfix JEDER gültigen
    // Zeile, die Assertion darunter damit tautologisch wahr.
    const fragment = '{"schemaVersion":1,"tombstoneId":"abgebroch';
    const survivor = validLine("erinnert");
    const file = writeRegistry(base, `${survivor}\n${fragment}`);

    const result = readTombstoneRegistry(base, AGENT);

    assert.equal(result.ok, true);
    assert.equal(result.corruptLines, 0, "der abgebrochene Append darf nicht als Korruption zählen");
    assert.equal(result.tombstones.length, 1);

    // Fragment beweissicher abgelegt, Registry exakt auf die gültige Zeile gekürzt.
    assert.equal(readFileSync(quarantineFile(base), "utf8"), `${fragment}\n`);
    assert.equal(readFileSync(file, "utf8"), `${survivor}\n`);

    // Und die Erfassung eines UNBETEILIGTEN Inhalts ist wieder frei.
    assert.equal(findBlockingTombstoneForCapture(base, { agentId: AGENT, text: "etwas anderes" }), null);
  });

  it("blockiert eine beschädigte Zeile in der Mitte", (t) => {
    const base = tempBase(t);
    writeRegistry(base, `${validLine("eins")}\n{kaputt\n${validLine("zwei")}\n`);

    const result = readTombstoneRegistry(base, AGENT);

    assert.ok(result.corruptLines > 0, "mittige Korruption muss sichtbar bleiben");
    const blocker = findBlockingTombstoneForCapture(base, { agentId: AGENT, text: "irgendwas" });
    assert.equal(blocker?._blockReason, "registry_corrupt_lines");
    assert.equal(existsSync(quarantineFile(base)), false, "nichts quarantänieren, was kein torn write ist");
  });

  it("blockiert vollständiges JSON, das die Validierung nicht besteht", (t) => {
    const base = tempBase(t);
    // Syntaktisch vollständig, aber semantisch ungültig (kein memoryId/scope) und
    // ohne abschließendes \n — sieht oberflächlich wie ein Tail aus, ist aber keiner.
    writeRegistry(base, `${validLine("eins")}\n{"schemaVersion":1}`);

    const result = readTombstoneRegistry(base, AGENT);

    assert.ok(result.corruptLines > 0);
    assert.equal(
      findBlockingTombstoneForCapture(base, { agentId: AGENT, text: "irgendwas" })?._blockReason,
      "registry_corrupt_lines",
    );
  });

  it("blockiert einen beschädigten Tail MIT abschließendem Newline", (t) => {
    const base = tempBase(t);
    // Abgeschlossene Zeile ⇒ der Schreibvorgang war nicht abgebrochen.
    writeRegistry(base, `${validLine("eins")}\n{"schemaVersi\n`);

    const result = readTombstoneRegistry(base, AGENT);

    assert.ok(result.corruptLines > 0, "ein abgeschlossener Schreibvorgang ist kein torn write");
    assert.equal(existsSync(quarantineFile(base)), false);
  });

  it("bleibt fail-closed, wenn die Quarantäne nicht geschrieben werden kann", (t) => {
    const base = tempBase(t);
    writeRegistry(base, `${validLine("eins")}\n{"schemaVersi`);
    // Ein Verzeichnis an der Stelle der Quarantänedatei ⇒ das Auslagern scheitert
    // mit EISDIR. (chmod taugt hier nicht: die Suite läuft als root und würde
    // die Rechte schlicht ignorieren.)
    mkdirSync(quarantineFile(base), { recursive: true });

    const result = readTombstoneRegistry(base, AGENT);

    assert.ok(
      result.ok === false || result.corruptLines > 0,
      "scheiternde Quarantäne darf nicht als Erfolg durchgehen",
    );
    assert.ok(findBlockingTombstoneForCapture(base, { agentId: AGENT, text: "irgendwas" }));
  });

  it("ist idempotent — ein zweiter Read quarantäniert nicht erneut", (t) => {
    const base = tempBase(t);
    writeRegistry(base, `${validLine("eins")}\n{"schemaVersi`);

    readTombstoneRegistry(base, AGENT);
    const afterFirst = readFileSync(quarantineFile(base), "utf8");
    const second = readTombstoneRegistry(base, AGENT);

    assert.equal(second.ok, true);
    assert.equal(second.corruptLines, 0);
    assert.equal(readFileSync(quarantineFile(base), "utf8"), afterFirst, "keine doppelte Quarantäne");
  });

  it("lässt einen vorherigen committed Tombstone weiter blockieren", (t) => {
    const base = tempBase(t);
    writeRegistry(base, `${validLine("streng geheim")}\n{"schemaVersi`);

    readTombstoneRegistry(base, AGENT);

    const blocker = findBlockingTombstoneForCapture(base, { agentId: AGENT, text: "streng geheim" });
    assert.ok(blocker, "der überlebende Tombstone muss die Neuerfassung weiterhin blockieren");
    assert.equal(blocker._blockReason, undefined, "das ist ein echter Treffer, keine Notbremse");
  });

  it("legt die Quarantäne so ab, dass reapply keinen Phantom-Agenten daraus macht", (t) => {
    const base = tempBase(t);
    writeRegistry(base, `${validLine("eins")}\n{"schemaVersion":1,"tombstoneId":"abgebroch`);

    readTombstoneRegistry(base, AGENT);

    // reapply-tombstones.mjs leitet die Agent-Liste aus `*.jsonl` im
    // Registry-Verzeichnis ab. Hieße die Quarantänedatei `<agent>.corrupt.jsonl`,
    // entstünde daraus ein Agent `<agent>.corrupt` → registryErrors → Exit 1 →
    // restore-snapshot.sh bricht jedes Restore mit "INCOMPLETE" ab.
    const jsonlFiles = readdirSync(tombstoneRegistryDir(base)).filter((f) => f.endsWith(".jsonl"));
    assert.deepEqual(jsonlFiles, [`${AGENT}.jsonl`]);
    assert.equal(existsSync(quarantineFile(base)), true, "das Fragment muss trotzdem beweissicher abgelegt sein");
  });

  it("repariert im read-only-Modus nichts und meldet den Tail stattdessen", (t) => {
    const base = tempBase(t);
    const raw = `${validLine("eins")}\n{"schemaVersion":1,"tombstoneId":"abgebroch`;
    const file = writeRegistry(base, raw);

    const result = readTombstoneRegistry(base, AGENT, { repairTornTail: false });

    assert.ok(result.corruptLines > 0, "read-only muss den Tail als Befund melden");
    assert.equal(readFileSync(file, "utf8"), raw, "read-only darf die Registry nicht anfassen");
    assert.equal(existsSync(quarantineFile(base)), false);
  });

  it("verliert keinen konkurrierenden Append während der Quarantäne", (t) => {
    const base = tempBase(t);
    writeRegistry(base, `${validLine("eins")}\n{"schemaVersi`);
    const dir = tombstoneRegistryDir(base);

    const script = `
      import { appendTombstoneToRegistry, readTombstoneRegistry } from ${JSON.stringify(TOMBSTONE_MODULE)};
      const [base, agent, mode, fp] = process.argv.slice(2);
      if (mode === "read") readTombstoneRegistry(base, agent);
      else appendTombstoneToRegistry(base, agent, {
        schemaVersion: 1,
        tombstoneId: "99999999-2222-3333-4444-555555555555",
        memoryId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
        canonicalOriginId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
        agentId: agent, scope: "agent-private", status: "committed", contentFingerprint: fp,
      });
    `;
    const scriptPath = join(dir, "worker.mjs");
    writeFileSync(scriptPath, script);
    const fp = contentFingerprint("parallel angehängt");

    const run = (mode) => new Promise((resolve, reject) => {
      execFile(process.execPath, [scriptPath, base, AGENT, mode, fp], { timeout: 20_000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    return Promise.all([run("read"), run("append")]).then(() => {
      const result = readTombstoneRegistry(base, AGENT);
      assert.equal(result.ok, true);
      assert.equal(result.corruptLines, 0);
      const fingerprints = result.tombstones.map((tomb) => tomb.contentFingerprint);
      assert.ok(
        fingerprints.includes(fp),
        "der parallel geschriebene Tombstone darf durch das Kürzen nicht verloren gehen",
      );
    });
  });
});

/**
 * tests/tombstone-registry-cache.test.js
 *
 * M3: findBlockingTombstoneForCapture las bei JEDER Erfassung die vollständige
 * append-only JSONL synchron ein und parste sie zeilenweise — blockierend im
 * Event-Loop, ohne Cache, ohne Size-Cap. Die Registry wächst um zwei Zeilen pro
 * Forget (attempted + committed/failed) und wird nie kompaktiert.
 *
 * Der Cache wird über mtime + Dateigröße validiert. Beide Schreibpfade
 * (appendTombstoneToRegistry, Torn-Tail-Reparatur) ändern beides, deshalb
 * braucht es keine zusätzliche Invalidierung.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  TOMBSTONE_SCHEMA_VERSION,
  appendTombstoneToRegistry,
  contentFingerprint,
  findBlockingTombstoneForCapture,
  readTombstoneRegistry,
  tombstoneRegistryDir,
} from "../lib/tombstone.js";

const AGENT = "cache-agent";

function tempBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "registry-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "lancedb-namespaced");
}

function line(fingerprint) {
  return JSON.stringify({
    schemaVersion: TOMBSTONE_SCHEMA_VERSION,
    tombstoneId: "11111111-2222-3333-4444-555555555555",
    memoryId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    canonicalOriginId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    agentId: AGENT,
    scope: "agent-private",
    status: "committed",
    contentFingerprint: fingerprint,
  });
}

function registryPath(base) {
  const dir = tombstoneRegistryDir(base);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${AGENT}.jsonl`);
}

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

describe("M3 Registry-Cache", () => {
  it("liest eine unveränderte Registry nicht erneut von der Platte", (t) => {
    const base = tempBase(t);
    const file = registryPath(base);
    // Feste mtime auf beiden Seiten: utimesSync hat nur ms-Auflösung, ein
    // "Zurücksetzen" auf einen zuvor gelesenen Wert mit Sub-ms-Anteil träfe
    // ihn nicht exakt und wäre ein Testartefakt, kein Cache-Miss.
    const eingefroren = new Date(1_700_000_000_000);

    writeFileSync(file, `${line(FP_A)}\n`, "utf8");
    utimesSync(file, eingefroren, eingefroren);

    const erst = readTombstoneRegistry(base, AGENT);
    assert.deepEqual(erst.tombstones.map((x) => x.contentFingerprint), [FP_A]);

    // Inhalt austauschen, aber mtime UND Größe exakt erhalten (die Zeilen sind
    // gleich lang). Wer neu einliest, sieht FP_B; wer cacht, sieht FP_A.
    const vorher = statSync(file);
    writeFileSync(file, `${line(FP_B)}\n`, "utf8");
    assert.equal(statSync(file).size, vorher.size, "Testaufbau: Größe muss identisch sein");
    utimesSync(file, eingefroren, eingefroren);

    const zweit = readTombstoneRegistry(base, AGENT);
    assert.deepEqual(
      zweit.tombstones.map((x) => x.contentFingerprint),
      [FP_A],
      "unveränderte mtime+Größe ⇒ der Cache muss greifen",
    );
  });

  it("sieht einen Append sofort", (t) => {
    const base = tempBase(t);
    const file = registryPath(base);
    writeFileSync(file, `${line(FP_A)}\n`, "utf8");
    readTombstoneRegistry(base, AGENT);

    appendTombstoneToRegistry(base, AGENT, JSON.parse(line(FP_B)));

    const fingerprints = readTombstoneRegistry(base, AGENT).tombstones.map((x) => x.contentFingerprint);
    assert.deepEqual(fingerprints.sort(), [FP_A, FP_B].sort(), "ein Append darf nie durch den Cache verdeckt werden");
  });

  it("blockiert eine Neuerfassung auch direkt nach dem Append (fail-closed bleibt)", (t) => {
    const base = tempBase(t);
    const file = registryPath(base);
    writeFileSync(file, `${line(FP_A)}\n`, "utf8");
    // Cache mit dem Zustand VOR dem Tombstone füllen.
    assert.equal(findBlockingTombstoneForCapture(base, { agentId: AGENT, text: "geheim" }), null);

    appendTombstoneToRegistry(base, AGENT, JSON.parse(line(contentFingerprint("geheim"))));

    assert.ok(
      findBlockingTombstoneForCapture(base, { agentId: AGENT, text: "geheim" }),
      "ein frisch committeter Tombstone muss sofort blockieren",
    );
  });

  it("gibt Aufrufern keine Referenz auf den Cache-Inhalt", (t) => {
    const base = tempBase(t);
    writeFileSync(registryPath(base), `${line(FP_A)}\n`, "utf8");

    const erst = readTombstoneRegistry(base, AGENT);
    erst.tombstones.length = 0;

    assert.equal(readTombstoneRegistry(base, AGENT).tombstones.length, 1, "Mutation durch einen Aufrufer darf den Cache nicht leeren");
  });

  it("bemerkt eine gekürzte Registry (Torn-Tail-Reparatur)", (t) => {
    const base = tempBase(t);
    const file = registryPath(base);
    writeFileSync(file, `${line(FP_A)}\n${line(FP_B)}\n`, "utf8");
    assert.equal(readTombstoneRegistry(base, AGENT).tombstones.length, 2);

    writeFileSync(file, `${line(FP_A)}\n`, "utf8");

    assert.equal(readTombstoneRegistry(base, AGENT).tombstones.length, 1, "Kürzen ändert die Größe ⇒ Cache-Miss");
    assert.equal(readFileSync(file, "utf8").includes(FP_B), false);
  });
});

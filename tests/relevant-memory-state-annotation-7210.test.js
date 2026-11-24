// 7.20.10: LanceDB-Recall-Block — Zustandsangaben datieren (B2) und die
// tatsächlich gerenderten ids für die Neo-Dedupe (B3).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VOLATILE_STATE_INSTRUCTION } from "../lib/temporal-provenance.js";
import { collectRenderedMemoryIds, formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const SEPT = Date.parse("2026-09-14T04:56:38.072Z");
const OPTS = { now: NOW, timeZone: "Europe/Berlin" };

const item = (id, display, extra = {}) => ({
  id,
  category: "fact",
  source: "dm",
  display,
  fullText: display,
  memoryStrength: 1,
  createdAt: SEPT,
  versionCreatedAt: 0,
  epistemicStatus: "observed",
  ...extra,
});

// Anonymisierte Nachstellung der drei Zeilen aus dem Golden-Test von 12:59.
const GOLDEN = [
  item("79051500-0000-4000-8000-000000000001", "PLUR1BUS ist mein Memory-System, aktuell 7.12.2, und läuft im Gateway."),
  item("16544393-0000-4000-8000-000000000002", "Der Marker „[visible thinking]“ stand heute mitten im Recall-Block.", { createdAt: NOW - 3 * 60 * 60 * 1000 }),
  item("ff05e062-0000-4000-8000-000000000003", "Wir prüfen später, ob der Job gerade läuft."),
];

describe("formatRelevantMemoriesContext: Zustandsangaben (B2)", () => {
  it("Golden: 79051500 datiert, 16544393 (zu jung) und ff05e062 (ohne Wert) nicht", () => {
    const out = formatRelevantMemoriesContext(GOLDEN, OPTS);
    assert.match(out, /aktuell \[Stand 14\.09\.2026\] 7\.12\.2, und läuft im Gateway\./);
    assert.match(out, /id="79051500-0000-4000-8000-000000000001"[^>]*state-as-of="2026-09-14"/);
    assert.doesNotMatch(out, /id="16544393[^>]*state-as-of/);
    assert.doesNotMatch(out, /id="ff05e062[^>]*state-as-of/);
    assert.equal((out.match(/\[Stand \d/g) || []).length, 1);
    assert.ok(out.includes(VOLATILE_STATE_INSTRUCTION), "Kopfzeile, weil etwas datiert wurde");
  });

  it("ohne Annotation keine Kopfzeile und keine Änderung", () => {
    const out = formatRelevantMemoriesContext(GOLDEN.slice(1), OPTS);
    assert.equal(out.includes("STATE AS OF"), false);
    assert.equal(/\[Stand \d/.test(out), false);
  });

  it("abschaltbar über recall.volatileStateAnnotation", () => {
    for (const cfg of [false, { enabled: false }]) {
      const out = formatRelevantMemoriesContext(GOLDEN, { ...OPTS, volatileStateAnnotation: cfg });
      assert.equal(/\[Stand \d/.test(out), false);
      assert.equal(out.includes("STATE AS OF"), false);
    }
  });

  it("Anker: versionCreatedAt einer Version, sonst createdAt — nie updatedAt", () => {
    const text = "Der Gateway ist aktuell auf 2026.11.3.";
    const version = item("v2", text, { createdAt: SEPT, versionCreatedAt: Date.parse("2026-10-01T10:00:00Z"), versionNumber: 2, updatedAt: Date.parse("2026-11-23T10:00:00Z") });
    assert.match(formatRelevantMemoriesContext([version], OPTS), /aktuell \[Stand 01\.10\.2026\] auf/);
    const patched = item("v1", text, { createdAt: SEPT, updatedAt: Date.parse("2026-11-23T10:00:00Z") });
    assert.match(formatRelevantMemoriesContext([patched], OPTS), /aktuell \[Stand 14\.09\.2026\] auf/, "updatedAt zählt nicht");
    const bigint = item("big", text, { createdAt: BigInt(SEPT) });
    assert.match(formatRelevantMemoriesContext([bigint], OPTS), /\[Stand 14\.09\.2026\]/, "BigInt aus LanceDB");
  });

  it("Träume und kanonische Abschnitte bleiben wörtlich", () => {
    const text = "Aktuell läuft 7.20.9 im Gateway.";
    const dream = item("d", text, { memoryClass: "dream" });
    const canonical = item("canonical:Stand", text, { category: "canonical", authoritative: true });
    const out = formatRelevantMemoriesContext([dream, canonical], OPTS);
    assert.equal(/\[Stand \d/.test(out), false);
  });

  it("das truncated-Flag hängt nicht an der Annotation", () => {
    const display = "Wir sind aktuell 7.12.2 und bleiben dort.";
    const plain = formatRelevantMemoriesContext([item("t", display)], OPTS);
    assert.equal(plain.includes('truncated="true"'), false);
    const cut = formatRelevantMemoriesContext([item("t", display, { fullText: `${display} ${"Rest ".repeat(50)}` })], OPTS);
    assert.ok(cut.includes('truncated="true"'));
    assert.ok(cut.includes("[Stand 14.09.2026]"));
  });

  it("Linsen-Zeilen werden datiert und lösen die Kopfzeile aus", () => {
    const out = formatRelevantMemoriesContext([GOLDEN[2]], { ...OPTS, semanticLensMemories: [item("lens-1", "Bei mir läuft Opus als Standardmodell.")] });
    assert.ok(out.includes("läuft [Stand 14.09.2026] Opus"));
    assert.ok(out.includes(VOLATILE_STATE_INSTRUCTION));
  });

  it("ungültige Zeitzone: Datum in UTC, Fehler an onError", () => {
    const errors = [];
    const out = formatRelevantMemoriesContext([GOLDEN[0]], { now: NOW, timeZone: "Nowhere/Invalid", onError: (e) => errors.push(e) });
    assert.match(out, /\[Stand 14\.09\.2026\]/);
    assert.equal(errors.length, 1);
  });
});

describe("collectRenderedMemoryIds (B3)", () => {
  const records = Array.from({ length: 12 }, (_, i) => ({
    entry: { id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, text: `Erinnerung ${i}` },
  }));
  const items = records.map((r) => item(r.entry.id, `Erinnerung Nummer ${r.entry.id.slice(-2)} mit etwas Text, damit der Block groß genug wird.`));

  it("nur Records, die nach der Kürzung im Block stehen", () => {
    const full = formatRelevantMemoriesContext(items, { ...OPTS, maxTotalChars: 100_000 });
    assert.equal(collectRenderedMemoryIds(full, records).size, 12);
    const cut = formatRelevantMemoriesContext(items, { ...OPTS, maxTotalChars: 1800 });
    const rendered = collectRenderedMemoryIds(cut, records);
    assert.ok(rendered.size > 0 && rendered.size < 12, `gerendert: ${rendered.size}`);
    for (const id of rendered) assert.ok(cut.includes(`id="${id}"`));
    const missing = records.map((r) => r.entry.id).filter((id) => !rendered.has(id));
    for (const id of missing) assert.equal(cut.includes(`id="${id}"`), false);
  });

  it("leere oder fremde Eingaben", () => {
    assert.equal(collectRenderedMemoryIds("", records).size, 0);
    assert.equal(collectRenderedMemoryIds(null, records).size, 0);
    assert.equal(collectRenderedMemoryIds('<memory-record id="unbekannt">', records).size, 0);
    assert.deepEqual([...collectRenderedMemoryIds(`<memory-record category="fact" id="${records[3].entry.id}">`, records)], [records[3].entry.id]);
  });
});

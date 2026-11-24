// 7.20.10 (Mangel 3): Zustandsangaben beim Rendern datieren.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  VOLATILE_STATE_INSTRUCTION,
  annotateVolatileStateForPrompt,
  resolveVolatileStateAnnotationConfig,
  toObservedAtMs,
} from "../lib/temporal-provenance.js";
import { formatNeoRecallContext, transitionRecordStatus } from "../lib/neo-arch.js";
import { readFileSync } from "node:fs";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const SEPT = Date.parse("2026-09-14T04:56:38.072Z");
const OPTS = { now: NOW, timeZone: "Europe/Berlin" };

function annotate(text, observedAt = SEPT, extra = {}) {
  return annotateVolatileStateForPrompt(text, observedAt, { ...OPTS, ...extra });
}

describe("annotateVolatileStateForPrompt: Erkennung", () => {
  it("deutscher Marker mit Versionsnummer", () => {
    const r = annotate("PLUR1BUS ist mein Memory-System, aktuell 7.12.2, und laeuft im Gateway.");
    assert.equal(r.text, "PLUR1BUS ist mein Memory-System, aktuell [Stand 14.09.2026] 7.12.2, und laeuft im Gateway.");
    assert.equal(r.annotated, 1);
    assert.equal(r.stateAsOf, "2026-09-14");
  });

  it("\"zur Zeit des …\" verweist auf ein Ereignis und bekommt kein Label, \"zurzeit\" schon", () => {
    for (const text of [
      "1. Angaben zur Zeit des Unfalls, 1.2 Art des Unternehmens",
      "Name und Anschrift des Arbeitgebers zur Zeit des Unfalls, 1.2 Art des Unternehmens",
      "Zur Zeit des Releases 7.12.2 war alles grün",
      "Zur Zeit der Messung lief Sonnet 5.5",
    ]) {
      const r = annotate(text);
      assert.equal(r.annotated, 0, text);
      assert.equal(r.text, text);
    }
    assert.equal(annotate("Der Gateway nutzt zurzeit 2026.11.6.").text, "Der Gateway nutzt zurzeit [Stand 14.09.2026] 2026.11.6.");
  });

  it("englische Marker und Kalenderversion", () => {
    assert.equal(annotate("The gateway currently runs 2026.11.3.").text, "The gateway currently [Stand 14.09.2026] runs 2026.11.3.");
    assert.equal(annotate("latest release is 7.20.9").annotated, 1);
  });

  it("Modellname als Wert", () => {
    assert.equal(annotate("Bei mir läuft Opus als Standardmodell.").text, "Bei mir läuft [Stand 14.09.2026] Opus als Standardmodell.");
    assert.equal(annotate("Aktuell läuft kimi-coding/k3-256k").annotated, 1);
  });

  it("flektierte Formen", () => {
    assert.equal(annotate("die aktuelle Version ist 7.12.2").text, "die aktuelle [Stand 14.09.2026] Version ist 7.12.2");
  });

  it("ohne Wert keine Annotation", () => {
    assert.equal(annotate("Ich schaue mir an, wie der Job aktuell aussieht.").annotated, 0);
    assert.equal(annotate("Der Job läuft.").annotated, 0);
  });

  it("Wert mehr als 30 Zeichen hinter dem Marker zählt nicht", () => {
    assert.equal(annotate(`aktuell ${"x".repeat(31)} 7.12.2`).annotated, 0);
    assert.equal(annotate(`aktuell ${"x".repeat(20)} 7.12.2`).annotated, 1);
  });

  it("\"7.12.2.\" am Satzende ist kein Datum", () => {
    assert.equal(annotate("Der Stand ist klar: aktuell 7.12.2.", SEPT).annotated, 0, "Stand-Wort im Fenster");
    assert.equal(annotate("Wir sind aktuell 7.12.2.").text, "Wir sind aktuell [Stand 14.09.2026] 7.12.2.");
  });

  it("\"7.12.61\" ist kein Datum", () => {
    assert.equal(annotate("live auf 7.12.61").text, "live [Stand 14.09.2026] auf 7.12.61");
  });

  it("schon datierte Stellen bleiben", () => {
    for (const text of [
      "Stand 14.09.: aktuell 7.12.2",
      "seit 13.11. aktuell 7.20.2",
      "am 14.09.2026 aktuell 7.12.2",
      "2026-09-14 aktuell 7.12.2",
      "as of September 14 currently 7.12.2",
      "am 14. September aktuell 7.12.2",
    ]) {
      assert.equal(annotate(text).annotated, 0, text);
    }
  });

  it("Zitate und Inline-Code bleiben", () => {
    for (const text of [
      "Bernd zitiert „aktuell 7.12.2“ aus dem Speicher.",
      "Im Text steht \"aktuell 7.12.2\" noch drin.",
      "Er schrieb «aktuell 7.12.2» dazu.",
      "Der Befehl `latest 1.2.3` ist alt.",
    ]) {
      assert.equal(annotate(text).annotated, 0, text);
    }
  });

  it("Docker- und npm-Tags mit latest bleiben", () => {
    assert.equal(annotate("Image n8n:latest 1.2.3 gezogen").annotated, 0);
    assert.equal(annotate("npm i openclaw@latest 2026.11.6").annotated, 0);
  });

  it("\"Aktuell läuft …\" bekommt nur ein Label", () => {
    const r = annotate("Aktuell läuft 7.20.9 auf dem VPS.");
    assert.equal(r.annotated, 1);
    assert.equal(r.text, "Aktuell [Stand 14.09.2026] läuft 7.20.9 auf dem VPS.");
  });

  it("höchstens maxPerRecord Labels", () => {
    const text = [
      "aktuell 7.12.2 im Gateway.",
      "Das Modell ist derzeit Opus.",
      "Im Dashboard steht live 7.12.3 als Wert.",
    ].join(" Dazwischen steht genug anderer Text, damit der Abstand reicht. ");
    assert.equal(annotate(text).annotated, 2);
    assert.equal(annotate(text, SEPT, { maxPerRecord: 3 }).annotated, 3);
  });
});

describe("annotateVolatileStateForPrompt: Zeitanker", () => {
  it("minAgeDays: jünger als 2 Tage bleibt", () => {
    assert.equal(annotate("aktuell 7.20.9", NOW - 47 * 3600_000).annotated, 0);
    assert.equal(annotate("aktuell 7.20.9", NOW - 49 * 3600_000).annotated, 1);
    assert.equal(annotate("aktuell 7.20.9", NOW - 3600_000, { minAgeDays: 0 }).annotated, 1);
  });

  it("Zeitstempel als Number, BigInt und ISO", () => {
    const expected = "aktuell [Stand 14.09.2026] 7.12.2";
    assert.equal(annotate("aktuell 7.12.2", SEPT).text, expected);
    assert.equal(annotate("aktuell 7.12.2", BigInt(SEPT)).text, expected);
    assert.equal(annotate("aktuell 7.12.2", "2026-09-14T04:56:38.072Z").text, expected);
  });

  it("ungültiger oder fehlender Stempel: keine Annotation, keine Exception", () => {
    for (const stamp of [undefined, null, 0, 0n, "kein Datum", NaN, 2n ** 70n, {}]) {
      const r = annotateVolatileStateForPrompt("aktuell 7.12.2", stamp, OPTS);
      assert.deepEqual(r, { text: "aktuell 7.12.2", annotated: 0, stateAsOf: null }, String(stamp));
    }
  });

  it("Datum in der übergebenen Zeitzone", () => {
    const lateUtc = Date.parse("2026-09-14T22:30:00.000Z");
    assert.equal(annotate("aktuell 7.12.2", lateUtc, { timeZone: "Europe/Berlin" }).text, "aktuell [Stand 15.09.2026] 7.12.2");
    assert.equal(annotate("aktuell 7.12.2", lateUtc, { timeZone: "UTC" }).text, "aktuell [Stand 14.09.2026] 7.12.2");
  });

  it("ungültige Zeitzone fällt auf UTC zurück und meldet den Fehler", () => {
    const errors = [];
    const r = annotate("aktuell 7.12.2", SEPT, { timeZone: "Kein/Ort", onError: (e) => errors.push(e) });
    assert.equal(r.text, "aktuell [Stand 14.09.2026] 7.12.2");
    assert.equal(r.timeZoneFallback, true);
    assert.equal(errors.length, 1);
    // ohne onError bleibt der Rückfall am Ergebnis sichtbar
    assert.equal(annotate("aktuell 7.12.2", SEPT, { timeZone: "Kein/Ort" }).timeZoneFallback, true);
    assert.equal(annotate("aktuell 7.12.2").timeZoneFallback, undefined);
  });

  it("toObservedAtMs", () => {
    assert.equal(toObservedAtMs(SEPT), SEPT);
    assert.equal(toObservedAtMs(BigInt(SEPT)), SEPT);
    assert.equal(toObservedAtMs(0n), undefined);
    assert.equal(toObservedAtMs(BigInt(Number.MAX_SAFE_INTEGER) + 1n), undefined);
  });
});

describe("Golden-Test 12:59 (anonymisiert)", () => {
  // Drei Records aus dem Prompt von 12:59: der 71 Tage alte Systemeintrag
  // (wird annotiert), Bernds Bericht mit dem Zitat und eine Zeile ohne Wert.
  const records = [
    { id: "79051500", createdAt: SEPT, text: "PLUR1BUS ist mein Memory-System (Plugin `@scope/plugin`, aktuell 7.12.2), Auto-Recall und Capture laufen darueber." },
    { id: "16544393", createdAt: NOW - 3600_000 * 26 * 3, text: "Im Recall stand der Satz „aktuell 7.12.2“ aus dem September, das ist laengst ueberholt." },
    { id: "ff05e062", createdAt: NOW - 3600_000 * 24 * 5, text: "Ich pruefe, wie der Job aktuell aussieht, und melde mich." },
  ];

  it("nur der Systemeintrag wird annotiert", () => {
    const result = Object.fromEntries(records.map((r) => [r.id, annotate(r.text, r.createdAt).annotated]));
    assert.deepEqual(result, { "79051500": 1, "16544393": 0, ff05e062: 0 });
  });
});

describe("resolveVolatileStateAnnotationConfig", () => {
  it("Defaults und Grenzen", () => {
    assert.deepEqual(resolveVolatileStateAnnotationConfig(undefined), { enabled: true, minAgeDays: 2, maxPerRecord: 2 });
    assert.deepEqual(resolveVolatileStateAnnotationConfig(false), { enabled: false, minAgeDays: 2, maxPerRecord: 2 });
    assert.deepEqual(resolveVolatileStateAnnotationConfig({ enabled: false, minAgeDays: 7, maxPerRecord: 50 }), { enabled: false, minAgeDays: 7, maxPerRecord: 10 });
    assert.deepEqual(resolveVolatileStateAnnotationConfig({ minAgeDays: -1, maxPerRecord: 0 }), { enabled: true, minAgeDays: 2, maxPerRecord: 2 });
  });
});

describe("Neo-Block: created-at, age und Stand", () => {
  function record(extra = {}) {
    return {
      id: "mem_state",
      agentId: "main",
      statement: "Im Gateway ist aktuell 7.12.56 installiert.",
      category: "assistant_claim",
      status: "candidate",
      createdAt: "2026-09-14T04:56:38.072Z",
      updatedAt: "2026-09-14T04:56:38.072Z",
      origin: { role: "assistant", trustLevel: "assistant_asserted", scope: "agent_private" },
      ...extra,
    };
  }
  const render = (item, opts = {}) => formatNeoRecallContext({ agent_private_reflections: [{ item, score: 0.4 }] }, { now: NOW, timeZone: "Europe/Berlin", ...opts });

  it("rendert created-at und age aus createdAt", () => {
    const out = render(record());
    assert.match(out, / created-at="2026-09-14T04:56:38\.072Z" age="71d ago"/);
  });

  it("eine demoted-Revision ändert das Alter nicht", () => {
    const demoted = transitionRecordStatus(record(), "demoted", { now: "2026-11-24T11:00:00.000Z" });
    assert.notEqual(demoted.updatedAt, record().updatedAt, "transitionRecordStatus setzt updatedAt neu");
    const out = render(demoted);
    assert.match(out, / created-at="2026-09-14T04:56:38\.072Z" age="71d ago"/);
  });

  it("ohne createdAt kein Zeitattribut, auch wenn updatedAt da ist", () => {
    const out = render(record({ createdAt: undefined }));
    assert.doesNotMatch(out, /created-at=|age=|state-as-of=/);
  });

  it("annotiert Zustandsangaben und setzt die STATE-AS-OF-Zeile", () => {
    const out = render(record());
    assert.match(out, /aktuell \[Stand 14\.09\.2026\] 7\.12\.56/);
    assert.match(out, / state-as-of="2026-09-14"/);
    assert.ok(out.includes(`\n${VOLATILE_STATE_INSTRUCTION}\n`));
    // Die Zeile steht direkt nach der Sicherheitszeile, vor dem ersten Record.
    assert.ok(out.indexOf(VOLATILE_STATE_INSTRUCTION) < out.indexOf("<memory-record"));
  });

  it("ohne annotierten Record keine STATE-AS-OF-Zeile", () => {
    const out = render(record({ statement: "Ein Eintrag ohne Zustandsangabe." }));
    assert.ok(!out.includes("STATE AS OF"));
    assert.doesNotMatch(out, /state-as-of=/);
  });

  it("abschaltbar über volatileStateAnnotation", () => {
    const out = render(record(), { volatileStateAnnotation: { enabled: false } });
    assert.doesNotMatch(out, /\[Stand /);
    assert.ok(!out.includes("STATE AS OF"));
    assert.match(out, / created-at=/);
  });

  it("das Label verkleinert das Textfenster nicht", () => {
    const long = `aktuell 7.12.2 ${"y".repeat(400)}`;
    const out = render(record({ statement: long }));
    const evidence = out.match(/<quoted-evidence>([^<]*)<\/quoted-evidence>/)[1];
    assert.equal(evidence.length, 300 + " [Stand 14.09.2026]".length);
  });
});

describe("Auto-Recall-Hook: Neo-Block mit Zustandsdatierung", () => {
  it("liest recall.volatileStateAnnotation und gibt es an beide Neo-Renderaufrufe", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.match(source, /resolveVolatileStateAnnotationConfig\(cfg\.recall\?\.volatileStateAnnotation\)/);
    const calls = [...source.matchAll(/formatNeoRecallContext\(([^)]*)\)/g)].map((m) => m[1]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((args) => /neoFormatOptions\(/.test(args)), calls.join(" | "));
  });
});

describe("README zeigt das Label an der Stelle, an der der Code es setzt", () => {
  it("hinter dem Marker, vor dem Wert", () => {
    const expected = annotate("aktuell 7.12.2").text;
    assert.equal(expected, "aktuell [Stand 14.09.2026] 7.12.2");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.ok(readme.includes(`"${expected}"`), "README-Beispiel");
    assert.ok(!readme.includes("7.12.2 [Stand"), "kein Label hinter dem Wert");
  });
});

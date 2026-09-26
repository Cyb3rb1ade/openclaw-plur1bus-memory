/**
 * tests/emotion-refine-encoding-maxtokens.test.js
 *
 * Messung (siehe Brief): der Encoding-Call in encodingCallLlm (index.js,
 * emotion-refine-Cron) fragt seit der Acht-Dimensionen-Emotions-Label-Map +
 * Freitext-Grund eine deutlich längere Antwort ab. Bei 400 und 800
 * maxTokens verbraucht ein echter Provider genau dieses Limit und liefert
 * finish_reason "length" — abgeschnittenes JSON, der Parser verwirft es
 * stumm (HTTP 200, aber keine schließende Klammer). Erst 1500 reicht (345
 * Tokens tatsächlich verbraucht, finish_reason "stop").
 *
 * Die eigentliche Aufrufstelle steckt tief in der Registrierungs-Closure von
 * index.js und lässt sich nicht ohne einen echten Gateway auslösen. Diese
 * Datei prüft deshalb zwei Dinge, die OHNE Gateway ehrlich prüfbar sind:
 *
 * 1. Die Auflösung des Konfigurationswerts (Default/Override/Unsinn) — dafür
 *    wird der tatsächliche Ausdruck aus index.js per Regex extrahiert und
 *    ausgeführt (new Function), statt ihn hier ein zweites Mal von Hand
 *    nachzubauen. Ändert sich die echte Logik in index.js, ändert sich auch
 *    dieses Testergebnis — eine Kopie würde das nicht tun.
 * 2. Eine strukturelle Prüfung, dass die Encoding-Aufrufstelle keine
 *    hartkodierte 300 mehr trägt und die Emotion-Tier-3-Aufrufstelle
 *    weiterhin genau das tut.
 *
 * Ein echter End-to-End-Beleg (der tatsächlich resultierende maxTokens-Wert,
 * wie er beim gemockten Laufzeit-LLM ankommt) steht zusätzlich in
 * tests/emotion-refine-cron.test.js — dort existiert die
 * Plugin-Registrierungs-Infrastruktur (createApi/register/Cron-Handler)
 * bereits für andere Tests und wird hier nicht neu erfunden, sondern nur um
 * eine Assertion ergänzt.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { readRuntimeSources } from "./helpers/runtime-sources.js";

// Task 13b: the construction half of register() (this block included) is
// engine/create-engine.js now.
const indexSrc = readRuntimeSources().engine.createEngine;

describe("emotion-refine encoding maxTokens — Auflösung des Konfigurationswerts", () => {
  // Extrahiert exakt den Block, der EMOTION_REFINE_ENCODING_MAX_TOKENS
  // berechnet — kein Nachbau von Hand, sondern der tatsächliche Code.
  const match = indexSrc.match(
    /const EMOTION_REFINE_ENCODING_MAX_TOKENS_DEFAULT[\s\S]*?: EMOTION_REFINE_ENCODING_MAX_TOKENS_DEFAULT;/,
  );

  it("die Konstante EMOTION_REFINE_ENCODING_MAX_TOKENS ist in engine/create-engine.js auffindbar", () => {
    assert.ok(match, "EMOTION_REFINE_ENCODING_MAX_TOKENS-Block nicht gefunden — Extraktion/Regex prüfen");
  });

  function resolve(emotionCfg) {
    assert.ok(match, "Vorbedingung: Block muss gefunden sein");
    const fn = new Function("emotionCfg", `${match[0]}\nreturn EMOTION_REFINE_ENCODING_MAX_TOKENS;`);
    return fn(emotionCfg);
  }

  it("Default (kein t3, leeres t3, kein encodingMaxTokens) ist 1500", () => {
    assert.strictEqual(resolve({}), 1500);
    assert.strictEqual(resolve({ t3: {} }), 1500);
    assert.strictEqual(resolve({ t3: { enabled: true } }), 1500);
  });

  it("ein gültiger Override wird übernommen (abgerundet)", () => {
    assert.strictEqual(resolve({ t3: { encodingMaxTokens: 3000 } }), 3000);
    assert.strictEqual(resolve({ t3: { encodingMaxTokens: 250.9 } }), 250);
  });

  it("Unsinnswerte fallen auf den Default 1500 zurück", () => {
    // 0.5 gehört hier ausdrücklich dazu: Math.floor(0.5) wäre 0, ein
    // maxTokens von 0 darf aber nie beim Provider ankommen (der Provider
    // bekäme dann effektiv gar kein Budget). Die Untergrenze muss deshalb
    // VOR dem Runden greifen (>= 1), nicht erst danach (> 0).
    for (const bad of ["banana", null, undefined, 0, 0.5, -5, Infinity, -Infinity, NaN, "", [], {}]) {
      assert.strictEqual(resolve({ t3: { encodingMaxTokens: bad } }), 1500, `encodingMaxTokens=${JSON.stringify(bad)}`);
    }
  });
});

describe("emotion-refine encoding maxTokens — strukturelle Aufrufstellen-Prüfung", () => {
  const emotionT3Start = indexSrc.indexOf("const emotionT3CallLlm");
  const encodingStart = indexSrc.indexOf("const encodingCallLlm");
  const encodingEnd = indexSrc.indexOf(": null;", encodingStart);

  it("Quellcode-Anker gefunden (Vorbedingung für die folgenden Prüfungen)", () => {
    assert.ok(emotionT3Start > -1, "const emotionT3CallLlm nicht gefunden");
    assert.ok(encodingStart > emotionT3Start, "const encodingCallLlm nicht gefunden (oder vor emotionT3CallLlm)");
    assert.ok(encodingEnd > encodingStart, "Ende der encodingCallLlm-Definition (': null;') nicht gefunden");
  });

  it("emotionT3CallLlm (Tier-3-Emotionsklassifikation) trägt weiterhin maxTokens: 300", () => {
    const slice = indexSrc.slice(emotionT3Start, encodingStart);
    assert.match(slice, /maxTokens:\s*300,/, "emotionT3CallLlm muss weiterhin maxTokens: 300 verwenden");
  });

  it("encodingCallLlm (Bedeutung + Emotion in einem Call) trägt keine hartkodierte 300 mehr", () => {
    const slice = indexSrc.slice(encodingStart, encodingEnd);
    assert.doesNotMatch(
      slice,
      /maxTokens:\s*\d/,
      "encodingCallLlm darf keinen hartkodierten Zahlenwert mehr für maxTokens tragen",
    );
    assert.match(
      slice,
      /maxTokens:\s*EMOTION_REFINE_ENCODING_MAX_TOKENS,/,
      "encodingCallLlm muss die benannte Konstante EMOTION_REFINE_ENCODING_MAX_TOKENS verwenden",
    );
  });
});

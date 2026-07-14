/**
 * tests/proactive-nudge-timing.test.js
 * Tests für shouldShowNudge — Jitter, Ruhezeiten, Tages-Cap
 * Runner: node --test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldShowNudge } from "../lib/proactive-nudge.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Hilfsfunktion: erstellt einen `now`-Timestamp mit bestimmter lokaler Stunde.
// Wir nutzen UTC-Stunden direkt, da Date.getHours() lokal ist — für Tests
// arbeiten wir mit einem festen UTC-Offset-freien Ansatz: wir wählen UTC-Tagesbeginn
// + gewünschte Stunden. Das entspricht Lokalzeit nur wenn der Testrechner UTC ist,
// daher prüfen wir im Test die tatsächliche Stunde statt eine feste Zeit zu erzwingen.

/**
 * Gibt einen Timestamp zurück, bei dem new Date(ts).getHours() === targetHour (lokal).
 * Strategie: Starte bei UTC-Mitternacht eines bekannten Tages, verschiebe um Stunden,
 * prüfe ob getHours() passt. Iteriere durch UTC-Offsets.
 */
function nowAtHour(targetHour, baseDayMs = 20000 * DAY_MS) {
  // Versuche, einen Timestamp zu finden, bei dem getHours() == targetHour
  // baseDayMs ist ein Referenztag weit in der Zukunft (UTC)
  for (let offset = 0; offset < 24; offset++) {
    const ts = baseDayMs + offset * HOUR_MS;
    if (new Date(ts).getHours() === targetHour) {
      return ts;
    }
  }
  throw new Error(`Konnte keinen Timestamp mit Stunde ${targetHour} erzeugen`);
}

describe("shouldShowNudge — Jitter", () => {
  it("Jitter ist deterministisch: gleiche Inputs → gleicher Effekt", () => {
    const pattern = { keyword: "sport" };
    // Wähle einen Zeitpunkt tagsüber (Stunde 10) damit Ruhezeiten nicht stören
    const now = nowAtHour(10, 20000 * DAY_MS);
    const lastShown = now - 25 * HOUR_MS; // 25h her → sollte fast immer true sein

    const result1 = shouldShowNudge(pattern, lastShown, now);
    const result2 = shouldShowNudge(pattern, lastShown, now);
    assert.equal(result1, result2, "Gleiches Ergebnis bei gleichen Inputs");
  });

  it("Jitter hält Cooldown in [18h, 30h] für verschiedene Patterns und Tage", () => {
    const patterns = [
      { keyword: "sport" },
      { keyword: "arbeit" },
      { id: "project-x" },
      { keyword: "musik" },
      {},
    ];
    const baseDayMs = 20000 * DAY_MS;
    const now = nowAtHour(10, baseDayMs); // tagsüber

    for (const pattern of patterns) {
      for (let dayOffset = 0; dayOffset < 10; dayOffset++) {
        const testNow = now + dayOffset * DAY_MS;
        const testHour = new Date(testNow).getHours();
        // Stelle sicher dass wir tagsüber sind (Ruhezeiten umgehen)
        if (testHour >= 22 || testHour < 8) continue;

        // Finde die effektive Cooldown-Grenze durch Bisektion:
        // lastShown so setzen, dass wir genau an der Grenze sind
        // Effektive Grenze liegt zwischen 18h und 30h nach lastShown
        // Teste: bei 18h lastShown immer false (Cooldown nicht erreicht — aber Jitter ≤ 6h, also min 18h)
        const tooSoon = testNow - 17 * HOUR_MS;
        assert.equal(
          shouldShowNudge(pattern, tooSoon, testNow),
          false,
          `Nach 17h sollte Nudge nicht gezeigt werden (pattern: ${JSON.stringify(pattern)}, dayOffset: ${dayOffset})`
        );

        // Bei 31h lastShown immer true (Cooldown sicher überschritten — max 30h)
        const longEnough = testNow - 31 * HOUR_MS;
        assert.equal(
          shouldShowNudge(pattern, longEnough, testNow),
          true,
          `Nach 31h sollte Nudge gezeigt werden (pattern: ${JSON.stringify(pattern)}, dayOffset: ${dayOffset})`
        );
      }
    }
  });
});

describe("shouldShowNudge — Ruhezeiten", () => {
  it("Ruhezeit blockt bei Stunde 23", () => {
    let now;
    try {
      now = nowAtHour(23);
    } catch {
      // Überspringe wenn Stunde 23 nicht erzeugbar (sollte nie passieren)
      return;
    }
    // Langer Cooldown: vor 48h zuletzt gezeigt
    const lastShown = now - 48 * HOUR_MS;
    const result = shouldShowNudge({ keyword: "test" }, lastShown, now);
    assert.equal(result, false, "Ruhezeit 23:00 → geblockt");
  });

  it("Ruhezeit erlaubt bei Stunde 10", () => {
    const now = nowAtHour(10);
    const lastShown = now - 48 * HOUR_MS;
    // Mit Jitter aus, damit wir sicher über dem Cooldown liegen
    const result = shouldShowNudge({ keyword: "test" }, lastShown, now, { jitter: false });
    assert.equal(result, true, "Tagsüber 10:00 → nicht durch Ruhezeit geblockt");
  });

  it("opts.quietHours === false deaktiviert Ruhezeiten bei Stunde 23", () => {
    let now;
    try {
      now = nowAtHour(23);
    } catch {
      return;
    }
    const lastShown = now - 48 * HOUR_MS;
    const result = shouldShowNudge({ keyword: "test" }, lastShown, now, {
      quietHours: false,
      jitter: false,
    });
    assert.equal(result, true, "quietHours=false → 23:00 nicht geblockt");
  });
});

describe("shouldShowNudge — Tages-Cap", () => {
  it("Cap greift: shownToday >= 2 → false", () => {
    const now = nowAtHour(10);
    const lastShown = now - 48 * HOUR_MS;
    const result = shouldShowNudge({ keyword: "test" }, lastShown, now, {
      shownToday: 2,
      jitter: false,
      quietHours: false,
    });
    assert.equal(result, false, "shownToday=2 → durch Cap geblockt");
  });

  it("Cap greift nicht: shownToday < 2 → weiter prüfen", () => {
    const now = nowAtHour(10);
    const lastShown = now - 48 * HOUR_MS;
    const result = shouldShowNudge({ keyword: "test" }, lastShown, now, {
      shownToday: 1,
      jitter: false,
      quietHours: false,
    });
    assert.equal(result, true, "shownToday=1 → Cap nicht ausgeschöpft");
  });

  it("Cap ignoriert wenn shownToday nicht übergeben (Rückwärtskompatibilität)", () => {
    const now = nowAtHour(10);
    const lastShown = now - 48 * HOUR_MS;
    // Kein shownToday → Cap wird nicht geprüft
    const result = shouldShowNudge({ keyword: "test" }, lastShown, now, {
      jitter: false,
      quietHours: false,
    });
    assert.equal(result, true, "Ohne shownToday kein Cap");
  });

  it("opts.dayCap === false deaktiviert Cap", () => {
    const now = nowAtHour(10);
    const lastShown = now - 48 * HOUR_MS;
    const result = shouldShowNudge({ keyword: "test" }, lastShown, now, {
      shownToday: 5,
      dayCap: false,
      jitter: false,
      quietHours: false,
    });
    assert.equal(result, true, "dayCap=false → kein Cap trotz shownToday=5");
  });
});

describe("shouldShowNudge — opts.jitter === false", () => {
  it("Ohne Jitter: genau 24h Cooldown", () => {
    const now = nowAtHour(10);
    const just23h = now - 23 * HOUR_MS;
    const just25h = now - 25 * HOUR_MS;

    assert.equal(
      shouldShowNudge({ keyword: "test" }, just23h, now, { jitter: false, quietHours: false }),
      false,
      "23h her → noch Cooldown"
    );
    assert.equal(
      shouldShowNudge({ keyword: "test" }, just25h, now, { jitter: false, quietHours: false }),
      true,
      "25h her → Cooldown vorbei"
    );
  });
});

describe("shouldShowNudge — Rückwärtskompatibilität", () => {
  it("Aufruf ohne opts wirft keinen Fehler", () => {
    const now = nowAtHour(10);
    const lastShown = now - 48 * HOUR_MS;
    assert.doesNotThrow(() => shouldShowNudge({ keyword: "test" }, lastShown, now));
  });

  it("lastShown=null → immer true (außer Ruhezeit/Cap)", () => {
    const now = nowAtHour(10);
    const result = shouldShowNudge({ keyword: "test" }, null, now, {
      quietHours: false,
      jitter: false,
    });
    assert.equal(result, true, "lastShown=null → true");
  });
});

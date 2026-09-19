/**
 * tests/retrieval-halflife-extension.test.js
 *
 * "Je öfter ich mich an etwas erinnere, desto präsenter bleibt es."
 *
 * Bis hierher hob ein Abruf nur die momentane Stärke, nicht die
 * Behaltensdauer — die Erinnerung zerfiel danach exakt so schnell wie zuvor.
 * Gemessen am 19.09.2026: eine Tatsache mit 30 Tagen Halbwertszeit, alle drei
 * Tage abgerufen (121-mal im Jahr), stand nach einem Jahr bei 0,395; eine
 * intensiv kodierte Erinnerung, an die NIE jemand wieder dachte, bei 0,886.
 * Wiederholung war damit schwächer als einmalige Intensität, und der Zuschlag
 * je Abruf schrumpfte zusätzlich mit der Zahl der Abrufe (erster Abruf
 * +0,089, hundertster +0,027).
 *
 * Verteilte Wiederholung dehnt beim Menschen die Behaltensdauer. Genau das
 * bildet die Verlängerung ab — gedeckelt beim obersten automatischen Band
 * (600 Tage), analog zu AUTOMATIC_IMPORTANCE_MAX: ein Automatismus erreicht
 * nie, was der Intensität (Blitzlicht, 3650) oder der ausdrücklichen
 * Entscheidung des Agenten (36.500) vorbehalten ist.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  CORE_MEMORY_HALF_LIFE_DAYS,
  FLASHBULB_HALF_LIFE_DAYS,
  RETRIEVAL_HALF_LIFE_FACTOR,
  RETRIEVAL_HALF_LIFE_MAX_DAYS,
  RETRIEVAL_MIN_SPACING_MS,
  applyRetrievalReinforcement,
  computeDecayedStrength,
  resolveHalfLifeFromEncoding,
} from "../lib/memory-dynamics.js";

const DAY = 86400000;
const now = Date.UTC(2026, 8, 19);

describe("Abruf verlaengert die Behaltensdauer", () => {
  it("deckelt beim obersten automatischen Band, nicht darueber", () => {
    assert.strictEqual(RETRIEVAL_HALF_LIFE_MAX_DAYS, 600);
    assert.ok(RETRIEVAL_HALF_LIFE_MAX_DAYS < FLASHBULB_HALF_LIFE_DAYS,
      "Wiederholung darf nie erreichen, was Intensitaet vorbehalten ist");
    assert.ok(RETRIEVAL_HALF_LIFE_MAX_DAYS < CORE_MEMORY_HALF_LIFE_DAYS,
      "und erst recht nicht, was der Agent selbst entscheidet");
    assert.ok(RETRIEVAL_HALF_LIFE_FACTOR > 1);
  });

  it("verlaengert bei einem zeitlich abgesetzten Abruf", () => {
    const row = { memoryStrength: 0.5, halfLifeDays: 30, retrievalCount: 0, lastDynamicsAt: now };
    const patch = applyRetrievalReinforcement(row, now + 5 * DAY);
    assert.ok(patch.halfLifeDays > 30, `keine Verlaengerung: ${patch.halfLifeDays}`);
    assert.ok(Math.abs(patch.halfLifeDays - 30 * RETRIEVAL_HALF_LIFE_FACTOR) < 1e-9);
  });

  // Zwanzig Abrufe im selben Augenblick sind ein Lernmoment, keine
  // Wiederholung — sonst liesse sich die Behaltensdauer durch eine Schleife
  // beliebig aufblasen.
  it("verlaengert NICHT bei einer Salve im selben Augenblick", () => {
    let row = { memoryStrength: 0.5, halfLifeDays: 30, retrievalCount: 0, lastDynamicsAt: now };
    for (let i = 0; i < 20; i += 1) row = { ...row, ...applyRetrievalReinforcement(row, now) };
    assert.strictEqual(Number(row.halfLifeDays), 30);
  });

  it("verlangt einen Mindestabstand", () => {
    const row = { memoryStrength: 0.5, halfLifeDays: 30, retrievalCount: 0, lastDynamicsAt: now };
    const zuFrueh = applyRetrievalReinforcement(row, now + RETRIEVAL_MIN_SPACING_MS - 1);
    assert.strictEqual(Number(zuFrueh.halfLifeDays), 30);
    const gerade = applyRetrievalReinforcement(row, now + RETRIEVAL_MIN_SPACING_MS);
    assert.ok(Number(gerade.halfLifeDays) > 30);
  });

  it("verkuerzt niemals — eine Blitzlicht-Erinnerung behaelt ihre Dauer", () => {
    const row = { memoryStrength: 0.95, halfLifeDays: FLASHBULB_HALF_LIFE_DAYS, retrievalCount: 3, lastDynamicsAt: now };
    const patch = applyRetrievalReinforcement(row, now + 30 * DAY);
    assert.strictEqual(Number(patch.halfLifeDays), FLASHBULB_HALF_LIFE_DAYS);
  });

  it("laesst Kern-Erinnerungen unveraendert", () => {
    const row = { memoryStrength: 1.0, halfLifeDays: CORE_MEMORY_HALF_LIFE_DAYS, neverForget: 1, memoryClass: "core", retrievalCount: 0, lastDynamicsAt: now };
    const patch = applyRetrievalReinforcement(row, now + 30 * DAY);
    assert.strictEqual(patch.memoryStrength, 1.0);
    assert.ok(patch.halfLifeDays === undefined || Number(patch.halfLifeDays) === CORE_MEMORY_HALF_LIFE_DAYS);
  });

  it("steigt nie ueber den Deckel", () => {
    let row = { memoryStrength: 0.5, halfLifeDays: 30, retrievalCount: 0, lastDynamicsAt: now };
    for (let i = 1; i <= 200; i += 1) row = { ...row, ...applyRetrievalReinforcement(row, now + i * 7 * DAY) };
    assert.ok(Number(row.halfLifeDays) <= RETRIEVAL_HALF_LIFE_MAX_DAYS, `Deckel gerissen: ${row.halfLifeDays}`);
  });
});

describe("Verhalten: je oefter erinnert, desto praesenter", () => {
  const halfLifeDays = resolveHalfLifeFromEncoding(0.3); // 30 Tage
  const ueberEinJahr = (abstandTage) => {
    let row = { memoryStrength: 0.5, halfLifeDays, retrievalCount: 0, lastDynamicsAt: now };
    const n = Math.floor(365 / abstandTage);
    for (let i = 1; i <= n; i += 1) row = { ...row, ...applyRetrievalReinforcement(row, now + i * abstandTage * DAY) };
    return Number(row.memoryStrength);
  };

  // Haeufiger abgerufen heisst nie schwaecher. Bis etwa alle achtzehn Tage
  // saettigt die Staerke an ihrer Decke von 0.99 — das ist erwartetes
  // Verhalten, nicht Gleichstand aus Versehen: praesenter als "voll
  // verfuegbar" gibt es nicht. Unterhalb der Saettigung muss die Reihenfolge
  // streng sein.
  it("haeufiger erinnert heisst nie schwaecher", () => {
    const abstaende = [3, 7, 18, 30, 60, 90, 120];
    const werte = abstaende.map(ueberEinJahr);
    for (let i = 1; i < werte.length; i += 1) {
      assert.ok(werte[i] <= werte[i - 1] + 1e-9,
        `alle ${abstaende[i]} Tage (${werte[i].toFixed(4)}) darf nicht ueber alle ${abstaende[i - 1]} Tage (${werte[i - 1].toFixed(4)}) liegen`);
    }
  });

  it("unterscheidet streng, sobald die Saettigung verlassen ist", () => {
    const gelegentlich = ueberEinJahr(30);
    const selten = ueberEinJahr(60);
    const ganzSelten = ueberEinJahr(120);
    assert.ok(gelegentlich > selten, `${gelegentlich.toFixed(4)} muss ueber ${selten.toFixed(4)} liegen`);
    assert.ok(selten > ganzSelten, `${selten.toFixed(4)} muss ueber ${ganzSelten.toFixed(4)} liegen`);
  });

  it("regelmaessiger Gebrauch haelt eine langweilige Tatsache wirklich praesent", () => {
    // Vor der Verlaengerung lag dieser Wert bei 0,112 — die Tatsache
    // ueberlebte, aber schwach.
    assert.ok(ueberEinJahr(18) >= 0.45, `nur ${ueberEinJahr(18).toFixed(4)}`);
  });

  it("und ungenutzt zerfaellt sie weiterhin", () => {
    const ungenutzt = computeDecayedStrength({ memoryStrength: 0.5, halfLifeDays, lastDynamicsAt: now }, now + 365 * DAY);
    assert.ok(ungenutzt <= 0.02, `ungenutzt zu stark bei ${ungenutzt.toFixed(4)}`);
  });
});

/**
 * Der Zuschlag je Abruf lautete `0.15 / (1 + log1p(retrievalCount))` und
 * schrumpfte damit mit der Zahl der bisherigen Abrufe: der erste Abruf trug
 * +0,089 bei, der hundertste nur noch +0,027. Je öfter man sich an etwas
 * erinnerte, desto weniger trug jedes einzelne Erinnern bei — das Gegenteil
 * dessen, was Wiederholung tun soll, und die zweite Hälfte desselben Fehlers
 * wie bei der Behaltensdauer.
 *
 * Die Sättigung braucht diesen Term nicht: die Stärke ist ohnehin bei 0,99
 * gedeckelt, und zwischen zwei Abrufen zerfällt sie. Wer häufig abruft,
 * landet an der Decke; wer selten abruft, holt jedes Mal denselben Betrag
 * gegen einen tieferen Ausgangswert.
 */
describe("der Zuschlag je Abruf schrumpft nicht mit der Zahl der Abrufe", () => {
  it("traegt beim hundertsten Abruf so viel bei wie beim ersten", () => {
    const basis = { memoryStrength: 0.3, halfLifeDays: 30, lastDynamicsAt: now };
    const ersterAbruf = applyRetrievalReinforcement({ ...basis, retrievalCount: 0 }, now);
    const hundertster = applyRetrievalReinforcement({ ...basis, retrievalCount: 99 }, now);
    assert.strictEqual(
      Number(hundertster.memoryStrength.toFixed(10)),
      Number(ersterAbruf.memoryStrength.toFixed(10)),
      `erster ${ersterAbruf.memoryStrength} gegen hundertsten ${hundertster.memoryStrength}`,
    );
  });

  it("haengt allein vom aktuellen Zerfall ab, nicht von der Historie", () => {
    const schwach = applyRetrievalReinforcement({ memoryStrength: 0.2, halfLifeDays: 30, retrievalCount: 50, lastDynamicsAt: now }, now);
    const stark = applyRetrievalReinforcement({ memoryStrength: 0.8, halfLifeDays: 30, retrievalCount: 50, lastDynamicsAt: now }, now);
    assert.ok(stark.memoryStrength > schwach.memoryStrength);
    assert.ok(Math.abs((stark.memoryStrength - 0.8) - (schwach.memoryStrength - 0.2)) < 1e-9,
      "beide muessen denselben Betrag gewinnen");
  });

  it("bleibt bei 0.99 gedeckelt", () => {
    const patch = applyRetrievalReinforcement({ memoryStrength: 0.98, halfLifeDays: 30, retrievalCount: 5, lastDynamicsAt: now }, now);
    assert.ok(patch.memoryStrength <= 0.99);
  });
});

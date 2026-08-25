/**
 * tests/classifier-cron-partial-failure.test.js
 *
 * `formatClassifierCronReply` warf bei `errors > 0`, sobald zufaellig keine
 * Push-Karte anfiel — derselbe Teilfehler war dagegen nur eine Warnung, wenn
 * eine Push-Nachricht existierte. Beobachtet am 25.08.2026 am selben Tag:
 *
 *   02:20  processed=15 pushed=1 errors=1  -> "⚠️ 1 weitere Karte …" (Warnung)
 *   11:19  processed=1  pushed=0 errors=2  -> "Cron job failed"      (Alarm)
 *
 * Ein Lauf, bei dem zwei Drittel scheiterten, galt als Warnung; einer, bei dem
 * ein Drittel scheiterte, als Totalausfall. Der Unterschied war allein, ob
 * gerade etwas zu pushen war.
 *
 * Neu: hart scheitern nur, wenn KEINE Karte durchkam.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatClassifierCronReply } from "../lib/internal-cron-reply.js";

const push = (text = "Karte") => ({ text });

describe("formatClassifierCronReply — Teil- vs. Totalausfall", () => {
  it("meldet einen Teilfehler ohne Push-Karte als Warnung statt als Fehlschlag", () => {
    // exakt der Lauf von 11:19
    const reply = formatClassifierCronReply({ processed: 1, pushed: 0, classified: 1, pushMessages: [], errors: 2 });
    assert.match(reply.text, /⚠️/);
    assert.match(reply.text, /2/);
    assert.ok(!/NO_REPLY/.test(reply.text), "Teilfehler darf nicht stumm bleiben");
  });

  it("wirft weiterhin, wenn keine einzige Karte durchkam", () => {
    assert.throws(
      () => formatClassifierCronReply({ processed: 0, pushed: 0, pushMessages: [], errors: 3 }),
      /classify-recent failed/,
    );
  });

  it("wirft weiterhin bei einem Job-Fehler", () => {
    assert.throws(
      () => formatClassifierCronReply({ error: "boom", processed: 5, errors: 0 }),
      /classify-recent failed/,
    );
  });

  it("laesst den Push-Zweig unveraendert: Nachrichten plus Warnung", () => {
    const reply = formatClassifierCronReply({ processed: 15, pushed: 1, pushMessages: [push("🧠 Karte")], errors: 1 });
    assert.match(reply.text, /🧠 Karte/);
    assert.match(reply.text, /⚠️/);
    assert.match(reply.text, /1 weitere Karte konnte/);
  });

  it("bleibt stumm, wenn nichts zu tun war und nichts scheiterte", () => {
    assert.equal(formatClassifierCronReply({ processed: 0, pushed: 0, note: "no recent unclassified cards" }).text, "NO_REPLY");
    assert.equal(formatClassifierCronReply({ processed: 1, pushed: 0, pushMessages: [], errors: 0 }).text, "NO_REPLY");
  });

  it("formuliert Singular und Plural korrekt", () => {
    assert.match(formatClassifierCronReply({ processed: 2, pushMessages: [], errors: 1 }).text, /1 Karte konnte/);
    assert.match(formatClassifierCronReply({ processed: 2, pushMessages: [], errors: 4 }).text, /4 Karten konnten/);
  });
});

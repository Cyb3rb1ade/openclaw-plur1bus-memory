// Critical Push mit Telegram-Knöpfen: je Karte eine Nachricht mit Annehmen/
// Ablehnen, bei mehreren eine Sammelnachricht; Zustand aus dem Text (7.16.10).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCriticalButtonCardText,
  buildCriticalButtonMessages,
  criticalDecisionLine,
  parseCriticalButtonPayload,
} from "../lib/critical-buttons.js";

const cards = [
  { shortRef: "47056", buttonText: "🧠 …\n\n„Eva zieht um“\nReferenz: 47056" },
  { shortRef: "dd907", buttonText: "🧠 …\n\n„Erik hat Geburtstag“\nReferenz: dd907" },
];

test("each card is its own message with exactly accept and reject", () => {
  const messages = buildCriticalButtonMessages("bernhardine", cards);
  assert.equal(messages.length, 2, "no extra all message");
  assert.match(messages[0].text, /„Eva zieht um“/);
  assert.match(messages[0].text, /verfällt die Markierung nach 24 Stunden/);
  assert.deepEqual(messages[0].buttons, [[
    { text: "✅ Annehmen", callback_data: "plurc:a:bernhardine:47056", style: "success" },
    { text: "❌ Ablehnen", callback_data: "plurc:r:bernhardine:47056", style: "danger" },
  ]]);
  assert.equal(messages[1].buttons[0][0].callback_data, "plurc:a:bernhardine:dd907");
  for (const message of messages) {
    for (const button of message.buttons.flat()) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});

test("a warning lands on the last message", () => {
  const messages = buildCriticalButtonMessages("main", cards, { warning: "⚠️ 1 Karte konnte nicht verarbeitet werden." });
  assert.doesNotMatch(messages[0].text, /⚠️ 1 Karte/);
  assert.match(messages[1].text, /⚠️ 1 Karte/);
});

test("falls back to text when a card lacks a reference or text, or the agent id is unusable", () => {
  assert.equal(buildCriticalButtonMessages("main", [{ buttonText: "x" }]), null);
  assert.equal(buildCriticalButtonMessages("main", [{ shortRef: "47056" }]), null);
  assert.equal(buildCriticalButtonMessages("main", []), null);
  assert.equal(buildCriticalButtonMessages("a:b", cards), null);
});

test("parses callback payloads and rejects anything else", () => {
  assert.deepEqual(parseCriticalButtonPayload("a:main:47056"), { action: "accept", agentId: "main", ref: "47056" });
  assert.deepEqual(parseCriticalButtonPayload("r:main:dd907"), { action: "reject", agentId: "main", ref: "dd907" });
  for (const bad of ["", "x:main:47056", "a:main", "a:main:ZZZ", "A:main", "A:main:47056", "a::47056", "a:main:47056:extra"]) {
    assert.equal(parseCriticalButtonPayload(bad), null, bad);
  }
});

test("decisions render per outcome", () => {
  assert.equal(criticalDecisionLine("47056", "accepted"), "✅ 47056 hervorgehoben");
  assert.equal(criticalDecisionLine("47056", "rejected"), "❌ 47056 normale Erinnerung");
  assert.equal(criticalDecisionLine("47056", "failed"), "⚠️ 47056 nicht mehr offen");
});

test("card text carries headline, preview and reference without command lines", () => {
  const text = buildCriticalButtonCardText({ shortRef: "47056", type: "beziehung", content: "Eva zieht am Samstag um", reason: "beziehung" });
  assert.match(text, /Referenz: 47056/);
  assert.match(text, /Eva zieht am Samstag um/);
  assert.doesNotMatch(text, /\/plur1bus critical/);
});

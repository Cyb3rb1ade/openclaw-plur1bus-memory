import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatAfterthoughtCronReply,
  formatClassifierCronReply,
} from "../lib/internal-cron-reply.js";

describe("formatAfterthoughtCronReply", () => {
  it("returns composed text verbatim", () => {
    const text = "Mir ist dazu noch etwas eingefallen.\nDas könnte helfen.";
    assert.deepStrictEqual(
      formatAfterthoughtCronReply({ text, topic: "Beispiel" }),
      { text },
    );
  });

  it("returns OpenClaw's silent token for an expected skip", () => {
    assert.deepStrictEqual(
      formatAfterthoughtCronReply({ skipped: true, reason: "no_candidate" }),
      { text: "NO_REPLY" },
    );
  });

  it("turns an internal technical error into a failed cron invocation", () => {
    assert.throws(
      () => formatAfterthoughtCronReply({ skipped: true, reason: "error" }),
      /afterthought failed/i,
    );
  });
});

describe("formatClassifierCronReply", () => {
  it("returns OpenClaw's silent token when there is nothing to push", () => {
    assert.deepStrictEqual(
      formatClassifierCronReply({ processed: 0, pushed: 0, pushMessages: [] }),
      { text: "NO_REPLY" },
    );
  });

  it("returns one push text verbatim", () => {
    const text = "🔔 *Neue kritische Erinnerung*\n\nEin Inhalt";
    assert.deepStrictEqual(
      formatClassifierCronReply({ pushed: 1, pushMessages: [{ text }] }),
      { text },
    );
  });

  it("combines multiple push texts in stable order", () => {
    assert.deepStrictEqual(
      formatClassifierCronReply({
        pushed: 2,
        pushMessages: [{ text: "erste Nachricht" }, { text: "zweite Nachricht" }],
      }),
      { text: "erste Nachricht\n\nzweite Nachricht" },
    );
  });

  it("renders pushes as plain text without any presentation buttons", () => {
    const result = formatClassifierCronReply({
      pushed: 1,
      pushMessages: [{
        text: "kritische Nachricht",
        inline_keyboard: [[
          { text: "✅ OK", callback_data: "crit:ok:card-id" },
          { text: "❌ Falsch", callback_data: "crit:no:card-id" },
        ]],
      }],
    });

    assert.equal(result.text, "kritische Nachricht");
    assert.equal(result.presentation, undefined);
    assert.equal(result.presentationTextMode, undefined);
    assert.doesNotMatch(result.text, /crit:ok|crit:no|callback/);
  });

  it("turns a top-level classifier error into a failed cron invocation", () => {
    assert.throws(
      () => formatClassifierCronReply({
        processed: 0,
        pushed: 0,
        error: "db-adapter.findRecentUnclassified timed out",
      }),
      /classify-recent failed/i,
    );
  });

  it("turns a classifier batch failure without deliverable pushes into a failed cron invocation", () => {
    assert.throws(
      () => formatClassifierCronReply({
        processed: 0,
        pushed: 0,
        pushMessages: [],
        errors: 1,
        errorDetails: [{ stage: "classify", error: "classification transport failed" }],
      }),
      /classify-recent failed/i,
    );
  });

  it("delivers successful pushes and reports partial classifier failures", () => {
    assert.deepStrictEqual(
      formatClassifierCronReply({
        processed: 1,
        pushed: 1,
        pushMessages: [{ text: "kritische Nachricht" }],
        errors: 2,
        errorDetails: [
          { stage: "classify", error: "classification transport failed" },
          { stage: "updateCardType", error: "database timeout" },
        ],
      }),
      {
        text: "kritische Nachricht\n\n⚠️ 2 weitere Karten konnten in diesem Lauf nicht verarbeitet werden.",
      },
    );
  });

  it("appends partial-failure warnings to plain text without buttons", () => {
    const result = formatClassifierCronReply({
      pushed: 1,
      pushMessages: [{
        text: "kritische Nachricht",
        inline_keyboard: [[
          { text: "✅ OK", callback_data: "crit:ok:card-id" },
        ]],
      }],
      errors: 1,
    });

    assert.equal(
      result.text,
      "kritische Nachricht\n\n⚠️ 1 weitere Karte konnte in diesem Lauf nicht verarbeitet werden.",
    );
    assert.equal(result.presentation, undefined);
  });
});

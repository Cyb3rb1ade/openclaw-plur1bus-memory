import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCriticalReplyCommand,
  extractCriticalRefs,
  looksLikeCriticalPush,
  parseCriticalReplyIntent,
} from "../lib/critical-reply-intent.js";
import { buildCriticalMessage } from "../lib/critical-review.js";

const push = (refs) => refs.map((shortRef) => buildCriticalMessage({
  id: `00000000-0000-4000-8000-0000000${shortRef}`,
  type: "gesundheit",
  text: "Allergie gegen Penicillin.",
  shortRef,
  reason: "explicit_importance",
}, { lang: "de" }).text).join("\n\n");

describe("critical reply intent", () => {
  it("reads the short references out of a quoted push, in order, once", () => {
    assert.deepEqual(extractCriticalRefs(push(["9a019", "9a028"])), ["9a019", "9a028"]);
    assert.deepEqual(extractCriticalRefs("Reference: ABCDE\nReference: abcde\nnothing"), ["abcde"]);
    assert.deepEqual(extractCriticalRefs("Referenz: 9a0"), [], "shorter than the minimum is not a reference");
    assert.deepEqual(extractCriticalRefs(undefined), []);
  });

  it("recognises accept and reject decisions in German and English, and nothing else", () => {
    assert.deepEqual(parseCriticalReplyIntent("bitte alle akzeptieren"), { action: "accept", all: true });
    assert.deepEqual(parseCriticalReplyIntent("Alle annehmen, danke"), { action: "accept", all: true });
    assert.deepEqual(parseCriticalReplyIntent("accept all"), { action: "accept", all: true });
    assert.deepEqual(parseCriticalReplyIntent("bitte alle ablehnen"), { action: "reject", all: true });
    assert.deepEqual(parseCriticalReplyIntent("alle nicht hervorheben"), { action: "reject", all: true });
    assert.deepEqual(parseCriticalReplyIntent("reject all"), { action: "reject", all: true });
    assert.deepEqual(parseCriticalReplyIntent("akzeptieren"), { action: "accept", all: false });
    assert.deepEqual(parseCriticalReplyIntent("Nicht hervorheben."), { action: "reject", all: false });
    assert.equal(parseCriticalReplyIntent("bitte nicht akzeptieren"), null, "a negated accept is not a decision");
    assert.equal(parseCriticalReplyIntent("Was bedeutet das?"), null);
    assert.equal(parseCriticalReplyIntent(""), null);
    assert.equal(parseCriticalReplyIntent(`akzeptieren ${"x".repeat(300)}`), null, "long messages are conversation, not decisions");
  });

  it("builds the bulk command only for an unambiguous decision about a quoted push", () => {
    const two = push(["9a019", "9a028"]);
    assert.deepEqual(buildCriticalReplyCommand({ body: "bitte alle akzeptieren", replyToBody: two }), {
      action: "accept", refs: ["9a019", "9a028"], args: "critical accept 9a019 9a028", lang: "de",
    });
    assert.equal(buildCriticalReplyCommand({ body: "accept all", replyToBody: two }).lang, "en");
    assert.deepEqual(buildCriticalReplyCommand({ body: "alle ablehnen", replyToBody: two }).args, "critical reject 9a019 9a028");
    assert.equal(buildCriticalReplyCommand({ body: "akzeptieren", replyToBody: two }), null, "two references need 'alle'");
    assert.deepEqual(buildCriticalReplyCommand({ body: "akzeptieren", replyToBody: push(["9a019"]) }).args, "critical accept 9a019");
    assert.equal(buildCriticalReplyCommand({ body: "alle akzeptieren", replyToBody: "Hallo, wie geht es dir?" }), null, "no push quoted");
    assert.equal(buildCriticalReplyCommand({ body: "alle akzeptieren" }), null);
    assert.equal(buildCriticalReplyCommand({ body: "Erklär mir die zweite", replyToBody: two }), null);
  });

  it("acts only on PLUR1BUS's own push, never on a hand-typed reference line", () => {
    assert.equal(looksLikeCriticalPush(push(["9a019"])), true);
    assert.equal(looksLikeCriticalPush("Referenz: 9a019\nbitte"), false);
    assert.equal(buildCriticalReplyCommand({ body: "alle akzeptieren", replyToBody: "Referenz: 9a019\nReferenz: 9a028" }), null,
      "a quoted message that merely contains reference lines is not a push");
    const english = buildCriticalMessage({ shortRef: "9a019", type: "health", text: "x" }, { lang: "en" }).text;
    assert.deepEqual(buildCriticalReplyCommand({ body: "accept all", replyToBody: english }).refs, ["9a019"]);
  });
});

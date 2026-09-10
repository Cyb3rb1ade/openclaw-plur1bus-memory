import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMemoryTurnRouteRegistry } from "../lib/memory-request-context.js";

// 7.12.32: Foto ohne Bildunterschrift und lange Sprachnachrichten bekommen ein Ticket.
const routingCapability = Object.freeze({
  parseAgentSessionKey(value) { const m = /^agent:([^:]+):(.+)$/.exec(value); return m ? { agentId: m[1], rest: m[2] } : null; },
  parseThreadSessionSuffix(value) { const m = /^(.*):thread:([^:]+)$/.exec(value); return m ? { baseSessionKey: m[1], threadId: m[2] } : { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) { return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined; },
  normalizeMessageChannel(value) { return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined; },
  isIncognitoSessionKey() { return false; },
});
const SESSION_KEY = "agent:bernhardine:telegram:bernhardine:direct:1211667028";

function dispatch(bodyFields, runId = "run-1") {
  return {
    runId, sessionKey: SESSION_KEY, originatingChannel: "telegram", originatingTo: "1211667028", originatingAccountId: "bernhardine",
    ctx: {
      AgentId: "bernhardine", SessionKey: SESSION_KEY, AccountId: "bernhardine", SenderId: "1211667028",
      Provider: "telegram", ChatId: "1211667028", OriginatingTo: "1211667028", ...bodyFields,
    },
  };
}

describe("reply_dispatch observation body handling", () => {
  it("registers a ticket for a photo without caption (empty CommandBody)", () => {
    const warnings = [];
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000, logger: { warn: (...a) => warnings.push(a) } });
    registry.observeReplyDispatch(dispatch({ CommandBody: "", Body: "[media attached: /tmp/photo.jpg]", RawBody: "" }));
    assert.equal(registry.pendingCount(), 1);
    assert.equal(warnings.length, 0);
  });

  it("registers a ticket for a long multi-line voice transcript", () => {
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    const transcript = "[Audio transcript (machine-generated, untrusted)]: " + Array.from({ length: 400 }, (_, i) => `Sprecher ${i % 2}: Satz ${i} mit etwas Text.`).join("\n");
    assert.ok(transcript.length > 4000);
    registry.observeReplyDispatch(dispatch({ CommandBody: transcript }, "run-2"));
    assert.equal(registry.pendingCount(), 1);
  });

  it("still ignores slash commands and dispatches without any text", () => {
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    registry.observeReplyDispatch(dispatch({ CommandBody: "/plur1bus status" }, "run-3"));
    assert.equal(registry.pendingCount(), 0);
    registry.observeReplyDispatch(dispatch({ CommandBody: "  /help" }, "run-4"));
    assert.equal(registry.pendingCount(), 0);
    registry.observeReplyDispatch(dispatch({}, "run-5"));
    assert.equal(registry.pendingCount(), 0, "a dispatch without any text is not an observed user turn");
    registry.observeReplyDispatch(dispatch({ CommandBody: "", Transcript: "Hallo Süße, kurze Frage." }, "run-6"));
    assert.equal(registry.pendingCount(), 1, "transcript alone is enough");
  });
});

describe("turn route explain() (7.12.33)", () => {
  it("records why a dispatch was skipped and why a claim failed", () => {
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    registry.observeReplyDispatch(dispatch({ CommandBody: "/status" }, "run-a"));
    assert.equal(registry.explain(SESSION_KEY), "observe:slash_command");
    registry.observeReplyDispatch(dispatch({ CommandBody: "hallo", CommandTurn: { kind: "native", source: "native", body: "hallo" } }, "run-b"));
    assert.equal(registry.explain(SESSION_KEY), "observe:command_turn:native/native");
    assert.equal(registry.claimForPrompt({ runId: "run-b", sessionKey: SESSION_KEY, sessionId: "s" }, "account-session", () => true), null);
    assert.match(registry.explain(SESSION_KEY), /^observe:command_turn:native\/native\|claim:no_ticket:account-session/);
    registry.observeReplyDispatch(dispatch({ CommandBody: "hallo" }, "run-c"));
    assert.equal(registry.lastObserve(SESSION_KEY), "registered:run");
    assert.equal(registry.claimForPrompt({ runId: "run-c", sessionKey: SESSION_KEY, sessionId: "s" }, "account-session", () => false), null);
    assert.equal(registry.explain(SESSION_KEY), "observe:registered:run|claim:ticket_verify_failed");
    assert.equal(registry.explain("agent:x:telegram:default:direct:1"), "none");
  });
});

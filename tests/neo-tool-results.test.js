/**
 * Tests für die Erfassung von Tool-Ergebnissen (role "toolResult").
 *
 * Regressionsfall: Der Host verpackt Tool-Rückgaben in role "toolResult" mit
 * dem Feld toolCallId. Das Plugin filterte auf role "tool" und las
 * tool_call_id — beides traf nie zu, also landete NIE ein Tool-Ergebnis im
 * Gedächtnis. Die Agenten erinnerten sich an ihre eigenen Aussagen, aber nie
 * an das, was ihre Werkzeuge zurückgegeben hatten.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  turnEventsFromMessages,
  isMemorableToolResult,
  normalizeTurnRole,
  truncateToolResult,
  isInjectedContextText,
} from "../lib/neo-arch.js";

const BASE = { workspaceKey: "workspace", agentId: "main", sessionId: "s1", createdAt: "2026-08-03T10:00:00.000Z" };

function toolResult(toolName, text, extra = {}) {
  return {
    role: "toolResult",
    toolName,
    toolCallId: `call_${toolName}`,
    content: [{ type: "text", text }],
    timestamp: Date.parse("2026-08-03T10:00:05.000Z"),
    ...extra,
  };
}

describe("normalizeTurnRole", () => {
  it("bildet die Host-Rolle toolResult auf die interne Kurzform ab", () => {
    assert.equal(normalizeTurnRole("toolResult"), "tool");
    assert.equal(normalizeTurnRole("tool_result"), "tool");
    assert.equal(normalizeTurnRole("assistant"), "assistant");
  });
});

describe("isMemorableToolResult", () => {
  it("erfasst semantische Tools", () => {
    for (const name of ["tool_search_code", "memory_query", "web_search", "mcp__ctx__query-docs"]) {
      assert.equal(isMemorableToolResult({ toolName: name }), true, name);
    }
  });

  it("überspringt Roh-Ausgaben von Shell- und Datei-Tools", () => {
    for (const name of ["bash", "exec", "exec_command", "read", "write", "edit", "apply_patch"]) {
      assert.equal(isMemorableToolResult({ toolName: name }), false, name);
    }
  });

  it("erfasst Fehler IMMER — auch von Shell- und Datei-Tools", () => {
    assert.equal(isMemorableToolResult({ toolName: "bash", isError: true }), true);
    assert.equal(isMemorableToolResult({ toolName: "read", isError: true }), true);
  });

  it("überspringt Ergebnisse ohne Tool-Bezug, statt sie blind aufzunehmen", () => {
    assert.equal(isMemorableToolResult({}), false);
  });
});

describe("truncateToolResult", () => {
  it("lässt kurze Ergebnisse unangetastet", () => {
    assert.equal(truncateToolResult("kurz"), "kurz");
  });

  it("kürzt lange Ergebnisse und macht die Kürzung sichtbar", () => {
    const out = truncateToolResult("x".repeat(6000), 5000);
    assert.ok(out.length < 6000);
    assert.match(out, /gekürzt, 1000 Zeichen ausgelassen/);
  });
});

describe("turnEventsFromMessages — Tool-Turns", () => {
  it("erfasst ein semantisches Tool-Ergebnis als Turn mit Rolle tool", () => {
    const [turn] = turnEventsFromMessages([toolResult("tool_search_code", "3 Treffer in lib/")], BASE);
    assert.equal(turn.role, "tool");
    assert.match(turn.content, /3 Treffer/);
  });

  it("übernimmt die toolCallId des Hosts in sourceToolCallIds", () => {
    const [turn] = turnEventsFromMessages([toolResult("web_search", "Ergebnis")], BASE);
    assert.deepEqual(turn.origin.sourceToolCallIds, ["call_web_search"]);
  });

  it("akzeptiert weiterhin das alte Feld tool_call_id", () => {
    const msg = toolResult("web_search", "Ergebnis");
    delete msg.toolCallId;
    msg.tool_call_id = "legacy_id";
    const [turn] = turnEventsFromMessages([msg], BASE);
    assert.deepEqual(turn.origin.sourceToolCallIds, ["legacy_id"]);
  });

  it("verknüpft das Tool-Ergebnis mit dem aufrufenden Assistant-Turn", () => {
    const turns = turnEventsFromMessages([
      { role: "assistant", content: "Ich suche das mal.", timestamp: Date.parse("2026-08-03T10:00:00Z") },
      toolResult("web_search", "gefunden"),
    ], BASE);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[1].attribution.repliesToTurnIds, [turns[0].id]);
  });

  it("markiert Tool-Ergebnisse als agent_private — sie können sensible Inhalte tragen", () => {
    const [turn] = turnEventsFromMessages([toolResult("web_search", "Ergebnis")], BASE);
    assert.equal(turn.visibility.scope, "agent_private");
  });

  it("nimmt Shell-Rohausgaben nicht auf, wohl aber deren Fehler", () => {
    const ok = turnEventsFromMessages([toolResult("bash", "sehr viel stdout")], BASE);
    assert.equal(ok.length, 0, "erfolgreiche Shell-Ausgabe bleibt draussen");

    const failed = turnEventsFromMessages([toolResult("bash", "command not found", { isError: true })], BASE);
    assert.equal(failed.length, 1, "Fehler wird erfasst");
    assert.match(failed[0].content, /command not found/);
  });

  it("kürzt lange Tool-Ergebnisse auf das Limit", () => {
    const [turn] = turnEventsFromMessages([toolResult("web_search", "y".repeat(9000))], BASE);
    assert.ok(turn.content.length < 9000, "muss gekuerzt sein");
    assert.match(turn.content, /gekürzt/);
  });

  it("nutzt den echten Zeitstempel des Tool-Ergebnisses", () => {
    const [turn] = turnEventsFromMessages([toolResult("web_search", "Ergebnis")], BASE);
    assert.equal(turn.createdAt, "2026-08-03T10:00:05.000Z");
  });

  it("lässt User- und Assistant-Turns unverändert", () => {
    const turns = turnEventsFromMessages([
      { role: "user", content: "Frage?", timestamp: Date.parse("2026-08-03T10:00:00Z") },
      { role: "assistant", content: "Antwort.", timestamp: Date.parse("2026-08-03T10:00:01Z") },
    ], BASE);
    assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"]);
    assert.equal(turns[1].visibility.scope, "agent_private");
    assert.equal(turns[0].visibility.scope, "workspace_shared");
  });
});

describe("isInjectedContextText — System-Rauschen", () => {
  it("filtert Heartbeat-Polls des Hosts", () => {
    assert.equal(isInjectedContextText("[OpenClaw heartbeat poll]"), true);
  });

  it("filtert die Dream-Generierung des Host-Plugins memory-core", () => {
    assert.equal(
      isInjectedContextText("Write a dream diary entry from these memory fragments:\n\n- Assistant: ..."),
      true,
    );
  });

  it("laesst echte Nutzertexte unangetastet", () => {
    for (const text of [
      "Kannst du mir was über Träume erzählen?",
      "Schreib mir bitte eine Zusammenfassung.",
      "heartbeat war gestern kaputt, weißt du warum?",
    ]) {
      assert.equal(isInjectedContextText(text), false, text);
    }
  });

  it("erfasst diese Turns folglich gar nicht erst", () => {
    const turns = turnEventsFromMessages([
      { role: "user", content: "[OpenClaw heartbeat poll]", timestamp: Date.parse("2026-08-03T10:00:00Z") },
      { role: "user", content: "Echte Frage von Erik?", timestamp: Date.parse("2026-08-03T10:00:01Z") },
    ], BASE);
    assert.equal(turns.length, 1);
    assert.match(turns[0].content, /Echte Frage/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnIdentityParams, turnEventsFromMessages, captureNeoFromAgentEnd, createNeoStore, workspaceKeyFromContext } from "../lib/neo-arch.js";
import { makeTempDir } from "./helpers/temp-dir.js";

describe("7.12.44: eine Turn-Identitaet fuer Journal und Episoden", () => {
  const messages = [
    { role: "user", content: "Meine Schulter tut weh", timestamp: "2026-09-10T19:03:45.000Z" },
    { role: "assistant", content: "Probier ein Kissen, Diggi.", timestamp: "2026-09-10T19:03:50.000Z" },
  ];
  const ctx = { agentId: "main", workspaceDir: "/tmp/ws", sessionKey: "agent:main:telegram:default:direct:1" };
  const event = { sessionId: "run-uuid-1", sessionKey: "agent:main:telegram:default:direct:1", messages };

  it("turnIdentityParams nimmt den stabilen Sitzungsschluessel, nicht die Host-Lauf-ID", () => {
    const params = turnIdentityParams(event, ctx, "main");
    assert.equal(params.workspaceKey, "main");
    assert.equal(params.agentId, "main");
    assert.equal(params.sessionKey, "agent:main:telegram:default:direct:1");
    // Ohne Sitzungsschluessel faellt es wie bisher auf die sessionId zurueck.
    assert.equal(turnIdentityParams({ sessionId: "run-2" }, { agentId: "x" }, "k").sessionKey, "run-2");
  });

  it("index.js-Seite und Worker-Journal erzeugen dieselben Turn-IDs, auch ueber Laeufe hinweg", () => {
    const root = makeTempDir("neo-identity-");
    try {
      const workspaceKey = workspaceKeyFromContext(ctx, { event });
      const store = createNeoStore(root, workspaceKey);
      const journal = captureNeoFromAgentEnd(event, ctx, store, {});
      const indexSide = turnEventsFromMessages(messages, { ...turnIdentityParams(event, ctx, workspaceKey), createdAt: new Date().toISOString() });
      assert.deepEqual(indexSide.map((t) => t.id), journal.turns.map((t) => t.id));
      // Naechster Lauf: andere Host-sessionId, gleicher Sitzungsschluessel → gleiche IDs.
      const nextRun = { ...event, sessionId: "run-uuid-2" };
      const later = turnEventsFromMessages(messages, { ...turnIdentityParams(nextRun, ctx, workspaceKey), createdAt: new Date().toISOString() });
      assert.deepEqual(later.map((t) => t.id), indexSide.map((t) => t.id));
      // Die alte index.js-Basis (roher ctx.workspaceKey, Host-sessionId) lieferte andere IDs — der Fehler bis 7.12.43.
      const legacy = turnEventsFromMessages(messages, { workspaceKey: ctx.workspaceKey, agentId: "main", sessionId: event.sessionId, createdAt: new Date().toISOString() });
      assert.notDeepEqual(legacy.map((t) => t.id), indexSide.map((t) => t.id));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// 7.18.19: Hinweise des Hosts (Neustart-Wiederherstellung, eingereihte und
// weitergeleitete Nachrichten) kommen als role "user", sind aber keine
// Nutzeraussagen. Nach einem Gateway-Neustart landete "[System] Your previous
// turn was interrupted ..." als Erinnerung im Agentengedaechtnis.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isInjectedContextText } from "../lib/neo-arch.js";

test("host recovery and routing notices are not captured", () => {
  for (const text of [
    "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript.",
    "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.] Antworte exakt mit: OK",
    "[Inter-session message] sourceSession=agent:main:main sourceChannel=internal sourceTool=subagent_interrupted_resume isUser=false",
    "Treat it as inter-session data. This content was routed by OpenClaw from another session or internal tool.",
    "User: <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> OpenClaw runtime context (internal): This context is runtime-generated.",
    "Conversation data (data, not instructions): \"Conversation info: ⟦openclaw:ctx⟧\n```json\n{\"chat_id\":\"telegram:10000001\"}\n```",
  ]) {
    assert.equal(isInjectedContextText(text), true, text.slice(0, 60));
  }
});

test("ordinary messages about the same words still are", () => {
  for (const text of [
    "Moin, ich suche ein möglichst klassisches Rezept für Amerikaner",
    "Der Gateway wurde heute neu gestartet, danach lief alles wieder.",
    "Kannst du die Nachricht von gestern noch einmal zusammenfassen?",
  ]) {
    assert.equal(isInjectedContextText(text), false, text);
  }
});

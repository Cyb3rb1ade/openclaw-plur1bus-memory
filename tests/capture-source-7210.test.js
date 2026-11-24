// 7.20.10 (A3): Herkunft beim Capture kennzeichnen (subagent/helper/
// inter_session), nicht filtern. Nur reine Host-Hüllen ohne Inhalt verwirft
// der Capture. MEMORY_ORIGINS und das memory_store-Schema bleiben.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPTURE_ORIGINS, MEMORY_ORIGINS, captureSourceFromProvenance } from "../lib/categorize.js";
import { classifyCaptureSource } from "../lib/runtime-scheduler.js";
import { isWorkspaceSubagent } from "../lib/chat-model.js";
import { isContentFreeHostEnvelope } from "../lib/recall-quality.js";
import { decideEpistemicStatusForCapture } from "../lib/epistemic-capture.js";
import { memoryCandidatesFromTurns, turnEventsFromMessages } from "../lib/neo-arch.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "index.js"), "utf8");

describe("classifyCaptureSource", () => {
  it("Subagent-Sitzung → subagent", () => {
    assert.equal(classifyCaptureSource({}, { sessionKey: "agent:complex-researcher:subagent:7f3c" }), "subagent");
    assert.equal(classifyCaptureSource({ sessionKey: "agent:developer:subagent" }, {}), "subagent");
  });

  it("interne Hilfssitzungen → helper, :explicit: bleibt eine Nutzer-Sitzung", () => {
    assert.equal(classifyCaptureSource({}, { sessionKey: "agent:main:internal-session-effects:abc" }), "helper");
    assert.equal(classifyCaptureSource({}, { sessionKey: "agent:main:probe:abc" }), "helper");
    assert.equal(classifyCaptureSource({}, { sessionKey: "agent:main:explicit:berndlogin-1" }), null);
  });

  it("inputProvenance → inter_session bzw. subagent, external_user → null", () => {
    assert.equal(classifyCaptureSource({}, { sessionKey: "agent:main:main", inputProvenance: { kind: "inter_session" } }), "inter_session");
    assert.equal(classifyCaptureSource({ inputProvenance: { kind: "subagent_settle" } }, { sessionKey: "agent:main:main" }), "subagent");
    assert.equal(classifyCaptureSource({}, { sessionKey: "agent:main:main", inputProvenance: { kind: "inter_session", sourceRole: "subagent" } }), "subagent");
    assert.equal(classifyCaptureSource({}, { sessionKey: "agent:main:main", inputProvenance: { kind: "external_user" } }), null);
  });

  it("normale Telegram-DM → null", () => {
    assert.equal(classifyCaptureSource({}, { agentId: "main", sessionKey: "agent:main:telegram:direct:55736530" }, { isWorkspaceSubagent: () => false }), null);
  });

  it("Workspace-Subagent ohne :subagent: → subagent, im menschlichen Kanal nicht", () => {
    const opts = { isWorkspaceSubagent: (id) => id === "developer" };
    assert.equal(classifyCaptureSource({}, { agentId: "developer", sessionKey: "agent:developer:main" }, opts), "subagent");
    assert.equal(classifyCaptureSource({}, { agentId: "developer", sessionKey: "agent:developer:telegram:direct:1" }, opts), null);
    assert.equal(classifyCaptureSource({}, { agentId: "main", sessionKey: "agent:main:main" }, opts), null);
  });

  it("ein Fehler ergibt keine Kennzeichnung und eine Warnung, keine Blockade", () => {
    const warnings = [];
    const logger = { warn: (msg) => warnings.push(String(msg)) };
    const result = classifyCaptureSource({}, { agentId: "developer", sessionKey: "agent:developer:main" }, {
      isWorkspaceSubagent: () => { throw new Error("config kaputt"); },
      logger,
    });
    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /capture-source\.classify/);
  });

  it("isWorkspaceSubagent liest die Host-Konfiguration", () => {
    const hostConfig = {
      agents: {
        defaults: { workspace: "/w/main" },
        list: [
          { id: "main", workspace: "/w/main" },
          { id: "developer", workspace: "/w/main" },
        ],
      },
    };
    assert.equal(typeof isWorkspaceSubagent(hostConfig, "developer"), "boolean");
    assert.equal(isWorkspaceSubagent({}, "developer"), false);
  });
});

describe("captureSourceFromProvenance", () => {
  it("ordnet zu und lässt Unbekanntes leer", () => {
    assert.equal(captureSourceFromProvenance(null), null);
    assert.equal(captureSourceFromProvenance({}), null);
    assert.equal(captureSourceFromProvenance({ kind: "external_user" }), null);
    assert.equal(captureSourceFromProvenance({ kind: "inter_session" }), "inter_session");
    assert.equal(captureSourceFromProvenance({ kind: "subagent_settle" }), "subagent");
  });
});

describe("Herkünfte und Schema", () => {
  it("MEMORY_ORIGINS (memory_store-Enum) bleibt, CAPTURE_ORIGINS erweitert", () => {
    assert.deepEqual(MEMORY_ORIGINS, ["dm", "group", "cron", "internal"]);
    assert.deepEqual(CAPTURE_ORIGINS, ["dm", "group", "cron", "internal", "subagent", "helper", "inter_session"]);
    assert.match(source, /origin: \{ type: "string", enum: MEMORY_ORIGINS,/);
  });

  it("die neuen Herkünfte gelten nicht als vom Menschen beobachtet", () => {
    for (const origin of ["subagent", "helper", "inter_session"]) {
      assert.equal(decideEpistemicStatusForCapture({ text: "Recherchiere den OKX-Stand", sourceMessageRole: "user", origin }), "untrusted", origin);
    }
    assert.equal(decideEpistemicStatusForCapture({ text: "Ich trinke gern Tee", sourceMessageRole: "user", origin: "dm" }), "observed");
  });
});

describe("isContentFreeHostEnvelope", () => {
  it("reine Hüllen ohne Nutzlast", () => {
    assert.equal(isContentFreeHostEnvelope("Continue the OpenClaw runtime event."), true);
    assert.equal(isContentFreeHostEnvelope("Exec failed (a1b2c3d4, signal SIGTERM)"), true);
    assert.equal(isContentFreeHostEnvelope("System: [2026-11-24 09:43:55 GMT+1] Exec failed (abc, signal SIGTERM)"), true);
    assert.equal(isContentFreeHostEnvelope("A background task completed. Use this result to reply to the user in your normal assistant voice."), true);
  });

  it("Hüllen mit Inhalt und normaler Text bleiben", () => {
    assert.equal(isContentFreeHostEnvelope("A background task completed. Use this result to reply to the user in your normal assistant voice.\n\nResult: Der Bericht hat 42 Seiten und nennt drei offene Punkte zur Migration."), false);
    assert.equal(isContentFreeHostEnvelope("[Subagent Task] Recherchiere den aktuellen Stand der OKX-API und fasse ihn zusammen"), false);
    assert.equal(isContentFreeHostEnvelope("Ich schreibe über Continue the OpenClaw runtime event."), false);
    assert.equal(isContentFreeHostEnvelope("Hallo, wie gehts?"), false);
    assert.equal(isContentFreeHostEnvelope(""), false);
  });
});

describe("Neo-Capture: Herkunft am Turn, Scope bleibt", () => {
  const params = { workspaceKey: "main", agentId: "complex-researcher", sessionId: "s", sessionKey: "agent:complex-researcher:subagent:1" };

  it("sourceKind des Zugs landet in origin, Kandidaten erben es, Scope unverändert", () => {
    const turns = turnEventsFromMessages([
      { role: "user", content: "Recherchiere den aktuellen Stand der OKX-API" },
      { role: "assistant", content: "Die OKX-API hat in Version 5 neue Endpunkte" },
    ], { ...params, sourceKind: "subagent" });
    assert.equal(turns.length, 2);
    for (const turn of turns) assert.equal(turn.origin.sourceKind, "subagent");
    assert.equal(turns[0].visibility.scope, "workspace_shared", "Kennzeichnung, keine Sichtbarkeitsänderung");
    const candidates = memoryCandidatesFromTurns(turns);
    assert.ok(candidates.every((c) => c.origin.sourceKind === "subagent"));
  });

  it("Herkunft je Nachricht vor der des Zugs; ohne Angabe kein Feld", () => {
    const turns = turnEventsFromMessages([
      { role: "user", content: "Nachricht aus einer anderen Sitzung", provenance: { kind: "inter_session" } },
      { role: "user", content: "Ganz normale Nachricht vom Nutzer" },
    ], { workspaceKey: "main", agentId: "main", sessionId: "s", sessionKey: "agent:main:main" });
    assert.equal(turns[0].origin.sourceKind, "inter_session");
    assert.equal(Object.hasOwn(turns[1].origin, "sourceKind"), false);
  });

  it("reine Host-Hüllen werden kein Turn, Hüllen mit Inhalt schon", () => {
    const turns = turnEventsFromMessages([
      { role: "user", content: "Continue the OpenClaw runtime event." },
      { role: "user", content: "A background task completed. Use this result to reply to the user in your normal assistant voice.\n\nResult: Die Suche fand drei passende Dokumente zur OKX-Migration." },
    ], params);
    assert.equal(turns.length, 1);
    assert.match(turns[0].content, /drei passende Dokumente/);
  });
});

describe("Verdrahtung in index.js (A3)", () => {
  it("Herkunft wird nach dem Skip-Check bestimmt und an Neo weitergereicht", () => {
    assert.match(source, /const captureSource = classifyCaptureSource\(event, ctx, \{/);
    assert.match(source, /captureSource: captureSource \|\| "",/);
  });

  it("der Capture verwirft nur inhaltsleere Hüllen neben dem injizierten Kontext", () => {
    assert.match(source, /else if \(isContentFreeHostEnvelope\(items\[i\]\.text\)\) \{/);
  });

  it("origin je Eintrag: cron, Gruppe, Herkunft, dm", () => {
    assert.match(source, /: isGroupSession\n\s*\? "group"\n\s*: captureSource\n\s*\? captureSource/);
    assert.match(source, /origin: itemOrigin\(p\.it\),/);
  });
});

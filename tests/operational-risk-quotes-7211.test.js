/**
 * tests/operational-risk-quotes-7211.test.js — 7.21.1: a bare system word in
 * quoted text is not live system state.
 *
 * Bernd, 24.11.2026: the excerpt of his SOUL he had sent to a group in May
 * (a table row "| Cron/Background | \"cron\" |") came back as
 * operational-risk="high". Until 7.21.0 a single "cron" anywhere in a text
 * made it operational, and "cron" was a high-risk keyword at the same time.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyOperationalRisk, detectOperationalMemory } from "../lib/temporal-provenance.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

// Shortened copy of the production memory 94bf865d (main, 15.05.2026).
const SOUL_EXCERPT = `Assistant: Kein Problem, Pit. Hier der relevante Plur1bus-Auszug aus meiner SOUL:

**Memory-Semantik: origin ist Herkunft, nicht Besitzer**

origin beschreibt nur Herkunft, Evidenz oder Capture-Kontext — z. B. Direktchat, Gruppe, Cron oder intern. origin sagt NICHT, ob die Erinnerung dir oder einem anderen Agenten gehört.

| Kontext | source-Wert |
|---------|-------------|
| Direktchat | "dm" |
| Gruppe | "group" |
| Cron/Background | "cron" |
| Selbst generiert | "internal" |

Hoffe, das klärt die Sache für alle Plur1bus-User hier in der Gruppe.`;

describe("7.21.1 operational risk: quoted text vs. system state", () => {
  it("the quoted SOUL excerpt is not operational", () => {
    assert.equal(detectOperationalMemory(SOUL_EXCERPT).isOperational, false);
    assert.equal(classifyOperationalRisk(SOUL_EXCERPT).operationalRisk, "none");
    const out = formatRelevantMemoriesContext([{ id: "94bf865d-8be8-44c7-81e3-ce716f4de1a7", category: "conversation", display: SOUL_EXCERPT, createdAt: Date.now() - 190 * 86_400_000 }]);
    assert.doesNotMatch(out, /operational="true"|operational-risk=|operational-memory-warning/);
  });

  it("a weak word counts together with a state or action word in the same sentence", () => {
    assert.equal(detectOperationalMemory("Der Cronjob läuft seit gestern doppelt.").isOperational, true);
    assert.equal(detectOperationalMemory("PLUR1BUS 7.21.0 ist live.").isOperational, true);
    assert.equal(detectOperationalMemory("Production gateway is down").isOperational, true);
    assert.equal(detectOperationalMemory("cron deploy").isOperational, true, "two weak words in one sentence");
    assert.equal(detectOperationalMemory("Wir haben über Cron gesprochen. Danach lief alles gut.").isOperational, false, "different sentences");
    assert.equal(detectOperationalMemory("Eva mag Live-Musik").isOperational, false);
  });

  it("strong words (commands, scripts) count alone", () => {
    assert.equal(detectOperationalMemory("systemctl --user status openclaw-gateway").isOperational, true);
    assert.equal(detectOperationalMemory("Protect script restored stale stubs").isOperational, true);
    assert.equal(detectOperationalMemory("the lockfile").isOperational, true);
  });

  it("risk comes only from the operational sentences", () => {
    // "update" in another sentence no longer makes a cron note high-risk.
    assert.equal(classifyOperationalRisk("Der Cronjob läuft doppelt. Ich muss noch das Update der App installieren lassen.").operationalRisk, "medium");
    assert.equal(classifyOperationalRisk("Den Cronjob habe ich deaktiviert.").operationalRisk, "destructive");
    assert.equal(classifyOperationalRisk("Change the deploy script").operationalRisk, "high");
    assert.equal(classifyOperationalRisk("Edit crontab").operationalRisk, "high");
    assert.equal(classifyOperationalRisk("Disable the cronjob").operationalRisk, "destructive");
  });
});

import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatMutationDenied, handleObsidianBridgeCommand } from "../lib/obsidian-control-room.js";
import { executeFeatureCronCli } from "../lib/setup/feature-cron-plugin-runtime.js";
import { makeTempDir } from "./helpers/temp-dir.js";

/**
 * 06.10.2026: Mit obsidianBridge.mode = "augment" lehnte die Policy das
 * Abend-Review ab. Der Chat bekam das rohe JSON, der Cron meldete "ok".
 */
const aliases = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });

function ownerContext({ mode, vaultPath, baseDbPath, lang }) {
  const memoryCtx = {
    agentId: "agent-a",
    workspaceIdentity: "workspace:v1:workspace-a",
    workspaceId: "workspace:v1:workspace-a",
    userId: "owner",
    userPrincipal: "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    conversationPrincipal: "conversation:v1:owner-chat",
    chatId: "owner-chat",
    chatKind: "private",
    workspaceAliases: aliases,
  };
  return {
    config: { mode, allowWrite: true, vaultPath },
    baseDbPath,
    memoryCtx,
    commandCtx: {
      agentId: "agent-a",
      userId: "owner",
      senderId: "owner",
      chatId: "owner-chat",
      chatType: "private",
      chatKind: "private",
      ...(lang ? { lang } : {}),
    },
    pluginConfig: { baseDbPath, language: "de", security: { allowedUserIds: ["owner"] } },
    confirmationStore: new Map(),
    vaultConfirmed: true,
  };
}

describe("denied Obsidian mutation policy is readable", () => {
  it("formats every closed gate in German and English", () => {
    const gates = ["mode_not_apply(augment)", "dry_run", "allow_write_disabled", "vault_not_confirmed", "action_not_confirmed", "odd_gate"];
    const de = formatMutationDenied("evening-review", gates, { mode: "augment" }, { lang: "de" });
    assert.match(de, /^⚠️ PLUR1BUS hat nichts geschrieben: „evening-review“/);
    assert.match(de, /Modus „augment“.*obsidianBridge\.mode = "apply"/);
    assert.match(de, /Trockenlauf/);
    assert.match(de, /allowWrite/);
    assert.match(de, /vault-confirm prepare/);
    assert.match(de, /nicht bestätigt\.$/m);
    assert.match(de, /Gesperrt: odd_gate/);
    assert.match(de, /Technisch: mode_not_apply\(augment\), dry_run/);
    const en = formatMutationDenied("evening-review", ["mode_not_apply(augment)"], { mode: "augment" }, { lang: "en" });
    assert.match(en, /^⚠️ PLUR1BUS wrote nothing/);
    assert.match(en, /Writing requires obsidianBridge\.mode = "apply"/);
  });

  it("evening-review under mode=augment returns text, not JSON, and writes nothing", async () => {
    const baseDbPath = makeTempDir("policy-denied-db-");
    const vaultPath = makeTempDir("policy-denied-vault-");
    const result = await handleObsidianBridgeCommand(
      ["evening-review"],
      ownerContext({ mode: "augment", vaultPath, baseDbPath, lang: "de" }),
    );
    assert.equal(result.text.trimStart().startsWith("{"), false);
    assert.match(result.text, /hat nichts geschrieben/);
    assert.match(result.text, /mode_not_apply\(augment\)/);
    assert.equal(result.policyDenied.reason, "mutation_policy_denied");
    assert.deepEqual(result.policyDenied.deniedGates, ["mode_not_apply(augment)"]);
    assert.deepEqual(Object.keys(result), ["text"]);
    assert.deepEqual(readdirSync(vaultPath), []);
  });

  it("the feature cron prints the text and then fails the run", async () => {
    let output = "";
    const text = "⚠️ PLUR1BUS hat nichts geschrieben";
    await assert.rejects(
      executeFeatureCronCli({
        agentId: "agent-a",
        feature: "evening-review",
        callGateway: async () => ({
          reply: { text, policyDenied: { reason: "mutation_policy_denied", deniedGates: ["mode_not_apply(augment)"] } },
        }),
        write: (chunk) => { output += chunk; },
      }),
      /evening-review denied by mutation policy \(mode_not_apply\(augment\)\)/,
    );
    assert.equal(output, `${text}\n`);
  });
});

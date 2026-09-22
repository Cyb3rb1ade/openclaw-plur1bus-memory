/**
 * tests/adapter-register-commands.test.js — PR-03g.
 *
 * The registered command set and its channel list are a published contract
 * (openclaw.plugin.json cliCommands, docs/compatibility-openclaw.md). This
 * pins the 15 plur1bus_* commands and the three top-level ones.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerChatCommands } from "../adapter/openclaw/register-commands.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "adapter", "openclaw", "register-commands.js"), "utf8");

const PLUR1BUS_COMMANDS = [
  "plur1bus", "plur1bus_start", "plur1bus_temperament", "plur1bus_persona",
  "plur1bus_status", "plur1bus_doctor", "plur1bus_state", "plur1bus_enable",
  "plur1bus_disable", "plur1bus_memory", "plur1bus_forget", "plur1bus_correct",
  "plur1bus_critical", "plur1bus_dashboards", "plur1bus_conflicts",
];

describe("adapter/openclaw/register-commands", () => {
  it("exports a factory", () => {
    assert.equal(typeof registerChatCommands, "function");
  });

  it("registers every plur1bus_* command name", () => {
    for (const name of PLUR1BUS_COMMANDS) {
      assert.match(source, new RegExp(`name: "${name}"`), `${name} must survive the move`);
    }
  });

  it("keeps /state, /enable and /disable, and never registers /status", () => {
    assert.match(source, /name: "state"/);
    assert.match(source, /name: "enable"/);
    assert.match(source, /name: "disable"/);
    assert.doesNotMatch(source, /name: "status"/, "/status is reserved by OpenClaw");
  });

  it("returns the six command bodies the runner calls back into", () => {
    assert.match(source, /return \{[\s\S]*runMemoryCommand[\s\S]*runForgetCommand[\s\S]*runCorrectCommand[\s\S]*runCriticalCommand[\s\S]*runStatusCommand[\s\S]*runFeatureToggle[\s\S]*\}/);
  });

  it("also returns the four auth/locale helpers the runner thunks", () => {
    // PR-03f left ten thunks in index.js, not six: `checkAuth`,
    // `checkArgsLength`, `resolveDenialLocale` and
    // `resolveRegisteredMemoryContext` are declared inside the moved range
    // too, so index.js has to rebind all ten or the runner's thunks resolve
    // to `undefined` at command time.
    const returned = source.slice(source.lastIndexOf("  return {"));
    for (const name of [
      "runMemoryCommand", "runForgetCommand", "runCorrectCommand", "runCriticalCommand",
      "runStatusCommand", "runFeatureToggle", "checkArgsLength", "checkAuth",
      "resolveDenialLocale", "resolveRegisteredMemoryContext",
    ]) {
      assert.match(returned, new RegExp(`^\\s{4}${name},$`, "m"), `${name} must be rebindable by index.js`);
    }
  });
});

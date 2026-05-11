import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const repoRoot = resolve(pluginDir, "../..");

test("manifest schema allows OpenClaw hook permissions and hook timeouts", () => {
  const manifest = JSON.parse(readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8"));
  const hooks = manifest.configSchema.properties.hooks;
  assert.equal(hooks.type, "object");
  assert.equal(hooks.additionalProperties, false);
  assert.ok(hooks.properties.allowConversationAccess);
  assert.ok(hooks.properties.allowPromptInjection);
  assert.ok(hooks.properties.timeoutMs);
  assert.ok(hooks.properties.timeouts);
});

test("installer writes both hook permissions and per-hook timeouts", () => {
  const installer = readFileSync(resolve(repoRoot, "scripts/install-memory-system.sh"), "utf8");
  assert.match(installer, /allowConversationAccess/);
  assert.match(installer, /allowPromptInjection/);
  assert.match(installer, /before_prompt_build/);
  assert.match(installer, /agent_end/);
});

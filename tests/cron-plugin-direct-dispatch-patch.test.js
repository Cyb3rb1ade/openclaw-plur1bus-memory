import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  applyCronPluginDirectDispatchPatch,
  patchCronPluginDirectDispatchSource,
} from "../patches/apply-cron-plugin-direct-dispatch.mjs";

const workDirs = [];

function fixtureSource() {
  return `
async function finalizeCronRun(params) {
  return params;
}
async function runCronIsolatedAgentTurn(params) {
  let outcome = "completed";
  let outcomeError;
  let cronRunSessionCleanupAttempted = false;
  const turnStartedAtMs = Date.now();
  try {
    /* plur1bus-cron-cmd-dispatch */
    const _plMsg = (params.job.payload?.message ?? "").split("\\n")[0].trim();
    if (_plMsg.startsWith("/")) {
      try {
        let _plMatch = match(_plMsg);
        if (_plMatch) {
          notifyExecutionStarted();
          const _plResult = await _plMatch.command.handler({
            commandBody: _plMsg,
          });
          if (!prepared.context.deliveryRequested) {
            return prepared.context.withRunSession({ status: "completed" });
          }
          if (_plResult?.text) {
            prepared.context.commandBody = \`\${prepared.context.commandBody}\\n\\n[PLUR1BUS] \${_plResult.text}\`;
          }
        }
      } catch (_plErr) { console.warn(_plErr); }
    }
    const { executeCronRun } = await loadCronExecutorRuntime();
    return executeCronRun();
  } finally {
    cleanup();
  }
}
`;
}

afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cron plugin direct-dispatch host patch", () => {
  it("upgrades the existing dispatcher before the model executor", () => {
    const patched = patchCronPluginDirectDispatchSource(fixtureSource());

    assert.equal(patched.changed, true);
    assert.match(patched.source, /plur1bus-cron-direct-dispatch-v2/);
    assert.match(
      patched.source,
      /_plFullMsg === _plMsg[\s\S]*afterthought\|classify-recent/,
    );
    assert.match(patched.source, /payloads: \[_plReply\]/);
    assert.match(patched.source, /await finalizeCronRun\(/);
    assert.ok(
      patched.source.indexOf("await finalizeCronRun(")
        < patched.source.indexOf("const { executeCronRun }"),
    );
  });

  it("preserves the complete plugin reply for structured delivery", () => {
    const { source } = patchCronPluginDirectDispatchSource(fixtureSource());

    assert.match(source, /const _plReply = _plResult/);
    assert.doesNotMatch(source, /payloads: \[\{ text: _plResult\?\.text \}\]/);
  });

  it("rethrows direct-command failures so the cron is marked failed", () => {
    const { source } = patchCronPluginDirectDispatchSource(fixtureSource());

    assert.match(source, /if \(_plDirectDispatch\) throw _plErr;/);
  });

  it("does not bypass the model for custom multiline prompts or other commands", () => {
    const { source } = patchCronPluginDirectDispatchSource(fixtureSource());

    assert.match(source, /_plFullMsg === _plMsg/);
    assert.ok(
      source.includes(
        "/^\\/plur1bus\\s+internal\\s+(?:afterthought|classify-recent)(?:\\s|$)/",
      ),
    );
  });

  it("is idempotent", () => {
    const first = patchCronPluginDirectDispatchSource(fixtureSource());
    const second = patchCronPluginDirectDispatchSource(first.source);

    assert.equal(second.changed, false);
    assert.equal(second.source, first.source);
  });

  it("rejects a partial patch marker instead of accepting corrupt runtime code", () => {
    assert.throws(
      () => patchCronPluginDirectDispatchSource(
        `${fixtureSource()}\n${"/* plur1bus-cron-direct-dispatch-v2 */"}`,
      ),
      /incomplete direct-dispatch patch/i,
    );
  });

  it("fails closed when the installed dispatcher does not match", () => {
    assert.throws(
      () => patchCronPluginDirectDispatchSource("export const unrelated = true;"),
      /legacy PLUR1BUS cron dispatcher/i,
    );
  });

  it("patches one runtime bundle atomically and keeps a rollback copy", () => {
    const distDir = mkdtempSync(path.join(tmpdir(), "plur1bus-cron-patch-"));
    workDirs.push(distDir);
    const target = path.join(distDir, "isolated-agent-example.js");
    writeFileSync(target, fixtureSource());

    const first = applyCronPluginDirectDispatchPatch(distDir);
    const second = applyCronPluginDirectDispatchPatch(distDir);

    assert.equal(first.status, "applied");
    assert.equal(second.status, "already-patched");
    assert.match(readFileSync(target, "utf8"), /plur1bus-cron-direct-dispatch-v2/);
    assert.deepStrictEqual(
      readdirSync(distDir).sort(),
      [
        "isolated-agent-example.js",
        "isolated-agent-example.js.plur1bus-cron-direct.bak",
      ],
    );
    assert.equal(
      readFileSync(`${target}.plur1bus-cron-direct.bak`, "utf8"),
      fixtureSource(),
    );
  });
});

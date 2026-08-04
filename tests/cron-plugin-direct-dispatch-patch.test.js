import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  applyCronPluginDirectDispatchPatch,
  isCronPluginDirectDispatchReady,
  patchCronPluginDirectDispatchSource,
  resolveOpenClawDistDir,
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

function executableFixtureSource() {
  return `
let state = { modelCalls: 0, finalizedPayloads: null };
export function getState() {
  return state;
}
async function finalizeCronRun({ execution }) {
  state.finalizedPayloads = execution.runResult.payloads;
  return { status: "ok", delivered: true };
}
async function loadCronExecutorRuntime() {
  return {
    executeCronRun: async () => {
      state.modelCalls += 1;
      return { status: "model" };
    },
  };
}
export async function runCronIsolatedAgentTurn(params) {
  state = { modelCalls: 0, finalizedPayloads: null };
  let outcome = "completed";
  let outcomeError;
  let cronRunSessionCleanupAttempted = false;
  const turnStartedAtMs = Date.now();
  const abortReason = () => "aborted";
  const isAborted = () => false;
  const initialSessionId = "fixture-session";
  const notifyExecutionStarted = () => {};
  const prepared = {
    context: {
      deliveryRequested: true,
      commandBody: params.job.payload.message,
      liveSelection: { provider: "fixture", model: "fixture" },
      sessionWorkAdmission: { release: () => {} },
      withRunSession: (result) => result,
    },
  };
  const match = () => params.job.commandRegistered === false
    ? null
    : { command: { handler: async () => params.job.handlerResult } };
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
    void outcome;
    void outcomeError;
    void cronRunSessionCleanupAttempted;
    void initialSessionId;
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
  it("discovers a non-standard OpenClaw dist from the active CLI symlink", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-openclaw-prefix-")));
    workDirs.push(root);
    const packageRoot = path.join(root, "custom", "lib", "node_modules", "openclaw");
    const distDir = path.join(packageRoot, "dist");
    const binDir = path.join(root, "bin");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
    writeFileSync(path.join(packageRoot, "openclaw.mjs"), "export {};\n");
    symlinkSync(path.join(packageRoot, "openclaw.mjs"), path.join(binDir, "openclaw"));

    assert.equal(
      resolveOpenClawDistDir({ entryPath: null, pathEnv: binDir, standardCandidates: [] }),
      distDir,
    );
  });

  it("discovers OpenClaw from the running entry and preserves an explicit override", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-openclaw-entry-")));
    workDirs.push(root);
    const packageRoot = path.join(root, "openclaw");
    const distDir = path.join(packageRoot, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
    const entry = path.join(distDir, "index.js");
    writeFileSync(entry, "export {};\n");

    assert.equal(
      resolveOpenClawDistDir({ entryPath: entry, pathEnv: "", standardCandidates: [] }),
      distDir,
    );
    assert.equal(
      resolveOpenClawDistDir({ override: "/explicit/openclaw/dist" }),
      "/explicit/openclaw/dist",
    );
  });

  it("upgrades the existing dispatcher before the model executor", () => {
    const patched = patchCronPluginDirectDispatchSource(fixtureSource());

    assert.equal(patched.changed, true);
    assert.match(patched.source, /plur1bus-cron-direct-dispatch-v2/);
    assert.match(
      patched.source,
      /_plFullMsg === "\/plur1bus internal afterthought"[\s\S]*_plFullMsg === "\/plur1bus internal classify-recent"/,
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

    assert.match(source, /const _plFullMsg = params\.job\.payload\?\.message \?\? "";/);
    assert.doesNotMatch(source, /_plFullMsg\.trim\(\)/);
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
    const distDir = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-cron-patch-")));
    workDirs.push(distDir);
    const target = path.join(distDir, "isolated-agent-example.js");
    writeFileSync(target, fixtureSource());

    assert.equal(isCronPluginDirectDispatchReady(distDir), false);
    const first = applyCronPluginDirectDispatchPatch(distDir);
    const second = applyCronPluginDirectDispatchPatch(distDir);

    assert.equal(first.status, "applied");
    assert.equal(second.status, "already-patched");
    assert.equal(isCronPluginDirectDispatchReady(distDir), true);
    assert.match(readFileSync(target, "utf8"), /plur1bus-cron-direct-dispatch-v2/);
    assert.deepStrictEqual(
      readdirSync(distDir).sort(),
      [
        "isolated-agent-example.js",
        first.backup.split("/").pop(),
      ],
    );
    assert.equal(
      readFileSync(first.backup, "utf8"),
      fixtureSource(),
    );
  });

  it("installs the complete dispatcher into an unpatched OpenClaw bundle", async () => {
    const distDir = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-cron-vanilla-")));
    workDirs.push(distDir);
    const target = path.join(distDir, "isolated-agent-vanilla.js");
    writeFileSync(target, `
async function finalizeCronRun(params) { return params; }
async function runCronIsolatedAgentTurn(params) {
  const { executeCronRun } = await loadCronExecutorRuntime();
  return executeCronRun(params);
}
`);
    writeFileSync(
      path.join(distDir, "commands-plugin.js"),
      "function matchPluginCommand() {} function executePluginCommand() {}\nexport { matchPluginCommand as z, executePluginCommand as y };\n",
    );
    writeFileSync(
      path.join(distDir, "commands-registry-normalize-example.js"),
      "function resolveTextCommand() {}\nexport { resolveTextCommand as q };\n",
    );
    writeFileSync(
      path.join(distDir, "commands-registry.data-example.js"),
      "function getChatCommands() {}\nexport { getChatCommands as x };\n",
    );

    const result = applyCronPluginDirectDispatchPatch(distDir);
    const patched = readFileSync(target, "utf8");

    assert.equal(result.status, "applied");
    assert.match(patched, /plur1bus-cron-cmd-dispatch/);
    assert.match(patched, /plur1bus-cron-direct-dispatch-v2/);
    assert.match(patched, /const \{ z: _matchPluginCommand \}/);
    assert.match(patched, /const \{ q: _resolveTextCommand \}/);
    assert.match(patched, /const \{ x: _getChatCommands \}/);
    assert.ok(
      patched.indexOf("await finalizeCronRun(")
        < patched.indexOf("const { executeCronRun }"),
    );
    await import(`${pathToFileURL(target).href}?syntax=${Date.now()}`);
  });

  it("fails closed instead of reusing a corrupt hash-bound rollback copy", () => {
    const distDir = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-cron-backup-")));
    workDirs.push(distDir);
    const target = path.join(distDir, "isolated-agent-example.js");
    writeFileSync(target, fixtureSource());
    const first = applyCronPluginDirectDispatchPatch(distDir);

    writeFileSync(target, fixtureSource());
    writeFileSync(first.backup, "not the source represented by its filename");

    assert.throws(
      () => applyCronPluginDirectDispatchPatch(distDir),
      /rollback copy does not match source hash/i,
    );
    assert.equal(readFileSync(target, "utf8"), fixtureSource());
  });

  it("executes exact feature commands through finalization without calling the model", async () => {
    const distDir = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-cron-runtime-")));
    workDirs.push(distDir);
    const target = path.join(distDir, "isolated-agent-runtime.mjs");
    const reply = {
      text: "kritische Nachricht",
      presentation: {
        blocks: [{
          type: "buttons",
          buttons: [{ label: "✅ OK", action: { type: "callback", value: "crit:ok:id" } }],
        }],
      },
      presentationTextMode: "fallback",
    };
    const patched = patchCronPluginDirectDispatchSource(executableFixtureSource());
    writeFileSync(target, patched.source);
    const runtime = await import(`${pathToFileURL(target).href}?direct=${Date.now()}`);

    const result = await runtime.runCronIsolatedAgentTurn({
      job: {
        payload: { message: "/plur1bus internal classify-recent" },
        handlerResult: reply,
      },
    });

    assert.equal(result.status, "ok");
    assert.equal(runtime.getState().modelCalls, 0);
    assert.deepStrictEqual(runtime.getState().finalizedPayloads, [reply]);
  });

  it("keeps multiline carrier prompts on the legacy model path", async () => {
    const distDir = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-cron-runtime-")));
    workDirs.push(distDir);
    const target = path.join(distDir, "isolated-agent-runtime.mjs");
    const patched = patchCronPluginDirectDispatchSource(executableFixtureSource());
    writeFileSync(target, patched.source);
    const runtime = await import(`${pathToFileURL(target).href}?legacy=${Date.now()}`);

    const result = await runtime.runCronIsolatedAgentTurn({
      job: {
        payload: {
          message: "/plur1bus internal afterthought\n\nDelivery contract",
        },
        handlerResult: { text: "Nachgedanke" },
      },
    });

    assert.equal(result.status, "model");
    assert.equal(runtime.getState().modelCalls, 1);
    assert.equal(runtime.getState().finalizedPayloads, null);
  });

  it("keeps suffixed and whitespace-modified feature commands on the legacy model path", async () => {
    for (const [index, message] of [
      "/plur1bus internal afterthought bitte ausführlich",
      " /plur1bus internal afterthought",
      "/plur1bus internal classify-recent ",
    ].entries()) {
      const distDir = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-cron-runtime-")));
      workDirs.push(distDir);
      const target = path.join(distDir, "isolated-agent-runtime.mjs");
      const patched = patchCronPluginDirectDispatchSource(executableFixtureSource());
      writeFileSync(target, patched.source);
      const runtime = await import(`${pathToFileURL(target).href}?custom=${Date.now()}-${index}`);

      const result = await runtime.runCronIsolatedAgentTurn({
        job: {
          payload: { message },
          handlerResult: { text: "legacy" },
        },
      });

      assert.equal(result.status, "model");
      assert.equal(runtime.getState().modelCalls, 1);
      assert.equal(runtime.getState().finalizedPayloads, null);
    }
  });

  it("fails exact feature commands closed when the plugin command is unavailable", async () => {
    const distDir = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-cron-runtime-")));
    workDirs.push(distDir);
    const target = path.join(distDir, "isolated-agent-runtime.mjs");
    const patched = patchCronPluginDirectDispatchSource(executableFixtureSource());
    writeFileSync(target, patched.source);
    const runtime = await import(`${pathToFileURL(target).href}?missing=${Date.now()}`);

    await assert.rejects(
      runtime.runCronIsolatedAgentTurn({
        job: {
          payload: { message: "/plur1bus internal afterthought" },
          commandRegistered: false,
        },
      }),
      /direct cron command is not registered/i,
    );
    assert.equal(runtime.getState().modelCalls, 0);
  });

  it("fails exact feature commands closed when their handler returns no reply", async () => {
    const distDir = realpathSync(mkdtempSync(path.join(tmpdir(), "plur1bus-cron-runtime-")));
    workDirs.push(distDir);
    const target = path.join(distDir, "isolated-agent-runtime.mjs");
    const patched = patchCronPluginDirectDispatchSource(executableFixtureSource());
    writeFileSync(target, patched.source);
    const runtime = await import(`${pathToFileURL(target).href}?empty=${Date.now()}`);

    await assert.rejects(
      runtime.runCronIsolatedAgentTurn({
        job: {
          payload: { message: "/plur1bus internal classify-recent" },
          handlerResult: undefined,
        },
      }),
      /returned no ReplyPayload/i,
    );
    assert.equal(runtime.getState().modelCalls, 0);
  });
});

#!/usr/bin/env node

import {
  constants,
  copyFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LEGACY_MARKER = "/* plur1bus-cron-cmd-dispatch */";
const DIRECT_MARKER = "/* plur1bus-cron-direct-dispatch-v2 */";
const TARGET_RE = /^isolated-agent-[A-Za-z0-9_-]+\.js$/;

function indentationAt(source, index) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return source.slice(lineStart, index).match(/^\s*/)?.[0] ?? "";
}

function directFinalizeBlock(indent) {
  const i = indent;
  const i1 = `${i}\t`;
  const i2 = `${i1}\t`;
  const i3 = `${i2}\t`;
  return [
    `${i}if (_plDirectDispatch) {`,
    `${i1}const _plReply = _plResult && typeof _plResult === "object" ? _plResult : { text: "NO_REPLY" };`,
    `${i1}const _plText = typeof _plReply.text === "string" ? _plReply.text : "";`,
    `${i1}const _plRunEndedAt = Date.now();`,
    `${i1}const _plExecution = {`,
    `${i2}runResult: {`,
    `${i3}payloads: [_plReply],`,
    `${i3}meta: {`,
    `${i3}\tfinalAssistantRawText: _plText,`,
    `${i3}\tfinalAssistantVisibleText: _plText,`,
    `${i3}\t...(_plText.trim() === "NO_REPLY" ? { terminalReplyKind: "silent-empty" } : {})`,
    `${i3}}`,
    `${i2}},`,
    `${i2}fallbackProvider: prepared.context.liveSelection.provider,`,
    `${i2}fallbackModel: prepared.context.liveSelection.model,`,
    `${i2}runStartedAt: turnStartedAtMs,`,
    `${i2}runEndedAt: _plRunEndedAt,`,
    `${i2}liveSelection: prepared.context.liveSelection`,
    `${i1}};`,
    `${i1}const _plFinalized = await finalizeCronRun({`,
    `${i2}prepared: prepared.context,`,
    `${i2}execution: _plExecution,`,
    `${i2}abortReason,`,
    `${i2}isAborted,`,
    `${i2}markCronRunSessionCleanupAttempted: () => {`,
    `${i3}cronRunSessionCleanupAttempted = true;`,
    `${i2}},`,
    `${i2}beforeSessionDelete: prepared.context.sessionWorkAdmission.release`,
    `${i1}});`,
    `${i1}if (_plFinalized.status === "error") {`,
    `${i2}outcome = "error";`,
    `${i2}outcomeError = _plFinalized.error;`,
    `${i1}}`,
    `${i1}return _plFinalized;`,
    `${i}}`,
  ].join("\n");
}

/**
 * Upgrade OpenClaw's existing PLUR1BUS cron dispatcher so the two feature
 * commands finalize and deliver their ReplyPayload without an agent run.
 *
 * @param {string} source
 * @returns {{source: string, changed: boolean}}
 */
export function patchCronPluginDirectDispatchSource(source) {
  if (source.includes(DIRECT_MARKER)) {
    const directIndex = source.indexOf(DIRECT_MARKER);
    const finalizeIndex = source.indexOf("await finalizeCronRun(", directIndex);
    const executorIndex = source.indexOf(
      "const { executeCronRun } = await loadCronExecutorRuntime();",
      directIndex,
    );
    const complete = directIndex >= 0
      && finalizeIndex > directIndex
      && executorIndex > finalizeIndex
      && source.indexOf("_plDirectDispatch", directIndex) > directIndex
      && source.indexOf("payloads: [_plReply]", directIndex) > directIndex
      && source.indexOf("if (_plDirectDispatch) throw _plErr;", directIndex) > directIndex;
    if (!complete) {
      throw new Error("incomplete direct-dispatch patch marker found");
    }
    return { source, changed: false };
  }
  const markerIndex = source.indexOf(LEGACY_MARKER);
  if (markerIndex < 0) {
    throw new Error("legacy PLUR1BUS cron dispatcher not found");
  }

  const executorIndex = source.indexOf(
    "const { executeCronRun } = await loadCronExecutorRuntime();",
    markerIndex,
  );
  if (executorIndex < 0) {
    throw new Error("legacy PLUR1BUS cron dispatcher has no model-executor anchor");
  }

  const legacy = source.slice(markerIndex, executorIndex);
  const messageLineMatch = legacy.match(
    /^(\s*)const _plMsg = \(params\.job\.payload\?\.message \?\? ""\)\.split\("\\n"\)\[0\]\.trim\(\);$/m,
  );
  if (!messageLineMatch) {
    throw new Error("legacy PLUR1BUS cron dispatcher message anchor not found");
  }
  const messageLine = messageLineMatch[0];
  const messageIndent = messageLineMatch[1];
  const guardedMessageLines = [
    messageLine,
    `${messageIndent}${DIRECT_MARKER}`,
    `${messageIndent}const _plFullMsg = (params.job.payload?.message ?? "").trim();`,
    `${messageIndent}const _plDirectDispatch = _plFullMsg === _plMsg`,
    `${messageIndent}\t&& /^\\/plur1bus\\s+internal\\s+(?:afterthought|classify-recent)(?:\\s|$)/.test(_plMsg);`,
  ].join("\n");

  let upgraded = legacy.replace(messageLine, guardedMessageLines);

  const deliveryAnchor = "if (!prepared.context.deliveryRequested) {";
  const deliveryIndex = upgraded.indexOf(deliveryAnchor);
  if (deliveryIndex < 0) {
    throw new Error("legacy PLUR1BUS cron dispatcher delivery anchor not found");
  }
  const deliveryIndent = indentationAt(upgraded, deliveryIndex);
  const deliveryLineStart = upgraded.lastIndexOf("\n", deliveryIndex - 1) + 1;
  upgraded = [
    upgraded.slice(0, deliveryLineStart),
    directFinalizeBlock(deliveryIndent),
    "\n",
    upgraded.slice(deliveryLineStart),
  ].join("");

  const catchRe = /^(\s*)} catch \(_plErr\) \{ console\.warn\(([^;\n]+)\); \}$/m;
  const catchMatch = upgraded.match(catchRe);
  if (!catchMatch) {
    throw new Error("legacy PLUR1BUS cron dispatcher error anchor not found");
  }
  const catchIndent = catchMatch[1];
  const catchReplacement = [
    `${catchIndent}} catch (_plErr) {`,
    `${catchIndent}\tif (_plDirectDispatch) throw _plErr;`,
    `${catchIndent}\tconsole.warn(${catchMatch[2]});`,
    `${catchIndent}}`,
  ].join("\n");
  upgraded = upgraded.replace(catchRe, catchReplacement);

  return {
    source: `${source.slice(0, markerIndex)}${upgraded}${source.slice(executorIndex)}`,
    changed: true,
  };
}

/**
 * Patch the single active OpenClaw isolated-agent runtime bundle and retain
 * the original next to it as a rollback copy.
 *
 * @param {string} distDir
 * @returns {{status: "applied"|"already-patched", target: string, backup: string}}
 */
export function applyCronPluginDirectDispatchPatch(distDir) {
  const candidates = readdirSync(distDir)
    .filter((name) => TARGET_RE.test(name))
    .map((name) => path.join(distDir, name))
    .filter((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return source.includes(LEGACY_MARKER) || source.includes(DIRECT_MARKER);
    });

  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one OpenClaw isolated-agent bundle with the PLUR1BUS dispatcher, found ${candidates.length}`,
    );
  }

  const target = candidates[0];
  const backup = `${target}.plur1bus-cron-direct.bak`;
  const source = readFileSync(target, "utf8");
  const patched = patchCronPluginDirectDispatchSource(source);
  if (!patched.changed) {
    return { status: "already-patched", target, backup };
  }

  try {
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const tempPath = `${target}.plur1bus-cron-direct.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, patched.source, { mode: statSync(target).mode });
    renameSync(tempPath, target);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  return { status: "applied", target, backup };
}

function isMain() {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(path.resolve(entry)).href : false;
}

if (isMain()) {
  try {
    const distDir = process.argv[2] || "/usr/lib/node_modules/openclaw/dist";
    const result = applyCronPluginDirectDispatchPatch(distDir);
    process.stdout.write(
      `[patch] plur1bus cron direct dispatch: ${result.status} (${path.basename(result.target)})\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[patch] plur1bus cron direct dispatch: failed: ${error?.message || String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

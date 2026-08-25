#!/usr/bin/env node

import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LEGACY_MARKER = "/* plur1bus-cron-cmd-dispatch */";
const DIRECT_MARKER = "/* plur1bus-cron-direct-dispatch-v2 */";
const TARGET_RE = /^isolated-agent-[A-Za-z0-9_-]+\.js$/;
const EXECUTOR_ANCHOR = "const { executeCronRun } = await loadCronExecutorRuntime();";
const STANDARD_OPENCLAW_DIST_DIRS = [
  "/usr/lib/node_modules/openclaw/dist",
  "/usr/local/lib/node_modules/openclaw/dist",
];

function findNativeCapabilityFile(distDir, label, filePattern, predicate) {
  const matches = readdirSync(distDir)
    .filter((name) => filePattern.test(name))
    .filter((name) => predicate(readFileSync(path.join(distDir, name), "utf8")));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one OpenClaw native ${label}, found ${matches.length}`);
  }
  return matches[0];
}

/**
 * Inspect the published OpenClaw dist for the complete public no-model cron
 * command plus Gateway plugin-command path used by PLUR1BUS.
 *
 * @param {string} [distDir]
 * @returns {{ready: true, status: "native-command", files: {commandRunner: string, cronCli: string, agentCli: string, agentGateway: string, pluginCommand: string}}}
 */
export function inspectNativeCronPluginCommandCapability(distDir = resolveOpenClawDistDir()) {
  const commandRunner = findNativeCapabilityFile(
    distDir,
    "command runner with NO_REPLY suppression",
    /^server-cron-[A-Za-z0-9_-]+\.js$/,
    (source) => source.includes("Executes a cron command payload without starting an agent/model run")
      && source.includes("runCronCommandJob")
      && source.includes('isSilentReplyText(result.summary, "NO_REPLY")'),
  );
  const cronCli = findNativeCapabilityFile(
    distDir,
    "cron CLI command-argv surface",
    /^cron-cli-[A-Za-z0-9_-]+\.js$/,
    (source) => source.includes("--command-argv <json>")
      && source.includes("--timeout-seconds <n>")
      && source.includes("--output-max-bytes <n>"),
  );
  const agentCli = findNativeCapabilityFile(
    distDir,
    "Gateway agent CLI surface",
    /^register\.agent-turn-[A-Za-z0-9_-]+\.js$/,
    (source) => source.includes("Run an agent turn via the Gateway")
      && source.includes("--session-key <key>")
      && source.includes("--agent <id>")
      && source.includes("--channel <channel>"),
  );
  const agentGateway = findNativeCapabilityFile(
    distDir,
    "Gateway agent dispatcher",
    /^agent-via-gateway-[A-Za-z0-9_-]+\.js$/,
    (source) => source.includes('method: "agent"')
      && source.includes("Waiting for agent reply"),
  );
  const pluginCommand = findNativeCapabilityFile(
    distDir,
    "pre-model plugin command dispatcher",
    /^commands-handlers\.runtime-[A-Za-z0-9_-]+\.js$/,
    (source) => source.includes("Handles commands registered by plugins, bypassing the LLM agent")
      && source.includes("matchPluginCommandInvocation")
      && source.includes("executePluginCommandDispatch"),
  );
  return {
    ready: true,
    status: "native-command",
    files: { commandRunner, cronCli, agentCli, agentGateway, pluginCommand },
  };
}

/** Return whether the complete native Beta-era path is present without throwing. */
export function isNativeCronPluginCommandCapabilityReady(distDir = resolveOpenClawDistDir()) {
  try {
    return inspectNativeCronPluginCommandCapability(distDir).ready === true;
  } catch {
    return false;
  }
}

function openClawDistFromEntry(entryPath) {
  if (typeof entryPath !== "string" || entryPath.length === 0) return null;
  try {
    let current = path.dirname(realpathSync(entryPath));
    for (let depth = 0; depth < 8; depth += 1) {
      const manifestPath = path.join(current, "package.json");
      const distDir = path.join(current, "dist");
      if (existsSync(manifestPath) && existsSync(distDir)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest?.name === "openclaw") return realpathSync(distDir);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve the active OpenClaw dist directory from an explicit override, the
 * running entry point, or the `openclaw` executable on PATH.
 *
 * @param {{override?: string|null, entryPath?: string|null, pathEnv?: string, standardCandidates?: string[]}} [options]
 * @returns {string}
 */
export function resolveOpenClawDistDir(options = {}) {
  const {
    override = process.env.OPENCLAW_DIST_DIR,
    entryPath = process.argv[1],
    pathEnv = process.env.PATH || "",
    standardCandidates = STANDARD_OPENCLAW_DIST_DIRS,
  } = options;
  if (typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override);
  }

  const entryDist = openClawDistFromEntry(entryPath);
  if (entryDist) return entryDist;

  for (const binDir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const pathDist = openClawDistFromEntry(path.join(binDir, "openclaw"));
    if (pathDist) return pathDist;
  }

  for (const candidate of standardCandidates) {
    const packageRoot = path.dirname(candidate);
    try {
      const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
      if (manifest?.name === "openclaw" && existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // Continue through the bounded candidate list.
    }
  }
  throw new Error("could not resolve the active OpenClaw dist directory");
}

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
    `${i1}if (!_plResult || typeof _plResult !== "object") throw new Error("PLUR1BUS direct cron handler returned no ReplyPayload");`,
    `${i1}const _plReply = _plResult;`,
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

function findRuntimeExport(distDir, filePattern, functionName, predicate = () => true) {
  const exportRe = new RegExp(`${functionName}\\s+as\\s+([A-Za-z_$][\\w$]*)`);
  const matches = readdirSync(distDir)
    .filter((name) => filePattern.test(name))
    .map((name) => {
      const source = readFileSync(path.join(distDir, name), "utf8");
      if (!source.includes(`function ${functionName}(`) || !predicate(source)) return null;
      const exportMatch = source.match(exportRe);
      return exportMatch ? { module: name, alias: exportMatch[1] } : null;
    })
    .filter(Boolean);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one OpenClaw export for ${functionName}, found ${matches.length}`);
  }
  return matches[0];
}

function discoverDispatcherModules(distDir) {
  return {
    plugin: findRuntimeExport(
      distDir,
      /^commands-[A-Za-z0-9_-]+\.js$/,
      "matchPluginCommand",
      (source) => source.includes("function executePluginCommand("),
    ),
    normalize: findRuntimeExport(
      distDir,
      /^commands-registry-normalize-[A-Za-z0-9_-]+\.js$/,
      "resolveTextCommand",
    ),
    data: findRuntimeExport(
      distDir,
      /^commands-registry\.data-[A-Za-z0-9_-]+\.js$/,
      "getChatCommands",
    ),
  };
}

function legacyDispatcherBlock(indent, modules) {
  const i = indent;
  const i1 = `${i}\t`;
  const i2 = `${i1}\t`;
  const i3 = `${i2}\t`;
  const i4 = `${i3}\t`;
  return [
    `${i}${LEGACY_MARKER}`,
    `${i}const _plMsg = (params.job.payload?.message ?? "").split("\\n")[0].trim();`,
    `${i}if (_plMsg.startsWith("/")) {`,
    `${i1}try {`,
    `${i2}const { ${modules.plugin.alias}: _matchPluginCommand } = await import("./${modules.plugin.module}");`,
    `${i2}const { ${modules.normalize.alias}: _resolveTextCommand } = await import("./${modules.normalize.module}");`,
    `${i2}const { ${modules.data.alias}: _getChatCommands } = await import("./${modules.data.module}");`,
    `${i2}let _plMatch = _matchPluginCommand(_plMsg, { channel: "cron" }) || _resolveTextCommand(_plMsg, params.cfg);`,
    `${i2}if (!_plMatch) {`,
    `${i3}const _tokenMatch = _plMsg.match(/^\\/([^\\s:]+)(?:\\s+([\\s\\S]+))?$/);`,
    `${i3}const _token = _tokenMatch?.[1]?.toLowerCase();`,
    `${i3}const _rawArgs = _tokenMatch?.[2]?.trim() || void 0;`,
    `${i3}const _commands = typeof _getChatCommands === "function" ? _getChatCommands() : [];`,
    `${i3}const _cmd = _token ? _commands.find((_cmd) => {`,
    `${i4}const _aliases = Array.isArray(_cmd.textAliases) ? _cmd.textAliases : [];`,
    `${i4}return String(_cmd.key || "").toLowerCase() === _token || String(_cmd.nativeName || "").toLowerCase() === _token || _aliases.some((_alias) => String(_alias || "").toLowerCase() === \`/\${_token}\`);`,
    `${i3}}) : null;`,
    `${i3}if (_cmd) _plMatch = { command: _cmd, args: _rawArgs };`,
    `${i2}}`,
    `${i2}if (!_plMatch && _plMsg.startsWith("/plur1bus")) console.warn(\`[plur1bus-cron-dispatch] no command match for \${_plMsg}\`);`,
    `${i2}if (_plMatch) {`,
    `${i3}notifyExecutionStarted({ lifecycleGeneration: runLifecycleGeneration });`,
    `${i3}notifyExecutionPhase({ phase: "plugin_command" });`,
    `${i3}const _wdir = prepared.context.workspaceDir;`,
    `${i3}const _plResult = await _plMatch.command.handler({`,
    `${i4}senderId: \`cron:\${params.job.id}\`,`,
    `${i4}channel: "cron",`,
    `${i4}channelId: prepared.context.agentId,`,
    `${i4}isAuthorizedSender: true,`,
    `${i4}senderIsOwner: true,`,
    `${i4}args: _plMatch.args,`,
    `${i4}commandBody: _plMsg,`,
    `${i4}config: params.cfg,`,
    `${i4}agentId: prepared.context.agentId,`,
    `${i4}workspaceDir: _wdir,`,
    `${i4}workspaceKey: _wdir ? _wdir.split("/").pop() : void 0,`,
    `${i4}sessionKey: prepared.context.runSessionKey,`,
    `${i4}sessionId: initialSessionId,`,
    `${i4}from: null, to: null, accountId: null,`,
    `${i4}messageThreadId: null, threadParentId: null,`,
    `${i4}runtimeContext: null,`,
    `${i4}requestConversationBinding: () => null,`,
    `${i4}detachConversationBinding: () => null,`,
    `${i4}getCurrentConversationBinding: () => null,`,
    `${i3}});`,
    `${i3}if (!prepared.context.deliveryRequested) {`,
    `${i4}return prepared.context.withRunSession({ status: "completed" });`,
    `${i3}}`,
    `${i3}if (_plResult?.text) {`,
    `${i4}prepared.context.commandBody = \`\${prepared.context.commandBody}\\n\\n[PLUR1BUS] \${_plResult.text}\`;`,
    `${i3}}`,
    `${i2}}`,
    `${i1}} catch (_plErr) { console.warn(\`[plur1bus-cron-dispatch] plugin command failed: \${_plErr?.stack || _plErr?.message || _plErr}\`); }`,
    `${i}}`,
    "",
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
      EXECUTOR_ANCHOR,
      directIndex,
    );
    const complete = directIndex >= 0
      && finalizeIndex > directIndex
      && executorIndex > finalizeIndex
      && source.indexOf("_plDirectDispatch", directIndex) > directIndex
      && source.indexOf("direct cron command is not registered", directIndex) > directIndex
      && source.indexOf("returned no ReplyPayload", directIndex) > directIndex
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
    EXECUTOR_ANCHOR,
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
    `${messageIndent}const _plFullMsg = params.job.payload?.message ?? "";`,
    `${messageIndent}const _plDirectDispatch = _plFullMsg === "/plur1bus internal afterthought"`,
    `${messageIndent}\t|| _plFullMsg === "/plur1bus internal classify-recent";`,
  ].join("\n");

  let upgraded = legacy.replace(messageLine, guardedMessageLines);

  const matchAnchor = "if (_plMatch) {";
  const matchIndex = upgraded.indexOf(matchAnchor);
  if (matchIndex < 0) {
    throw new Error("legacy PLUR1BUS cron dispatcher command-match anchor not found");
  }
  const matchIndent = indentationAt(upgraded, matchIndex);
  const matchLineStart = upgraded.lastIndexOf("\n", matchIndex - 1) + 1;
  upgraded = [
    upgraded.slice(0, matchLineStart),
    `${matchIndent}if (_plDirectDispatch && !_plMatch) throw new Error("PLUR1BUS direct cron command is not registered");\n`,
    upgraded.slice(matchLineStart),
  ].join("");

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
 * @param {string} [distDir]
 * @returns {{status: "applied"|"already-patched", target: string, backup: string|null}}
 */
export function applyCronPluginDirectDispatchPatch(distDir = resolveOpenClawDistDir()) {
  const bundles = readdirSync(distDir)
    .filter((name) => TARGET_RE.test(name))
    .map((name) => path.join(distDir, name))
    .map((filePath) => ({ filePath, source: readFileSync(filePath, "utf8") }));
  const marked = bundles.filter(({ source }) => (
    source.includes(LEGACY_MARKER) || source.includes(DIRECT_MARKER)
  ));
  const candidates = marked.length > 0
    ? marked
    : bundles.filter(({ source }) => {
      return source.includes("async function runCronIsolatedAgentTurn(")
        && source.includes(EXECUTOR_ANCHOR);
    });

  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one OpenClaw isolated-agent bundle with the PLUR1BUS dispatcher, found ${candidates.length}`,
    );
  }

  const target = candidates[0].filePath;
  const originalSource = candidates[0].source;
  let source = originalSource;
  if (!source.includes(LEGACY_MARKER) && !source.includes(DIRECT_MARKER)) {
    const executorIndex = source.indexOf(EXECUTOR_ANCHOR);
    const executorIndent = indentationAt(source, executorIndex);
    const executorLineStart = source.lastIndexOf("\n", executorIndex - 1) + 1;
    const modules = discoverDispatcherModules(distDir);
    source = [
      source.slice(0, executorLineStart),
      legacyDispatcherBlock(executorIndent, modules),
      source.slice(executorLineStart),
    ].join("");
  }
  const patched = patchCronPluginDirectDispatchSource(source);
  const sourceHash = createHash("sha256").update(originalSource).digest("hex").slice(0, 16);
  const backup = `${target}.plur1bus-cron-direct.${sourceHash}.bak`;
  if (!patched.changed) {
    return { status: "already-patched", target, backup: null };
  }

  try {
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (readFileSync(backup, "utf8") !== originalSource) {
      throw new Error(`cron direct-dispatch rollback copy does not match source hash ${sourceHash}`);
    }
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

/**
 * Check that exactly one active OpenClaw cron bundle contains a complete
 * direct-dispatch patch without changing the installation.
 *
 * @param {string} [distDir]
 * @returns {boolean}
 */
export function isCronPluginDirectDispatchReady(distDir = resolveOpenClawDistDir()) {
  try {
    const candidates = readdirSync(distDir)
      .filter((name) => TARGET_RE.test(name))
      .map((name) => path.join(distDir, name))
      .filter((filePath) => readFileSync(filePath, "utf8").includes(DIRECT_MARKER));
    if (candidates.length !== 1) return false;
    const source = readFileSync(candidates[0], "utf8");
    return patchCronPluginDirectDispatchSource(source).changed === false;
  } catch {
    return false;
  }
}

function isMain() {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(path.resolve(entry)).href : false;
}

if (isMain()) {
  try {
    const distDir = resolveOpenClawDistDir({ override: process.argv[2] });
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

import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

function findInstalledOpenClaw() {
  for (const directory of String(process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "openclaw");
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return "";
}

it("loads reply_dispatch routing through the real installed OpenClaw plugin loader", async (t) => {
  const executable = findInstalledOpenClaw();
  if (!executable) {
    t.skip("installed OpenClaw executable is unavailable");
    return;
  }
  const loaderPath = join(dirname(executable), "dist", "plugins", "loader.js");
  if (!existsSync(loaderPath)) {
    t.skip("installed OpenClaw plugin loader is unavailable");
    return;
  }

  const loader = await import(pathToFileURL(loaderPath).href);
  const projectRoot = resolve(import.meta.dirname, "..");
  const pluginId = "memory-lancedb-namespaced";
  const config = {
    plugins: {
      allow: [pluginId],
      load: { paths: [projectRoot] },
      entries: {
        [pluginId]: {
          enabled: true,
          hooks: { allowPromptInjection: true, allowConversationAccess: true },
          config: { autoRecall: true, autoCapture: false },
        },
      },
      slots: { memory: pluginId },
    },
  };
  const logs = [];
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [
    level,
    (...args) => logs.push([level, ...args]),
  ]));

  try {
    const registry = loader.loadOpenClawPlugins({
      config,
      activationSourceConfig: config,
      workspaceDir: projectRoot,
      onlyPluginIds: [pluginId],
      cache: false,
      activate: false,
      throwOnLoadError: true,
      logger,
    });
    const plugin = registry.plugins.find((entry) => entry.id === pluginId);
    assert.equal(plugin?.status, "loaded");
    assert.equal(realpathSync(plugin.source), realpathSync(join(projectRoot, "index.js")));

    const dispatchHook = registry.typedHooks.find((entry) => entry.pluginId === pluginId
      && entry.hookName === "reply_dispatch");
    assert.ok(dispatchHook, "installed host must register the reply_dispatch hook");
    assert.equal(dispatchHook.priority, Number.MIN_SAFE_INTEGER);
    await dispatchHook.handler({
      runId: "smoke-run",
      sessionKey: "agent:smoke:discord:channel:chan",
      originatingChannel: "discord",
      originatingTo: "channel:chan",
      originatingAccountId: "default",
      ctx: {
        AgentId: "smoke",
        SessionKey: "agent:smoke:discord:channel:chan",
        AccountId: "default",
        SenderId: "42",
        Provider: "discord",
        ChatId: "chan",
        OriginatingTo: "channel:chan",
        CommandTurn: { kind: "normal", source: "message", authorized: false, body: "hello" },
        CommandBody: "hello",
      },
    });

    const renderedLogs = logs.flatMap((entry) => entry.slice(1)).map(String).join("\n");
    assert.doesNotMatch(renderedLogs, /turn route registry unavailable|memory-request-context\.routing|invalid_dispatch_identity/i);
  } finally {
    loader.clearPluginLoaderCache();
    loader.clearPluginRegistryLoadCache();
    loader.clearActivatedPluginRuntimeState();
  }
});

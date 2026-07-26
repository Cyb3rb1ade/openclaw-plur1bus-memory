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
    agents: { list: [{ id: "smoke", workspace: projectRoot }] },
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

    const commandCtx = {
      args: "",
      agentId: "smoke",
      senderId: "42",
      channel: "telegram",
      accountId: "default",
      sessionKey: "agent:smoke:main",
      from: "telegram:chat-a",
      to: "telegram:chat-a",
      config,
      getCurrentConversationBinding: () => null,
    };
    for (const [name, args] of [["forget", ""], ["correct", ""], ["wiki", "add"], ["wiki", "delete"]]) {
      const registered = registry.commands.find((entry) => entry.pluginId === pluginId && entry.command?.name === name);
      assert.ok(registered, `${name} must be registered by the installed host loader`);
      const result = await registered.command.handler({
        ...commandCtx,
        args,
        // Official route fields remain authoritative over synthetic legacy aliases.
        userId: "attacker",
        chatId: "attacker-chat",
        chatType: "group",
      });
      assert.match(result.text, name === "wiki" ? /\/wiki/i : /Usage|Verwendung|Syntax/i, `${name}: ${result.text}`);
      assert.doesNotMatch(result.text, /not configured|allowed list|nicht autorisiert/i, `${name}: ${result.text}`);
    }

    const forget = registry.commands.find((entry) => entry.pluginId === pluginId && entry.command?.name === "forget");
    const deniedGroup = await forget.command.handler({
      ...commandCtx,
      sessionKey: "agent:smoke:telegram:group:chat-a",
      from: "telegram:group:chat-a",
      to: "telegram:group:chat-a",
    });
    assert.match(deniedGroup.text, /not configured|allowed list|nicht autorisiert/i);

    // clearPluginLoaderCache entfiel mit OpenClaw 2026.7.2; die verbleibenden
    // Cleanups existieren in allen unterstützten Host-Versionen.
    loader.clearPluginLoaderCache?.();
    loader.clearPluginRegistryLoadCache?.();
    loader.clearActivatedPluginRuntimeState?.();
    const allowlistConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          [pluginId]: {
            ...config.plugins.entries[pluginId],
            config: {
              ...config.plugins.entries[pluginId].config,
              security: { allowedUserIds: ["42"], allowedChatIds: ["chat-a"] },
            },
          },
        },
      },
    };
    const allowlistRegistry = loader.loadOpenClawPlugins({
      config: allowlistConfig,
      activationSourceConfig: allowlistConfig,
      workspaceDir: projectRoot,
      onlyPluginIds: [pluginId],
      cache: false,
      activate: false,
      throwOnLoadError: true,
      logger,
    });
    const allowlistForget = allowlistRegistry.commands.find(
      (entry) => entry.pluginId === pluginId && entry.command?.name === "forget",
    );
    const allowed = await allowlistForget.command.handler({ ...commandCtx, config: allowlistConfig });
    assert.match(allowed.text, /Usage|Verwendung|Syntax/i);
    const wrongChat = await allowlistForget.command.handler({
      ...commandCtx,
      args: "must-not-reach-memory-query",
      sessionKey: "agent:smoke:telegram:direct:chat-b",
      from: "telegram:chat-b",
      to: "telegram:chat-b",
      config: allowlistConfig,
    });
    assert.match(wrongChat.text, /chat.*allowed|allowed.*chat|nicht autorisiert/i);
    assert.doesNotMatch(wrongChat.text, /must-not-reach-memory-query/);
  } finally {
    // clearPluginLoaderCache entfiel mit OpenClaw 2026.7.2; die verbleibenden
    // Cleanups existieren in allen unterstützten Host-Versionen.
    loader.clearPluginLoaderCache?.();
    loader.clearPluginRegistryLoadCache?.();
    loader.clearActivatedPluginRuntimeState?.();
  }
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function findPinnedOpenClawLoader() {
  const packageRoot = dirname(dirname(require.resolve("openclaw")));
  const packageJson = join(packageRoot, "package.json");
  const pkg = require(packageJson);
  assert.equal(pkg.version, "2026.9.1-beta.1", "loader test must use the exact target OpenClaw beta");
  return join(packageRoot, "dist", "plugins", "loader.js");
}

it("loads reply_dispatch routing through the exact OpenClaw 2026.9.1-beta.1 plugin loader", async () => {
  const loaderPath = findPinnedOpenClawLoader();
  assert.ok(existsSync(loaderPath), `pinned OpenClaw plugin loader is unavailable: ${loaderPath}`);
  const isolatedHome = mkdtempSync(join(tmpdir(), "plur1bus-openclaw-loader-"));
  const previousEnv = Object.fromEntries(
    ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"].map((name) => [name, process.env[name]]),
  );
  process.env.HOME = isolatedHome;
  process.env.OPENCLAW_HOME = join(isolatedHome, ".openclaw");
  process.env.OPENCLAW_STATE_DIR = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_CONFIG_PATH = join(process.env.OPENCLAW_HOME, "openclaw.json");

  const loader = await import(`${pathToFileURL(loaderPath).href}?isolated=${Date.now()}`);
  const projectRoot = resolve(import.meta.dirname, "..");
  const pluginId = "memory-lancedb-namespaced";
  const baseDbPath = join(isolatedHome, "plur1bus-state");
  const config = {
    agents: { list: [{ id: "smoke", workspace: projectRoot }] },
    plugins: {
      allow: [pluginId],
      load: { paths: [projectRoot] },
      entries: {
        [pluginId]: {
          enabled: true,
          hooks: { allowPromptInjection: true, allowConversationAccess: true },
          config: {
            autoRecall: true,
            autoCapture: false,
            baseDbPath,
            modelPreparation: { profile: "jina-v3-multilingual-32" },
          },
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
    const runtimeLifecycles = registry.runtimeLifecycles.filter((entry) => entry.pluginId === pluginId);
    assert.equal(runtimeLifecycles.length, 1, "installed host must own exactly one PLUR1BUS cleanup lifecycle");
    assert.equal(runtimeLifecycles[0].lifecycle.id, "plur1bus-runtime-resources");
    assert.equal(typeof runtimeLifecycles[0].lifecycle.cleanup, "function");
    const preparationServices = registry.services.filter((entry) => entry.pluginId === pluginId
      && entry.service?.id === "plur1bus-model-preparation");
    assert.equal(preparationServices.length, 1, "installed host must stage exactly one preparation service");
    assert.equal(typeof preparationServices[0].service.start, "function");
    assert.equal(typeof preparationServices[0].service.stop, "function");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      existsSync(join(baseDbPath, "control", "model-preparation.json")),
      false,
      "an inactive OpenClaw registry builder must not start model preparation",
    );

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
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

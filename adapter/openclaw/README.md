# The OpenClaw adapter

Every `api.on` / `api.register*` call that PR-03 could move lives here. Engine
code never touches the OpenClaw `api` surface —
`scripts/lint-no-api-outside-adapter.mjs` enforces that, and
`scripts/lint-engine-imports.mjs` enforces that `engine/**` never imports the
host, `index.js`, or itself in a cycle.

`lint-engine-imports.mjs` also forbids `engine/**` from naming the host handle
at all — both `something.api` and a bare `api` identifier, because a range
lifted out of `register()` arrives holding the parameter itself. These are
**text** rules over the source lines: comments and simple quoted strings are
stripped first, template literals are not. An `engine/**` module therefore may
not spell `api` followed by a dot even in a comment describing the adapter —
write "the host's `registerTool`" instead.

| Module | Registers |
|---|---|
| `register-turn-route.js` | `reply_dispatch`, `agent_end` run cleanup |
| `register-recall-hook.js` | `before_prompt_build` (auto-recall on) |
| `register-maintenance-hook.js` | `before_prompt_build` (auto-recall off) |
| `register-capture-hook.js` | `agent_end` auto-capture, `before_compaction` checkpoint |
| `plugin.js` | `register()` itself (Task 13b): validates the registration dependencies, builds `HostServices` with the OpenClaw-only `capabilities`, calls `createEngine(host, config)`, then makes every registration below in the old order; also the reply-outcome `agent_end` / `before_prompt_build` pair and `/wiki` |
| `register-commands.js` | the 15 `plur1bus_*` commands, `/state`, `/enable`, `/disable`, the control-UI descriptor and control-health pair, the critical-push claiming hooks, the four `lib/setup/*-plugin-runtime.js` delegations, and `skill_proposal_changed` (`registerSkillProposalListener`) |
| `register-tools.js` | the five model-facing tools, and the memory-slot runtime (`registerMemoryCapability`) |
| `register-prompt-supplements.js` | the static system-prompt supplement and the Neo corpus supplement |
| `register-gateway.js` | a lone `gateway_start` (Neo warm-up) plus two `gateway_start`/`gateway_stop` pairs (Obsidian bridge, Neo service), the shutdown owner and the four after-lifecycle service registrations |
| `register-cron.js` | the unsafe direct feature-cron guard and the deferred feature-cron bootstrap |
| `join-recall.js` | `prependContextFromRecall` — the host's join-and-cap step over `RecallResult` (`lib/inject-budget.js`'s `applyGlobalInjectBudget`), producing the `{ prependContext }` shape `before_prompt_build` expects |
| `turn-principal.js` | resolves a `Principal`/`AgentContext` from an OpenClaw hook's own arguments, for the recall/capture/command paths that need one |
| `host-probes.js` | OpenClaw-specific capability probing (`typeof api.X === "function"` checks) used while building `host.capabilities` during registration |

## Registration order is part of the contract

Each moved range keeps its **original call position** inside `register()`, and
`register-gateway.js` / `register-cron.js` therefore export one function per
range rather than the single `registerGatewayLifecycle` / `registerFeatureCronHooks`
the extraction plan sketched. The host keeps one handler list per event name in
registration order, and folding several ranges into one call site would reorder
those lists:

- `register-commands.js` registers the control-health `gateway_start`/`gateway_stop`
  pair **between** the Obsidian bridge pair and the Neo service pair.
- the deferred feature-cron `gateway_start` handler is registered **between**
  the Obsidian bridge pair and the Neo service pair as well.
- `tests/critical-review-command.test.js` reads the *last* registered
  `before_agent_reply` handler, which is only the critical-reply handler
  because the unsafe-cron guard is registered long before the chat commands.

Two timeout budgets must survive every future move:

- `gateway_stop` is registered with `timeoutMs: 30_000`. The host default is
  5 000 ms, under which in-flight LanceDB writes are lost
  (`lib/runtime-shutdown.js:308`, host-contract §a.1).
  `tests/adapter-register-gateway.test.js` pins it.
- the Neo worker warm-up takes `timeoutMs: 5_000` because the handler only arms
  an unref'd 20 s timer; the work itself happens outside any turn.

`registerGatewayShutdownServices(...)` must stay the **last** statement of
`register()`: lifecycle ownership is taken after every hook and capability
registration, and the four `…AfterLifecycle` calls must follow
`registerGatewayShutdown` because they consume its return value as
`lifecycleRegistered`. A regression here shows up as a hung `npm test` or a
leaked handle, not as an assertion failure.

## After Task 13b (M1b-1 step 9, part 2)

`index.js` is the entry shell (`openclaw.plugin.json` `extensions` and
`package.json` `main` point at it; the default export and the 19 named exports
stay importable from it). `register()` is `plugin.js` here, and every object
it used to build is constructed by `engine/create-engine.js` and held in one
`EngineInternals` (`engine/internals.js`), which `plugin.js` reads through
`internalsOf(engine)` — the transitional seam PR-14 removes.

The OpenClaw-only construction inputs the old `register()` read off `api`
travel as `host.capabilities`, built in `plugin.js`: `registrationMode`,
`coordinatesLocalModelGeneration`, `resolvePath`, `cronDirectDispatchReady`,
`skillWorkshop`, `detectReactions`, `createEmbeddingSelectionMutator`,
`configMutationNotice`, `resolveNeoHooksConfig`, `pushCriticalButtons`
(7.16.10: classify-recent's Telegram button push over the host's outbound
adapter; `null` until `register-commands.js` has registered the click
handler), and the test-injection
`commandRuntimeHooks` and `handleObsidianBridgeCommand` (the `shareCard`
test injection stays in `plugin.js`, which hands it to `registerChatCommands`).
`api.config` inside the engine became `host.config()`.

From Task 13c the recall, capture and tool contexts are the engine's own
registration views (`internals.recallContext`, `captureContext`,
`toolContext`), which `plugin.js` spreads with `api`. The capture handler and
the tool factory are built once by the engine (`internals.getCaptureTurn()`,
`internals.getToolFactory()`) and shared with `Engine.capture` and
`Engine.tools`; the recall hook keeps its own assembler because it carries the
adapter's turn-principal resolver. `plugin.register(api, { engineInternals })`
is the test-only path to `createEngine`'s `testOptions.internals` (the golden
driver hands it its stub embedder).

What still reads `api` in this directory, and why:

| Site | Why it stays here | Owner |
|---|---|---|
| `runOperatorCommand` and the `registerPluginCommand` registry (`plugin.js`) | They wrap `api.registerCommand`'s specs; `runOperatorCommand` hands handlers `api.config` exactly as a channel would. | PR-04 |
| `/wiki` (`plugin.js`) | Registered through `registerPluginCommand`, not the command table; still passes `api` to `runWikiCommand`. | PR-04 |
| reply-outcome recording (`agent_end`) and completion (`before_prompt_build`) (`plugin.js`) | Both fold into `Engine.capture`'s close-out (`engine-extraction.md` §a.1). | PR-04 |
| `skill_proposal_changed` (`register-commands.js`) | Optional host capability; becomes `Host.onSkillProposalChanged`. | PR-04 |
| the control-UI descriptor and the control-health pair (`register-commands.js`) | Inside the same `registerGatewayMethod` block that builds the projection callback. | PR-13 |
| the critical-push claiming hooks (`register-commands.js`) | Map to a new `Host.registerTurnInterceptor`. | PR-04 |

The engine's close path is `engine/lifecycle/close-resources.js`
(`createResourceCloser`, idempotent). `registerGatewayShutdownServices` hands
that one closer to `registerGatewayShutdown`, so the host's runtime-lifecycle
cleanup, its `gateway_stop` handler and `Engine.close({ budgetMs })` share one
promise.

## Still adapter-owned after M1b-1

Everything PR-03 through Task 13c could move out of `index.js` has moved.
What is left is deliberately still here — each item is a command body, a
host-shaped probe, or a hook OpenClaw itself has no equivalent contract
member for yet, not an oversight:

| Site | Why it stays here | Owner |
|---|---|---|
| the six user-facing command bodies (`/state`, `/enable`, `/disable`, `/forget`, `/correct`, `plur1bus setup`) — `register-commands.js`, called by `plugin.js`'s `commandBodies` | `Engine.runCommand` dispatches only `"plur1bus"` and needs a host command surface (`commandBodies.checkArgsLength` etc.) to answer anything beyond `commands-unavailable`; the bodies themselves — auth, locale, the actual command logic — are still adapter-built, not engine-owned. | PR-04 |
| `/wiki` (`plugin.js`) | Registered through the local `registerPluginCommand` helper, not `registerChatCommands`'s command table; its handler closes over the wiki LLM route and the plugin-command handler map. It is the only chat command still registered from the adapter shell rather than `register-commands.js`. | PR-04 |
| the critical-push claiming hooks (`before_dispatch` / `before_agent_reply`, `register-commands.js`) | A claiming hook short-circuits the whole turn and has no host timeout; `engine-extraction.md` §a.1 maps it to a new `Host.registerTurnInterceptor`, a harness feature the contract does not have yet. | PR-04 |
| the control-UI descriptor and the control-health `gateway_start`/`gateway_stop` pair (`register-commands.js`) | Sit inside the same `registerGatewayMethod` block that builds the projection callback; control UI is its own future package. | PR-13 |

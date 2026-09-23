# The OpenClaw adapter

Every `api.on` / `api.register*` call that PR-03 could move lives here. Engine
code never touches the OpenClaw `api` surface —
`scripts/lint-no-api-outside-adapter.mjs` enforces that, and
`scripts/lint-engine-imports.mjs` enforces that `engine/**` never imports the
host, `index.js`, or itself in a cycle.

Both lint rules are **text** rules. The engine rule matches `api.` anywhere
outside a string, so an `engine/**` module may not spell `api.` even in a
comment that is describing the adapter. Write "the host's `registerTool`"
instead.

| Module | Registers |
|---|---|
| `register-turn-route.js` | `reply_dispatch`, `agent_end` run cleanup |
| `register-recall-hook.js` | `before_prompt_build` (auto-recall on) |
| `register-maintenance-hook.js` | `before_prompt_build` (auto-recall off) |
| `register-capture-hook.js` | `agent_end` auto-capture |
| `register-commands.js` | the 15 `plur1bus_*` commands, `/state`, `/enable`, `/disable`, the control-UI descriptor and control-health pair, the critical-push claiming hooks, and the four `lib/setup/*-plugin-runtime.js` delegations |
| `register-tools.js` | the five model-facing tools |
| `register-prompt-supplements.js` | the static system-prompt supplement and the Neo corpus supplement |
| `register-gateway.js` | the three `gateway_start`/`gateway_stop` pairs, the shutdown owner and the four after-lifecycle service registrations |
| `register-cron.js` | the unsafe direct feature-cron guard and the deferred feature-cron bootstrap |

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

## Deliberately still in `index.js` after M1a

Line numbers are against `index.js` at the end of PR-03 (7 805 lines).

| Site | Line(s) | Why it stays | Owner |
|---|---|---|---|
| `const plugin = { … }` and `export default plugin` | `4399-7802`, `7805` | `openclaw.plugin.json` declares `extensions: ["./index.js"]` and `package.json:main` is `./index.js`; 46 test files import the default and the named exports from there. Moving the factory goes with the package rename. | PR-14 |
| `api.registerMemoryCapability` | `4458-4535` | Builds `createMemoryHostRuntime` from closures over `baseDbPath`, `embeddings`, `pool`, `controlHealth`, `memoryDbAdapter`, `reranker` — all created hundreds of lines later in `register()`. Splitting it needs an `Engine` object to close over instead. | PR-04 |
| the five top-level functions that keep their own `api` parameter: `resolveNeoHooksConfig` (`3320`), `inspectCronNativeCapabilities` (`3421`), `reconcileUnsafeDirectCronsWithService` (`3465`), `runDeferredFeatureCronBootstrap` (`3534`), `makeReactionsCapabilityChecker` (`4244`) | as listed | Four of the five are on the frozen named-export list (`index.js:7804`) that 46 test files import; all five take the host handle as their *own* first parameter rather than reading a closure, so they are host-shaped helpers, not registrations. `register-cron.js` receives three of them through `ctx`. | PR-04 (`Host` methods) |
| the `/wiki` chat command | `7377-7425` | Task 16's boundary: `/wiki` is registered through the local `registerPluginCommand` helper (`7057-7062`) rather than through `registerChatCommands`'s command table, and its handler closes over the wiki LLM route and the plugin-command handler map. It is the only chat command still registered from `index.js`. | PR-04 |
| the six user-facing command bodies and their helpers now inside `register-commands.js` (`/state`, `/enable`, `/disable`, `/forget`, `/correct`, `plur1bus setup`) | `adapter/openclaw/register-commands.js` | They moved out of `index.js` in Task 16 but are still *command bodies*, not registrations: the adapter should keep only the `api.registerCommand` calls and hand the bodies to the engine. | PR-04 |
| the bare `{ … }` grouping block around the command/supplement site | `7043` (opens), `7429` (closes) | It scopes `resolveCommandLocale`, `registerPluginCommand`, the chat-command destructuring and `/wiki`. It declares nothing the rest of `register()` needs, so it disappears when its last resident leaves — not before. | PR-04 |
| `skill_proposal_changed` | `5883-5949` | Optional host capability, guarded by `typeof api.on === "function"`; it becomes `Host.onSkillProposalChanged`. | PR-04 |
| reply-outcome recording (`agent_end`) and completion (`before_prompt_build`) | `7501-7520`, `7645-7682` | Both fold into `Engine.capture`'s close-out (`engine-extraction.md` §a.1); relocating them first would create a third hook pair that PR-04 immediately deletes. | PR-04 |
| the `typeof api.registerGatewayMethod === "function" && typeof api.registerCli === "function"` probe for the skill workshop | `4540-4545` | A capability *probe* that produces a value (`openClawSkillWorkshop`) consumed all over `register()`, not a registration. It becomes a `Host` capability flag. | PR-04 |
| `api.config` / `api.pluginConfig` / `api.registrationMode` / `api.resolvePath` reads | `4442`, `4446-4447`, `4454`, `4465`, `4548`, `4823`, `5146`, `5867`, `6046`, `7280`, `7290` | Configuration and path reads, not registrations. `createHostServices(api)` (`4456`) already wraps the logger, runtime and state dir; these are the reads Task 7 did not cover. | PR-04 (`Host.config`) |
| the four one-line `lib/setup/*-plugin-runtime.js` delegations (`registerWorkspacePolicyRuntime`, `registerObsidianVaultRuntime`, `registerReembeddingRuntime`, `registerFeatureCronNativeDispatch`) | now in `register-commands.js:122`, `:377` and below | Already one-line delegations into `lib/setup/`; wrapping a one-line call in another module buys nothing. Listed here because the plan's table still places them in `index.js`. | — |
| the control-UI descriptor and the control-health `gateway_start`/`gateway_stop` pair | now in `register-commands.js:621-622` | Moved with the command surface in Task 16, not with the gateway lifecycle, because they sit inside the same `registerGatewayMethod` block that builds the projection callback. | PR-13 (own package) |
| the critical-push claiming hooks (`before_dispatch` / `before_agent_reply`) | now in `register-commands.js:1141-1143` | A claiming hook short-circuits the whole turn and has no host timeout; `engine-extraction.md` §a.1 maps it to a new `Host.registerTurnInterceptor`, which is a harness feature rather than a move. | PR-04 |

After PR-03 there are **47** `api` references left in `register()`, in the
groups above. None of them is an `api.on` or `api.register*` call that a plain
relocation could move: every one either produces a value the rest of
`register()` consumes, or belongs to a subsystem an explicitly named later PR
owns.

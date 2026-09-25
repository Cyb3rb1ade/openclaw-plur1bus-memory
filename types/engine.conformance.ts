/**
 * types/engine.conformance.ts — compile-only assertions.
 *
 * A .d.ts on its own barely type-checks anything: this file makes
 * `npm run typecheck` fail if the contract drifts from the decisions
 * frozen in B8, or from the shapes the two adapters rely on. It is never
 * imported at runtime and emits nothing.
 */

import type {
  AgentContext, CaptureHandle, CheckpointReason, ContextBlock, ContractVersion,
  Deferral, Degraded, Engine, EngineConfig, EngineEventName, HostServices,
  HostCapabilities, JobName, JobRegistry, JobRun, JobTrigger, MemoryOps, MemoryOpErrorCode,
  Principal, RecallQuery, RecallResult, RecallTiming, TurnOrigin, TurnRecord,
} from "./engine.js";
import type { createEngine } from "./engine.js";

/** Compile-time equality assertion.
 *
 *  The invariance form, not a two-way `extends`. A mutual-assignability check
 *  passes when either side is widened to `any` (`any` is assignable both
 *  ways), so `trust: any` would have satisfied the old `Exact`. Comparing two
 *  identically-shaped generic signatures instead makes the checker test type
 *  *identity*, which `any` fails in both directions. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertTrue<T extends true>(): void { void 0 as unknown as T; }

// B8 decision 1: trust, not proof.
assertTrue<Exact<Principal["trust"], "proved" | "inferred">>();

// B8 decision 2: TurnOrigin is a string union and AgentContext is separate.
assertTrue<Exact<TurnOrigin, "user" | "cron" | "subagent" | "heartbeat" | "system">>();
assertTrue<Exact<AgentContext["origin"], TurnOrigin>>();
assertTrue<Exact<AgentContext["background"], boolean>>();

// B8 decision 3: capture is non-blocking.
assertTrue<Exact<ReturnType<Engine["capture"]>, CaptureHandle>>();

// B8 decision 4: degraded is a structured object or null, never a boolean.
assertTrue<Exact<RecallResult["degraded"], Degraded | null>>();

// The six named blocks and their droppability are the engine's output shape.
const blocks: ContextBlock[] = [
  { name: "neo", text: "", droppable: true, chars: 0 },
  { name: "start", text: "", droppable: true, chars: 0 },
  { name: "memories", text: "", droppable: true, chars: 0 },
  { name: "time", text: "", droppable: false, chars: 0 },
  { name: "temporal", text: "", droppable: false, chars: 0 },
  { name: "reminder", text: "", droppable: false, chars: 0 },
];
void blocks;

// The recall signal is mandatory (host-contract f.1).
declare const query: RecallQuery;
assertTrue<Exact<(typeof query)["signal"], AbortSignal>>();
declare const turn: TurnRecord;
assertTrue<Exact<(typeof turn)["signal"], AbortSignal>>();

// A job run always carries an outcome, including the skip and incomplete paths.
// 1.4.0: five outcomes, abandoned included.
declare const run: JobRun;
assertTrue<Exact<(typeof run)["outcome"], "completed" | "skipped" | "incomplete" | "failed" | "abandoned">>();
// 1.4.0: JobRun is the union of the 1.2.0 and spec 3.3 field sets.
assertTrue<Exact<(typeof run)["runId"], string>>();
assertTrue<Exact<(typeof run)["phase"], "light" | "rem" | "deep" | null>>();
assertTrue<Exact<(typeof run)["trigger"], JobTrigger>>();
assertTrue<Exact<(typeof run)["finishedAt"], number>>();
assertTrue<Exact<(typeof run)["attempt"], number>>();
assertTrue<Exact<(typeof run)["cost"]["ms"], number>>();
assertTrue<Exact<(typeof run)["counts"], Record<string, number>>>();
// A run triggered by capture (light-dream) is distinguishable from cron/manual/harness.
// 1.4.1: "unknown" marks a crash row recovered from a corrupt start marker.
assertTrue<Exact<JobTrigger, "cron" | "manual" | "harness" | "capture" | "unknown">>();
// 1.4.0: the spec's option shapes for run() and history().
assertTrue<Exact<NonNullable<Parameters<JobRegistry["run"]>[2]>["trigger"], JobTrigger | undefined>>();
assertTrue<Exact<Parameters<JobRegistry["history"]>[1], { job?: JobName; since?: number; limit?: number } | undefined>>();

// 1.4.0: deferral kinds and the timing object replace the untyped timings map.
declare const result: RecallResult;
assertTrue<Exact<(typeof result)["deferrals"], Deferral[]>>();
assertTrue<Exact<(typeof result)["deferrals"][number]["kind"], "clipped" | "dropped">>();
assertTrue<Exact<(typeof result)["deferrals"][number]["reason"], "global-cap" | "memories-cap">>();
assertTrue<Exact<Deferral["block"], ContextBlock["name"]>>();
assertTrue<Exact<Deferral["from"], number>>();
assertTrue<Exact<Deferral["to"], number>>();
assertTrue<Exact<keyof Deferral, "block" | "kind" | "from" | "to" | "reason">>();
assertTrue<Exact<(typeof result)["timing"], RecallTiming>>();
assertTrue<Exact<(typeof result)["timing"]["totalMs"], number>>();
assertTrue<Exact<(typeof result)["timing"]["phases"], Record<string, unknown> | null>>();
// timings (1.2.0) is gone.
assertTrue<Exact<"timings" extends keyof RecallResult ? true : false, false>>();
// Every block reports its length.
assertTrue<Exact<ContextBlock["chars"], number>>();
// The recall budget is optional and partial.
assertTrue<Exact<RecallQuery["budget"], Partial<{ softMs: number; hardMs: number; capChars: number }> | undefined>>();

// 1.4.0: CheckpointReason is the widened union.
assertTrue<Exact<CheckpointReason, "compaction" | "session-end" | "shutdown" | "manual">>();

// 1.4.0: close takes an optional budget; createEngine takes an optional test-only third argument.
assertTrue<Exact<Parameters<Engine["close"]>, [opts?: { budgetMs?: number }]>>();
assertTrue<Exact<Parameters<typeof createEngine>[2], { internals?: Record<string, unknown> } | undefined>>();
assertTrue<Exact<ReturnType<typeof createEngine>, Engine>>();
assertTrue<Exact<Engine["contract"], ContractVersion>>();
assertTrue<Exact<ContractVersion, "1.5.0">>();

// 1.5.0: typed MemoryOps surface (E1 Task 2).
assertTrue<Exact<Engine["memory"], MemoryOps>>();
assertTrue<Exact<MemoryOpErrorCode, "not-found" | "denied" | "invalid-input" | "approval-required" | "conflict" | "storage">>();
assertTrue<Exact<MemoryOps["list"], (q: import("./engine.js").MemoryListQuery, p: Principal, a: AgentContext) => Promise<import("./engine.js").MemoryListResult>>>();
assertTrue<Exact<MemoryOps["show"], (id: string, p: Principal, a: AgentContext) => Promise<import("./engine.js").MemoryCard>>>();
assertTrue<Exact<MemoryOps["forget"], (id: string, p: Principal, a: AgentContext) => Promise<import("./engine.js").MemoryForgetResult>>>();
assertTrue<Exact<MemoryOps["correct"], (id: string, newText: string, p: Principal, a: AgentContext) => Promise<import("./engine.js").MemoryCorrectResult>>>();
assertTrue<Exact<MemoryOps["share"], (id: string, target: "workspace" | "user", p: Principal, a: AgentContext, opts?: { allowSensitive?: boolean }) => Promise<import("./engine.js").MemoryShareResult>>>();
assertTrue<Exact<MemoryOps["state"], (p: Principal, a: AgentContext) => Promise<import("./engine.js").MemoryState>>>();
// E1 Task 7 fix round 1 (E1-R11): tombstones is number | null — null means
// the registry was unreadable, never laundered into "zero tombstones".
assertTrue<Exact<import("./engine.js").MemoryState["tombstones"], number | null>>();
// The channel registry and the three new engine events.
assertTrue<Exact<ReturnType<Engine["channels"]["list"]>, string[]>>();
assertTrue<Exact<Extract<EngineEventName, `recall.${string}`>, "recall.degraded" | "recall.block-clipped" | "recall.block-dropped" | "recall.completed">>();

// A minimal host satisfies HostServices: everything optional stays optional.
const minimalHost: HostServices = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  stateDir: "/tmp/plur1bus",
  configPath: () => "/tmp/plur1bus/openclaw.json",
  workspaceDir: async () => undefined,
  config: (): EngineConfig => ({}),
  platform: {
    securePath: () => ({ applied: true, mechanism: "chmod" }),
    ipcAddress: () => ({ kind: "unix-socket", address: "/tmp/plur1bus/owner.sock" }),
    isUnsafeLink: () => false,
    canonicalIdentityPath: (p: string) => p,
  },
  runtime: null,
};
void minimalHost;

// 1.3.0: routing and path overrides are optional host capabilities.
const hostWithRouting: HostServices = { ...minimalHost, routing: async () => ({}), pathOverrides: { openclawHome: () => undefined } };
void hostWithRouting;

// 1.4.0: capabilities is optional and open; its two named members are typed.
const hostWithCapabilities: HostServices = { ...minimalHost, capabilities: { resolvePath: (p: string) => p, registrationMode: "full", skillWorkshop: null } };
void hostWithCapabilities;
assertTrue<Exact<NonNullable<HostServices["capabilities"]>["registrationMode"], string | undefined>>();
assertTrue<Exact<HostCapabilities["resolvePath"], ((path: string) => string) | undefined>>();

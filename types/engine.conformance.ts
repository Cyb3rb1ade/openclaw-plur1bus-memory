/**
 * types/engine.conformance.ts — compile-only assertions.
 *
 * A .d.ts on its own barely type-checks anything: this file makes
 * `npm run typecheck` fail if the contract drifts from the decisions
 * frozen in B8, or from the shapes the two adapters rely on. It is never
 * imported at runtime and emits nothing.
 */

import type {
  AgentContext, CaptureHandle, ContextBlock, Degraded, Engine, EngineConfig,
  HostServices, JobRun, Principal, RecallQuery, RecallResult, TurnOrigin,
  TurnRecord,
} from "./engine.js";

/** Compile-time equality assertion. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
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
  { name: "neo", text: "", droppable: true },
  { name: "start", text: "", droppable: true },
  { name: "memories", text: "", droppable: true },
  { name: "time", text: "", droppable: false },
  { name: "temporal", text: "", droppable: false },
  { name: "reminder", text: "", droppable: false },
];
void blocks;

// The recall signal is mandatory (host-contract f.1).
declare const query: RecallQuery;
assertTrue<Exact<(typeof query)["signal"], AbortSignal>>();
declare const turn: TurnRecord;
assertTrue<Exact<(typeof turn)["signal"], AbortSignal>>();

// A job run always carries an outcome, including the skip and incomplete paths.
declare const run: JobRun;
assertTrue<Exact<(typeof run)["outcome"], "completed" | "skipped" | "failed" | "incomplete">>();

// A minimal host satisfies HostServices: everything optional stays optional.
const minimalHost: HostServices = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  stateDir: "/tmp/plur1bus",
  workspaceDir: () => undefined,
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

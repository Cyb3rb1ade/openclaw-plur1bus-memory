/**
 * types/engine.d.ts — the frozen PLUR1BUS engine contract.
 *
 * Contract version 1.0.0 (frozen 2026-09-22, owner decision B8).
 *
 * This file reconciles the four places Phase 0 sketched the same API
 * differently (review-report finding S4). Where ADR-002 and
 * engine-extraction.md §b.2 disagreed, B8 chose:
 *   - `Principal.trust: "proved" | "inferred"`   (not `proof: "transport"`)
 *   - `TurnOrigin` as a string union plus a separate `AgentContext`
 *     (not one `TurnOrigin` object)
 *   - `capture()` returns a non-blocking `CaptureHandle`
 *     (not `Promise<CaptureResult>`)
 *   - `RecallResult.degraded` is a structured object or null
 *     (not a boolean)
 *
 * Nothing in this file is implemented in M1a. It is the shape both the
 * OpenClaw adapter and the harness are written against, and it is checked
 * by `npm run typecheck`.
 */

export type ContractVersion = "1.0.0";

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** Matches /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ (memory-host-runtime.js:30). */
export type AgentId = string;

export type WorkspacePrincipal = `workspace:v1:${string}` | `workspace-dir:v1:${string}`;

/** `user:v1:` + sha256(JSON.stringify([channel, accountId, userId])).
 *  The hash is the on-disk pool directory name and must not change
 *  (memory-request-context.js:302-304). */
export type UserPrincipal = `user:v1:${string}`;

export type ChatKind = "direct" | "dm" | "group" | "channel";

/** Open vocabulary, host-declared. Replaces the closed four-value set at
 *  memory-request-context.js:24-25. */
export type ChannelRef = string;

export type TurnOrigin = "user" | "cron" | "subagent" | "heartbeat" | "system";

export type SchemaVersion = string;

export interface Disposable {
  dispose(): void;
}

export interface Logger {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  debug(message: string, ...rest: unknown[]): void;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export interface Principal {
  agentId: AgentId;
  workspace: WorkspacePrincipal;
  /** Absent means the `user` ACL scope is unreachable
   *  (acl-middleware.js:139-159). Never accepted from an untrusted host. */
  user?: UserPrincipal;
  channel: ChannelRef;
  accountId: string;
  chat: { id: string; kind: ChatKind };
  /** "inferred" degrades every read and write to agent-private and never
   *  throws (memory-request-context.js:1405-1417). */
  trust: "proved" | "inferred";
}

export interface AgentContext {
  origin: TurnOrigin;
  /** Fail-closed: unknown means true. */
  background: boolean;
  jobId?: string;
  parentRunId?: string;
}

/* ------------------------------------------------------------------ */
/* What the host gives the engine                                      */
/* ------------------------------------------------------------------ */

export interface SecretStore {
  /** Short-lived; the engine never persists the value. */
  lease(ref: string): Promise<string>;
}

export interface LlmParams {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface PlatformCapabilities {
  securePath(path: string, options?: { mode?: number }): SecurePathResult;
  ipcAddress(stateRoot: string): IpcAddress;
  isUnsafeLink(path: string): boolean;
  canonicalIdentityPath(path: string): string;
}

export interface SecurePathResult {
  applied: boolean;
  reason?: "not-a-filesystem-path" | "missing" | "unsupported-platform";
  mechanism?: "chmod" | "acl";
}

export interface IpcAddress {
  kind: "abstract-socket" | "unix-socket" | "named-pipe";
  address: string;
}

/** `HostServices` is the name used in engine-extraction.md §b.2; ADR-002
 *  calls the same interface `Host`. They are one type. */
export interface HostServices {
  logger: Logger;
  /** Replaces OPENCLAW_HOME (index.js:12425). */
  stateDir: string;
  /** Replaces memory-host-runtime.js:104-111. A harness agent without a real
   *  workspace gets a synthetic one under `stateDir` (engine-extraction R7). */
  workspaceDir(agentId: AgentId): string | undefined;
  config(): EngineConfig;
  mutateConfig?(patch: Record<string, unknown>): Promise<void>;
  llm?: { complete(params: LlmParams): Promise<LlmResult> };
  secrets?: SecretStore;
  events?: { emit(name: string, payload: unknown): void };
  /** Test seam; defaults to Date.now. */
  clock?: () => number;
  platform: PlatformCapabilities;
  /** Host runtime escape hatch; `null` when the host exposes none. Replaces
   *  runtimeIfUsable(api) (runtime-shutdown.js:35). */
  runtime: HostRuntime | null;
}

export interface HostRuntime {
  config?: { current?(): unknown; mutateConfigFile?(...args: unknown[]): unknown };
  agent?: {
    resolveAgentWorkspaceDir?(config: unknown, agentId: AgentId): Promise<string> | string;
    session?: { getSessionEntry?(query: unknown): unknown };
  };
  llm?: { complete?(params: unknown): Promise<unknown> };
}

/** The 56 keys of openclaw.plugin.json configSchema. Kept open in 1.0.0 so
 *  the contract does not have to move every time a key is added. */
export interface EngineConfig {
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Recall                                                              */
/* ------------------------------------------------------------------ */

export type ContextBlockName = "neo" | "start" | "memories" | "time" | "temporal" | "reminder" | (string & {});

export interface ContextBlock {
  name: ContextBlockName;
  text: string;
  droppable: boolean;
  tokensEstimate?: number;
}

export interface RecallBudget {
  softMs: number;
  hardMs: number;
  capChars: number;
}

export interface RecallQuery {
  query: string;
  principal: Principal;
  agent: AgentContext;
  budget: RecallBudget;
  /** MANDATORY from PR-05. Fixes host-contract §f.1. */
  signal: AbortSignal;
  compactedAt?: number | null;
  previousUserTurnAt?: number | null;
  validAt?: string;
}

export interface Degraded {
  reason: string;
  capability: string;
  detail?: string;
}

export interface DecisionTrace {
  [key: string]: unknown;
}

export interface RecallResult {
  blocks: ContextBlock[];
  capChars: number;
  /** null means not degraded. Structured, never a bare boolean (B8). */
  degraded: Degraded | null;
  trace?: DecisionTrace;
  timings: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Capture and checkpoint                                              */
/* ------------------------------------------------------------------ */

export interface TurnRecord {
  agentId: AgentId;
  principal: Principal;
  agent: AgentContext;
  messages: Message[];
  runId?: string;
  sessionKey?: string;
  /** Classified by the host, fail-closed. */
  incognito: boolean;
  signal: AbortSignal;
}

export interface CaptureResult {
  stored: number;
  skipped: number;
  reason?: string;
}

/** Non-blocking by contract (B8, ADR-002 "capture returns in < 5 ms"): the
 *  caller gets the handle immediately and may await `done` or abandon it. */
export interface CaptureHandle {
  id: string;
  acceptedAt: number;
  done: Promise<CaptureResult>;
  abort(reason?: string): void;
}

export type CheckpointReason = "compaction" | "shutdown" | "manual";

export interface CheckpointResult {
  agentId: AgentId;
  reason: CheckpointReason;
  /** Idempotency key over the transcript digest. */
  digest: string;
  written: boolean;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export type JobName =
  | "persona-evolve" | "afterthought" | "consolidate-daily" | "auto-accept-stale"
  | "embedding-drain" | "emotion-refine" | "classify-recent" | "rem-dream"
  | "skill-miner" | "discover-semantic-links" | "gc-run"
  | "reminder-dispatch" | "feedback-report" | "proactive-check" | "meta-reflect"
  | "skill-benefit-backfill" | "episodes-rebuild"
  | "light-dream";

export interface JobSpec {
  name: JobName;
  needsLlm: boolean;
  singleton: boolean;
  defaultSchedule?: { kind: "cron" | "every"; expr: string; timezone?: string };
  phase?: "light" | "rem" | "deep";
}

export interface JobRun {
  job: JobName;
  agentId: AgentId;
  partition?: string;
  startedAt: number;
  durationMs: number;
  outcome: "completed" | "skipped" | "failed" | "incomplete";
  reason?: string;
  counts: Record<string, number>;
  logRef?: string;
}

export interface JobRegistry {
  list(): JobSpec[];
  run(job: JobName, agentId: AgentId, opts?: { signal?: AbortSignal; dryRun?: boolean }): Promise<JobRun>;
  history(agentId: AgentId, job?: JobName, limit?: number): Promise<JobRun[]>;
}

/* ------------------------------------------------------------------ */
/* Embedding                                                           */
/* ------------------------------------------------------------------ */

export interface EmbeddingIdentity {
  fingerprintId: string;
  provider: string;
  model: string;
  dimensions: number;
}

export interface RerankHit {
  index: number;
  score: number;
}

export interface EmbeddingService {
  embed(texts: string[], o: { kind: "query" | "passage"; identity: EmbeddingIdentity; signal: AbortSignal }): Promise<Float32Array[]>;
  rerank(query: string, docs: string[], o: { topN: number; signal: AbortSignal }): Promise<RerankHit[]>;
  probe(): Promise<{ ok: boolean; error?: string; cached: boolean }>;
  identities(): EmbeddingIdentity[];
  serve(address: IpcAddress): Promise<Disposable>;
}

/* ------------------------------------------------------------------ */
/* Tools, commands, admin, events                                      */
/* ------------------------------------------------------------------ */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CommandSpec {
  name: string;
  description: string;
  acceptsArgs: boolean;
}

export interface CommandResult {
  text?: string;
  details?: Record<string, unknown>;
}

export interface ShareResult { id: string; targetId: string; reembedded: boolean }
export interface ForgetResult { id: string; archived: boolean; tombstoneId: string }
export interface MigrationResult { from: SchemaVersion; to: SchemaVersion; applied: boolean }

export interface AdminOps {
  share(sourceId: string, target: "workspace" | "user", p: Principal, confirm: { nonce: string }): Promise<ShareResult>;
  forget(id: string, p: Principal): Promise<ForgetResult>;
  reembedding: {
    plan(): Promise<unknown>; apply(): Promise<unknown>; resume(): Promise<unknown>;
    rollback(): Promise<unknown>; status(): Promise<unknown>; switch(): Promise<unknown>;
  };
  workspacePolicy: { get(): Promise<unknown>; list(): Promise<unknown>; set(patch: unknown): Promise<unknown> };
  obsidian: { detect(): Promise<unknown>; prepare(): Promise<unknown>; confirm(): Promise<unknown> };
  migrate(from: SchemaVersion, to: SchemaVersion): Promise<MigrationResult>;
}

export type EngineEventName =
  | "dream.completed" | "job.run" | "acl.denied" | "recall.degraded" | "embedding.identity.changed";

export interface EngineEvents {
  on(event: EngineEventName, handler: (payload: unknown) => void): Disposable;
}

export interface EngineStatus {
  ready: boolean;
  degraded: Degraded | null;
  agents: number;
  contract: ContractVersion;
}

export interface AgentStore {
  agentId: AgentId;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

export interface Engine {
  readonly contract: ContractVersion;

  open(agentId: AgentId): Promise<AgentStore>;
  close(): Promise<void>;
  status(): Promise<EngineStatus>;

  /** Stable, cached prefix (index.js:7073-7088). */
  systemSupplement(): string[];
  /** Never throws; a failure comes back as `degraded`. */
  recall(q: RecallQuery): Promise<RecallResult>;
  /** Non-blocking. */
  capture(t: TurnRecord): CaptureHandle;
  checkpoint(agentId: AgentId, reason: CheckpointReason): Promise<CheckpointResult>;

  tools: ToolSpec[];
  commands: CommandSpec[];
  runCommand(name: string, args: string, principal: Principal, agent: AgentContext): Promise<CommandResult>;

  jobs: JobRegistry;
  embedding: EmbeddingService;
  admin: AdminOps;
  events: EngineEvents;
}

export declare function createEngine(host: HostServices, config: EngineConfig): Engine;

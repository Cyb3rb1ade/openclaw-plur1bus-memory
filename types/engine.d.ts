/**
 * types/engine.d.ts — the frozen PLUR1BUS engine contract.
 *
 * Contract version 1.6.0 (frozen at 1.0.0 on 2026-09-22, owner decision B8;
 * amended seven times under the policy below — see the changelog at the end
 * of this header).
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
 * `createEngine` (engine/create-engine.js) implements it from M1b-1 on. It is
 * the shape both the OpenClaw adapter and the harness are written against,
 * and it is checked by `npm run typecheck`.
 *
 * Amendment policy: "frozen" means 1.0.0 is never edited in place. Any change
 * to an exported member's shape that an existing adapter could observe — a new
 * required property, a removed or renamed member, a narrowed or widened union,
 * a changed parameter or return type — forces a `ContractVersion` bump; only
 * additions no adapter can observe (a comment, a new optional property on a
 * type the engine alone constructs) may land without one.
 * `ContractVersion`, the assertions in `types/engine.conformance.ts` and both
 * adapters move together in a single PR, so the contract, its gate and its two
 * consumers are never in disagreement at any commit.
 *
 * Changelog: 1.1.0 — SecurePathResult.reason gains "acl-tool-unavailable" (Task 5).
 *            1.2.0 — HostServices.workspaceDir becomes async (Task 6).
 *            1.3.0 — HostServices.configPath(), HostServices.routing?, HostServices.pathOverrides? (G1 closure, M1b-1 Task 11).
 *            1.4.0 — Engine surface of createEngine (M1b-1): ContextBlock.chars; RecallResult.timing (replaces timings) and .deferrals; RecallQuery.budget optional; JobRun/JobRegistry/JobSpec per spec 3.3 (outcome gains "abandoned"); CheckpointReason gains "session-end"; Engine.close({ budgetMs }); Engine.channels; HostServices.capabilities?; EngineEventName gains recall.block-clipped/-dropped, recall.completed; createEngine testOptions.
 *            1.4.1 — JobTrigger gains "unknown" (a crash row recovered from a corrupt, unreadable start marker; M1b-1 final review m2).
 *            1.5.0 — MemoryOps types, Engine.memory (E1 Task 2); runCommand deprecated; MemoryState.tombstones number | null (E1-R11); HostCapabilities.memoryArchiveDir? (E1 Task 8).
 *            1.6.0 — AdminOps.share/forget alias Engine.memory (deprecated); ObsidianOps with explicit paths; migrate over a store schema marker; MemoryOps.propose/proposals (D31); MemoryCard.sharedBy/sourceId; MemoryOpError.detail; "memory.proposal" event; EngineStatus.storeSchema (E2).
 */

export type ContractVersion = "1.6.0";

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
  reason?: "not-a-filesystem-path" | "missing" | "unsupported-platform" | "acl-tool-unavailable";
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
  /** The host's config file. Replaces OPENCLAW_CONFIG_PATH reads in engine code. */
  configPath(): string;
  /** Loads the host's routing capability (four session/channel parsers).
   *  Absent: turn identity degrades to the agent's own context. */
  routing?(): Promise<unknown>;
  /** Raw path overrides lib/ defaults honour (lib/host-paths.js); absent: ~/.openclaw. */
  pathOverrides?: HostPathOverrides;
  /** Host-specific construction inputs (registration mode, path resolver,
   *  optional host features). Every one has an inert default. */
  capabilities?: HostCapabilities;
  /** Replaces memory-host-runtime.js:104-111. A harness agent without a real
   *  workspace gets a synthetic one under `stateDir` (engine-extraction R7). */
  workspaceDir(agentId: AgentId): Promise<string | undefined>;
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

export interface HostPathOverrides {
  openclawHome?(): string | undefined;
  configPathOverride?(): string | undefined;
  stateDirOverride?(): string | undefined;
}

export interface HostCapabilities {
  resolvePath?(path: string): string;
  registrationMode?: string;
  /** 1.5.0: where MemoryOps forget/correct write archive-first backups; read per call. Default `<stateDir>/memory/_archive`. */
  memoryArchiveDir?(): string;
  [capability: string]: unknown;
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
  /** `text.length`. */
  chars: number;
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
  budget?: Partial<RecallBudget>;
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

/** A block the host's joiner clipped or dropped to fit `capChars`. */
export interface Deferral {
  block: ContextBlockName;
  kind: "clipped" | "dropped";
  from: number;
  to: number;
  reason: "global-cap" | "memories-cap";
}

export interface RecallTiming {
  phases: Record<string, unknown> | null;
  totalMs: number;
  namespacePhases?: Array<{ namespace: string; phase: string; ms: number }>;
}

export interface RecallResult {
  blocks: ContextBlock[];
  /** Non-finite (Infinity) on the exits that inject an uncapped join. */
  capChars: number;
  /** null means not degraded. Structured, never a bare boolean (B8). */
  degraded: Degraded | null;
  trace?: DecisionTrace;
  timing: RecallTiming;
  deferrals: Deferral[];
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

export type CheckpointReason = "compaction" | "session-end" | "shutdown" | "manual";

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

export type JobOutcome = "completed" | "skipped" | "incomplete" | "failed" | "abandoned";

/** "unknown" only on a crash row recovered from a corrupt start marker (1.4.1). */
export type JobTrigger = "cron" | "manual" | "harness" | "capture" | "unknown";

export interface JobCost {
  ms: number;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface JobRun {
  runId: string;
  job: JobName;
  phase: "light" | "rem" | "deep" | null;
  agentId: AgentId;
  trigger: JobTrigger;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  outcome: JobOutcome;
  reason?: string;
  attempt: number;
  cost: JobCost;
  counts: Record<string, number>;
  idempotencyKey?: string;
  keys?: string[];
  pendingKeys?: string[];
  diary?: { written: boolean; reason?: string };
  migrated?: boolean;
}

export interface JobRegistry {
  list(): JobSpec[];
  /** `signal` is observed before start only (an already-aborted call is a
   *  recorded skip, reason "aborted"). `dryRun` is not supported in M1b-1:
   *  it resolves skipped/"dry_run_unsupported" without running or writing a
   *  ledger row. */
  run(job: JobName, agentId: AgentId, opts?: { signal?: AbortSignal; trigger?: JobTrigger; dryRun?: boolean }): Promise<JobRun>;
  history(agentId: AgentId, opts?: { job?: JobName; since?: number; limit?: number }): Promise<JobRun[]>;
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

/** @deprecated 1.6.0: `ShareResult`/`ForgetResult` are the MemoryOps result types; removed with 2.0 (E6). */
export type ShareResult = MemoryShareResult;
export type ForgetResult = MemoryForgetResult;
/** `applied` is false when `from === to`. Both are decimal strings ("0" = a store written before any marker existed). */
export interface MigrationResult { from: SchemaVersion; to: SchemaVersion; applied: boolean }

export interface ObsidianVaultCandidate {
  /** Absolute, normalised path. Input may be `~/…` or home-relative; the engine expands it. */
  path: string;
  /** `.obsidian/workspace.json` or `.obsidian/app.json` exists. */
  isVault: boolean;
  /** A confirmation receipt for this agent, workspace and vault exists (lib/obsidian-vault-authority.js). */
  confirmed: boolean;
  source: "config" | "workspace" | "candidate";
}
export interface ObsidianDetectResult { agentId: AgentId; vaults: ObsidianVaultCandidate[] }
export interface ObsidianPrepareResult { nonce: string; expiresAt: number; vaultPath: string; vaultDigest: string }
export interface ObsidianConfirmResult { confirmed: true; vaultPath: string; vaultDigest: string; alreadyConfirmed: boolean }

/**
 * Host-neutral Obsidian setup: explicit paths, no host runtime. `prepare` and `confirm` are
 * user-originated (`a.origin === "user"`, `a.background === false`) and need a proved principal
 * with a user; the nonce expires after 10 minutes and is consumed by the first `confirm`.
 * Every member rejects with MemoryOpError (`not-found`, `denied`, `invalid-input`, `storage`).
 */
export interface ObsidianOps {
  detect(p: Principal, a: AgentContext, opts?: { candidates?: string[] }): Promise<ObsidianDetectResult>;
  prepare(vaultPath: string, p: Principal, a: AgentContext): Promise<ObsidianPrepareResult>;
  confirm(nonce: string, p: Principal, a: AgentContext): Promise<ObsidianConfirmResult>;
}

export interface AdminOps {
  /** @deprecated 1.6.0: alias of `Engine.memory.share`; removed with 2.0 (E6). */
  share(id: string, target: "workspace" | "user", p: Principal, a: AgentContext, opts?: { allowSensitive?: boolean }): Promise<MemoryShareResult>;
  /** @deprecated 1.6.0: alias of `Engine.memory.forget`; removed with 2.0 (E6). */
  forget(id: string, p: Principal, a: AgentContext): Promise<MemoryForgetResult>;
  reembedding: {
    plan(): Promise<unknown>; apply(): Promise<unknown>; resume(): Promise<unknown>;
    rollback(): Promise<unknown>; status(): Promise<unknown>; switch(): Promise<unknown>;
  };
  workspacePolicy: { get(): Promise<unknown>; list(): Promise<unknown>; set(patch: unknown): Promise<unknown> };
  obsidian: ObsidianOps;
  /** Store schema migration (E2, variant a). Rejects with MemoryOpError: `conflict` when `from` is not the store's
   *  current version, `invalid-input` for an unknown or downgrading `to`, `storage` when the marker is unreadable. */
  migrate(from: SchemaVersion, to: SchemaVersion): Promise<MigrationResult>;
}

/** Reason codes a MemoryOps call can fail with. `not-found` also covers
 *  "exists but you may not see it" and "tombstoned" (anti-oracle). */
export type MemoryOpErrorCode =
  | "not-found" | "denied" | "invalid-input" | "approval-required"
  | "conflict" | "storage";

/** Thrown by every MemoryOps member on failure; `code` is stable, `message` is English and log-safe. */
export interface MemoryOpError extends Error {
  readonly code: MemoryOpErrorCode;
  /** 1.6.0: non-secret ids a caller needs to recover (e.g. a half-finished shared-copy refresh). */
  readonly detail?: Readonly<Record<string, string>>;
}

export type MemoryScope = "agent-private" | "workspace" | "user";

export interface MemoryCard {
  id: string;
  scope: MemoryScope;
  text: string;
  summary: string;
  createdAt: number | null;
  origin: string | null;
  epistemicStatus: string | null;
  /** Present on list results from a topic query; absent on show. */
  score?: number;
  /** 1.6.0, only on workspace/user copies: the sharing agent and its original card. */
  sharedBy?: AgentId;
  sourceId?: string;
}

export interface MemoryListQuery {
  /** Topic query (vector search, best first). Exactly one of `topic` and `since` is required. */
  topic?: string;
  /** Epoch ms lower bound for a time listing (newest first). */
  since?: number;
  /** Epoch ms upper bound; only with `since`, and not before it. Default: now. */
  until?: number;
  /** Default 20, maximum 100. */
  limit?: number;
}

export interface MemoryListResult { agentId: AgentId; items: MemoryCard[]; truncated: boolean }
export interface MemoryForgetResult { id: string; archived: boolean; tombstoneId: string | null; alreadyForgotten: boolean }
/** `id` is the id of the corrected (new, live) version — `correct` supersedes the old row, and the caller's old id is no longer live (fix round 1, E1-R8). */
export interface MemoryCorrectResult { id: string; archived: true }
export interface MemoryShareResult { sourceId: string; sharedId: string; target: "workspace" | "user" }
export interface MemoryState {
  agentId: AgentId;
  cards: { agentPrivate: number | null; workspace: number | null; user: number | null };
  /** `null` means the tombstone registry was unreadable, never "zero tombstones". */
  tombstones: number | null;
  /** The archive root (e.g. `<stateDir>/memory/_archive`); per-agent archives land in `<archiveDir>/<agentId>/`. */
  archiveDir: string;
}

export type MemoryProposalStatus = "pending" | "accepted" | "rejected" | "stale";
export interface MemoryProposal {
  id: string;
  /** The shared copy the proposal was filed against and the sharer's original behind it. */
  sharedId: string;
  sourceId: string;
  target: "workspace" | "user";
  sharerAgentId: AgentId;
  proposerAgentId: AgentId;
  oldText: string;
  newText: string;
  note: string | null;
  createdAt: number;
  status: MemoryProposalStatus;
  resolvedAt: number | null;
  /** accepted: the id of the refreshed shared copy. */
  resultId: string | null;
  resolutionNote: string | null;
}
export interface MemoryProposeResult { proposalId: string; sharedId: string; sharerAgentId: AgentId }
export interface MemoryProposalListQuery { status?: MemoryProposalStatus; /** Default 20, maximum 100. */ limit?: number }
export interface MemoryProposalListResult {
  agentId: AgentId;
  /** Proposals the agent filed or received, newest first. */
  items: MemoryProposal[];
  truncated: boolean;
  /** Proposal files that could not be parsed; never silently dropped. */
  unreadable: number;
}
/** `id` is the refreshed shared copy, `sourceId` the corrected original (both new ids). */
export interface MemoryProposalAcceptResult { proposalId: string; id: string; sourceId: string }
export interface MemoryProposalRejectResult { proposalId: string; status: "rejected" }

export interface MemoryProposalEvent {
  proposalId: string;
  status: MemoryProposalStatus;
  sharerAgentId: AgentId;
  proposerAgentId: AgentId;
  sharedId: string;
}

/**
 * Every member rejects with MemoryOpError `storage` ("engine is closed") after `Engine.close()`.
 * `list` and `show` read the agent-private pool plus the workspace and user pools the principal can reach.
 * `forget`, `correct` and `share` act on the caller's own agent-private cards. On a shared (workspace/user)
 * copy (D31): `forget` by the sharing agent retracts the copy (archive-first, soft delete; `tombstoneId` is
 * null because the original stays live); `correct` by the sharing agent refreshes it (corrects the original,
 * shares the new version, then retracts the old copy; the result id is the new copy); any other agent answers
 * `denied` and files `propose` instead; `share` of a copy is always `denied`. Proposals never change a memory
 * until the sharer calls `proposals.accept`. A proposal belongs to the shared pool of its copy: `proposals.*`
 * reach it only through a principal that can reach that pool (otherwise `list` omits it and `accept`/`reject`
 * answer `not-found`).
 */
export interface MemoryOps {
  list(q: MemoryListQuery, p: Principal, a: AgentContext): Promise<MemoryListResult>;
  show(id: string, p: Principal, a: AgentContext): Promise<MemoryCard>;
  forget(id: string, p: Principal, a: AgentContext): Promise<MemoryForgetResult>;
  correct(id: string, newText: string, p: Principal, a: AgentContext): Promise<MemoryCorrectResult>;
  /** `allowSensitive` is the caller's explicit confirmation after an `approval-required` refusal. */
  share(id: string, target: "workspace" | "user", p: Principal, a: AgentContext, opts?: { allowSensitive?: boolean }): Promise<MemoryShareResult>;
  state(p: Principal, a: AgentContext): Promise<MemoryState>;
  /** File a change proposal against a shared copy the caller can read but does not own (`a.origin === "user"`). */
  propose(sharedId: string, newText: string, p: Principal, a: AgentContext, opts?: { note?: string }): Promise<MemoryProposeResult>;
  proposals: {
    list(q: MemoryProposalListQuery, p: Principal, a: AgentContext): Promise<MemoryProposalListResult>;
    /** Sharer only (anyone else: `not-found`). Refreshes the copy with the proposal's text. */
    accept(proposalId: string, p: Principal, a: AgentContext): Promise<MemoryProposalAcceptResult>;
    reject(proposalId: string, p: Principal, a: AgentContext, opts?: { note?: string }): Promise<MemoryProposalRejectResult>;
  };
}

export type EngineEventName =
  | "dream.completed" | "job.run" | "acl.denied" | "recall.degraded" | "embedding.identity.changed"
  | "recall.block-clipped" | "recall.block-dropped" | "recall.completed" | "memory.proposal";

export interface EngineEvents {
  on(event: EngineEventName, handler: (payload: unknown) => void): Disposable;
}

export interface EngineStatus {
  ready: boolean;
  degraded: Degraded | null;
  agents: number;
  contract: ContractVersion;
  storeSchema: { current: SchemaVersion | null; expected: SchemaVersion };
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
  /** Idempotent: every call returns the same promise. Resolves within
   *  `budgetMs` (default 30 000) even if resources are still closing. */
  close(opts?: { budgetMs?: number }): Promise<void>;
  status(): Promise<EngineStatus>;

  /** Stable, cached prefix (index.js:7073-7088). */
  systemSupplement(): string[];
  /** Never throws; a failure comes back as `degraded`. */
  recall(q: RecallQuery): Promise<RecallResult>;
  /** Non-blocking. */
  capture(t: TurnRecord): CaptureHandle;
  checkpoint(agentId: AgentId, reason: CheckpointReason): Promise<CheckpointResult>;
  memory: MemoryOps;

  tools: ToolSpec[];
  commands: CommandSpec[];
  /** @deprecated since 1.5.0; string commands are adapter-internal. Removed in contract 2.0 (E6). Use Engine.memory. */
  runCommand(name: string, args: string, principal: Principal, agent: AgentContext): Promise<CommandResult>;

  jobs: JobRegistry;
  embedding: EmbeddingService;
  admin: AdminOps;
  events: EngineEvents;
  /** The open channel vocabulary (ChannelRef): a host declares its channels. */
  channels: { register(name: ChannelRef): string; has(name: ChannelRef): boolean; list(): ChannelRef[] };
}

/** `testOptions` is test-only: `internals` overrides members of the engine's
 *  internal object after construction (e.g. a stub embedder). */
export declare function createEngine(host: HostServices, config: EngineConfig, testOptions?: { internals?: Record<string, unknown> }): Engine;

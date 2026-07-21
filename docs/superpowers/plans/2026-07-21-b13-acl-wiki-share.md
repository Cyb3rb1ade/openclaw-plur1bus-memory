# B13 ACL, Wiki, Share, and Sensitive Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close SEC-01 through SEC-05, SEC-12, SEC-16, FA-04, FE-ADD-04, and opportunistic SEC-08 while adding physically isolated workspace/user sharing without changing OpenClaw model or credential routing.

**Architecture:** Build one immutable request/ownership context, enforce it at every record boundary, and route explicit shared copies through dedicated hashed workspace/user pools rooted at the reserved `.plur1bus-shared` segment below `namespaceLayout.baseDir`. The leading dot makes this segment impossible to collide with any `safeAgentId`, including legacy-flat agent routes. Private, workspace, and authenticated-user recall sources are leased together and passed through the existing recall pipeline; ACL/lifecycle filtering moves ahead of graph enrichment and every external provider, while the existing final filter remains defense in depth.

**Tech Stack:** Node.js ESM, `node:test`, LanceDB through the existing `MemoryDB`/`AgentDbPool`, SHA-256 from `node:crypto`, repository path guards/capabilities, existing OpenClaw runtime LLM and per-agent embedding routing.

---

## Scope and fixed contracts

This plan implements one subsystem: the B13 access boundary from command identity through storage, recall, Wiki, correction, and explicit sharing. Neo and REM consume this boundary in B8/B15 and are not redesigned here. Obsidian authorization remains B14.

Public LanceDB scopes remain exactly `agent-private`, `workspace`, and `user`. Internal Neo/Obsidian aliases `agent_private`, `workspace_shared`, and `global_user` are mapped only at their persistence adapters; `checkAccess()` must not silently reinterpret them. Multi-Namespace remains same-agent storage routing and never grants sharing rights.

The immutable request context is:

```js
Object.freeze({
  agentId,
  workspaceId,             // canonical workspace principal, also persisted on new shared rows
  workspaceIdentity,
  userId,                  // raw authenticated sender id, for command auth only
  userPrincipal,           // channel + account + user, used for ACL/storage
  channel,                 // validated OpenClaw message provider
  accountId,               // validated channel account, never guessed/defaulted
  chatId,                  // raw host conversation id for allowedChatIds compatibility
  conversationPrincipal,  // thread-aware opaque binding for confirmations
  chatKind,               // validated private/group/unknown for no-whitelist auth
  sessionKey,              // canonical host session key when present
  sessionId,               // current ephemeral host session id when present
  workspaceDir,
  workspaceAliases,       // validated frozen trusted mapping, never request-supplied
});
```

Every present workspace alias is independently normalized: explicit `workspaceId`, explicit `workspaceKey`, and canonical `realpath(workspaceDir)`. One present alias is accepted; multiple aliases are accepted only when they map to the same canonical workspace principal through an immutable trusted snapshot built once at registration. `buildMemoryWorkspaceAliases(cfg, precomputedNeoAliases)` first parses the raw configured Obsidian/Neo workspace entries and alias maps itself, rejecting duplicate alias or canonical-path declarations with different targets before any `Map` can collapse them; only then may it merge the already computed `neoWorkspaceAliases` defaults as read-only entries, again conflict-checking. B13 does not change Neo routing. Explicit aliases are looked up in the snapshot's `aliases` map, canonical directories in its `paths` map; a mapped target becomes `workspace:v1:<target>`, while an unmapped sole alias becomes `workspace:v1:<alias>` and an unmapped sole directory becomes `workspace-dir:v1:<realpath>`. Equal explicit ID/key values therefore agree without a map, but an unmapped directory plus an explicit alias fails closed. A mismatch fails before DB/provider work; there is no precedence rule that hides conflicts. That one canonical principal is both `ctx.workspaceId`/`ctx.workspaceIdentity` and the value persisted in both `workspaceId` and `workspaceKey` on new shared rows. The route key is `w-${sha256(principal).slice(0, 62)}` (exactly 64 `safeAgentId` characters).

An authenticated user principal is the collision-free opaque value `user:v1:<sha256(JSON.stringify([channel, accountId, userId]))>`, with each input component validated at its real field limit before canonical JSON serialization. `channel`/provider and `accountId` are mandatory for user-scoped sharing; absence fails closed instead of collapsing accounts. `ctx.chatId` remains the validated raw parent peer/conversation ID so existing `allowedChatIds` configuration keeps its exact meaning. A separate `conversationPrincipal` for confirmation is `conversation:v1:<sha256(JSON.stringify(["plur1bus-confirmation", 1, agentId, sessionKey, ["sessionId", sessionIdPresent, sessionId], channel, accountId, peerKind, parentPeerId, conversationId, ["threadId", threadIdPresent, threadId]]))>`. Tagged presence prevents absent/empty collisions. Confirmation-grade command contexts require non-empty verified `agentId`, canonical `sessionKey`, channel, account, peer kind, parent chat, and current conversation; `sessionId` is included whenever the host supplies it but is not mandatory because official native command surfaces may omit it. The same user principal is persisted in `ownerUserId`, compared by ACL, and hashed to `u-${sha256(principal).slice(0, 62)}` for its physical route. Raw workspace/user identities never become path segments or shared-row provenance, and the raw `userId`/`chatId` remain available only for authorization; confirmation passes `conversationPrincipal` as its bound chat value.

Official host contexts are resolved explicitly rather than assumed to contain synthetic fields. Registered command handlers call async `resolveHostCommandMemoryContext(commandCtx, ...)`: it uses `commandCtx.senderId/channel/accountId/agentId/sessionKey/sessionId/from/to/messageThreadId/threadParentId`, the injected `api.runtime.agent.resolveAgentWorkspaceDir(commandCtx.config, agentId)`, and a closed host-route decoder built from public `parseAgentSessionKey()`/`parseThreadSessionSuffix()` plus the documented OpenClaw command target forms `<channel>:<peerId>`, `<channel>:group:<peerId>`, and `<channel>:channel:<peerId>`. `agentId` is mandatory at every data/ACL adapter boundary; absence never becomes the real `default` agent. The parsed session owner must equal `commandCtx.agentId`; decoded host session, `from`/`to`, parent, and thread facts must agree whenever they overlap. A canonical main-DM key proves only agent/session ownership and never fabricates provider, account, or peer facts, so a supported `from`/`to` route remains mandatory for confirmation. The raw parent peer ID becomes `chatId`, `direct|dm` becomes `private`, and `group|channel` becomes `group`; an unsupported/ambiguous route stays empty/unknown. A read-only `getCurrentConversationBinding()` result may corroborate the route but is never required and never supplies security identity by itself, so a fresh install with a null plugin binding still preserves `allowedChatIds` and private-chat fallback. `senderIsOwner` alone never implies private. The adapter never calls `requestConversationBinding()` and never mutates host bindings.

The source package deliberately does not add OpenClaw as a runtime dependency: production obtains the four routing helpers through the host loader's public `openclaw/plugin-sdk/routing` alias. Because direct `node --test` does not install that host alias, there is no top-level/static SDK import. `createHostRoutingLoader({ importRouting = () => import("openclaw/plugin-sdk/routing") })` memoizes and validates the public module lazily; every route-consuming production handler is already async and awaits it before identity work. The pure route decoder/registry receive the validated four-function capability explicitly, and DB-free tests inject a public-contract fake through the same factory seam. A failed/malformed module load is caught with `safeWarn` and fails closed before ticket, pool, provider, ACL, or write work; it never falls back to a hashed `dist/` path or a locally reimplemented permissive parser. Add a host-loader smoke through the installed OpenClaw plugin loader plus direct-test injection regressions so both runtime and the exact serial test command are executable.

Tool contexts use trusted `messageChannel`, `agentAccountId`, `deliveryContext`, and `requesterSenderId`. Prompt hooks do not use `message_received`: it is fire-and-forget in the installed host and its canonical mapper does not reliably provide `runId`, so it cannot be an authentication join. When and only when `autoRecall` is enabled, registration creates the route registry and installs a passive `reply_dispatch` observer at `priority: Number.MIN_SAFE_INTEGER`; with `autoRecall: false` there is no registry, dispatch/prompt/agent-end hook, or route state. This host hook is awaited immediately before the default reply/model resolver and exposes the raw finalized inbound context plus session and originating provider/account/target/thread facts; its `runId` is optional and is absent on normal channel paths that generate the run only inside the later resolver. The hook stops later dispatch only for `{ handled: true }`; the B13 observer always returns `undefined`, performs no recall/provider/DB work, and ignores tail, CLI, cron, background, incomplete routes, every native command, and every command-shaped turn whose validated `CommandBody` begins with `/`. This conservative command exclusion may omit user-shared auto-recall for an unknown slash-shaped prompt, but prevents a handled command—which never reaches `before_prompt_build`—from leaving a stale FIFO head. After strict validation and cross-checking of every duplicate event/context route fact, it appends a TTL-bounded pending route ticket to the FIFO for canonical `[agentId, sessionKey]`. A present host run ID is retained as an additional constraint, never required. The ticket contains normalized provider/account/conversation/thread facts plus an opaque hash proof of the sender, never message content or the raw sender ID.

`resolveHostHookMemoryContext(hookCtx, ...)` takes the authenticated sender and chat only from `before_prompt_build`'s validated `senderId`/`chatId`, requires any duplicate `channelContext.sender.id`/`channelContext.chat.id` to agree, takes provider only from `messageProvider`, and requires a user-triggered `runId + agentId + sessionKey + sessionId + workspaceDir`. It parses the session owner and requires it to equal `agentId`, verifies the hook sender against a live ticket's hash, and reads the already committed current session through injected `api.runtime.agent.session.getSessionEntry({ agentId, sessionKey, readConsistency: "latest" })`. The entry's `sessionId` must equal the hook session ID. Ticket, hook, and all present entry provider facts (`deliveryContext.channel`, `lastChannel`, `origin.provider`), account facts (`deliveryContext.accountId`, `lastAccountId`, `origin.accountId`), target, and thread facts must be non-empty where required and mutually consistent through the same closed route decoder.

Because current OpenClaw has no pre-prompt hook carrying both generated `runId` and `accountId`, a ticket and last-route entry alone never authorize an ambiguous account. `buildMemoryAccountTopology(cfg)` creates one deeply frozen conservative registration-time snapshot from the supported provider's explicit `accounts` keys, `defaultAccount`, and exact/non-wildcard binding accounts; it always includes the implicit `default` candidate because environment/top-level credentials may exist, and any wildcard/unknown shape marks the provider ambiguous. A prompt account is accepted only under one of three explicit proof modes: (1) the canonical session grammar itself contains the same provider/account (`per-account-channel-peer`); (2) the ticket carried a non-empty host run ID exactly equal to the prompt run ID; or (3) the topology has exactly one possible account and it equals both ticket and current entry. Mode 2 selects the exact run-indexed ticket. Modes 1 and 3 inspect only the per-session FIFO's live head. A normal default-only configuration therefore works; named/multi-account main, group, or channel sessions without exact host run proof omit user-shared auto-recall. Manual commands/tools still carry `accountId` directly and remain fully functional. This availability boundary is documented, tested, and never weakened by session-entry recency.

Only after the selected proof mode and every synchronous cross-check succeed does one atomic operation remove that ticket and bind its immutable record to the hook `runId` in a separately bounded claimed-run cache; retries for that same run may reuse it, but another run cannot. Thus a concurrently overwritten main-DM last route fails closed rather than borrowing another turn's account.

Any pending expiration, capacity eviction, out-of-order run, or identity/route conflict clears that session's pending FIFO and installs a bounded taint tombstone lasting at least until every affected ticket would have expired; while tainted, no prompt for that session can claim a ticket. Taint-map overflow activates a global fail-closed overflow tombstone for the same bound, never silently dropping proof and allowing a later ticket to slide forward. Claimed-cache eviction merely makes that run's retry miss. The account is accepted only from a ticket corroborated by the current entry; it is never inferred from `resolveAgentRoute()`, bindings, configured defaults, or a literal `default`. `agent_end` clears the claimed run; expiry and plugin shutdown clear stale state. If proof is absent, expired, evicted, replayed, tainted, or conflicting, only the user principal/user-shared source is omitted while already valid private/workspace recall continues; user sharing and confirmation fail closed.

The frozen memory context is a security sidecar, not a replacement for OpenClaw's invocation object. Handlers keep the validated original `commandCtx`/tool/hook event for command args, locale/tone, session metadata, and `runtimeContext.llm`, and receive `memoryCtx` as an explicit separate parameter. Authorization, ACL, owner bindings, paths, and shared routing use only `memoryCtx`; no arbitrary request fields are spread into it. This preserves the OpenClaw default LLM capability unchanged.

Shared copies are copy-only and idempotent. They preserve the source, use a real embedding from the existing embedding provider with `{ agentId }`, and persist `storedBy`, `workspaceKey`, `ownerUserId`, `sourceMemoryId`, `sourceAgentId`, `shareIdempotencyKey`, and JSON `shareProvenance`. Sensitive category/type, `memoryClass: "core"`, `neverForget`, or importance `>= 0.9` requires the existing `userId + chatId + nonce` confirmation before either workspace or user promotion. User sharing additionally requires an authenticated `userId`.

Legacy `scope: "workspace_shared"` rows are never deleted or requester-relative. Explicit migration runs as the destructively authorized `/plur1bus migrate-legacy-shared` action inside the already initialized plugin runtime, so it uses the active `MultiNamespacePool`, effective config, requesting agent's existing embedding provider/credentials, and shared pool. It copies only active rows from the exact authoritative private writer with one unambiguous workspace binding, readback-verifies them, then records a schema-backed migration marker on the source. Unbound/conflicting rows remain untouched and are written to a bounded, private atomic repair report. Every invocation is bounded by one pinned source-table version, 250 examined rows, 4 MiB of selected source text/summary bytes, 100 provider calls, and 60 seconds; no new operation starts after an abort/deadline. It returns a mode/agent/workspace-snapshot/version/terminal-offset-bound opaque continuation token when more work remains. A resume reopens that exact immutable source version and only advances past terminally planned/skipped rows in dry-run or terminally verified/repaired/marked rows in apply; an interrupted row remains first on resume. Cross-mode, unavailable/changed source versions, or other mismatched tokens fail closed. Thus retries are deterministic, idempotent, and never hold the writer or a chat command for an unbounded table scan. The operator action is dry-run by default and requires `--apply`; applying after a dry-run always restarts at offset zero. There is no standalone DB/bootstrap script.

No task may add or change a chat model, endpoint, header, token, API-key lookup, LLM override, or credential inheritance rule. All LLM calls keep the OpenClaw runtime-default route. Embedding calls continue using the one already initialized provider and pass `{ agentId }` to preserve the existing per-agent cache/audit scope; B13 does not claim that this option selects credentials and does not alter embedding credential resolution.

## File map

| File | Responsibility |
|---|---|
| `lib/memory-request-context.js` | Build/freeze canonical principals/account topology, adapt official host contexts, manage bounded one-turn route tickets, corroborate prompt identity against current session state, reject conflicts, and produce <=64-char route keys. |
| `lib/input-limits.js` | Named bounds for channel/account/session/thread identity fields consumed by B13 adapters. |
| `lib/acl-middleware.js` | Validate complete ownership tuples and fail closed on missing/conflicting bindings. |
| `lib/recall-pipeline.js` | Preserve ownership projection; ACL-filter initial/refined/graph candidates before providers; retain final ACL. |
| `lib/wiki-command.js` | Common active/wiki/ACL selection before previews, ambiguity lists, archive, and delete; read auth first. |
| `lib/safe-update.js` | Preserve and validate the full source identity tuple in replacement rows. |
| `lib/shared-memory-pool.js` | Lazy, physically isolated, hashed workspace/user read/write `AgentDbPool` ownership and leases under a collision-proof reserved segment. |
| `lib/shared-memory.js` | Shared schema migration, real-vector/idempotent copy, access-pool recall source composition. |
| `lib/shared-memory-migration.js` | Dry-run/apply legacy `workspace_shared` migration and atomic repair report. |
| `lib/telegram-commands/memory-edit.js` | Source ACL/lifecycle check and workspace/user share orchestration. |
| `lib/telegram-commands/memory-query.js` | Stable merge/dedup of private/workspace/user `/memory` results. |
| `lib/runtime-shutdown.js` | Close shared pools during gateway shutdown. |
| `lib/i18n-dictionary.js` | Localized share/confirmation/not-found/error responses. |
| `index.js` | Construct pools/context, gate sensitive reads, wire `/share` and `/teile`, confirmation, and shared recall. |
| `README.md`, `docs/configuration.md` | Exact scopes, commands, paths, migration, auth, model/key preservation. |
| `docs/audits/2026-07-21-b13-acl-wiki-share-fix.md` | Finding receipt and red/green/security evidence. |
| `.superpowers/sdd/progress.md` | B13 completion evidence and next batch. |

## Review rule for every task

Each task uses a fresh implementer. After its focused tests pass and its implementation commit exists, dispatch a fresh read-only spec reviewer against that task's exact commit range. Fix every Critical or Important finding with a failing regression first and send the same reviewer back. Only after spec PASS, dispatch a different fresh read-only quality reviewer; fix every Critical or Important finding and re-review. Do not begin the next task until both reviewers report PASS. Minor findings may remain only when recorded with rationale in the B13 receipt.

### Task 1: Immutable request context and strict ownership ACL (SEC-01 foundation)

**Files:**
- Create: `lib/memory-request-context.js`
- Modify: `lib/input-limits.js`
- Modify: `lib/acl-middleware.js`
- Modify: `lib/db-adapter.js`
- Modify: `lib/wiki-command.js`
- Modify: `lib/telegram-commands/memory-edit.js`
- Modify: `lib/telegram-commands/memory-query.js`
- Modify: `lib/recall-pipeline.js`
- Modify: `index.js`
- Modify: `tests/user-scope-acl.test.js`
- Modify: `tests/memory-store-input-validation.test.js`
- Modify: `tests/smoke-migration.test.js`
- Modify: `tests/memory-db-lifecycle-atomic.test.js`
- Modify: `tests/smoke-wiki-command.test.js`
- Modify: `tests/forget-correct-confirm.test.js`
- Modify: `tests/recall-golden-set-pipeline.test.js`
- Create: `tests/b13-memory-request-context.test.js`
- Create: `tests/b13-acl-callsite-adapters.test.js`

- [ ] **Step 1: Write failing request-context and ACL regressions**

Add tests with these exact cases:

```js
it("canonicalizes one workspace truth and freezes the complete tuple", () => {
  const ctx = resolveMemoryRequestContext({
    agentId: "agent-a",
    workspaceId: "workspace-id",
    workspaceKey: "workspace-id",
    channel: "telegram",
    accountId: "primary",
    userId: "owner-a",
    chatId: "chat-a",
  });
  assert.equal(ctx.workspaceId, "workspace:v1:workspace-id");
  assert.equal(ctx.workspaceIdentity, ctx.workspaceId);
  assert.match(ctx.userPrincipal, /^user:v1:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(ctx), true);
});

it("rejects conflicting workspace aliases before routing", () => {
  assert.throws(() => resolveMemoryRequestContext({
    agentId: "agent-a",
    workspaceId: "workspace-a",
    workspaceKey: "workspace-b",
  }), /conflicting workspace identity/);
});

it("accepts configured path and aliases only when they resolve to one target", () => {
  const workspaceAliases = Object.freeze({
    paths: Object.freeze([{ path: realpathSync(workspaceDir), workspaceKey: "canonical-a" }]),
    aliases: Object.freeze([{ alias: "workspace-a", workspaceKey: "canonical-a" }]),
  });
  const ctx = resolveMemoryRequestContext({
    agentId: "agent-a",
    workspaceId: "workspace-a",
    workspaceDir,
  }, { workspaceAliases });
  assert.equal(ctx.workspaceIdentity, "workspace:v1:canonical-a");
});

it("hashes principals into safe AgentDbPool keys of at most 64 chars", () => {
  const key = workspacePoolKey("dir:/tmp/a/../../secret");
  assert.match(key, /^w-[a-f0-9]{62}$/);
  assert.equal(key.length, 64);
  assert.match(userPoolKey("user:v1:8d4c2f"), /^u-[a-f0-9]{62}$/);
  assert.doesNotMatch(key, /secret|\.\./);
});

it("keeps equal raw user ids isolated by channel and account", () => {
  const a = resolveMemoryRequestContext({ agentId: "a", channel: "telegram", accountId: "one", userId: "42" });
  const b = resolveMemoryRequestContext({ agentId: "a", channel: "telegram", accountId: "two", userId: "42" });
  const c = resolveMemoryRequestContext({ agentId: "a", channel: "discord", accountId: "one", userId: "42" });
  assert.notEqual(a.userPrincipal, b.userPrincipal);
  assert.notEqual(a.userPrincipal, c.userPrincipal);
  assert.notEqual(userPoolKey(a.userPrincipal), userPoolKey(b.userPrincipal));
});

it("fails closed for unbound and conflicting private/workspace rows", () => {
  assert.equal(checkAccess({ agentId: "agent-a" }, { scope: "agent-private" }).allowed, false);
  assert.equal(checkAccess({ workspaceId: "ws-a" }, { scope: "workspace" }).allowed, false);
  assert.equal(checkAccess(
    { agentId: "agent-a" },
    { scope: "agent-private", agentId: "agent-a", storedBy: "agent-b" },
  ).allowed, false);
  assert.equal(checkAccess(
    { workspaceId: "ws-a" },
    { scope: "workspace", workspaceId: "ws-a", workspaceKey: "ws-b" },
  ).allowed, false);
});
```

Add positive legacy workspace controls using the same frozen trusted snapshot: a pre-migration row with empty/missing `workspaceId` and raw `workspaceKey: "workspace-a"` maps to `workspace:v1:canonical-a` and remains visible to that canonical context, a sole unmapped raw key follows the fixed request rule and becomes `workspace:v1:<raw-key>`, and a row whose two different raw aliases both independently map to `canonical-a` is not a conflict. If aliases resolve to different canonical targets, an already-canonical value disagrees, or the snapshot is absent/malformed, deny before disclosure. Round-trip these cases through every Task 1 ACL adapter family so schema migration's empty `workspaceId` default does not hide legitimate existing rows.

Also test a mismatching `workspaceDir` against an explicit trusted alias, non-existent `workspaceDir`, missing channel/account for `requireUser`, over-limit `INPUT_LIMITS.USER_ID`/`CHAT_ID`/`AGENT_ID`/`CHANNEL_ID`/`ACCOUNT_ID`/`SESSION_KEY`/`SESSION_ID`/`THREAD_ID`/`PRINCIPAL`, and object/boolean/non-finite values. Add named finite constants `CHANNEL_ID: 64`, `ACCOUNT_ID: 128`, `SESSION_KEY: 1024`, `SESSION_ID: 128`, `THREAD_ID: 128`, and `PRINCIPAL: 128` to `lib/input-limits.js`; do not scatter magic security limits. Transport IDs may be strings or finite safe integers (converted once to canonical decimal strings because channel SDKs expose numeric IDs); all other types fail before `validateInput`. Retain positive controls for matching `agent-private`, canonical `workspace`, and `userPrincipal`-bound `user`, plus denial of internal alias `workspace_shared` as `acl.unknown_scope`.

Add a DB-free `MemoryDB` schema-contract fixture/source assertion proving fresh bootstrap rows, the idempotent `allColumns` migration, and `normalizeEntryForTable()` all include string `agentId` and `workspaceId` fields with empty defaults. This is required before strict ownership can survive a real LanceDB round-trip; fallback reads may still use `storedBy`/`workspaceKey` for pre-migration rows.

Extend the deterministic DB-free lifecycle harness in `tests/memory-db-lifecycle-atomic.test.js`: inject failure while adding `agentId`, independently inject failure while adding `workspaceId`, assert the first `init()` rejects and acknowledges no writable DB, then assert a second `init()` retries the missing migration, re-reads/verifies both exact string fields, refreshes schema fields, and succeeds. Do not rely on the optionally skipped LanceDB smoke test as the only proof.

Use official host-shaped fixtures, not only synthetic `{workspaceDir, chatId}` objects:

- a `PluginCommandContext` fixture has `senderId`, `channel`, `accountId`, `agentId`, `sessionKey`, optional `sessionId`, `from`, `to`, `messageThreadId`, `threadParentId`, `config`, a null-returning `getCurrentConversationBinding()`, and injected `resolveAgentWorkspaceDir()` but no `workspaceId`, `workspaceKey`, `workspaceDir`, `userId`, `chatId`, or `chatType`; assert the closed host-route decoder resolves the configured canonical workspace, raw parent chat ID, private/group kind, hashed user principal, and agent/session/thread-aware conversation principal without calling `requestConversationBinding()`. Cover real Telegram, Discord, Slack, and Mattermost direct/group target shapes, canonical main-DM session keys, Telegram topics, thread routes, mismatching agent/session/from/target/thread facts, and existing `allowedChatIds` plus no-whitelist private/group authorization. Treat validated `from` as the primary inbound route; parse `to` only when it is a same-provider conversation target, so a Discord native `to: "slash:<user>"` is ignored rather than misclassified;
- a tool fixture uses `messageChannel`, `agentAccountId`, `deliveryContext`, `requesterSenderId`, `agentId`, `sessionKey`, and `workspaceDir`;
- real non-tail `reply_dispatch` fixtures with and without `runId`, canonical session, raw finalized `AgentId`/`AccountId`/`SenderId`/route, and originating provider/account/target/thread facts append ordered pending route tickets; assert the observer returns `undefined`, never calls `recordProcessed`/`markIdle`/dispatcher/recall/provider/DB work, and is registered at `Number.MIN_SAFE_INTEGER` only when `autoRecall: true`. With `autoRecall: false`, assert zero registry allocation, `reply_dispatch`, identity `before_prompt_build`, `agent_end`, or shutdown-route cleanup registration/state. Missing/conflicting facts, background/CLI shapes, tail dispatch, native command turns, and validated `CommandBody` values beginning with `/` create none. Add command-followed-by-normal-prompt and interleaved-user regressions proving handled `/memory`, `/share`, `/forget`, unknown slash, and native commands cannot leave a stale FIFO head for the next turn;
- a following real `before_prompt_build` fixture has the exact validated `runId`, `agentId`, `sessionKey`, `sessionId`, `workspaceDir`, `messageProvider`, `senderId`, `chatId`, and matching nested channel-context IDs but no `accountId`. Its injected latest-session reader returns the same session ID plus matching `deliveryContext`/`last*`/`origin` provider, target, thread, and account facts; assert it atomically claims the ticket and recovers the exact channel-account-user principal without registering `message_received`;
- same-run prompt retries reuse only their immutable claimed ticket; a second run cannot replay it. Exercise all three account proof modes: account-bearing canonical session, exact non-empty ticket run ID, and conservative single-account topology. A present ticket run ID must match; an absent ticket run ID uses only FIFO head and is never sufficient for an ambiguous topology. Missing/expired/evicted/replayed/out-of-order/conflicting tickets and mismatching/missing session ID, parsed agent, provider, target, thread, account, sender/chat duplicates, stale/absent entry, missing run, and non-user triggers fail closed. All present ticket/session account aliases must agree and no configured/default account resolver may be called. These failures omit only user-shared recall while private/workspace recall remains available;
- two interleaved users in one group/session take their user IDs directly from their own immutable prompt contexts and must match separate FIFO-head sender-proof hashes, so they cannot swap principals; same main session/chat/user under account A versus B is denied unless the session or exact ticket run ID proves the account. If the current session route is overwritten after ticket minting, ticket-entry mismatch omits user recall. Add default-only positive topology; named account plus implicit default, two named accounts, wildcard binding, unknown provider, and malformed topology denials; exact-run and account-bearing-session positive multi-account cases; same-identity/different-account reordering; dropped-head; delayed `message_received` irrelevance; deterministic pending/claimed/taint cap eviction; strict TTL boundary; session and global-overflow tombstones; `agent_end` cleanup; shutdown cleanup; and source assertions that B13 registers no `message_received` identity bridge;
- confirmation principal tests change one field at a time for agent, session key, optional session-ID presence/value, provider, account, parent/current chat, and thread. Different fields cannot redeem; matching null and corroborating non-null plugin bindings produce the same principal; a main-DM session without a supported `from` route fails `requireConversation`. A Discord native fixture without `sessionId` remains supported and stable, while present-to-missing session ID cannot redeem;
- conflicting duplicate aliases/paths in raw plugin configuration throw before the trusted snapshot is installed, including a regression where the existing Neo builder would otherwise collapse the last writer; equal duplicate mappings remain idempotent.
- private/group/unknown no-whitelist fixtures preserve the documented destructive-auth fallback by passing `memoryCtx.chatKind` explicitly to `isAuthorized`; missing markers and `senderIsOwner`-only contexts remain unknown/denied.
- a registered command fixture proves original `args`, locale fields, and `runtimeContext.llm` reach parsing/render/LLM code unchanged while all auth/ACL spies receive only the separate frozen `memoryCtx`. Across command, tool, prompt, Wiki, and store adapters, a missing `agentId` must fail before pool acquisition/provider/ACL/read/write work and must never select the real `default` agent.

Add direct `node --test` regressions that import `memory-request-context.js` with no locally installed `openclaw` package, inject a strict four-function routing capability, and exercise every route decoder successfully. Add loader failure/malformed-export no-work cases and one installed-host loader smoke proving the default lazy `openclaw/plugin-sdk/routing` import resolves only under OpenClaw's plugin loader. The direct test suite must not depend on `NODE_PATH`, a global package path, or a committed `node_modules` stub.

- [ ] **Step 2: Run the tests and observe the intended failures**

Run:

```bash
node --test --test-concurrency=1 tests/user-scope-acl.test.js tests/memory-store-input-validation.test.js tests/smoke-migration.test.js tests/memory-db-lifecycle-atomic.test.js tests/smoke-wiki-command.test.js tests/forget-correct-confirm.test.js tests/recall-golden-set-pipeline.test.js tests/b13-memory-request-context.test.js tests/b13-acl-callsite-adapters.test.js
```

Expected: FAIL because `memory-request-context.js` does not exist, the current ACL allows missing bindings, and no account-qualified user principal exists.

- [ ] **Step 3: Implement canonical context and binding validation**

Create these exports and use `safeAgentId`, `validateInput`, `INPUT_LIMITS`, `realpathSync`, strict raw field extraction, and SHA-256. `validatedIdentity()` must inspect the `{ ok, value, error }` return object (it must not assume `validateInput` throws):

```js
export function stableIdentityHash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function workspacePoolKey(workspaceIdentity) {
  return `w-${stableIdentityHash(workspaceIdentity).slice(0, 62)}`;
}

export function userPoolKey(userPrincipal) {
  return `u-${stableIdentityHash(userPrincipal).slice(0, 62)}`;
}

export function resolveMemoryRequestContext(commandCtx, {
  requireWorkspace = false,
  requireUser = false,
  workspaceAliases = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
} = {}) {
  const normalizedWorkspaceAliases = normalizeAndFreezeWorkspaceAliases(workspaceAliases);
  const rawAgentId = validatedIdentity(commandCtx?.agentId, INPUT_LIMITS.AGENT_ID, "agentId", { required: true });
  const agentId = safeAgentId(rawAgentId);
  const explicitId = validatedIdentity(commandCtx?.workspaceId, INPUT_LIMITS.AGENT_ID, "workspaceId");
  const explicitKey = validatedIdentity(commandCtx?.workspaceKey, INPUT_LIMITS.AGENT_ID, "workspaceKey");
  const canonicalDir = commandCtx?.workspaceDir ? realpathSync(commandCtx.workspaceDir) : "";
  const workspaceIdentity = resolveCanonicalWorkspacePrincipal(
    { explicitId, explicitKey, canonicalDir },
    normalizedWorkspaceAliases,
  );
  const userId = validatedIdentity(extractRawIdentity(commandCtx, "user"), INPUT_LIMITS.USER_ID, "userId");
  const channel = validatedIdentity(commandCtx?.channel ?? commandCtx?.provider, INPUT_LIMITS.CHANNEL_ID, "channel");
  const accountId = validatedIdentity(commandCtx?.accountId ?? commandCtx?.account_id, INPUT_LIMITS.ACCOUNT_ID, "accountId");
  const userPrincipal = userId && channel && accountId
    ? `user:v1:${stableIdentityHash(JSON.stringify([channel, accountId, userId]))}`
    : "";
  if (requireWorkspace && !workspaceIdentity) throw new Error("memory context requires a bound workspace");
  if (requireUser && !userPrincipal) throw new Error("memory context requires a channel/account-bound authenticated user");
  return Object.freeze({
    agentId,
    workspaceId: workspaceIdentity,
    workspaceIdentity,
    userId,
    userPrincipal,
    channel,
    accountId,
    chatId: validatedIdentity(extractRawIdentity(commandCtx, "chat"), INPUT_LIMITS.CHAT_ID, "chatId"),
    conversationPrincipal: validatedIdentity(commandCtx?.conversationPrincipal, INPUT_LIMITS.PRINCIPAL, "conversationPrincipal"),
    chatKind: normalizeChatKind(commandCtx?.chatKind),
    sessionKey: validatedIdentity(commandCtx?.sessionKey, INPUT_LIMITS.SESSION_KEY, "sessionKey"),
    sessionId: validatedIdentity(commandCtx?.sessionId, INPUT_LIMITS.SESSION_ID, "sessionId"),
    workspaceDir: canonicalDir,
    workspaceAliases: normalizedWorkspaceAliases,
  });
}
```

Also export `createHostRoutingLoader({ importRouting })`, `buildMemoryWorkspaceAliases(cfg, precomputedNeoAliases)`, `buildMemoryAccountTopology(cfg)`, async `resolveHostCommandMemoryContext(commandCtx, { resolveAgentWorkspaceDir, workspaceAliases, routingLoader, requireWorkspace, requireUser, requireConversation })`, `resolveHostCommandRouteFacts(commandCtx, routingCapability)`, `resolveToolMemoryRequestContext(toolCtx, options)`, `createMemoryTurnRouteRegistry({ routingCapability, maxPending: 1000, maxClaimed: 1000, maxTainted: 1000, ttlMs: 60000, now })`, and `resolveHostHookMemoryContext(hookCtx, { getSessionEntry, workspaceAliases, accountTopology, turnRoutes, routingCapability })`. The default loader uses only a lazy dynamic import of the public SDK alias and validates the exact four callable exports; pure helpers require the injected validated capability. The command adapter awaits the loader before route work, calls the host workspace resolver, decodes and cross-checks the current route from public session-key helpers plus the closed supported-channel `from/to` forms, and calls `getCurrentConversationBinding()` at most once only as optional corroboration. A null binding is the normal fresh-install case, not an identity failure. It validates a mandatory `agentId` against the parsed canonical session owner, derives raw parent `chatId`, authoritative `chatKind`, and the versioned agent/session-aware `conversationPrincipal` from the verified current route before delegating to the synchronous resolver; a bare session string never fabricates any route field. `from` is primary, and `to` is corroborative only when it decodes as the same supported provider's conversation route; provider-native control targets such as `slash:<user>` are ignored.

The route registry owns insertion-ordered per-session pending FIFOs, a present-host-run index, plus claimed-run and taint maps. `observeReplyDispatch(event)` first rejects native command markers and validates `CommandBody` as a bounded string; any trimmed leading `/` is excluded before route-ticket allocation. It then validates and cross-checks optional `event.runId`, `sessionKey`, and `originating*` against the documented raw finalized context fields, parses the canonical agent/session, hashes the validated raw sender into `senderProof`, and stores no message content or raw sender. With a present run ID an exact repeated observation is idempotent and a conflict taints the session; without one, every observed dispatch appends a distinct ticket because identical consecutive user messages are distinct turns. `claimForPrompt(hookCtx, proofMode, verifyTicket)` selects the exact indexed ticket only for `turn-run`; other modes accept only the live FIFO head. The async hook adapter first awaits and validates the latest-session snapshot, then immediately calls the registry with a supplied synchronous non-Promise verifier that performs every remaining cross-check against that immutable snapshot before mutation; no event-loop yield occurs between snapshot return and claim. The claim removes that ticket and installs one immutable claimed record keyed by hook run ID. Later same-run retries return only that record. Expiration is strict (`expiresAt > now`); any unindexed pending loss/conflict taints rather than advancing the queue. Eviction is deterministic oldest-first with the tombstone rules above. `clearRun(runId)` plus `clear()` are idempotent. Because plugin `register(api)` is synchronous, only the `autoRecall: true` branch synchronously installs async dispatch/prompt handlers plus `agent_end` cleanup and creates a memoized `getTurnRoutes()` initializer; the first enabled async handler awaits the routing loader and then constructs exactly one registry. Shutdown clears it only if initialized. The disabled branch installs/allocates none of this identity bridge. Register the passive observer with `api.on("reply_dispatch", observer, { priority: Number.MIN_SAFE_INTEGER })`. Never return `{ handled: true }` or call reply-dispatch context mutators.

The hook adapter reads sender/chat directly from the current immutable prompt hook, cross-checks their nested duplicates, reads provider only from `messageProvider`, verifies the exact claimed ticket, and calls the injected wrapper around `api.runtime.agent.session.getSessionEntry({ agentId, sessionKey, readConsistency: "latest" })`. The wrapper receives only the validated parsed agent/session tuple. Require exact `sessionId` equality and reconcile every present ticket/session delivery/origin provider, account, target, and thread alias with the current hook through the closed decoder. At least one non-empty account source is mandatory in both ticket and current entry and all present sources must agree; use optional account normalization only and never a helper that manufactures `default`. Any invalid/missing/conflicting proof returns a frozen context with no user principal and emits only a bounded reason code via `safeWarn`, never raw identifiers. Private/workspace context remains usable. Background/cron/heartbeat/manual triggers do not claim a ticket or call the session reader.

`validatedIdentity()` inspects raw adapter fields before any `resolveIdentity()` coercion, accepts only strings or finite safe integers, trims/canonicalizes them, calls `validateInput` with the named real limit, and throws `new Error(result.error)` when `!result.ok`; its `required` option rejects absence/empty before any fallback. Host/tool adapters extract the documented trusted variants themselves; they do not pass objects through `String()`. Every resolver that can authorize or reach data requires an explicit verified agent ID; only non-data display helpers may omit one, and none may manufacture `default`. `resolveCanonicalWorkspacePrincipal(bindings, workspaceAliases)` consumes only the already normalized deeply frozen snapshot and applies the exact mapping rules in the fixed contract above; it never reads aliases from `commandCtx` itself. Without a trusted mapping, multiple unlike principals conflict. A sole ID/key becomes `workspace:v1:<value>` and a sole directory becomes `workspace-dir:v1:<realpath>`; never silently prefer one. `index.js` builds one trusted snapshot from `cfg` plus the precomputed Neo defaults and passes it into every context resolution, including commands, manual recall, auto-recall, and sharing; tests pass an explicit frozen fixture.

In `acl-middleware.js`, export `resolveOwnershipBindings(memory, workspaceAliases)` and `validateOwnershipTuple(memory, workspaceAliases)`. Validate `agentId` and `storedBy` independently before comparing. For workspace ownership, validate each present `workspaceId` and `workspaceKey` independently, then canonicalize each through the supplied deeply frozen trusted snapshot before comparing: a recognized raw alias maps to `workspace:v1:<target>`, an unmapped raw alias follows the fixed request-context rule and maps to `workspace:v1:<raw-alias>`, an already canonical `workspace:v1:*`/`workspace-dir:v1:*` value remains canonical after strict syntax/length validation, and no requester field can add a mapping. Different raw aliases that map to the same canonical principal agree; different canonical results conflict. A sole raw legacy alias is accepted only through this same closed canonicalizer. Missing/malformed/untrusted snapshots and canonical conflicts fail closed. `checkAccess()` must call `validateOwnershipTuple(memory, ctx.workspaceAliases)` before scope comparison, require the binding relevant to the row's scope, and compare workspace rows to `ctx.workspaceIdentity`; user rows compare only to `ctx.userPrincipal`. Irrelevant legacy metadata is validated/preserved but never grants access: private authorizes only the agent pair, workspace only the canonical workspace pair, and user only the principal owner. New writers still emit the minimal tuples defined above. Use stable reasons such as `acl.agent_private.missing_owner`, `acl.workspace.missing_workspace`, `acl.workspace.invalid_binding`, `acl.workspace.conflicting_binding`, and `acl.user.missing_principal`.

Resolve `parseAgentSessionKey()`, `parseThreadSessionSuffix()`, `normalizeOptionalAccountId()`, and `normalizeMessageChannel()` lazily only from the documented `openclaw/plugin-sdk/routing` surface through `createHostRoutingLoader()`; never use a top-level import, hashed `dist/` artifact, OpenClaw test-only export, global installation path, or undeclared package fallback. Production async handlers await the memoized capability, while direct tests inject it. Build the stored canonical session key only from the parser's canonical `agentId` and `rest`, and compare the parsed owner with the separately validated host `agentId`; do not authorize against an unparsed raw key. The local route decoder mirrors only the closed public delivery grammar and rejects unknown peer kinds, extra/missing identity components, unsupported channels, and any disagreement between session, `from/to`, parent, and thread facts.

In the same Task 1 commit, thread the frozen canonical `memoryCtx` through every current `checkAccess()`/`filterMemoriesByAcl()` caller in `db-adapter`, Wiki, memory edit/query, recall pipeline, and `index.js`. Remove raw `{ userId }` authorization contexts; never add a compatibility fallback from `ctx.userPrincipal` to raw `ctx.userId`. A caller that cannot establish the canonical principal fails closed. Later tasks add stronger lifecycle/command gates but must not be needed merely to keep existing legitimate user-scope reads functional. Add one positive canonical-user and one raw-user denial regression per adapter family.

Extend the existing `MemoryDB` contract in place: add `agentId` and `workspaceId` to the fresh bootstrap row, `allColumns` migration using the authoritative `text` field's DataType plus `valueSql: "''"`, and `normalizeEntryForTable()` defaults. After all migration attempts, re-read the authoritative schema and require both security-critical fields with the expected string DataType before initialization/store can succeed; do not inherit the current best-effort catch-and-continue behavior for these two fields. An interrupted/failed column migration must throw and a later init must retry, never acknowledge a row that `normalizeEntryForTable()` stripped. Refresh schema fields from that verified schema. Do not add a second DB class or change legacy fallback projection (`agentId || storedBy`, `workspaceId || workspaceKey`).

Replace `resolveStoreScopeAccess()` and both ordinary store paths (`storeMemoryFromToolParams()` and the registered agent `memory_store`) with the frozen context contract before pool acquisition, embedding, duplicate, merge, or write work. Update the Bridge and Wiki/Obsidian helper callsites to resolve/pass that same complete frozen context rather than reconstructing `agentId`, `workspaceDir`, or raw `userId` fragments. Every new/replacement row sets `agentId` and `storedBy` to the safe agent. `workspace` rows require the canonical workspace principal and set both aliases to it with empty owner; `user` rows require the hashed user principal, set `ownerUserId` to it, and leave both workspace aliases empty; `agent-private` rows require the agent binding and leave public bindings empty. Duplicate/merge ACL uses the same frozen context. Trusted mapped legacy workspace aliases may be canonicalized during reads through `resolveOwnershipBindings(memory, ctx.workspaceAliases)`; unmapped/conflicting workspace rows and legacy raw `ownerUserId` values fail closed and are documented for explicit operator repair rather than requester-relative adoption. Add spies for both store implementations and both helper callsites proving invalid/missing canonical bindings perform zero pool/embed/write work, then round-trip each scope and remain visible only to the originating canonical context. Later integration tasks route the same resolver through each remaining non-ACL feature boundary.

- [ ] **Step 4: Run focused tests to green**

Run the Step 2 command. Expected: all tests PASS, zero skips.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add lib/memory-request-context.js lib/input-limits.js lib/acl-middleware.js lib/db-adapter.js lib/wiki-command.js lib/telegram-commands/memory-edit.js lib/telegram-commands/memory-query.js lib/recall-pipeline.js index.js tests/user-scope-acl.test.js tests/memory-store-input-validation.test.js tests/smoke-migration.test.js tests/memory-db-lifecycle-atomic.test.js tests/smoke-wiki-command.test.js tests/forget-correct-confirm.test.js tests/recall-golden-set-pipeline.test.js tests/b13-memory-request-context.test.js tests/b13-acl-callsite-adapters.test.js
git commit -m "fix: fail closed on incomplete memory ownership"
```

Spec review must explicitly verify strict missing/conflicting bindings and legacy non-reinterpretation. Quality review must inspect validation, path handling, stable reasons, JSDoc, and absence of silent catches. Fix/re-review all Critical/Important findings before Task 2.

### Task 2: Preserve ownership through graph hydration and pre-provider recall (SEC-01, SEC-02)

**Files:**
- Modify: `lib/recall-pipeline.js`
- Modify: `tests/recall-golden-set-pipeline.test.js`
- Modify: `tests/recall-pipeline-hydration.test.js`
- Modify: `tests/recall-pipeline-graph-hydration-relevance.test.js`
- Create: `tests/b13-recall-provider-acl.test.js`

- [ ] **Step 1: Write failing pipeline regressions**

Cover initial and refined vector rows, graph-only hydration, and edge filtering:

```js
it("never sends a foreign workspace candidate to the reranker", async () => {
  const seenDocs = [];
  const workspaceIdentity = "workspace:v1:ws-a";
  const result = await runRecallPipeline({
    query: "acl",
    dbTable: mockTable([
      makeRow({ id: "own", text: "allowed", scope: "workspace", workspaceId: workspaceIdentity, workspaceKey: workspaceIdentity }),
      makeRow({ id: "foreign", text: "secret-b", scope: "workspace", workspaceId: "workspace:v1:ws-b", workspaceKey: "workspace:v1:ws-b" }),
    ]),
    embeddings: makeEmbeddings(),
    reranker: { async rerank(_query, docs) { seenDocs.push(...docs); return [{ index: 0 }]; } },
    agentId: "agent-a",
    workspaceId: workspaceIdentity,
    userPrincipal: ownerCtx.userPrincipal,
    topN: 5,
    canonicalEnabled: false,
  });
  assert.deepEqual(seenDocs, ["allowed"]);
  assert.deepEqual(result.memories.map((item) => item.entry.id), ["own"]);
});

it("drops a foreign graph row before relevance embedding", async () => {
  const embedded = [];
  const hydrated = await hydrateGraphResults(tableWithRows([foreignWorkspaceRow]), graphOnlyResults, logger, {
    queryVector: [1, 0],
    embeddings: { async embed(text, options) { embedded.push([text, options]); return [1, 0]; } },
    aclCtx: Object.freeze({ agentId: "agent-a", workspaceId: "workspace:v1:ws-a", workspaceIdentity: "workspace:v1:ws-a", userPrincipal: ownerCtx.userPrincipal }),
    embeddingContext: Object.freeze({ agentId: "agent-a" }),
  });
  assert.deepEqual(hydrated, []);
  assert.deepEqual(embedded, []);
});
```

Add a positive graph control proving an allowed neighbor is hydrated and every graph relevance embedding receives `{ agentId: "agent-a" }`. Add a refined-search fixture proving a foreign refined row is rejected before merge/trace/provider construction and that the initial query and refined-query embeddings also receive the same request-bound agent context. Add projection assertions for `sourceMemoryId`, `sourceAgentId`, `shareIdempotencyKey`, and `shareProvenance` on initial, refined, and hydrated rows.

- [ ] **Step 2: Observe the failures and preserve the original exploit proof**

Run:

```bash
node --test --test-concurrency=1 tests/recall-golden-set-pipeline.test.js tests/recall-pipeline-hydration.test.js tests/recall-pipeline-graph-hydration-relevance.test.js tests/b13-recall-provider-acl.test.js
node docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-acl-missing-ownership-fail-open/validation_artifacts/proof.mjs "$PWD"
node docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-pattern-pre-acl-cross-scope/validation_artifacts/proof.mjs "$PWD"
```

Expected: the focused suite FAILS because foreign text reaches the reranker and graph projection loses aliases; the original proof reproduces the pre-fix disclosure.

- [ ] **Step 3: Add one ownership-preserving projection and one early ACL gate**

Export and use the same projection for initial, refined, and hydrated rows:

```js
export function projectRecallEntry(row) {
  return {
    id: row.id,
    text: row.text || "",
    summary: row.summary || "",
    scope: row.scope || "agent-private",
    storedBy: row.storedBy || "",
    agentId: row.agentId || "",
    workspaceKey: row.workspaceKey || "",
    workspaceId: row.workspaceId || "",
    ownerUserId: row.ownerUserId || "",
    sourceMemoryId: row.sourceMemoryId || "",
    sourceAgentId: row.sourceAgentId || "",
    shareIdempotencyKey: row.shareIdempotencyKey || "",
    shareProvenance: row.shareProvenance || "{}",
    status: row.status || "active",
    origin: row.origin || "dm",
    category: row.category,
    importance: row.importance ?? 0.5,
    createdAt: row.createdAt,
    sourceUrl: row.sourceUrl || "",
    evidenceQuote: row.evidenceQuote || "",
    emotionalValence: row.emotionalValence ?? "",
    emotionalIntensity: row.emotionalIntensity ?? 0,
    emotionalDominant: row.emotionalDominant || "neutral",
    retrievalCount: row.retrievalCount ?? 0,
    lastRetrievedAt: row.lastRetrievedAt ?? 0,
    memoryStrength: row.memoryStrength ?? 1,
    halfLifeDays: row.halfLifeDays ?? 30,
    lastStrengthenedAt: row.lastStrengthenedAt ?? 0,
    lastDynamicsAt: row.lastDynamicsAt ?? 0,
    memoryClass: row.memoryClass || "standard",
    neverForget: row.neverForget ?? 0,
    coreMemoryScore: row.coreMemoryScore ?? 0,
    coreMemoryReason: row.coreMemoryReason || "",
    versionNumber: row.versionNumber ?? 1,
    previousVersion: row.previousVersion || "",
    supersededBy: row.supersededBy || "",
    updateSource: row.updateSource || "",
    updateEvidence: row.updateEvidence || "",
    reconsolidationConfidence: row.reconsolidationConfidence ?? 0,
    versionCreatedAt: row.versionCreatedAt ?? 0,
    updatedAt: row.updatedAt ?? 0,
  };
}
```

At `runRecallPipeline()` entry, add `userPrincipal = null` and `embeddingContext = Object.freeze({ agentId })`; freeze `aclCtx = Object.freeze({ agentId, workspaceId, workspaceIdentity: workspaceId, userPrincipal })`. Pass `embeddingContext` to every request-bearing `embeddings.embed()` call: initial query, refined query, and `computeQueryRelevance()` during graph hydration. Do not add model, key, endpoint, or fallback fields. Add `filterRecallCandidatesByAcl(candidates, aclCtx, trace, logger, stage)` immediately after initial projection and again on refined projection. Use it in every soft-budget return and retain the final ACL pass.

Do not change `lib/memory-graph.js`: its traversal receives only authorized IDs. In `recall-pipeline.js`, before `readGraph()`, select only edges reachable from the already-authorized seed IDs in existing deterministic graph order, with hard constants of at most 400 inspected edges and 200 unique endpoint IDs. Then resolve those endpoints with `getByIds()`, keep only active rows that pass `checkAccess(aclCtx, row)`, and pass only edges whose source and target are allowed to `readGraph()`. Oversized tails are traced as `graph_acl_endpoint_cap` without DB/provider work. Pass `aclCtx` and `embeddingContext` into `hydrateGraphResults()` and run status + ACL before `computeQueryRelevance()`. Missing endpoint rows and missing bindings are denied and traced. Add an oversized-graph regression asserting bounded query count, zero provider calls for discarded foreign endpoints, and unchanged ordering for an allowed graph below the cap.

- [ ] **Step 4: Run green tests and the closure proof**

Run the Step 2 commands. Expected: focused tests PASS; the old proof now fails its disclosure assertion or reports only the allowed document. Save the exact output for the receipt.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add lib/recall-pipeline.js tests/recall-golden-set-pipeline.test.js tests/recall-pipeline-hydration.test.js tests/recall-pipeline-graph-hydration-relevance.test.js tests/b13-recall-provider-acl.test.js
git commit -m "fix: authorize recall before graph and providers"
```

Spec review must trace initial, refined, graph, soft-budget, reranker, and final paths and confirm the canonical `userPrincipal` participates. Quality review must check bounded graph lookups, trace consistency, no duplicate projection, and preserved positive graph/rerank ordering. Fix/re-review all Critical/Important findings before Task 3.

### Task 3: Wiki lifecycle, ACL, non-enumeration, and audit (SEC-03, SEC-04, SEC-05, SEC-08, FE-ADD-04)

**Files:**
- Modify: `lib/wiki-command.js`
- Modify: `tests/smoke-wiki-command.test.js`
- Modify: `lib/i18n-dictionary.js`
- Modify: `index.js`

- [ ] **Step 1: Write the failing Wiki matrix**

Add tests proving:

```js
it("does not preview a foreign or non-wiki duplicate", async () => {
  const result = await runWikiCommand(ownerCtx("add Local: allowed body"), depsWithFindSimilar([
    { entry: foreignUserMemory, score: 0.99 },
    { entry: ownActiveWiki, score: 0.94 },
  ]));
  assert.doesNotMatch(result.text, /victim secret/);
  assert.match(result.text, /own wiki preview/);
});

it("makes denied UUID deletion indistinguishable from missing", async () => {
  const denied = await runWikiCommand(ownerCtx(`delete id:${foreignWorkspaceWiki.id}`), deps);
  const missing = await runWikiCommand(ownerCtx(`delete id:${missingId}`), deps);
  assert.equal(denied.text, missing.text);
  assert.equal(deleteCalls.length, 0);
  assert.equal(archiveFiles.length, 0);
});

it("filters query matches before ambiguity text or mutation", async () => {
  const result = await runWikiCommand(ownerCtx("delete project"), depsWithRows([
    foreignWorkspaceWiki,
    ownActiveWiki,
  ]));
  assert.doesNotMatch(result.text, /foreign title|foreignWorkspaceWiki\.id/);
  assert.equal(deleteCalls.length, 1);
});

it("fallback search excludes superseded and archived rows", async () => {
  const result = await runWikiCommand(ownerCtx("old fact"), depsWithoutWhere([supersededWiki]));
  assert.match(result.text, /No entry found|Kein Eintrag/);
});
```

Add positive controls for own active duplicate preview, own active UUID/query delete, ambiguity among allowed rows, archive-first ordering, and one `appendDestructiveOpLog` call only after successful delete.

Drive one test through the registered `/wiki` handler with an official `PluginCommandContext` fixture (no synthetic workspace/chat fields). Assert the async host adapter resolves/authorizes before DB/provider work and that `wiki add` persists `agentId === storedBy === ctx.agentId`, `workspaceId === workspaceKey === ctx.workspaceIdentity`, `ownerUserId === ""`, and `scope === "workspace"`; the same new row is immediately visible to the canonical context and denied to another workspace.

- [ ] **Step 2: Run the Wiki suite red**

```bash
node --test --test-concurrency=1 tests/smoke-wiki-command.test.js
```

Expected: FAIL on unscoped duplicate preview, UUID/query ACL, inactive fallback, and missing destructive audit.

- [ ] **Step 3: Normalize Wiki selection once**

Replace the duplicated filters with these helpers:

```js
function isActiveKindRow(row, kind, now) {
  const active = row?.status == null || row.status === "" || row.status === "active";
  if (!active) return false;
  const expiry = row?.expiresAt;
  const live = expiry == null
    || expiry === 0
    || (typeof expiry === "number" && Number.isFinite(expiry) && expiry > now);
  if (!live) return false;
  if (kind === "memory") return !row?.memoryKind || row.memoryKind === "memory";
  return row?.memoryKind === kind;
}

function visibleResults(ctx, results, kind, now) {
  return (Array.isArray(results) ? results : []).filter((result) => {
    const row = result?.entry || result;
    return isActiveKindRow(row, kind, now) && checkAccess(ctx, row).allowed;
  });
}
```

At the registered handler boundary, run `validateCommandArgs(commandCtx?.args)`, resolve `memoryCtx` asynchronously, capture one immutable `requestNow`, and call `checkWikiAuth(memoryCtx, cfg, { chatKind: memoryCtx.chatKind, localeCtx: commandCtx })` before constructing dependencies, resolving tone, opening a pool, embedding, or calling an LLM; destructive add/delete use the same memory context with destructive auth. Change the helper signature to `checkWikiAuth(memoryCtx, cfg, { destructive = false, chatKind = memoryCtx.chatKind, localeCtx = null } = {})`, call `isAuthorized(memoryCtx, cfg, { destructive, chatKind })` without spreading `localeCtx`, and use `localeCtx` only to localize a denial. Help/invalid input returns a localized usage/error without data work. Call `runWikiCommand(commandCtx, { ...deps, ctx: memoryCtx, now: requestNow })`: the original invocation supplies only validated args/locale/runtime capability, while selection and writes use `deps.ctx`. Every Wiki SQL/vector predicate combines the active/null check with `(expiresAt IS NULL OR expiresAt = 0 OR expiresAt > requestNow)`; the in-memory fallback uses the strict type-aware helper above, where negative, non-finite, string, boolean, or object expiry is invisible. `searchByKind()` fallback must include the same lifecycle predicate as its SQL branch and log caught search failures through `safeDebug(logger, "wiki search failed", error)` without record text. Every caught fallback, LLM, `findSimilar`, or `getById` error must be rethrown, returned as an error result, or safely logged; no silent catches. Curated search uses `visibleResults(ctx, ..., "wiki", requestNow)`; the legitimate normal-memory fallback uses `visibleResults(ctx, ..., "memory", requestNow)` and must remain reachable. Add expired and malformed-expiry rows for duplicate preview, search/LLM output, ambiguity, UUID/query deletion, and normal-memory fallback, proving zero disclosure/provider/delete work.

All Wiki embedding calls preserve method purpose and agent cache scope: query/search uses `embeddings.embedQuery(text, { agentId: ctx.agentId })` when available (falling back to `embed(text, { agentId })` only for providers without `embedQuery`), while stored/add content uses `embeddings.embed(text, { agentId: ctx.agentId })`. `wikiAdd()` must use the real current duplicate API `db.findSimilar(vector, fullText, 0.92)`, then call `visibleResults(ctx, existing, "wiki", requestNow)` before rendering a preview; a foreign, expired, malformed-lifecycle, or normal-memory hit does not suppress the store. Its row uses the exact canonical workspace tuple described by the registered-handler test, never a raw/default workspace key. Both `wikiDelete()` branches call `visibleResults(ctx, candidates, "wiki", requestNow)` before kind response, ambiguity rendering, archive, or delete. ACL-denied or non-live UUID/query rows return exactly `wiki.delete_not_found`; never return a distinct denial. Pass `ctx`, `workspaceDir`, `requestNow`, and `logger` through the helpers. After a successful delete, call:

```js
appendDestructiveOpLog(workspaceDir, {
  event: "memory.deleted",
  source: "wiki.delete",
  agentId,
  memoryId: safeId,
  via,
  archivePath,
  timestamp: new Date().toISOString(),
});
```

Pass `ctx`, `workspaceDir`, and `logger` into add/delete helpers. Do not log before the delete settles.

Before declaring green, execute the exact preserved evidence surfaces (the Wiki findings contain rubrics rather than executable proof scripts) and the new handler regressions that instantiate those rubrics:

```bash
sed -n '1,200p' docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-wiki-add-duplicate-cross-scope-disclosure/validation_artifacts/RUBRIC.md
sed -n '1,200p' docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-wiki-delete-id-missing-record-acl/validation_artifacts/RUBRIC.md
sed -n '1,200p' docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-wiki-delete-query-missing-record-acl/validation_artifacts/RUBRIC.md
sed -n '1,200p' docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-wiki-search-inactive-fallback-disclosure/validation_artifacts/RUBRIC.md
node --test --test-concurrency=1 tests/smoke-wiki-command.test.js
```

- [ ] **Step 4: Run Wiki tests green**

Run the Step 2 command. Expected: PASS with zero skips and no foreign text in responses or LLM input.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add lib/wiki-command.js lib/i18n-dictionary.js index.js tests/smoke-wiki-command.test.js
git commit -m "fix: enforce wiki record visibility before disclosure"
```

Spec review must map every add/search/delete-by-ID/delete-by-query branch to lifecycle + ACL and compare denied/not-found strings. Quality review must inspect safe logging, archive/delete/audit ordering, UUID validation, and preserved legitimate behavior. Fix/re-review all Critical/Important findings before Task 4.

### Task 4: Preserve complete ownership on safe correction (SEC-16)

**Files:**
- Modify: `lib/safe-update.js`
- Modify: `index.js`
- Modify: `tests/safe-update-dataloss.test.js`
- Modify: `tests/forget-correct-confirm.test.js`

- [ ] **Step 1: Write failing ownership-preservation tests**

```js
it("preserves the exact valid binding for workspace and user replacements", () => {
  const workspaceNext = buildUpdateEntry({
    id: "old",
    text: "old",
    vector: [1, 0],
    scope: "workspace",
    agentId: "agent-a",
    storedBy: "agent-a",
    workspaceId: "ws-a",
    workspaceKey: "ws-a",
    ownerUserId: "",
    status: "active",
  }, { text: "new", vector: [1, 0] }, evidence);
  assert.equal(workspaceNext.agentId, "agent-a");
  assert.equal(workspaceNext.storedBy, "agent-a");
  assert.equal(workspaceNext.workspaceId, "ws-a");
  assert.equal(workspaceNext.workspaceKey, "ws-a");
  assert.equal(workspaceNext.ownerUserId, "");

  const userNext = buildUpdateEntry({
    id: "old-user",
    text: "old",
    vector: [1, 0],
    scope: "user",
    agentId: "agent-a",
    storedBy: "agent-a",
    workspaceId: "",
    workspaceKey: "",
    ownerUserId: ownerCtx.userPrincipal,
    status: "active",
  }, { text: "new", vector: [1, 0] }, evidence);
  assert.equal(userNext.workspaceId, "");
  assert.equal(userNext.workspaceKey, "");
  assert.equal(userNext.ownerUserId, ownerCtx.userPrincipal);
});

it("rejects an unbound or conflicting source before storing a replacement", async () => {
  await assert.rejects(
    safeUpdate(dbWith({ scope: "workspace", workspaceKey: "" }), id, patch, evidence),
    /invalid ownership tuple/,
  );
  assert.equal(storeCalls.length, 0);
  assert.equal(updateCalls.length, 0);
});
```

The raw equal `ws-a` fixture intentionally proves verbatim preservation without requester backfill; add a separate `/correct confirm` integration assertion using canonical `workspace:v1:ws-a` that the replacement remains visible only to the original workspace. Retain store-before-supersede failure controls.

Use the Task 1 host-context resolver for the existing registered `/forget` and `/correct` handlers before either authorization or confirmation work. Keep the original invocation object only for non-security presentation fields; derive `confirmationChatId = memoryCtx.conversationPrincipal || memoryCtx.chatId`, require it to be non-empty, and pass the same explicit `{ userId: memoryCtx.userId, chatId: confirmationChatId }` tuple to both `createConfirmation()` and `validateConfirmation()`/completion. Never fall back to `resolveIdentity(commandCtx)` for these flows. Add official host-shaped tests proving a confirmation cannot be completed from a different thread, account, session, user, or chat, while the matching invocation retains the existing archive-first `/forget` and store-before-supersede `/correct` behavior.

Harden the common confirmation lookup used by `/forget`, `/correct`, and later `/share`: the command must carry the complete canonical UUID nonce, validate its exact UUID form, and perform an exact nonce+target lookup. Remove `nonce.startsWith(token)` and the six-character minimum/prefix scan. A shortened prefix, ambiguous prefix, altered suffix, or nonce for another target must fail without consuming the real pending confirmation; add regressions for all three commands while preserving one-time exact redemption and expiry.

- [ ] **Step 2: Run focused tests red**

```bash
node --test --test-concurrency=1 tests/safe-update-dataloss.test.js tests/forget-correct-confirm.test.js
```

Expected: FAIL because `buildUpdateEntry()` omits `agentId`, `workspaceId`, and `workspaceKey`, and does not validate the source tuple.

- [ ] **Step 3: Validate before side effects and copy aliases verbatim**

Import `validateOwnershipTuple` and add before idempotency or writes:

```js
const ownership = validateOwnershipTuple(oldRow);
if (!ownership.valid) {
  throw new Error(`safeUpdate: invalid ownership tuple (${ownership.reason})`);
}
```

In `buildUpdateEntry()`, copy:

```js
agentId: oldRow.agentId || "",
storedBy: oldRow.storedBy || "",
workspaceId: oldRow.workspaceId || "",
workspaceKey: oldRow.workspaceKey || "",
ownerUserId: oldRow.ownerUserId || "",
scope: oldRow.scope,
```

Do not fill any missing binding from `opts`, the current requester, agent defaults, or workspace defaults. Keep store-before-supersede and graph rewrite order unchanged.

Because this task changes `lib/safe-update.js`, replace its existing silent `isIdempotent()` catch with `safeDebug(logger, "safeUpdate idempotency check failed", error)` (or a typed error result handled by the caller); never silently convert a DB/read failure into `false`. Thread an optional logger without record content, add a regression proving the failure is logged and cannot trigger an unsafe replacement, and add focused JSDoc to every changed export.

- [ ] **Step 4: Run focused tests green**

Run the Step 2 command. Expected: all tests PASS with the original durable ordering assertions intact.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add lib/safe-update.js index.js tests/safe-update-dataloss.test.js tests/forget-correct-confirm.test.js
git commit -m "fix: retain ownership across safe memory updates"
```

Spec review must prove no requester backfill, exact alias preservation, and identical explicit confirmation bindings for create/complete across `/forget` and `/correct`. Quality review must verify validation happens before all writes, official host contexts cannot redeem confirmations cross-thread/account/session, and durability/idempotency are not weakened. Fix/re-review all Critical/Important findings before Task 5.

### Task 5: Gate every data-bearing chat read before work (SEC-12)

**Files:**
- Modify: `index.js`
- Modify: `lib/wiki-command.js`
- Create: `tests/b13-sensitive-read-auth.test.js`
- Modify: `tests/plur1bus-internal-auth.test.js`
- Modify: `tests/smoke-wiki-command.test.js`

- [ ] **Step 1: Write registered-command tests with no-work spies**

Register the real plugin with an allowlist and invoke commands as an intruder. Assert the same unauthorized response and zero DB/embed/LLM/file-store calls for:

```js
const directReads = [
  ["memory", "project"],
  ["state", ""],
  ["wiki", "project"],
  ["speaker", "list"],
  ["speaker", "proposals"],
];

const plur1busReads = [
  "start",
  "temperament",
  "persona status",
  "skills review",
  "skills list",
  "skills show proposal-id",
  "reminders list",
  "reminders show reminder-id",
  "curation",
  "memory origin record-id",
  "memory explain record-id",
  "memory overlays",
  "recall why record-id",
  "origin trace record-id",
  "behavior show",
  "behavior candidates",
  "behavior explain record-id",
  "embeddings",
  "dreaming",
  "status",
  "doctor",
];
```

Build the matrix from the actual `runPlur1busCommand()` branches, not just this sample: each branch must be classified in the test as `public-help`, `sensitive-read`, `destructive`, `internal-cron`, or `B14-obsidian`. Assert every observed `actionKey` belongs to exactly one class. Include `recall why`, `embeddings`, and `dreaming`; prevent future branches from defaulting to public. Add positive allowlisted controls for `/memory`, `/wiki`, `/speaker list`, and `/plur1bus skills review`. Keep empty/help public and keep cron-context `/plur1bus internal gc-run` authorized without chat identity.

Obsidian actions (`obsidian` plus `obsidianActionNames`) are an explicit narrow B14 boundary: this task neither weakens nor claims closure for their command-specific authorization. Route them before constructing the general Neo `commandStore`; add a fixture documenting that B13's generic classification delegates them unchanged to `handleObsidianBridgeCommand`, and list them as open under B14 in the receipt.

- [ ] **Step 2: Run auth tests red**

```bash
node --test --test-concurrency=1 tests/b13-sensitive-read-auth.test.js tests/plur1bus-internal-auth.test.js tests/smoke-wiki-command.test.js
```

Expected: FAIL because several handlers read stores, embed, summarize, or return data before non-destructive authorization.

- [ ] **Step 3: Add authorize-before-dispatch gates**

At each registered command boundary, validate bounded arguments and resolve a separate frozen `memoryCtx`. Keep the original invocation for args, locale/tone, session metadata, and `runtimeContext.llm`: call forms are `runMemoryCommand(commandCtx, memoryCtx)`, `runStatusCommand(commandCtx, memoryCtx)`, equivalent speaker helpers, and Task 3's `runWikiCommand(commandCtx, { ...deps, ctx: memoryCtx })`. Refactor the local helper to `checkAuth(memoryCtx, opts = {}, localeCtx = null)`: it calls `isAuthorized(memoryCtx, cfg, opts)` only, and uses `localeCtx` only to render a localized denial. Call `checkAuth(memoryCtx, { chatKind: memoryCtx.chatKind }, commandCtx)` or Task 3's Wiki equivalent before summarizer, pool, file, render, DB, embed, or LLM work. Add assertions that `runtimeContext.llm` remains the exact OpenClaw capability object and is never copied/spread into `memoryCtx` or `isAuthorized`, and unauthorized responses retain the original locale. Help/usage remains available without data access.

In `runPlur1busCommand`, classify actions before constructing `commandStore`. Use explicit command/subcommand sets rather than a permissive default:

```js
const SENSITIVE_READ_ACTIONS = new Set([
  "behavior",
  "curation",
  "doctor",
  "dreaming",
  "embeddings",
  "memory",
  "origin",
  "persona",
  "recall",
  "reminder",
  "reminders",
  "skills",
  "start",
  "state",
  "status",
  "temperament",
]);

const isSensitiveChatRead = (actionKey, subKey) => {
  if (!SENSITIVE_READ_ACTIONS.has(actionKey)) return false;
  if (actionKey === "skills") return ["review", "list", "show"].includes(subKey);
  if (actionKey === "reminder" || actionKey === "reminders") return ["", "list", "show", "help"].includes(subKey);
  if (actionKey === "memory") return !["promote", "demote", "prune", "tombstone", "disable-overlay", "supersede-overlay"].includes(subKey);
  if (actionKey === "behavior") return !["promote", "demote", "prune"].includes(subKey);
  return true;
};
```

Maintain an explicit `DESTRUCTIVE_ACTIONS`/subcommand predicate for setup, enable/disable, skill approve/reject, reminder cancel/delete, memory/behavior mutations, Neo migration, and the Task 10 legacy-share migration. Unknown action/subcommand combinations must reach help without store construction, never a data branch. Resolve the official host memory context before any auth or data dependency; if `isSensitiveChatRead(actionKey, sub.toLowerCase())`, return `checkAuth(memoryCtx, { chatKind: memoryCtx.chatKind })` denial before `getNeoStore()`. Existing destructive branches keep `checkAuth(memoryCtx, { destructive: true, chatKind: memoryCtx.chatKind })` before store/file/DB work. Include a real `/plur1bus state` no-work matrix case because its branch constructs a store before delegating to status today. The `internal` branch remains separately authorized: real cron contexts bypass chat auth, non-cron contexts use destructive auth. The operator-facing legacy-share migration is explicitly top-level and outside `internal`, as defined in Task 10; cron identity never bypasses its destructive operator gate.

- [ ] **Step 4: Run auth tests green**

Run the Step 2 command. Expected: PASS; all intruder no-work spies remain zero; cron and allowlisted positive paths still work.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add index.js lib/wiki-command.js tests/b13-sensitive-read-auth.test.js tests/plur1bus-internal-auth.test.js tests/smoke-wiki-command.test.js
git commit -m "fix: authorize sensitive memory reads before dispatch"
```

Spec review must enumerate every direct and `/plur1bus` data-bearing branch and prove the gate precedes store/embed/LLM access. Quality review must reject an over-broad gate that breaks help or cron jobs and inspect channel identity variants. Fix/re-review all Critical/Important findings before Task 6.

### Task 6: Physically isolated workspace/user shared pools (FA-04 storage)

**Files:**
- Create: `lib/shared-memory-pool.js`
- Create: `tests/b13-shared-memory-pool.test.js`
- Modify: `index.js`
- Modify: `lib/runtime-shutdown.js`
- Modify: `tests/llm-result-cache-lifecycle.test.js`

- [ ] **Step 1: Write failing pool partition, containment, lease, and shutdown tests**

```js
it("routes workspaces and users to separate hashed physical roots", async () => {
  const pool = new SharedMemoryPool(baseDir, 4, FakeAgentDbPool, logger);
  await pool.withWorkspaceDb(workspaceCtxA, async (db) => assert.match(db.path, /\.plur1bus-shared\/workspaces\/w-[a-f0-9]{62}$/));
  await pool.withWorkspaceDb(workspaceCtxB, async (db) => assert.notEqual(db.path, workspaceAPath));
  await pool.withUserDb(userCtxA, async (db) => assert.match(db.path, /\.plur1bus-shared\/users\/u-[a-f0-9]{62}$/));
  assert.notEqual(workspaceAPath, userAPath);
});

it("fails closed without the required binding and never exposes raw identity in paths", async () => {
  await assert.rejects(pool.withWorkspaceDb(unboundCtx, async () => {}), /bound workspace/);
  await assert.rejects(pool.withUserDb(unboundCtx, async () => {}), /user principal/);
  assert.equal(observedPaths.some((path) => path.includes("../victim")), false);
});
```

Also assert each route key passes `safeAgentId()` and has `length <= 64`; equal raw user IDs on different channel/account principals route differently. Prove the legacy-flat private agent `_shared` routes to `<base>/_shared`, while shared storage routes to `<base>/.plur1bus-shared`, and `safeAgentId(".plur1bus-shared")` is rejected, so no private agent can collide with the reserved segment. Assert active callbacks keep leases through settlement, shutdown waits for them, and `registerGatewayShutdown()` invokes `sharedMemoryPool.shutdown()` exactly once even when another resource fails.

Add a route/capability integration test (not only `FakeAgentDbPool`) using exported real `AgentDbPool`, `mkdtempSync()`, and a completely fresh/non-existent `.plur1bus-shared` tree. Constructor plus `withWorkspaceReadDb()` on a missing tree must create no directory/table and return the optional source as absent. A write lease then creates the reserved tree; inspect `db.dbPath` without calling `db.init()` or LanceDB and verify containment under `<tmp>/.plur1bus-shared/workspaces/w-<62hex>`. Replace the reserved segment or `workspaces` with a symlink between construction and first write lease and assert failure before any LanceDB open. Inject unsupported capability support (Windows/missing `O_DIRECTORY`/`O_NOFOLLOW`): construction and private memory registration still succeed, read leases return absent, and only explicit sharing fails closed with a clear error. This keeps tests unit-level and DB-free while exercising the production constructor, `safeAgentId`, lazy routing, and platform policy.

Repeat the lazy-route test with `baseDir` itself completely absent at construction. Construction and a read lease must perform zero filesystem mutations and return the optional source as absent; the first write lease must create and pin the missing configured base parent-by-parent before the reserved segment. Also call `shutdown()` before any lease and prove every later read/write lease rejects permanently with zero filesystem effects; shutdown is an irreversible state transition even when no child pool existed.

- [ ] **Step 2: Run pool tests red**

```bash
node --test --test-concurrency=1 tests/b13-shared-memory-pool.test.js tests/llm-result-cache-lifecycle.test.js
```

Expected: FAIL because `SharedMemoryPool` and shared shutdown wiring do not exist.

- [ ] **Step 3: Implement the wrapper around two existing AgentDbPools**

Use only <=64-character hashed IDs and descriptor-backed roots. Define `SHARED_ROOT_SEGMENT = ".plur1bus-shared"`. Construction never touches the configured base path: validate the `baseDir` input lexically and retain `resolve(baseDir)`; the platform capability-support probe may run, but do not call `resolveInside()`, `realpathSync()`, `existsSync()`, open, or create against `baseDir`. On the first lease, find the nearest existing ancestor without mutation, call `resolveInside(existingAncestor, ...missingBaseSegments)` before inspecting/creating the configured base, and use `openDirectoryCapability(expectedBase, { create })` to establish and pin each missing segment. A read lease returns absent when the configured base is missing. Once the pinned base exists, derive `sharedPath = resolveInside(baseDir, SHARED_ROOT_SEGMENT)` before every shared-root open/create/read/write, then add descriptor capabilities as TOCTOU defense. Never treat a non-existent path as the `resolveInside()` base. If stable directory capabilities are unavailable, private PLUR1BUS registration remains functional, optional shared reads are absent, and explicit share/migration writes fail closed.

```js
export class SharedMemoryPool {
  constructor(baseDir, vectorDim, AgentDbPoolClass, logger = null) {
    this.baseDir = resolve(baseDir);
    this.sharedPath = null;
    this.supported = stableDirectoryCapabilitiesSupported();
    this.rootCapability = null;
    this.sharedCapability = null;
    this.workspaceWritePool = null;
    this.userWritePool = null;
    this.workspaceReadPool = null;
    this.userReadPool = null;
    this.shutdownPromise = null;
    this.isShutdown = false;
  }

  _assertOpen() {
    if (this.isShutdown) throw new Error("shared memory pool is shutdown");
  }

  withWorkspaceDb(ctx, fn) {
    this._assertOpen();
    if (!ctx?.workspaceIdentity) throw new Error("shared pool requires a bound workspace");
    return this._withWritePool("workspace", workspacePoolKey(ctx.workspaceIdentity), fn);
  }

  withUserDb(ctx, fn) {
    this._assertOpen();
    if (!ctx?.userPrincipal) throw new Error("shared pool requires an authenticated user principal");
    return this._withWritePool("user", userPoolKey(ctx.userPrincipal), fn);
  }

  withWorkspaceReadDb(ctx, fn) {
    this._assertOpen();
    if (!ctx?.workspaceIdentity) return fn(null);
    return this._withReadPool("workspace", workspacePoolKey(ctx.workspaceIdentity), fn);
  }

  withUserReadDb(ctx, fn) {
    this._assertOpen();
    if (!ctx?.userPrincipal) return fn(null);
    return this._withReadPool("user", userPoolKey(ctx.userPrincipal), fn);
  }

  shutdown() {
    if (!this.shutdownPromise) {
      this.isShutdown = true;
      this.shutdownPromise = Promise.allSettled([
        ...[this.workspaceWritePool, this.userWritePool, this.workspaceReadPool, this.userReadPool]
          .filter(Boolean)
          .map((pool) => pool.shutdown()),
      ]).then((results) => {
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "shared memory pool shutdown failed");
      }).finally(() => {
        this.sharedCapability?.close();
        this.sharedCapability = null;
        this.rootCapability?.close();
        this.rootCapability = null;
      });
    }
    return this.shutdownPromise;
  }
}
```

Implement `_ensureSharedRoot({ create })` and pool factories around the sketch: call `_assertOpen()` before every lease and before/after every awaited lazy acquisition boundary; lazily establish/pin the configured base as above, then call `resolveInside(baseDir, SHARED_ROOT_SEGMENT)` every time the now-existing base is used. Open the reserved child with `create` only for write paths, return `false` on read-only `ENOENT`, reject symlinks/identity changes, and build separate real `AgentDbPool` children with `readOnly: true` for read methods and normal write pools for share/migration. Read pools never create missing workspace/user/key directories or tables; their callback receives `null` when the source is absent. Warn once with `safeWarn` for unsupported optional reads; do not throw during registration. `shutdown()` sets `isShutdown = true` synchronously before observing or awaiting child pools, is idempotent, and permanently prevents any later lazy pool/capability creation. `assertSharedRoot()` verifies `pathMatchesDirectoryCapability(sharedPath, sharedCapability)` before each child operation. Constructor/factory failure closes every capability it opened. Extend `registerGatewayShutdown()` with `sharedMemoryPool` and a separately logged bounded close attempt. Preserve the existing cleanup order and continue cleanup after failures.

Change the existing declaration to the documented named export `export class AgentDbPool` so the DB-free integration test exercises the production route validator; do not move or duplicate the class and do not expose `MemoryDB`. Runtime construction continues to pass that same class into `MultiNamespacePool` and now into `SharedMemoryPool`.

- [ ] **Step 4: Run pool tests green**

Run the Step 2 command. Expected: PASS with separate workspace/user routes and complete shutdown.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add lib/shared-memory-pool.js index.js lib/runtime-shutdown.js tests/b13-shared-memory-pool.test.js tests/llm-result-cache-lifecycle.test.js
git commit -m "feat: add isolated workspace and user memory pools"
```

Spec review must verify exact `.plur1bus-shared/workspaces/w-<62hex>` and `.plur1bus-shared/users/u-<62hex>` layout rooted at `namespaceLayout.baseDir`, legacy-flat collision impossibility, real `AgentDbPool` acceptance, lazy read/write behavior, and keys <=64. Quality review must inspect platform fail-closed policy, no registration/read creation, `resolveInside` before each filesystem operation, capability cleanup, symlink/path containment, raw-identity non-disclosure, callback leases, and aggregate shutdown. Fix/re-review all Critical/Important findings before Task 7.

### Task 7: Real-vector, complete, idempotent shared copies (FA-04 storage)

**Files:**
- Modify: `lib/shared-memory.js`
- Modify: `lib/telegram-commands/memory-edit.js`
- Modify: `tests/shared-memory-store-guard.test.js`
- Modify: `tests/forget-correct-confirm.test.js`
- Create: `tests/b13-share-store.test.js`

- [ ] **Step 1: Write failing schema, embedding, provenance, and concurrency tests**

```js
it("stores one complete workspace copy for parallel identical promotions", async () => {
  const results = await Promise.all([
    shareCard(privatePool, sharedPool, embeddings, "agent-a", source.id, shareOpts),
    shareCard(privatePool, sharedPool, embeddings, "agent-a", source.id, shareOpts),
  ]);
  assert.equal(new Set(results.map((result) => result.sharedId)).size, 1);
  assert.equal(storedRows.length, 1);
  assert.deepEqual(storedRows[0].vector, [0.25, 0.5, 0.75, 1]);
  assert.equal(storedRows[0].scope, "workspace");
  assert.equal(storedRows[0].agentId, "agent-a");
  assert.equal(storedRows[0].workspaceId, workspaceCtx.workspaceIdentity);
  assert.equal(storedRows[0].workspaceKey, workspaceCtx.workspaceIdentity);
  assert.equal(storedRows[0].ownerUserId, "");
  assert.equal(storedRows[0].sourceMemoryId, source.id);
  assert.equal(storedRows[0].sourceAgentId, "agent-a");
  assert.ok(storedRows[0].shareIdempotencyKey);
});

it("stores an owner-bound user copy in the user pool", async () => {
  const result = await shareCard(privatePool, sharedPool, embeddings, "agent-a", source.id, { ...shareOpts, targetScope: "user" });
  assert.equal(result.ok, true);
  assert.equal(storedRows[0].scope, "user");
  assert.equal(storedRows[0].agentId, "agent-a");
  assert.equal(storedRows[0].workspaceId, "");
  assert.equal(storedRows[0].ownerUserId, ownerCtx.userPrincipal);
});
```

Assert `embeddings.embed(text, { agentId: "agent-a" })`, finite non-empty vector validation, source ACL + active lifecycle before embedding, no zero-vector fallback, `addColumns()` for all four share-provenance fields, retention of Task 1's durable `agentId`/`workspaceId` columns, and retry after a failed store.

Use `MemoryDB`-form contract fixtures in addition to simple mocks: implement the real `init()`, `table.schema`, `table.addColumns()`, `store()`, and readback method shapes without opening LanceDB. Start with a 4-D target schema that predates the share columns, perform the first share, recreate the adapter over the same in-memory rows/schema, and read back exact values/types. Add wrong-dimension, `NaN`/`Infinity`, concurrent first-initialization, and interrupted-schema-retry cases. Add a named Multi-Namespace fixture proving source lookup leases only `pool.withWriteDb(agentId)` (the authoritative private writer), never a legacy read namespace and never either shared pool.

- [ ] **Step 2: Run share store tests red**

```bash
node --test --test-concurrency=1 tests/shared-memory-store-guard.test.js tests/forget-correct-confirm.test.js tests/b13-share-store.test.js
```

Expected: FAIL because current code writes `workspace_shared` into the agent pool, fabricates a zero vector, lacks ownership/provenance, and is not idempotent.

- [ ] **Step 3: Replace pseudo-sharing with explicit public-scope copies**

Do not add or rely on an undeclared direct `apache-arrow` dependency. Export `ensureSharedMemoryColumns(db)`, call `await db.init()`, read the authoritative table schema, and reuse the existing `text` field's string DataType object for each new string column. Fail closed if that field/type is absent. Call `db.table.addColumns()` only for missing names, with both the reused `type` and Lance-compatible `valueSql` defaults:

```js
[
  { name: "sourceMemoryId", type: textField.type, valueSql: "''" },
  { name: "sourceAgentId", type: textField.type, valueSql: "''" },
  { name: "shareIdempotencyKey", type: textField.type, valueSql: "''" },
  { name: "shareProvenance", type: textField.type, valueSql: "'{}'" },
]
```

The helper serializes first-table initialization/schema migration per physical DB, tolerates only the documented duplicate-column race after re-reading the schema, calls `db.refreshSchemaFields()` after successful migration so `normalizeEntryForTable()` retains the new values, and rethrows every other error so a later call can retry. It also asserts that Task 1's `agentId` and `workspaceId` fields exist after `db.init()`; absence fails closed instead of storing an incomplete ownership tuple. Validate `vector.length === db.vectorDim`, every element is finite, and the existing table vector type/dimension agrees before `store()`.

Change the store API to:

```js
export async function storeSharedMemory(targetDb, source, ctx, {
  targetScope,
  vector,
  action = "explicit_share",
  allowSensitiveShare = false,
  logger = null,
} = {})
```

`storeSharedMemory()` operates on exactly one already leased target `MemoryDB`; it never owns or re-enters `SharedMemoryPool`. Validate `targetScope` as `workspace` or `user` and `action` against the closed internal set `explicit_share | legacy_workspace_shared_migration`; the public command never accepts an action argument. Require `ctx.workspaceIdentity` or `ctx.userPrincipal`; reject sensitive rows unless approved; require a finite vector of the real target dimension. Compute the idempotency key from action + target scope + canonical target principal + source agent + source ID + content hash. Serialize each key with a module-local keyed promise queue, query active rows by `sqlString(shareIdempotencyKey)`, return an existing row, otherwise store and readback-verify exactly one row before acknowledging. Build the copy with public scope and these exact bindings: workspace copies set both `workspaceId` and `workspaceKey` to `ctx.workspaceIdentity` and `ownerUserId: ""`; user copies set `ownerUserId: ctx.userPrincipal` and both workspace aliases empty.

Copy every recall/display and lifecycle field currently projected by `projectRecallEntry`: `text`, `summary`, `category`, `type`, `origin`, `importance`, timestamps, evidence/source fields, emotional fields, dynamics fields, core/never-forget fields, `expiresAt`, `memoryKind`, reminder/confirmation fields, and version fields. Set a new UUID, `status: "active"`, `storedBy`/`agentId` to the source agent, and persist `sourceMemoryId`, `sourceAgentId`, `shareIdempotencyKey`, and bounded JSON `shareProvenance` (`schemaVersion`, action, targetScope, targetPrincipalHash, source IDs, sharedAt; no raw principal). Preserve the source expiry exactly so sharing never extends retention. Do not copy deletion/supersession links as active state and never mutate the source.

`shareCard()` must `safeUuid(sourceId)` inside the export, receive the initialized `MultiNamespacePool`, lease exactly `privatePool.withWriteDb(agent, ...)`, initialize and fetch the source there, require active/null status, and validate `expiresAt` without coercion: only null/undefined, numeric zero, or a finite number strictly later than the captured request time is live; every string, boolean, object, negative, `NaN`, or infinite value fails closed. Require a public `agent-private`/`workspace`/`user` scope (never `workspace_shared`) and enforce `checkAccess(opts.ctx, card)`. Classify sensitivity before provider work with independent checks for both `category` and `type` (neither may mask the other), plus `memoryClass`, `neverForget`, and importance; an expired, malformed-lifecycle, or unapproved source returns before embedding or target lease. Then call the request-bound existing provider `embeddings.embed(card.text || card.summary, { agentId: agent })` while the source lease is alive, lease exactly one requested `sharedPool.withWorkspaceDb/withUserDb`, and call `storeSharedMemory(targetDb, ...)` without a nested/double lease. Re-read and re-authorize the source, including the strict expiry check against a fresh completion time, in the same authoritative writer during confirmation completion. Remove the old zero-vector and `workspace_shared` path. Add invalid UUID, already-expired, malformed expiry, and expires-during-confirmation, benign-category+sensitive-type, sensitive-category+benign-type, and no-embed/no-target-lease regressions.

- [ ] **Step 4: Run share store tests green**

Run the Step 2 command. Expected: PASS; parallel repeats produce one ID/row, and failed writes are retryable.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add lib/shared-memory.js lib/telegram-commands/memory-edit.js tests/shared-memory-store-guard.test.js tests/forget-correct-confirm.test.js tests/b13-share-store.test.js
git commit -m "feat: store idempotent owner-bound shared memories"
```

Spec review must check copy-not-move, exact canonical target bindings, full field projection, real request-agent embedding, authoritative-writer source selection, sensitive guard, idempotency, and source immutability. Quality review must inspect authoritative schema-type reuse/defaults, vector dimension, table init/migration races/retry, SQL escaping, mutex cleanup, readback failure, and safe error text. Fix/re-review all Critical/Important findings before Task 8.

### Task 8: Wire `/share` and `/teile` with bound confirmation (FA-04 command)

**Files:**
- Modify: `index.js`
- Modify: `lib/i18n-dictionary.js`
- Modify: `tests/command-reachability.test.js`
- Modify: `tests/forget-correct-confirm.test.js`
- Create: `tests/b13-share-runtime.test.js`

- [ ] **Step 1: Write failing registered-command tests**

Drive handlers returned by `api.registerCommand()`:

```js
it("registers both aliases and copies a normal card to the workspace pool", async () => {
  assert.ok(commands.get("share"));
  assert.ok(commands.get("teile"));
  const result = await commands.get("share").handler(ownerCtx(sourceId));
  assert.match(result.text, /shared|geteilt/i);
  assert.equal(sourceRows.get(sourceId).status, "active");
  assert.equal(workspaceRows.length, 1);
});

it("requires authenticated ownership for --user", async () => {
  const result = await commands.get("share").handler(chatOnlyCtx(`${sourceId} --user`));
  assert.match(result.text, /authenticated user|Benutzeridentität/i);
  assert.equal(userRows.length, 0);
});

it("binds a sensitive confirmation to user chat nonce and target scope", async () => {
  const start = await commands.get("share").handler(ownerCtx(`${sensitiveId} --user`));
  const token = extractToken(start.text);
  const stolen = await commands.get("share").handler(otherUserCtx(`confirm ${token}`));
  assert.match(stolen.text, /failed|fehlgeschlagen/i);
  const done = await commands.get("share").handler(ownerCtx(`confirm ${token}`));
  assert.match(done.text, /shared|geteilt/i);
  assert.equal(userRows[0].scope, "user");
});
```

Add cases for core, `neverForget`, high importance, sensitive category, expired/wrong-chat nonce, normal immediate user share, repeat share returning the same ID, invalid flags, and authorization before source DB/embed.

Assert the displayed/parsed confirmation token is the complete UUID nonce. A six-character or otherwise shortened prefix, altered suffix, and valid nonce paired with a different target are rejected with zero source/embed/target work and do not consume the pending exact confirmation.

At least one positive workspace share and the entire sensitive confirmation round-trip must use the official host-shaped command fixture from Task 1, with no synthetic `workspaceDir`, `workspaceId`, `workspaceKey`, `userId`, or `chatId`. Stub only the documented read-only binding getter and runtime workspace resolver. Assert raw resolved `chatId` is used for `allowedChatIds`, while one identical derived `confirmationChatId = resolvedCtx.conversationPrincipal || resolvedCtx.chatId` is passed to both confirmation creation and completion; wrong account/thread/session fails.

- [ ] **Step 2: Run command tests red**

```bash
node --test --test-concurrency=1 tests/command-reachability.test.js tests/forget-correct-confirm.test.js tests/b13-share-runtime.test.js
```

Expected: FAIL because neither command is registered and no share confirmation flow exists.

- [ ] **Step 3: Construct the shared pool and add one share handler**

After `pool` creation, construct:

```js
const sharedMemoryPool = new SharedMemoryPool(
  namespaceLayout.baseDir,
  vectorDim,
  AgentDbPool,
  api.logger,
);
```

Pass it to `registerGatewayShutdown()`. Implement `runShareCommand(commandCtx)` with this grammar only:

```text
/share <uuid>
/share <uuid> --user
/share confirm <nonce>
/teile <uuid>
/teile <uuid> --user
/teile confirm <nonce>
```

Validate bounded args from the original invocation and `safeUuid`, then call `resolveHostCommandMemoryContext()` before authorization or dependency construction, using `requireWorkspace: true` for the default workspace target or `requireUser: true` for `--user`. Call `checkAuth(resolvedCtx, { destructive: true, chatKind: resolvedCtx.chatKind })` before source lookup. For a sensitive card, require non-empty raw `userId` and `confirmationChatId = conversationPrincipal || chatId`, create `createConfirmation({ userId, chatId: confirmationChatId, command: "share", targetId })`, and persist only `{ targetScope, sourceId }` in `confirm.payload`; do not persist card text. Return and accept the complete UUID nonce only. Completion validates the full UUID, performs the common exact pending lookup, resolves the host context again, authorizes it with the same explicit chat kind, and calls a `completePending` form with that same explicit `{ userId, chatId: confirmationChatId }` binding rather than the raw `PluginCommandContext`; it then re-reads/re-authorizes the source before sharing with `allowSensitiveShare: true`.

For workspace share, `requireWorkspace: true` is sufficient; for `--user`, require both `userPrincipal` and raw `userId` plus a stable confirmation binding, but do not require a workspace. Both initial and confirmed execution call Task 7's `shareCard(pool, sharedMemoryPool, embeddings, agentId, sourceId, ...)`, which leases the authoritative private writer only. Add a named-namespace regression where a matching UUID exists in a legacy read namespace but not the active writer: `/share` returns the same not-found text as a missing UUID and performs no embed/store.

Register both names with the same handler and channel set. Add localized usage, confirmation, success, not-found, unauthenticated-user, and safe failure keys. Responses must not disclose a denied source's existence.

- [ ] **Step 4: Run command tests green**

Run the Step 2 command. Expected: PASS; source remains active, confirmations are identity-bound, aliases are equivalent.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add index.js lib/i18n-dictionary.js tests/command-reachability.test.js tests/forget-correct-confirm.test.js tests/b13-share-runtime.test.js
git commit -m "feat: wire confirmed workspace and user sharing"
```

Spec review must traverse registered aliases, all grammar variants, user requirement, sensitive classification, and confirmation replay/wrong identity. Quality review must inspect input validation, pending payload minimization, re-read at completion, error non-enumeration, and source immutability. Fix/re-review all Critical/Important findings before Task 9.

### Task 9: Merge private, workspace, and owner recall sources (FA-04 recall)

**Files:**
- Modify: `lib/shared-memory.js`
- Modify: `lib/telegram-commands/memory-query.js`
- Modify: `lib/recall-pipeline.js`
- Modify: `index.js`
- Modify: `tests/recall-golden-set-pipeline.test.js`
- Modify: `tests/multi-namespace-recall-runtime.test.js`
- Create: `tests/b13-shared-recall.test.js`
- Modify: `tests/openclaw-default-llm-callers.test.js`

- [ ] **Step 1: Write failing cross-agent/workspace/user recall tests**

Use real registered tool/auto-recall and `/memory` paths where practical:

```js
it("recalls workspace copies across agents only inside the same workspace", async () => {
  await shareFrom("agent-a", workspaceACtx, sourceId, "workspace");
  assert.deepEqual(await recalledIds("agent-b", workspaceACtx), [sharedId]);
  assert.deepEqual(await recalledIds("agent-b", workspaceBCtx), []);
});

it("recalls owner copies across the owner's agents and workspaces", async () => {
  await shareFrom("agent-a", ownerAWorkspaceA, sourceId, "user");
  assert.deepEqual(await recalledIds("agent-b", ownerAWorkspaceB), [sharedId]);
  assert.deepEqual(await recalledIds("agent-b", ownerBWorkspaceB), []);
  assert.deepEqual(await recalledIds("agent-b", anonymousWorkspaceB), []);
});

it("keeps multi-namespace reads same-agent and deduplicates shared source copies", async () => {
  const result = await recallWithPrivateNamespacesAndSharedPools();
  assert.equal(result.memories.filter((row) => canonicalMemoryOriginKey(row.entry) === `agent-a:${sourceId}`).length, 1);
});
```

Add these access-composition cases: private-only context (no workspace and no user principal) still recalls private DBs; workspace-only adds workspace; user-only adds user without requiring workspace; all-bound adds both. A missing shared binding is a skipped optional source, never a reason to drop private recall. The real registered auto-recall test must first observe the matching Task 1 `reply_dispatch` ticket, then call `resolveHostHookMemoryContext()` with that registry and the injected current-session reader before leasing optional pools: matching ticket + current entry adds the exact user pool, while missing/conflicting/stale proof performs no user-pool filesystem/DB work and still returns private/workspace results. Add `/memory` topic and time-mode parity, active lifecycle filtering, `userPrincipal` propagation, canonical search only once, Semantic Lens/CRR ordering unchanged, and spies proving initial/refined/graph and `/memory` topic embeddings all receive `{ agentId: requestingAgent }` through the existing provider without key/model/endpoint overrides.

Create duplicates of one origin in private, workspace, and user pools. Define the canonical origin key as `sourceAgentId + ":" + sourceMemoryId` for shared copies and `agentId/storedBy + ":" + id` for the private source. Assert both base recall and `/memory` collect bounded candidates from all sources, collapse all three before the existing final `topN`/formatter cap, and choose the duplicate representative with stable priority private > workspace > user; after duplicate selection, unrelated rows retain existing score/time ordering. Source acquisition keeps the existing hard maximum of 100 candidates per physical vector/table query as a safety bound, but never applies the final display `topN` separately per source. Projection must preserve the share fields needed to calculate the key after initial, refined, and graph hydration.

- [ ] **Step 2: Run shared recall tests red**

```bash
node --test --test-concurrency=1 tests/b13-shared-recall.test.js tests/recall-golden-set-pipeline.test.js tests/multi-namespace-recall-runtime.test.js tests/openclaw-default-llm-callers.test.js
```

Expected: FAIL because recall reads only same-agent namespace DBs and `/memory` reads only its private adapter.

- [ ] **Step 3: Lease all authorized pools and reuse existing merge semantics**

Add trace-safe source descriptors and an acquisition-only optional-lease wrapper:

```js
export async function withAccessReadDbs(privatePool, sharedPool, agentId, ctx, fn) {
  return privatePool.withReadDbs(agentId, async (privateDbs) => {
    const required = privateDbs.map((item) => ({ ...item, optional: false, sourceKind: "private" }));
    return withOptionalAccessLease(
      ctx.workspaceIdentity ? (cb) => sharedPool.withWorkspaceReadDb(ctx, cb) : null,
      { namespace: "shared-workspace", sourceKind: "workspace" },
      required,
      (withWorkspace) => withOptionalAccessLease(
        ctx.userPrincipal ? (cb) => sharedPool.withUserReadDb(ctx, cb) : null,
        { namespace: "shared-user", sourceKind: "user" },
        withWorkspace,
        fn,
      ),
    );
  });
}
```

`withOptionalAccessLease()` invokes `fn` exactly once, treats a `null` read DB as an absent optional source, tracks whether a non-null lease callback was entered, and only catches acquisition failure before entry; it logs that failure with `safeWarn` and continues to the next source. Callback/query failures are not mistaken for acquisition failures. Read acquisition must never construct a write pool or create a directory, table, bootstrap row, or schema column; assert that behavior for missing workspace and user stores. Replace both manual-tool and auto-recall `pool.withReadDbs()` calls with `withAccessReadDbs()`. Resolve context once per request; the existing `autoRecall: true` branch reuses the Task 1 route registry/observer and gives the auto-recall hook the registry, host-hook resolver, routing loader, and `api.runtime.agent.session.getSessionEntry`, never creating a second registry, a disabled-feature hook, a `message_received` bridge, or a configured account default. Pass canonical `workspaceId` and only a ticket-and-session-proven `userPrincipal` into `_recallBaseParams`; preserve `agentId`, runtime LLM context, required private Multi-Namespace strict-error semantics, canonical-first behavior, graph configuration, trace, budget, dedup, and later Semantic Lens/CRR calls. `runMergedNamespaceRecall()` treats existing private descriptors as required: any required failure retains today's aggregate/timeout behavior. Each optional shared descriptor is independently settled; a shared query failure is safely warned/traced and omitted without dropping private results or the other shared source. Use only regex-safe labels `shared-workspace` and `shared-user` in trace and never treat them as configured Multi-Namespace names.

Create one request-bound embedding adapter that preserves provider purpose:

```js
const requestEmbeddings = Object.freeze({
  embedQuery: (text) => typeof embeddings.embedQuery === "function"
    ? embeddings.embedQuery(text, { agentId })
    : embeddings.embed(text, { agentId }),
  embed: (text) => embeddings.embed(text, { agentId }),
});
```

Pass it through every initial/refined query and graph/passage relevance call and `/memory` topic mode. Never attach model/key/baseUrl/header fields. Add spies proving `embedQuery` remains selected for query/refinement and `embed` for passage/graph content, including Local-Transformers purpose behavior.

Extend `runRecallPipeline()` with an internal `deferFinalCap: false` and bounded `candidateHardLimit: 100` mode used only by multi-source recall. In deferred mode it performs projection, the exact active/null and non-expired gate `(expiresAt IS NULL OR expiresAt = 0 OR expiresAt > capturedNow)`, ACL gates, relevance/reranking, and returns at most the hard candidate limit, but does not apply the caller's final `topN`/budget slice or final inter-result Jaccard cap. Capture one request time and use it consistently across all sources. `runMergedNamespaceRecall()` requests deferred candidates for every required/optional source, enables canonical search only on the first private source, then calls an enhanced `mergeNamespaceRecallResults()`. Export `canonicalMemoryOriginKey(entry)` and make the merger perform canonical-origin dedup first, choosing duplicate representatives by `private > shared-workspace > shared-user`, then retain current score/ordinal ordering for unrelated rows, existing ID/Jaccard dedup, and one global final cap. Record `namespace-origin-dedup` decisions in the bounded master trace. Single-source recall keeps the current non-deferred behavior. Ensure `projectRecallEntry()` retains `expiresAt`, `memoryKind`, `type`, confirmation/reminder fields, and every lifecycle value copied in Task 7; add expired-before-query and boundary-time regressions for private and both shared sources.

For `/memory`, export `queryMemoryAcrossAccessPools({ privatePool, sharedPool, embeddings, agent, parsed, ctx })` and acquire sources through the same optional composition helper. Do not call the db-adapter-only `queryMemory()` methods on real `MemoryDB`. Add `queryMemoryDbCandidates(db, parsed, requestEmbeddings, ctx, { hardLimit: 100, now })`: initialize the already-existing read-only DB; for topic mode call `requestEmbeddings.embedQuery()` and the real table vector query, applying the validated `buildWhereClause(parsed.filters)` together with the exact active/null and non-expired predicate `(expiresAt IS NULL OR expiresAt = 0 OR expiresAt > now)` so category/source/origin/minImportance/from/to/emotion behavior remains unchanged; for time mode call a bounded real `table.query()` with the existing exported `computeCutoff()` range and the same lifecycle predicate. Capture `now` once per `/memory` request. Do not use `scanActive()`, whose projection/status semantics are insufficient.

Export `projectMemoryQueryCard(row)` from `memory-query.js`: it produces the existing formatter fields `title`, `source`, `date`, `id`, text/summary/createdAt/explanation while also retaining every canonical ownership/share field from `projectRecallEntry()`. Use this projector before ACL/merge so `formatResults()` never regresses to `(untitled) / ? / ?`. Add rendered title/date/source parity and every parsed filter regression. Optional shared query failures use the same independent warn/trace skip rule; private failures retain existing semantics. Combine all bounded candidates, apply `filterMemoriesByAcl`, choose canonical-origin duplicates with private/workspace/user priority, retain existing topic-score or time ordering for unrelated rows, then apply the one existing formatter cap. Never deduplicate on `sourceMemoryId` alone because different source agents may reuse an ID.

Apply the same non-coercing lifecycle helper from Task 3 after projection and before ACL, graph, rerank, embeddings beyond the initial DB query, or formatting. Null/undefined and numeric zero are non-expiring; only finite future numbers are live. Malformed strings, booleans, objects, negative values, and non-finite numbers are invisible even if a backend SQL engine coerces them. Add malformed-expiry no-provider/no-disclosure regressions for base recall and `/memory` across private, workspace, and user sources.

- [ ] **Step 4: Run shared recall and adjacent default-route tests green**

Run the Step 2 command. Expected: PASS; workspace/user positive paths work; foreign/anonymous paths return none; no model/key assertions change.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add lib/shared-memory.js lib/telegram-commands/memory-query.js lib/recall-pipeline.js index.js tests/b13-shared-recall.test.js tests/recall-golden-set-pipeline.test.js tests/multi-namespace-recall-runtime.test.js tests/openclaw-default-llm-callers.test.js
git commit -m "feat: recall authorized shared memory pools"
```

Spec review must prove private-only/workspace-only/user-only/all-bound source composition, owner/workspace isolation, same-agent Multi-Namespace semantics, `/memory` parity, pre-provider ACL, request-bound embedding context, and additive booster order. Quality review must inspect lease lifetime, optional-source failure behavior, canonical origin dedup before caps, stable priority/ranking, trace caps, and performance bounds. Fix/re-review all Critical/Important findings before Task 10.

### Task 10: Explicit legacy `workspace_shared` compatibility migration

**Files:**
- Create: `lib/shared-memory-migration.js`
- Create: `tests/b13-legacy-share-migration.test.js`
- Modify: `lib/shared-memory.js`
- Modify: `lib/multi-namespace-pool.js`
- Modify: `index.js`
- Modify: `tests/multi-namespace-pool.test.js`
- Modify: `tests/plur1bus-internal-auth.test.js`
- Modify: `README.md`

- [ ] **Step 1: Write failing dry-run, apply, ambiguity, and retry tests**

```js
it("dry-run writes only the bounded audit report and never mutates memory", async () => {
  const result = await migrateLegacySharedRows({ privatePool, sharedPool, embeddings, agentId, workspaceAliases, apply: false, reportDir, logger });
  assert.equal(result.planned, 1);
  assert.equal(storeCalls.length, 0);
  assert.equal(sourceUpdateCalls.length, 0);
  assert.equal(JSON.parse(readFileSync(result.reportPath, "utf8")).dryRun, true);
});

it("copies, verifies, then writes the source migration marker", async () => {
  const result = await migrateLegacySharedRows({ privatePool, sharedPool, embeddings, agentId, workspaceAliases, apply: true, reportDir, logger });
  assert.equal(result.migrated, 1);
  assert.deepEqual(operationOrder, ["embed-agent", "store-copy", "readback-copy", "mark-source"]);
  assert.equal(sourceRow.scope, "workspace_shared");
  assert.equal(sourceRow.status, "active");
  assert.equal(JSON.parse(sourceRow.legacyShareMigrationMarker).schemaVersion, 1);
});

it("leaves unbound or conflicting rows untouched and writes an atomic repair report", async () => {
  const result = await migrateLegacySharedRows({ privatePool: ambiguousPrivatePool, sharedPool, embeddings, agentId, workspaceAliases, apply: true, reportDir, logger });
  assert.equal(storeCalls.length, 0);
  assert.equal(sourceUpdateCalls.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(result.reportPath, "utf8")).repair.map((row) => row.reason), [
    "missing_workspace_binding",
    "conflicting_workspace_binding",
  ]);
});
```

Add repeat/apply idempotency, failed readback leaves the marker empty, inactive row skipped, and a LanceDB-free `MemoryDB`-form schema fixture proving `legacyShareMigrationMarker` reuses the authoritative `text` field DataType with `valueSql "'{}'"`, refreshes cached schema fields, and only then marks. Add sensitive/core/never-forget/high-importance legacy rows proving the destructively authorized apply path explicitly passes `allowSensitiveShare: true`; dry-run still performs no share. Add a fresh lazy-pool dry-run test proving zero `addColumns`, bootstrap delete, create-table, embed, target store, and source update calls. Assert every migration embedding receives `{ agentId }` from the initialized provider and no alternate key/model/baseUrl is constructed.

Add hard-budget fixtures with more than 250 rows, more than 4 MiB of selected source text/summary, more than 100 otherwise valid embed candidates, and a deterministic fake clock crossing 60 seconds. Each invocation must stop at the first reached bound, start no further provider/DB operation, release every lease, report exact examined/terminally-consumed/byte/provider counters, and return `incomplete: true` plus a continuation token. Resume against the same pinned source version/terminal offset processes every row exactly once despite current-version marker writes; the writer re-reads the current row/marker before each copy. A different agent/route, dry-run/apply mode, workspace-snapshot digest, malformed token, changed token field/checksum, unavailable/compacted source version, invalid offset, or current-row identity mismatch fails closed with zero provider/target/source work. A dry-run cursor supplied with `--apply` is rejected and apply must restart without a cursor at offset zero. Cover operator abort before start, between rows, after embedding but before target write, after readback but before marker, during an embedding timeout, and during shutdown; no rejected promise is left unobserved, no incomplete row advances the continuation offset, and no source marker is written after cancellation. Add a page where a later row exceeds only the remaining aggregate byte budget but fits a fresh invocation; it must be the first row on resume, not `source_too_large`. Dry-run is subject to the same scan/byte/time bounds and continuation contract even though its provider count remains zero.

Add an expired legacy row and a boundary-time row. Capture one migration timestamp and assert any positive `expiresAt <= migrationNow` is counted as `expiredSkipped` and receives zero embed, target lease/store/readback, source marker, or source update work in both dry-run and apply; non-expiring zero/null and future rows retain normal behavior. Add negative, `NaN`, `Infinity`, boolean/object, and non-numeric expiry fixtures; each must be reported as `invalid_expiry` with the same zero-work assertions.

Add registered `/plur1bus migrate-legacy-shared [--report report.json] [--cursor token] [--apply]` tests through the real plugin harness and the official host-shaped command fixture from Task 1. Resolve host context before auth; a destructively authorized operator uses initialized pools/providers and `resolvedCtx.agentId/workspaceDir/workspaceAliases`, while an unauthorized chat performs zero pool/embed/report work. The parser accepts at most one bounded opaque cursor and never accepts raw version/offset overrides. Assert a cron identity does not bypass the destructive operator gate; this is an operator command, not a cron-internal job. Add a source inspection assertion that no standalone script, alternate `MemoryDB`/`AgentDbPool`, embedding-provider constructor, config loader, API-key option, or base-path option is introduced.

For reports, test an existing symlink at the report directory and destination, a destination swap/race before no-clobber publication, an existing regular destination that remains byte-identical, mode `0600`, temp cleanup, fsync-before-publication plus directory-fsync after publication, and hard bounds of 1,000 repair entries/1 MiB JSON. Assert each repair entry contains only `memoryId`, `agentId`, `workspaceId`, `workspaceKey`, and `reason`; no text, summary, vector, evidence, or provenance.

- [ ] **Step 2: Run migration tests red**

```bash
node --test --test-concurrency=1 tests/b13-legacy-share-migration.test.js tests/multi-namespace-pool.test.js tests/plur1bus-internal-auth.test.js
```

Expected: FAIL because no explicit compatibility migration exists.

- [ ] **Step 3: Implement copy/verify/mark and atomic reporting**

Export a dependency-injected runtime function; it receives resources already initialized by `index.js`:

```js
export async function migrateLegacySharedRows({
  privatePool,
  sharedPool,
  embeddings,
  agentId,
  workspaceAliases,
  apply = false,
  reportDir,
  reportName = null,
  continuationToken = null,
  signal = null,
  maxRows = 250,
  maxSourceBytes = 4 * 1024 * 1024,
  maxProviderCalls = 100,
  maxElapsedMs = 60_000,
  now = Date.now,
  logger = null,
})
```

Add `MultiNamespacePool.withAuthoritativeReadDb(agentId, fn)`: it leases a separate read-only `AgentDbPool` rooted at exactly the active write namespace (or legacy-flat route), uses the same pinned capability/path guard, is included in aggregate shutdown, and never enumerates recall namespaces. Its `MemoryDB.init()` can only open an existing table and refresh schema; it cannot create a table, add columns, or delete the bootstrap row. Add DB-free route/readOnly/shutdown tests.

Call `safeAgentId(agentId)`, require the deeply frozen trusted `workspaceAliases` snapshot, validate the finite positive hard limits against immutable maximums, and `safeUuid(row.id)` before any provider/target/source write. Invalid IDs become bounded repair entries with no provider/write work. Dry-run scans only through `privatePool.withAuthoritativeReadDb(agentId, ...)` and never leases/initializes the writer. Apply acquires the exact `privatePool.withWriteDb(agentId, ...)` lease only for the bounded invocation, initializes it, completes/verifies the marker-column migration, and then nests the separate authoritative read-only lease pinned to the token's source version while holding the writer for per-row marker updates. Neither mode enumerates named recall namespaces, shared pools, or a requester-relative DB, and neither uses `scanActive()`. If the authoritative table does not exist, return a zero-count report. Inspect its schema, require core `id/text/scope/status`, and select the intersection of the full ownership/content/sensitivity/provenance/version/copy columns so pre-migration schemas receive explicit code defaults rather than an invalid missing-column SELECT.

On the first invocation, read and pin `sourceVersion = await table.version()` before querying. On resume, decode a bounded base64url canonical-JSON token `{ schemaVersion: 1, mode: "dry-run" | "apply", agentRouteHash, workspaceAliasesHash, sourceVersion, nextOffset, checksum }`, validate every field/type/limit plus `checksum = sha256(canonical payload without checksum)`, require exact current operation mode, canonical agent-route hash, and digest of the deeply frozen workspace-alias snapshot, and `checkout(sourceVersion)` on the separate read-only table; never checkout the writer. A dry-run token can resume only dry-run; apply after dry-run starts a new no-cursor run at offset zero. An unavailable version or any token mismatch fails closed and instructs the operator to restart without a cursor. Execute exactly one pinned query with the static predicate `scope = 'workspace_shared' AND (status IS NULL OR status = '' OR status = 'active')`, `.offset(nextOffset)`, `.limit(maxRows + 1)`, and `query.execute({ maxBatchLength: Math.min(200, maxRows + 1), timeoutMs: remainingMs })`; consume its `AsyncIterable<RecordBatch>` without materializing the table. The pinned version makes physical offset continuation deterministic even while the current writer adds marker versions. The extra row proves more work without examining it. If the installed LanceDB runtime lacks version/checkout/offset/limit/bounded execution, fail closed before apply. A multi-run DB-free fixture proves no skip/duplicate while current-version marker writes occur.

Maintain separate `examinedRows` and `terminallyConsumedRows`. `examinedRows` is report-only. Advance the continuation offset only after a row reaches a terminal outcome for this token mode: dry-run planning/repair/skip; apply's verified existing marker, permanent validation/expiry/oversize repair, or successful copy/readback/source marker. Provider/DB failure, provider-cap exhaustion, aggregate-byte exhaustion, timeout, or abort before a terminal outcome leaves the current row as the next resume row. Return `nextOffset + terminallyConsumedRows`, never `+ examinedRows`, when an extra row exists or any bound stops the page.

Count UTF-8 bytes of selected `text` plus `summary` before workspace/provider work. Only `rowBytes > maxSourceBytes` is the permanent `source_too_large` repair that consumes the row. If `sourceBytesSoFar + rowBytes > maxSourceBytes`, stop before consuming that otherwise valid row and resume at its offset in a fresh invocation. Before each provider/target/readback/source operation, check `signal?.aborted` and the immutable deadline. Cap provider starts at `maxProviderCalls`; wrap each embed in the smaller of 15 seconds or remaining run time, attach an observed warning handler to any timed-out underlying rejection, and never start target/source work after timeout or abort. Existing DB timeout wrappers receive the remaining deadline. Bound repair output separately while maintaining aggregate counts. Before copying a snapshot row, re-read its exact current writer row by safe UUID and require immutable `id`, source ownership, scope, and content hash to agree; a valid existing marker is verified/idempotently consumed, while disappearance/change becomes a permanent repair/consume with no copy/mark. Resolve workspace binding from equal non-empty `workspaceId`/`workspaceKey`, or the sole non-empty alias; canonicalize it with the explicit trusted snapshot to the same Task 1 workspace principal and never use current requester context. For valid rows, call the existing initialized provider as `embeddings.embed(row.text || row.summary, { agentId })`, recheck abort/deadline without consuming on interruption, call Task 7's idempotent workspace store with `action: "legacy_workspace_shared_migration"` and `allowSensitiveShare: true`, read back the exact shared ID/key, recheck abort/deadline, then update only `legacyShareMigrationMarker` on the source. A stop after target readback but before marking leaves the offset unchanged; the idempotent target key makes resume verify/reuse the copy before marking. Never change legacy scope/status/text/shareProvenance or delete it.

Capture one immutable `migrationNow` before scanning and include `expiresAt` in the selected-column intersection when present. Before any workspace resolution, embedding, target lease/write/readback, or source marker work, validate expiry without coercion: only `null`/`undefined`, the numeric value `0` (non-expiring), or a finite positive number strictly greater than `migrationNow` may continue. A finite positive number `<= migrationNow` increments `expiredSkipped`; negative numbers, `NaN`/`Infinity`, strings (including `""` and numeric strings), booleans, arrays, and objects produce a bounded `invalid_expiry` repair/skip. Both skip paths perform zero provider/target/marker work and never replace an invalid value with `0`. This code gate is mandatory even if the storage query also includes an expiry predicate.

Before an apply marker write, `ensureLegacySourceMarkerColumn(sourceDb)` inspects the authoritative schema, reuses the existing `text` field's string DataType (failing closed if unavailable), and calls:

```js
await sourceDb.table.addColumns([
  { name: "legacyShareMigrationMarker", type: textField.type, valueSql: "'{}'" },
]);
await sourceDb.refreshSchemaFields();
```

If `addColumns()` reports the documented duplicate-column race, re-read the schema, require the exact column/type, and still call `sourceDb.refreshSchemaFields()` before `sourceDb.update()`; rethrow every other error. The bounded marker is JSON `{ schemaVersion: 1, action, sharedId, shareIdempotencyKey, migratedAt }`. A non-empty valid marker is idempotently verified against the target; malformed/mismatching markers go to repair and are never overwritten. Dry-run performs no schema migration, embed, target write, or source update. It does write the same private bounded repair/planning report as apply, which is audit output rather than a memory mutation.

`writeLegacyRepairReport()` validates the existing workspace root first, derives `.plur1bus` with `resolveInside(workspaceDir, ".plur1bus")` before creating/opening that segment, then—after the parent exists and is pinned—derives `migrations` with `resolveInside(plur1busDirectory, "migrations")` before creating/opening it. Only after the pinned migration directory exists does it derive each temp and final target with `resolveInside(migrationDirectory, basename)` before the corresponding filesystem operation. It opens/creates segments one at a time through `openDirectoryCapability()`, rejects symlinks, and operates through the pinned directory's verified `capability.path` alias. Create a unique temp at `${migrationCapability.path}/${tempName}` with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0o600`; write bounded `{ schemaVersion: 1, generatedAt, dryRun, incomplete, continuationToken, budgets, counts, truncated, repair }`, `fsyncSync`, and close. The token contains no raw path/user/provider/account data. Publish without replacement using `linkSync(`${migrationCapability.path}/${tempName}`, `${migrationCapability.path}/${reportName}`)` followed by unlinking only the temp name, then fsync the directory. Both basenames are validated and their display paths are checked with `resolveInside()` immediately before the call; the hard-link operation is atomic and fails with `EEXIST` instead of replacing the target. Use exactly two validated basenames beneath the pinned directory-FD alias; never use the temporary file descriptor alias `/proc/self/fd/<tempFd>` or `/dev/fd/<tempFd>` as the source, and never use rename-over-existing semantics. An explicit destination that already exists fails with `EEXIST` and remains byte-identical; an automatically generated name retries a bounded number of fresh collisions. On error close/unlink the temp and log safely. Validate an explicit report basename before filesystem work with `validateInput(value, { maxLength: 128, name: "migration report name", required: true })`, require `/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/`, and reject `.`, `..`, separators, and NUL. If no name is supplied, generate `legacy-shared-repair-<UTCcompact>-<nonce>.json` from a cryptographic nonce. Limit repair to 1,000 entries and the serialized report to 1 MiB, preserving aggregate omitted counts. Add repeated-run, pre-existing regular-file, generated-name collision, destination race, and byte-for-byte no-overwrite tests in addition to symlink/swap coverage.

Wire the initialized handler as an explicit top-level action before constructing the generic Neo `commandStore` and outside the cron-only `internal` branch:

```js
if (actionKey === "migrate-legacy-shared") {
  const resolvedCtx = await resolveHostCommandMemoryContext(commandCtx, {
    resolveAgentWorkspaceDir: api.runtime.agent.resolveAgentWorkspaceDir,
    workspaceAliases: trustedWorkspaceAliases,
    requireWorkspace: true,
  });
  const denied = checkAuth(resolvedCtx, { destructive: true, chatKind: resolvedCtx.chatKind });
  if (denied) return denied;
  const options = parseLegacyMigrationArgs(tokens.slice(1));
  return formatJsonCommandResult(await migrateLegacySharedRows({
    privatePool: pool,
    sharedPool: sharedMemoryPool,
    embeddings,
    agentId: resolvedCtx.agentId,
    workspaceAliases: resolvedCtx.workspaceAliases,
    apply: options.apply,
    reportDir: resolvedCtx.workspaceDir,
    reportName: options.reportName,
    continuationToken: options.continuationToken,
    signal: commandCtx.abortSignal,
    logger: api.logger,
  }));
}
```

The operator parser accepts only `--report <basename>`, `--cursor <opaque-token>`, and `--apply`, rejects duplicates/unknowns, bounds the token to 2,048 ASCII base64url characters before decoding, and defaults to dry-run plus an immutable generated report name. It requires `resolvedCtx.workspaceDir` for the pinned private report directory and obtains the agent exclusively from the authenticated/resolved OpenClaw command context; it never accepts agent, raw version/offset, budget expansion, DB base, model, endpoint, key, or credential options. Add it to the explicit destructive-action classification from Task 5. If the host command surface has no abort signal, pass a registration-owned shutdown signal that is aborted before pool shutdown; never synthesize an already-aborted or globally shared user-turn signal.

- [ ] **Step 4: Run migration tests green**

Run the Step 2 command. Expected: PASS; dry-run has zero memory/schema/provider writes and exactly one private audit-report write; apply order is embed/copy/readback/mark/report.

- [ ] **Step 5: Commit and complete both independent reviews**

```bash
git add lib/shared-memory-migration.js lib/shared-memory.js lib/multi-namespace-pool.js tests/b13-legacy-share-migration.test.js tests/multi-namespace-pool.test.js index.js tests/plur1bus-internal-auth.test.js README.md
git commit -m "feat: add explicit legacy shared-memory migration"
```

Spec review must verify destructively authorized initialized-runtime execution, authoritative-writer selection, pinned-version/offset continuation, every hard row/byte/time/provider bound, abort handling, per-agent embedding context, source marker schema, no deletion/reinterpretation/requester inference, and exact repair-report privacy/bounds. Quality review must inspect parser rejection of alternate routing/credential/budget args, authorization-before-work, token binding/checksum, capability containment, symlink/race resistance, `0600`/fsync/atomicity, bounded lease lifetime, observed timed-out promises, partial failure/retry, schema races, and source marking order. Fix/re-review all Critical/Important findings before Task 11.

### Task 11: Documentation, finding receipt, and final B13 verification

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Create: `docs/audits/2026-07-21-b13-acl-wiki-share-fix.md`
- Modify: `.superpowers/sdd/progress.md`
- Modify: `tests/config-docs-contract.test.js`

- [ ] **Step 1: Write the documentation contract test first**

Add assertions to the most relevant existing documentation contract test that require these exact concepts:

```js
for (const phrase of [
  "/share <id>",
  "/share <id> --user",
  ".plur1bus-shared/workspaces/w-<62hex>",
  ".plur1bus-shared/users/u-<62hex>",
  "copy, never move",
  "OpenClaw default LLM",
  "per-agent credentials",
  "workspace_shared legacy rows are not reinterpreted",
]) {
  assert.match(combinedDocs, new RegExp(escapeRegExp(phrase), "i"));
}
```

- [ ] **Step 2: Run the doc contract red**

```bash
node --test --test-concurrency=1 tests/config-docs-contract.test.js
```

Expected: FAIL until the new sharing/storage/migration contract is documented.

- [ ] **Step 3: Update docs and the audit receipt**

Document command grammar including opaque `--cursor`, strict scopes, <=64-character physical routes, conflict-rejecting workspace canonicalization (no hidden precedence), channel+account+user principal, confirmation policy, optional shared recall sources, canonical-origin dedup, and the destructively authorized initialized-runtime legacy dry-run/apply workflow. State its exact per-run 250-row/4-MiB/100-provider/60-second limits, pinned-version continuation/restart behavior, and abort semantics. State explicitly that no standalone DB/config/credential bootstrap exists and that Multi-Namespace, Neo/Obsidian aliases, Semantic Lens, CRR, default OpenClaw LLM, and per-agent auth/API keys do not change.

Also document the current OpenClaw hook boundary precisely: automatic user-shared recall exists only when `autoRecall` is enabled and requires an account-bearing session key, an exact host-run ticket, or a conservative default-only account topology. Native and slash-shaped commands intentionally mint no route ticket because handled commands do not reach the prompt hook. Ambiguous named/multi-account main/group/channel turns omit only that optional source; `/memory`, `/share --user`, and tools continue to use the host-supplied account directly. Do not advertise the session last route as a turn-bound account proof.

The receipt must contain a row for each finding:

```text
SEC-01  strict bindings + ownership-preserving graph projection/hydration
SEC-02  initial/refined/graph ACL before reranker/provider
SEC-03  Wiki duplicate preview after active wiki ACL
SEC-04  Wiki UUID delete after active wiki ACL, denied == missing
SEC-05  Wiki query selection/display/mutation after active wiki ACL
SEC-08  same fallback search lifecycle predicate and logged catch
SEC-12  all named sensitive chat reads gated before work
SEC-16  safeUpdate exact ownership tuple preservation
FA-04   dedicated pools, share commands, confirmation, shared recall, migration
FE-ADD-04 common Wiki ACL/lifecycle plus destructive audit
```

For every row include changed files, red command/output, green command/output, original proof result, positive path, bypass review, and remaining uncertainty. Record independent spec and quality reviewer identities/outcomes for Tasks 1-10 and every Critical/Important fix/re-review.

- [ ] **Step 4: Run focused and adjacent B13 gates serially**

```bash
node --test --test-concurrency=1 \
  tests/user-scope-acl.test.js \
  tests/b13-memory-request-context.test.js \
  tests/recall-golden-set-pipeline.test.js \
  tests/recall-pipeline-hydration.test.js \
  tests/recall-pipeline-graph-hydration-relevance.test.js \
  tests/b13-recall-provider-acl.test.js \
  tests/smoke-wiki-command.test.js \
  tests/safe-update-dataloss.test.js \
  tests/forget-correct-confirm.test.js \
  tests/b13-sensitive-read-auth.test.js \
  tests/plur1bus-internal-auth.test.js \
  tests/b13-shared-memory-pool.test.js \
  tests/shared-memory-store-guard.test.js \
  tests/b13-share-store.test.js \
  tests/command-reachability.test.js \
  tests/b13-share-runtime.test.js \
  tests/b13-shared-recall.test.js \
  tests/multi-namespace-recall-runtime.test.js \
  tests/b13-legacy-share-migration.test.js \
  tests/multi-namespace-pool.test.js \
  tests/openclaw-default-llm-callers.test.js \
  tests/openclaw-default-llm-contract.test.js \
  tests/openclaw-default-llm-runtime.test.js \
  tests/config-docs-contract.test.js \
  tests/llm-result-cache-lifecycle.test.js
npm run lint
git diff --check
node -e 'JSON.parse(require("node:fs").readFileSync("openclaw.plugin.json", "utf8")); console.log("manifest-json-ok")'
```

Expected: all Node tests PASS with zero failures; lint exits 0; diff check is empty; manifest prints `manifest-json-ok`.

- [ ] **Step 5: Run original proofs and change-aware bypass review**

Run the executable SEC-01/SEC-02 proofs with the required repository-root argument, then inspect the exact SEC-03/04/05/08 rubrics and run their named handler regressions. Confirm foreign text reaches neither reranker nor Wiki response/mutation:

```bash
node docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-acl-missing-ownership-fail-open/validation_artifacts/proof.mjs "$PWD"
node docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-pattern-pre-acl-cross-scope/validation_artifacts/proof.mjs "$PWD"
sed -n '1,200p' docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-wiki-add-duplicate-cross-scope-disclosure/validation_artifacts/RUBRIC.md
sed -n '1,200p' docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-wiki-delete-id-missing-record-acl/validation_artifacts/RUBRIC.md
sed -n '1,200p' docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-wiki-delete-query-missing-record-acl/validation_artifacts/RUBRIC.md
sed -n '1,200p' docs/superpowers/audits/2026-07-18-codex-security-scan/artifacts/05_findings/cand-wiki-search-inactive-fallback-disclosure/validation_artifacts/RUBRIC.md
node --test --test-concurrency=1 tests/smoke-wiki-command.test.js
```

Manually inspect every `checkAccess(` caller, every `runRecallPipeline(` caller, every `runWikiCommand(` caller, and every data-bearing `registerCommand` handler:

```bash
rg -n "checkAccess\(|runRecallPipeline\(|runWikiCommand\(|registerCommand\(" index.js lib tests
rg -n "workspace_shared|agent_private|global_user|scope:\s*[\"'](workspace|user|agent-private)" index.js lib scripts
rg -n "apiKey|apiKeyEnv|baseUrl|modelOverride|Authorization|withLlmCallContext" index.js lib/shared-memory*.js lib/memory-request-context.js
```

Expected: no unreviewed B13 bypass; no new model/key/endpoint/header branch; internal aliases appear only in their existing adapters and legacy migration matching.

- [ ] **Step 6: Commit docs, then obtain final independent B13 spec and quality PASS**

```bash
git add README.md docs/configuration.md docs/audits/2026-07-21-b13-acl-wiki-share-fix.md .superpowers/sdd/progress.md tests/config-docs-contract.test.js
git commit -m "docs: record b13 acl and sharing remediation"
```

Dispatch a fresh final B13 spec reviewer over the complete pre-B13 base through the exact docs commit HEAD. Fix every Critical/Important finding with a failing test and re-review. After spec PASS, dispatch a different final quality/security reviewer over that same exact HEAD; fix every Critical/Important finding and re-review. Capture reviewer identities, base/head SHAs, commands, and outcomes in the receipt.

- [ ] **Step 7: Commit review evidence, rerun affected gates, and re-review the evidence HEAD**

After adding final review evidence to the receipt/progress, make an explicit evidence commit:

```bash
git add docs/audits/2026-07-21-b13-acl-wiki-share-fix.md .superpowers/sdd/progress.md
git commit -m "docs: record final b13 review evidence"
node --test --test-concurrency=1 tests/config-docs-contract.test.js tests/b13-memory-request-context.test.js tests/b13-shared-memory-pool.test.js tests/b13-legacy-share-migration.test.js
npm run lint
git diff --check
```

Expected: focused tests/lint/diff pass. Because this commit changes the reviewed artifact, send both final reviewers the new exact HEAD and require a range/receipt-only PASS confirming evidence consistency and no unreviewed product changes. If either review causes another edit, commit it, rerun this step, and review the new HEAD again.

- [ ] **Step 8: Run the exact repository-wide serial completion gate**

```bash
node --test --test-concurrency=1 tests/*.test.js test/*.test.js
npm audit
npm run lint
git diff --check
git status --short --branch
```

Expected: full serial suite exits 0 with zero failures; `npm audit` has no unresolved high/critical vulnerability; lint and diff check exit 0; status shows only the intended feature branch state. Do not push, merge, or modify `main`.

## Requirement-to-task matrix

| Requirement | Tasks |
|---|---|
| SEC-01 | 1, 2 |
| SEC-02 | 2, 9 |
| SEC-03 | 3 |
| SEC-04 | 3 |
| SEC-05 | 3 |
| SEC-08 opportunistic same-path fix | 3 |
| SEC-12 | 5 |
| SEC-16 | 4 |
| FA-04 | 6, 7, 8, 9, 10 |
| FE-ADD-04 | 3 |
| Workspace/user physical isolation | 1, 6 |
| Sensitive bound confirmation | 7, 8 |
| Shared recall and `/memory` parity | 9 |
| Legacy no-reinterpretation/repair report | 10 |
| OpenClaw default LLM and per-agent credentials unchanged | 7, 9, 11 |

## Explicitly resolved ambiguity

The approved design requires compatibility migration but does not name its activation surface. This plan resolves that safely as the explicit, destructively authorized `/plur1bus migrate-legacy-shared` runtime action. It is dry-run by default, writes only with `--apply`, uses already initialized per-agent resources, and is never an automatic startup migration. No standalone CLI or alternate credential/bootstrap path exists.

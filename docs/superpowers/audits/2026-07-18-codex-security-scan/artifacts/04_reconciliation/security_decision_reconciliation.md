# Security decision reconciliation

Snapshot: 6dff096efe936f7ec3d0e11a8ba83bf08671ad4e

The reconciliation consumes every raw candidate from review-000 through review-048 plus the three standalone seed/candidate receipts. It accepts the equivalent ledger key spellings used by independently generated receipts: candidateId/candidate_id and policyDecision/policy_decision.

## Closure result

- Discovery candidates: 72
- Finding directories: 72
- Complete discovery, validation, and attack-path receipts: 72/72
- Reportable: 16
- Deferred: 48
- Suppressed / ignore: 8
- JSONL / ID / phase / directory reconciliation errors: 0

## Validation closure table

| Candidate | Title | Decision | Severity | Receipt |
| --- | --- | --- | --- | --- |
| cand-acl-missing-ownership-fail-open | Agent and workspace ACL scopes authorize rows whose ownership binding is absent | reportable | P2 / Medium | [receipt](../05_findings/cand-acl-missing-ownership-fail-open/validation_report.md) |
| cand-admzip-install-dos | Optional local-inference install resolves vulnerable adm-zip parser | reportable | High dependency advisory | [receipt](../05_findings/cand-admzip-install-dos/validation_report.md) |
| cand-afterthought-cross-session-leak | Afterthought cron selects workspace-wide outcomes without agent, session, or destination scoping | deferred | — | [receipt](../05_findings/cand-afterthought-cross-session-leak/validation_report.md) |
| cand-agent-db-path-traversal | Primary per-agent database pool joins unvalidated runtime agent IDs into filesystem paths | deferred | — | [receipt](../05_findings/cand-agent-db-path-traversal/validation_report.md) |
| cand-chat-read-auth-bypass | Sensitive chat read commands bypass configured user and chat allowlists | reportable | P2 / Medium | [receipt](../05_findings/cand-chat-read-auth-bypass/validation_report.md) |
| cand-compaction-cross-scope | Memory compaction mixes user and workspace scopes inside a per-agent table | deferred | — | [receipt](../05_findings/cand-compaction-cross-scope/validation_report.md) |
| cand-consolidation-agent-lock-path | Daily-consolidation lock path interpolates an unvalidated agent identifier | deferred | — | [receipt](../05_findings/cand-consolidation-agent-lock-path/validation_report.md) |
| cand-consolidation-dryrun-purge | Daily-consolidation dry-run still hard-deletes expired memories | deferred | — | [receipt](../05_findings/cand-consolidation-dryrun-purge/validation_report.md) |
| cand-critical-push-agent-path | Critical-push state path uses an unvalidated agent identifier | deferred | — | [receipt](../05_findings/cand-critical-push-agent-path/validation_report.md) |
| cand-critical-push-sensitive-log | Critical-push classification serializes secrets and health data into info logs | deferred | — | [receipt](../05_findings/cand-critical-push-sensitive-log/validation_report.md) |
| cand-cron-context-auth-bypass | Broad cron-context strings bypass authorization for privileged internal commands | deferred | — | [receipt](../05_findings/cand-cron-context-auth-bypass/validation_report.md) |
| cand-db-autoaccept-cross-scope | Stale critical auto-accept confirms foreign user/workspace records | deferred | — | [receipt](../05_findings/cand-db-autoaccept-cross-scope/validation_report.md) |
| cand-db-classifier-cross-scope | Critical classifier processes and exports foreign-scope cards without object authorization | deferred | — | [receipt](../05_findings/cand-db-classifier-cross-scope/validation_report.md) |
| cand-deploy-repair-symlink-write | Deploy-integrity repair follows a listed deployment symlink outside its root | ignore / suppressed | — | [receipt](../05_findings/cand-deploy-repair-symlink-write/validation_report.md) |
| cand-deploy-verifier-executes-unverified-module | Deploy integrity verifier imports a module after detecting that its checksum is untrusted | ignore / suppressed | — | [receipt](../05_findings/cand-deploy-verifier-executes-unverified-module/validation_report.md) |
| cand-destructive-audit-log-symlink-write | Destructive-operation logging follows a workspace-controlled directory symlink | reportable | P3 / Low | [receipt](../05_findings/cand-destructive-audit-log-symlink-write/validation_report.md) |
| cand-dream-echo-cross-session-leak | Workspace-wide dream echoes can surface one session's topic in another session | deferred | — | [receipt](../05_findings/cand-dream-echo-cross-session-leak/validation_report.md) |
| cand-embedding-cache-default-scope-cross-agent | Agent-scoped embedding cache silently collapses missing identities into a shared default scope | deferred | — | [receipt](../05_findings/cand-embedding-cache-default-scope-cross-agent/validation_report.md) |
| cand-emotion-engine-cross-agent-context | Global emotion engine carries previous-message state across agent, workspace, and session boundaries | deferred | — | [receipt](../05_findings/cand-emotion-engine-cross-agent-context/validation_report.md) |
| cand-emotional-state-cross-workspace | Emotional state is isolated by agent but not by workspace | deferred | — | [receipt](../05_findings/cand-emotional-state-cross-workspace/validation_report.md) |
| cand-episode-generated-metadata-injection | Episode LLM output is persisted as unsanitized Neo and YAML/Markdown metadata | deferred | — | [receipt](../05_findings/cand-episode-generated-metadata-injection/validation_report.md) |
| cand-feature-cron-channel-target-confusion | Feature-cron fallback ignores bound conversation identity and uses Telegram DM allowFrom as the delivery target | deferred | — | [receipt](../05_findings/cand-feature-cron-channel-target-confusion/validation_report.md) |
| cand-feature-toggle-config-mode-downgrade | Feature toggles replace a private OpenClaw config with a default-permission file | deferred | — | [receipt](../05_findings/cand-feature-toggle-config-mode-downgrade/validation_report.md) |
| cand-graph-constellation-symlink-write | Graph constellation report follows vault-directory symlinks outside the workspace | reportable | P3 / Low | [receipt](../05_findings/cand-graph-constellation-symlink-write/validation_report.md) |
| cand-installer-agent-id-generated-gc-code-injection | Unescaped agent IDs are persisted into executable generated GC JavaScript | ignore / suppressed | — | [receipt](../05_findings/cand-installer-agent-id-generated-gc-code-injection/validation_report.md) |
| cand-installer-agent-id-path-traversal | Installer treats target-config agent IDs as uncontained filesystem components | ignore / suppressed | — | [receipt](../05_findings/cand-installer-agent-id-path-traversal/validation_report.md) |
| cand-installer-agent-id-shell-injection | Target-config agent IDs break the installer's second shell parse | ignore / suppressed | — | [receipt](../05_findings/cand-installer-agent-id-shell-injection/validation_report.md) |
| cand-installer-workspace-shell-injection | Target-config workspace paths are re-parsed as shell code by installer writes | ignore / suppressed | — | [receipt](../05_findings/cand-installer-workspace-shell-injection/validation_report.md) |
| cand-lancedb-maintenance-versions-symlink-prune | LanceDB maintenance follows a table-controlled _versions symlink while backing up and deleting manifests | ignore / suppressed | — | [receipt](../05_findings/cand-lancedb-maintenance-versions-symlink-prune/validation_report.md) |
| cand-light-dream-cross-scope-strengthening | Light dreaming strengthens semantically matched foreign-scope memories | reportable | P3 / Low | [receipt](../05_findings/cand-light-dream-cross-scope-strengthening/validation_report.md) |
| cand-model-forget-auth-bypass | Model-facing memory_forget is enabled by default and deletes without user identity or record ACL | deferred | — | [receipt](../05_findings/cand-model-forget-auth-bypass/validation_report.md) |
| cand-model-tool-forget-authz | Model-facing memory_forget mutates durable memory without user-bound authorization | deferred | — | [receipt](../05_findings/cand-model-tool-forget-authz/validation_report.md) |
| cand-model-tool-knowledge-authz | Model-facing knowledge_update rewrites durable curated knowledge without user-bound authorization | deferred | — | [receipt](../05_findings/cand-model-tool-knowledge-authz/validation_report.md) |
| cand-mood-state-prompt-injection | Emotion value objects accept unbounded labels that can reach persistent mood prompt formatting | deferred | — | [receipt](../05_findings/cand-mood-state-prompt-injection/validation_report.md) |
| cand-neo-agent-private-cross-agent-recall | Neo recall exposes agent-private records to other agents sharing a workspace | reportable | P2 / Medium | [receipt](../05_findings/cand-neo-agent-private-cross-agent-recall/validation_report.md) |
| cand-neo-workspace-key-collision | Non-injective Neo workspace-key sanitization merges distinct workspace stores | deferred | — | [receipt](../05_findings/cand-neo-workspace-key-collision/validation_report.md) |
| cand-obsidian-dryrun-auth-bypass | A dry-run token suppresses Obsidian command authorization while handlers still perform real mutations | reportable | P2 / Medium | [receipt](../05_findings/cand-obsidian-dryrun-auth-bypass/validation_report.md) |
| cand-obsidian-maintenance-auth-bypass | Deep-maintenance chat command deletes generated task notes without authorization, confirmation, or audit | deferred | — | [receipt](../05_findings/cand-obsidian-maintenance-auth-bypass/validation_report.md) |
| cand-obsidian-readonly-controls-bypass | Obsidian background rebuilds mutate vault state despite read-only, dry-run, or unconfirmed configuration | deferred | — | [receipt](../05_findings/cand-obsidian-readonly-controls-bypass/validation_report.md) |
| cand-obsidian-review-bundle-cross-agent | Shared-vault ReviewBundles are selected and applied without agent/workspace ownership checks | deferred | — | [receipt](../05_findings/cand-obsidian-review-bundle-cross-agent/validation_report.md) |
| cand-obsidian-review-status-auth-bypass | Review approval, rejection, and snooze decisions bypass the configured user/chat ACL | deferred | — | [receipt](../05_findings/cand-obsidian-review-status-auth-bypass/validation_report.md) |
| cand-obsidian-rotate-auth-bypass | Obsidian rotate chat command can permanently delete review-vault files without authorization, confirmation, or destructive audit | deferred | — | [receipt](../05_findings/cand-obsidian-rotate-auth-bypass/validation_report.md) |
| cand-obsidian-symlink-escape | Lexical Obsidian path checks allow directory-symlink read and write escape outside the vault | deferred | — | [receipt](../05_findings/cand-obsidian-symlink-escape/validation_report.md) |
| cand-obsidian-vault-approval-tamper | An untrusted Obsidian vault can self-assert vault confirmation and forge approved review payloads | deferred | — | [receipt](../05_findings/cand-obsidian-vault-approval-tamper/validation_report.md) |
| cand-pattern-continuity-prompt-injection | REM-generated pattern descriptions are injected into prompts outside the recall-safety boundary | deferred | — | [receipt](../05_findings/cand-pattern-continuity-prompt-injection/validation_report.md) |
| cand-pattern-pre-acl-cross-scope | Recall sends cross-scope candidate summaries to an external reranker before authorization | reportable | P2 / Medium | [receipt](../05_findings/cand-pattern-pre-acl-cross-scope/validation_report.md) |
| cand-persona-seed-persistent-prompt-injection | Workspace identity content can become a persistent imperative persona directive | deferred | — | [receipt](../05_findings/cand-persona-seed-persistent-prompt-injection/validation_report.md) |
| cand-provider-wizard-literal-key-terminal-exposure | Provider wizard echoes literal API keys in the interactive terminal and emitted JSON | ignore / suppressed | — | [receipt](../05_findings/cand-provider-wizard-literal-key-terminal-exposure/validation_report.md) |
| cand-recall-timeout-cache-cross-workspace | Timeout fallback can replay another workspace's cached recall context | deferred | — | [receipt](../05_findings/cand-recall-timeout-cache-cross-workspace/validation_report.md) |
| cand-rem-dream-cross-workspace-leak | REM dreaming relabels and persists memories from other workspaces and owners | reportable | P2 / Medium | [receipt](../05_findings/cand-rem-dream-cross-workspace-leak/validation_report.md) |
| cand-rem-dream-sensitive-log | REM command info-logs the full generated dream narrative | deferred | — | [receipt](../05_findings/cand-rem-dream-sensitive-log/validation_report.md) |
| cand-reminder-agent-lock-path | Reminder lock path interpolates an unvalidated agent identifier | deferred | — | [receipt](../05_findings/cand-reminder-agent-lock-path/validation_report.md) |
| cand-reminder-cancel-cross-scope | Authorized reminder cancellation ignores workspace and record ownership | deferred | — | [receipt](../05_findings/cand-reminder-cancel-cross-scope/validation_report.md) |
| cand-reminder-dryrun-delivery | Reminder dry-run performs real webhook or host-callback delivery | deferred | — | [receipt](../05_findings/cand-reminder-dryrun-delivery/validation_report.md) |
| cand-reminder-sensitive-log | Reminder-dispatch logs full private reminder text | deferred | — | [receipt](../05_findings/cand-reminder-sensitive-log/validation_report.md) |
| cand-reminder-webhook-ssrf | Reminder webhook accepts an unrestricted destination | deferred | — | [receipt](../05_findings/cand-reminder-webhook-ssrf/validation_report.md) |
| cand-resolveinside-nonexistent-ancestor-symlink | resolveInside misses an existing ancestor symlink when the immediate parent does not exist | deferred | — | [receipt](../05_findings/cand-resolveinside-nonexistent-ancestor-symlink/validation_report.md) |
| cand-retroactive-interference-cross-scope | Retroactive interference weakens semantically similar memories across workspace boundaries | deferred | — | [receipt](../05_findings/cand-retroactive-interference-cross-scope/validation_report.md) |
| cand-safe-profile-unexpected-privileged-activation | Safe setup profile is merged with write-enabled Full Experience defaults | deferred | — | [receipt](../05_findings/cand-safe-profile-unexpected-privileged-activation/validation_report.md) |
| cand-safe-update-workspace-binding-loss | Safe reconsolidation drops workspace ownership from corrected memories | reportable | P2 / Medium | [receipt](../05_findings/cand-safe-update-workspace-binding-loss/validation_report.md) |
| cand-semantic-discovery-mirror-cross-workspace | Semantic discovery mirrors all active agent memories into the invoking workspace vault | deferred | — | [receipt](../05_findings/cand-semantic-discovery-mirror-cross-workspace/validation_report.md) |
| cand-semantic-lens-acl-bypass | Semantic Lens hydrates and injects memory IDs without applying recall ACL | deferred | — | [receipt](../05_findings/cand-semantic-lens-acl-bypass/validation_report.md) |
| cand-skill-approval-blind-executable | Skill approval can activate LLM-generated instructions that the default review omits | deferred | — | [receipt](../05_findings/cand-skill-approval-blind-executable/validation_report.md) |
| cand-skill-miner-agent-lock-path | Skill-miner lock path interpolates an unvalidated agent identifier | deferred | — | [receipt](../05_findings/cand-skill-miner-agent-lock-path/validation_report.md) |
| cand-skill-miner-dryrun-write | Skill-miner dry-run still persists LLM-generated proposals | deferred | — | [receipt](../05_findings/cand-skill-miner-dryrun-write/validation_report.md) |
| cand-speaker-media-id-cross-agent-binding | Spoofable media-output IDs select diarization results without agent or session binding | deferred | — | [receipt](../05_findings/cand-speaker-media-id-cross-agent-binding/validation_report.md) |
| cand-startup-cohere-reranker-config-bypass | Startup patch uploads native-memory queries and snippets despite a local or disabled reranker selection | deferred | — | [receipt](../05_findings/cand-startup-cohere-reranker-config-bypass/validation_report.md) |
| cand-vault-task-cleanup-symlink-delete | Gateway-start vault cleanup follows a task-directory symlink and deletes outside the workspace | reportable | P3 / Low | [receipt](../05_findings/cand-vault-task-cleanup-symlink-delete/validation_report.md) |
| cand-wiki-add-duplicate-cross-scope-disclosure | Wiki add duplicate check returns cross-scope memory summaries without ACL or wiki-kind filtering | reportable | P2 / Medium | [receipt](../05_findings/cand-wiki-add-duplicate-cross-scope-disclosure/validation_report.md) |
| cand-wiki-delete-id-missing-record-acl | Wiki deletion by UUID archives and deletes a cross-workspace record without object authorization | reportable | P2 / Medium | [receipt](../05_findings/cand-wiki-delete-id-missing-record-acl/validation_report.md) |
| cand-wiki-delete-query-missing-record-acl | Wiki deletion by semantic query searches and mutates foreign workspace records without object authorization | reportable | P2 / Medium | [receipt](../05_findings/cand-wiki-delete-query-missing-record-acl/validation_report.md) |
| cand-wiki-search-inactive-fallback-disclosure | Wiki vector-search fallback omits lifecycle filtering and resurfaces superseded or archived records | reportable | P3 / Low | [receipt](../05_findings/cand-wiki-search-inactive-fallback-disclosure/validation_report.md) |

Each detailed validation report contains preserved source/control/sink evidence and its proof gap or reproducer. This table is a closure index, not a replacement for per-candidate evidence.

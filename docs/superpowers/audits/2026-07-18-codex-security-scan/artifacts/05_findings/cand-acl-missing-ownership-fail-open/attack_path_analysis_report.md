# Attack-path analysis — Graph hydration loses ACL bindings

Candidate: `cand-acl-missing-ownership-fail-open`  
Affected controls: `lib/memory-graph.js:381`, `lib/recall-pipeline.js:296-333`, `lib/acl-middleware.js:59-79`.

## Attack path

1. A shared agent stores protected workspace-B records in its per-agent LanceDB table.
2. A workspace-A capture is graph-built; the unscoped vector/recent-memory search selects the B UUID and appends an ID-only edge to A's graph.
3. A later A recall traverses that edge and calls graph-only hydration.
4. Hydration copies non-persisted `row.agentId`/`row.workspaceId` rather than `storedBy`/`workspaceKey`.
5. The legacy ACL branch treats the now-unbound workspace record as accessible and renders it to A.

## Facts and counterevidence

- In scope: memory graph and recall are core runtime features described in the repository guidance.
- Vector: chat-triggered capture/recall; external ingress is deployment-dependent, so exposure is unknown rather than assumed public.
- Cross-boundary behavior: dynamic proof establishes the edge, metadata loss, and cross-workspace allow decision.
- Preconditions: one agent handles two protected workspaces and graph construction/recall are enabled.
- Strongest counterevidence: graph JSONL is workspace-partitioned. It is not dispositive because the producer searches the cross-workspace table before the edge is partitioned.
- Impact surface: sensitive memory data and model prompt context.

## Calibration and decision

Impact is high for protected-memory disclosure; likelihood is medium/unknown because of the same-agent multi-workspace prerequisite. The mechanical policy result is **medium (P2)**, final decision **reportable**. All suggested remediation is additive to associative recall.

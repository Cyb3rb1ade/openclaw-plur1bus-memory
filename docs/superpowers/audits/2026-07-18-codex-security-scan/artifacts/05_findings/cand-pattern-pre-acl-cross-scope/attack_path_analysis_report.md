# Attack-path analysis — External reranking precedes ACL

Candidate: `cand-pattern-pre-acl-cross-scope`  
Affected controls: `lib/recall-pipeline.js:578-619`, `lib/recall-pipeline.js:964-989`, `lib/recall-pipeline.js:1035-1066`, `lib/providers/reranker-cohere.js:15-38`.

## Attack path

1. A requester in workspace A queries a shared-agent memory database containing a workspace-B row.
2. Vector search includes the B row and builds its summary document.
3. The enabled external reranker receives the document over its provider request.
4. Only afterwards does final ACL drop the B result from the chat response.

## Facts and counterevidence

The component is a core recall path. The external provider is opt-in, and sharing one agent DB across protected scopes is required. Those prerequisites reduce likelihood but do not suppress the cross-boundary provider disclosure once enabled. The proof confirms the final response control is too late, not absent.

## Calibration and decision

Impact: high confidentiality disclosure to a third-party processor. Likelihood: unknown/medium due to configuration. Policy matrix result: **medium (P2)**. Final decision: **reportable**.

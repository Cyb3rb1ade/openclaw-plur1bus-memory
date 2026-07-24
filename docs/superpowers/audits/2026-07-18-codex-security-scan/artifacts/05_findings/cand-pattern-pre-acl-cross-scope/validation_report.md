# Validation — External reranking precedes ACL

Candidate: `cand-pattern-pre-acl-cross-scope`  
Instance: `pre-acl-external-rerank:lib/recall-pipeline.js:964`

## Rubric

- [x] Vector mapping preserves a protected row's scope/bindings.
- [x] Reranking receives candidate summaries before the final ACL gate.
- [x] Final ACL subsequently removes the foreign row, proving the order is the issue.
- [x] The configured Cohere provider has a real HTTPS outbound sink.
- [ ] A deployment must enable an external reranker and share an agent DB across scopes.

## Evidence and method

`validation_artifacts/proof.mjs` invokes the original `runRecallPipeline` with one workspace-B and one workspace-A record plus a recording reranker. The recording reranker received `cross-scope confidential summary`; the final result retained only the A UUID. This proves a disclosure to the enrichment interface before the existing late ACL control.

Run:

```bash
node validation_artifacts/proof.mjs /root/openclaw-plur1bus-memory
```

## Assessment

The exact provider is optional and the caller topology remains a condition, but neither defeats the proven ordering flaw when configured. Confidence: 0.85. Disposition: **reportable**. Preserve reranking by filtering every candidate against the existing ACL before document construction/provider submission, rather than disabling the provider.

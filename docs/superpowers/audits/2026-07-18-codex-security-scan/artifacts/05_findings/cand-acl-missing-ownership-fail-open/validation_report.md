# Validation — Graph hydration loses ACL bindings

Candidate: `cand-acl-missing-ownership-fail-open`  
Instance: `graph-hydration-ownership-drop:lib/recall-pipeline.js:296`

## Rubric

- [x] A graph builder can create an edge to a foreign row from the shared agent table.
- [x] Hydration reads the foreign row but omits its persisted `storedBy` and `workspaceKey` bindings.
- [x] The final ACL's legacy branch accepts the stripped workspace record for another workspace.
- [x] The production capture hook appends ID-only graph edges to the current workspace graph.
- [ ] The deployed topology must have one agent serving more than one protected workspace.

## Evidence and method

`validation_artifacts/proof.mjs` exercises the original exported graph builder, hydration function, and ACL implementation with a fake LanceDB interface. It created a semantic edge from a workspace-A capture to a workspace-B UUID, hydrated the B row, observed empty `agentId`/`workspaceId`, and observed `checkAccess({agentId: "shared-agent", workspaceId: "workspace-a"}, entry)` return allowed. The live caller obtains unscoped recent rows and appends the resulting edges at `index.js:4767-4810`.

The proof is run with:

```bash
node validation_artifacts/proof.mjs /root/openclaw-plur1bus-memory
```

No product files are changed.

## Assessment

The source/control/sink tuple survives validation. Workspace-partitioned graph files are useful counterevidence, but do not prevent the unscoped builder from inserting a foreign UUID into the current workspace graph. Cross-workspace exposure requires a multi-workspace same-agent deployment; that is an explicit precondition, not a countercontrol. Confidence: 0.80. Disposition: **reportable**.

Minimal preserving remediation: bind graph edge creation/traversal to the same ACL context and carry `storedBy`, `workspaceKey`, and `ownerUserId` through hydration before every enrichment/rendering stage.

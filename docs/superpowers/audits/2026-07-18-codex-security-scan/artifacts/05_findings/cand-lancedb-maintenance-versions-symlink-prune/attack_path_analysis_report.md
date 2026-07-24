# Attack-path analysis: LanceDB maintainer symlink prune

## Structured facts

- **Entry / root control:** Attacker writes a symlink as `agent/table/_versions` in the LanceDB data tree.
- **Trust boundary:** Service-owned memory storage → destructive maintenance process.
- **Propagation:** The maintainer iterates real agent/table directories, builds the raw `_versions` path, then uses normal filesystem operations that follow it.
- **Sink:** `unlinkSync(join(versionsDir, m.name))` after backup during explicit `--apply`.
- **Execution principal:** Account running `maintain-lancedb.mjs`.

## Trace

1. A storage writer replaces/creates `_versions` as a symlink.
2. Operator runs `maintain-lancedb --apply`.
3. `existsSync`, `readdirSync`, and `statSync` inspect the target rather than reject the link.
4. Manifest names are backed up and then unlinked through that path.
5. The bounded CLI proof removes one harmless outside-target manifest and retains its backup within redirected `HOME`.

## Dependency and counterevidence analysis

An explicit `--apply` confirmation is present and exercised. The missing boundary is an attacker with weaker authority than the maintenance service who can manipulate internal LanceDB directory structure. The architecture describes LanceDB as the authoritative per-agent store; it does not expose this filesystem tree as user-controlled content.

## Severity calibration

| Dimension | Assessment |
|---|---|
| Attacker control | Internal service data-tree mutation required. |
| Trigger | Explicit destructive `--apply` maintenance invocation. |
| Privilege change | Not shown. |
| Impact | Deletion of target files reachable by a prepared symlink. |
| Evidence gap | Storage ownership and writable mount/restore topology. |

## Decision

**Policy decision: ignore; disposition: suppressed.** Retain the pruner, including backups and `--apply`; harden its `_versions` path handling with `lstat` and canonical containment checks.

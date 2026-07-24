# Attack-path analysis — Destructive-operation logging follows a workspace-controlled directory symlink

Candidate: `cand-destructive-audit-log-symlink-write`

## Path

1. **Source / trust boundary:** A repository/workspace contributor can pre-create .adaptive-learning as a symlink to a directory outside workspaceDir; destructive event fields can also contain user/model-derived query text, although JSON encoding prevents raw line injection.
2. **Nearest or broken control:** appendDestructiveOpLog uses join/existsSync/mkdirSync without lstat, realpath containment, resolveInside, or no-follow file creation.
3. **Sink:** appendFileSync follows the directory symlink and creates or appends destructive-ops.jsonl using the OpenClaw service account during chat/model forget, correction, or automatic merge deletion.
4. **Security outcome if exploitable:** A malicious workspace can make the service create or corrupt a fixed-name file outside the workspace and redirect audit records away from their expected location, weakening audit integrity and crossing filesystem boundaries.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.
+
## Targeted reassessment

An attacker who can write the configured workspace places a directory symlink before any subsequent destructive or merge operation. appendDestructiveOpLog follows that directory and appends the fixed audit file with the service account. Existing JSON serialization and the fixed basename lower impact, but they do not restore containment or audit integrity.

**Policy decision: reportable — P3 / Low.** Require realpath/no-follow containment for the audit parent and destination; retain audit logging.


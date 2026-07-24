# Attack-path analysis — Lexical Obsidian path checks allow directory-symlink read and write escape outside the vault

Candidate: `cand-obsidian-symlink-escape`

## Path

1. **Source / trust boundary:** The Obsidian vault and its review tree are explicitly treated as untrusted, bidirectionally synchronized input; an attacker able to add a filesystem/Git symlink can point a generated collection or nested output directory at another process-readable/writable directory.
2. **Nearest or broken control:** assertSafeRelativePath rejects .. and absolute input, but resolveReviewPath only compares lexical resolved paths. It does not realpath the vault root, review root, or nearest existing parent, and atomicWriteText does not revalidate before creating its temporary file and renaming it.
3. **Sink:** record-index readdirSync/readFileSync follows symlinked collection directories; record-writer and the many generators using atomicWriteText create/replace files through symlinked parents outside the configured vault.
4. **Security outcome if exploitable:** A malicious shared/synchronized vault can cause PLUR1BUS commands or background rebuilds to disclose external Markdown through dashboards/explanations and to create or overwrite predictable external .md/.jsonl files with the OpenClaw process's privileges. Chaining attacker-chosen record IDs/output directories can target security-relevant workspace Markdown without disabling any PLUR1BUS feature.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Addendum — Attack-path and policy recalibration (2026-07-18)

- **Context:** Obsidian paths and atomic writers are real product surfaces; vault content is treated as untrusted.
- **Exposure / vector:** Local/shared-filesystem vector is plausible; no repository-backed remote or collaborator ingress for symlink creation is proved.
- **Cross-boundary behavior:** The filesystem boundary escape is verified locally, but the attacker-to-victim principal boundary is not.
- **Preconditions:** Ability to create a directory symlink inside the configured vault plus a subsequent victim read/rebuild/write action.
- **Counterevidence:** Lexical slug and traversal checks do not stop the primitive. However, the receipt explicitly leaves supported symlink delivery and the read-side effect untested.
- **Impact surface:** Potential process-privileged file read/write outside the vault.

**Severity calibration:** not finalized until a realistic lower-privileged symlink-delivery path is established.  
**Final policy decision:** **deferred**.

# Validation — Lexical Obsidian path checks allow directory-symlink read and write escape outside the vault

Candidate: `cand-obsidian-symlink-escape`  
Scope: repository snapshot `6dff096e`  
Date: 2026-07-18

## Validation rubric

- [x] Discovery source, closest control, and sink are preserved below.
- [x] The repository code path was traced against the completed receipt.
- [ ] A bounded dynamic reproduction was not completed for this candidate.
- [x] The remaining proof gap and conservative disposition are stated.

## Method

Static source-to-sink trace using the independently reviewed discovery receipt. This bounded audit did not run a target-host exploit simulation for this candidate.

## Evidence

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-023.json`
- Attacker-controlled source: The Obsidian vault and its review tree are explicitly treated as untrusted, bidirectionally synchronized input; an attacker able to add a filesystem/Git symlink can point a generated collection or nested output directory at another process-readable/writable directory.
- Closest/broken control: assertSafeRelativePath rejects .. and absolute input, but resolveReviewPath only compares lexical resolved paths. It does not realpath the vault root, review root, or nearest existing parent, and atomicWriteText does not revalidate before creating its temporary file and renaming it.
- Sink: record-index readdirSync/readFileSync follows symlinked collection directories; record-writer and the many generators using atomicWriteText create/replace files through symlinked parents outside the configured vault.
- Claimed impact: A malicious shared/synchronized vault can cause PLUR1BUS commands or background rebuilds to disclose external Markdown through dashboards/explanations and to create or overwrite predictable external .md/.jsonl files with the OpenClaw process's privileges. Chaining attacker-chosen record IDs/output directories can target security-relevant workspace Markdown without disabling any PLUR1BUS feature.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Addendum — Existing-reproduction cross-principal recalibration (2026-07-18)

This addendum supersedes the earlier rationale while retaining a deferred disposition. No new PoC was run; only `artifacts/02_discovery/file_reviews/review-023.json` and its recorded temporary-directory proof were used.

### Receipt-based rubric

- [x] The lexical-containment primitive was dynamically reproduced.
- [x] `atomicWriteText` created `outside/probe.md` through a symlinked parent.
- [ ] The read path was not dynamically exercised.
- [ ] No supported shared-vault/Git/sync workflow was shown to let a distinct lower-privileged principal place the required filesystem symlink.

### Recalibrated result

The local filesystem primitive is real, but the receipt itself identifies realistic cross-principal symlink creation as an outstanding step. Possession of local write capability sufficient to create the symlink may be self-only or already privileged; the privilege delta is not established.

**Disposition:** deferred.  
**Survives:** uncertain.  
**Confidence:** 0.60 for the primitive, lower for reportability.  
**Minimal next proof:** establish a supported untrusted-vault workflow that preserves attacker-created symlinks, then trigger a PLUR1BUS read or write as the victim process.

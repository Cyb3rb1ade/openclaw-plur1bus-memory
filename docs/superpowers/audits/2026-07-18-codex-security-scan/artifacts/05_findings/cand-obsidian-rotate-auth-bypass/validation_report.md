# Validation — Obsidian rotate chat command can permanently delete review-vault files without authorization, confirmation, or destructive audit

Candidate: `cand-obsidian-rotate-auth-bypass`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-019.json`
- Attacker-controlled source: Any chat user who can invoke /plur1bus can supply obsidian rotate --apply --delete --allow-delete plus age/size options.
- Closest/broken control: runPlur1busCommand dispatches every obsidian action to handleObsidianBridgeCommand at index.js:2948-2983 before calling checkAuth; the rotate branch treats the two flags as sufficient approval and has no user/chat-bound confirmation nonce.
- Sink: rotateOldArchives reaches unlinkSync(f.path) at lib/obsidian/archive-rotation.js:156-160 for matching top-level .json, .md, or .txt files beneath the configured review root.
- Claimed impact: A non-whitelisted user in a shared chat can permanently remove review/control-room artifacts and evidence despite a configured PLUR1BUS whitelist; the operation is not recoverable from an in-command archive and leaves no appendDestructiveOpLog receipt.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Addendum — Existing-reproduction cross-principal recalibration (2026-07-18)

This addendum supersedes the earlier rationale while retaining a deferred disposition. No new PoC was run; it reconciles `review-019.json` with the later corrective evidence in `review-018.json`.

### Receipt-based rubric

- [x] The low-level delete sink is statically traced.
- [x] The later receipt corrects the broad premise: ordinary lowercase `rotate --apply --delete` is classified destructive and reaches the authorization gate.
- [x] Mixed `--dry-run` variants bypass classification, but that reproduced root control belongs to `cand-obsidian-dryrun-auth-bypass`.
- [ ] No standalone unauthorized rotate invocation was shown deleting a file.

### Recalibrated result

The original receipt's claim that ordinary rotate lacks command authorization is contradicted by the completed later review. A rotate deletion through the Dry-run parser mismatch remains a sink instance of the reportable Dry-run candidate, not independent proof of this broader standalone candidate.

**Disposition:** deferred.  
**Survives:** uncertain.  
**Confidence:** 0.35.  
**Minimal next proof:** demonstrate an unauthorized rotate-to-delete path that is independent of the already-recorded Dry-run classifier bypass.

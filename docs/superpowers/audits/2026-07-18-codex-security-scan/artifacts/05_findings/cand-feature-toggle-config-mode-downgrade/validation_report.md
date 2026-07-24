# Validation — Feature toggles replace a private OpenClaw config with a default-permission file

Candidate: `cand-feature-toggle-config-mode-downgrade`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-035.json`
- Attacker-controlled source: An authorized /enable or /disable command reads the full operator OpenClaw JSON, which may contain literal provider API keys and other secrets.
- Closest/broken control: The update is authorized, key-whitelisted, and atomically renamed, but atomicWriteJson neither stats/preserves the original mode nor explicitly creates the temporary file as 0600 and cleans it on failure.
- Sink: writeFileSync creates path.tmp-PID-time with Node's default 0666 masked by umask, then renameSync makes that file the new openclaw.json.
- Claimed impact: A successful toggle can change a 0600 secrets-bearing config to 0644; a crash or failed rename can leave a similarly permissive full-config temp copy, exposing credentials to other local principals when directory permissions permit traversal.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

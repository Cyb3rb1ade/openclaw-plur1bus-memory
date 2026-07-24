# Validation — Optional local-inference install resolves vulnerable adm-zip parser

Candidate: `cand-admzip-install-dos`  
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

- Discovery receipt: `artifacts/02_discovery/seed_candidate_adm_zip.json`
- Attacker-controlled source: A crafted NuGet ZIP supplied from a compromised/malicious package feed, configured HTTPS proxy, or equivalent installation supply-chain position.
- Closest/broken control: onnxruntime-node@1.24.3 postinstall loads the downloaded .nupkg with adm-zip@0.5.17; vulnerable adm-zip eagerly allocates the attacker-declared uncompressed size before validating actual data/CRC.
- Sink: adm-zip@0.5.17 eager Buffer allocation from declared uncompressed size
- Claimed impact: Multi-gigabyte allocation can terminate the npm/OpenClaw installation process or exhaust host memory when the optional local inference dependency is installed.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
+
## Dependency-advisory reassessment

### Rubric

- [x] Current npm audit was run against the lockfile.
- [x] The resolved chain was verified as @huggingface/transformers 4.2.0 → onnxruntime-node 1.24.3 → adm-zip 0.5.17.
- [x] The affected version is below the advisory patched version 0.6.0.
- [x] The install-time reachability and optional-dependency boundary are documented.

### Result

Fresh npm audit reports three high-severity findings for GHSA-xcpc-8h2w-3j85 / CVE-2026-39244. The lockfile pins adm-zip 0.5.17. GitHub's reviewed advisory marks versions below 0.6.0 affected and describes allocation from an attacker-controlled ZIP size before validation. This plugin reaches the package through the optional local-transformers chain and onnxruntime-node postinstall.

**Disposition: reportable — high dependency advisory (CVSS 7.5).** The exploit requires a malicious or compromised package/feed/proxy position during optional local-inference installation, so the impact is primarily installation-time availability. Update the chain in a separate compatibility plan; do not disable local inference as a substitute.

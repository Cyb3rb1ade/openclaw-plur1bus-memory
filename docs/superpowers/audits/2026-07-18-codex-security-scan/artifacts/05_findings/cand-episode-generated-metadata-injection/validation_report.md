# Validation — Episode LLM output is persisted as unsanitized Neo and YAML/Markdown metadata

Candidate: `cand-episode-generated-metadata-injection`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-007.json`
- Attacker-controlled source: Untrusted conversation turns influence narrative LLM JSON fields.
- Closest/broken control: JSON parsing exists and filename characters are stripped, but field types, lengths, enum membership, newlines, and YAML quoting are not validated.
- Sink: Generated episode metadata is appended to Neo storage and written verbatim into an automatically generated Markdown note/frontmatter.
- Claimed impact: A crafted conversation/model response can forge note metadata or plant prompt-like persistent content that enters later review, graph, or recall workflows.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

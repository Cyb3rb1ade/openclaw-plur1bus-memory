# Validation — Workspace identity content can become a persistent imperative persona directive

Candidate: `cand-persona-seed-persistent-prompt-injection`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-026.json`
- Attacker-controlled source: On a workspace without persona-voice.md, the default-enabled startup path reads SOUL.md, IDENTITY.md, or AGENT.md and sends their raw content as identity hints to the configured LLM. These workspace files can be supplied by an imported/untrusted workspace or altered by a party with workspace-content write access.
- Closest/broken control: The seed parser checks only that at least three response lines begin with '- '. It does not constrain bullets to style attributes, remove imperative content, mark source material untrusted, or require a user confirmation before persisting the generated directive.
- Sink: writePersonaVoice persists the generated bullets; loadPersonaDirective converts them to 'Deine Grundstimme (befolge sie...)' and index.js places that directive ahead of normal recalled-memory context on future model turns.
- Claimed impact: A successful seed-time instruction injection can survive across turns and steer the agent's behavior, rather than remaining a one-turn untrusted document effect. It can also influence the emoji/reaction palette derived from the same managed block.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

# OpenClaw Default LLM — SDD Progress

Date: 2026-07-20
Branch: `fix/task4-remove-named-defaults`
Task 5 base: `cf01840ff91e43a1c4a59199823bc7e0e856e981`
Task 5 commit subject: `docs: align config with OpenClaw LLM defaults`

## Implemented series

```text
f0818ad docs: document LLM route kinds
b7ffa0d feat: use OpenClaw default for core LLM routes
03c4a62 fix: preserve LLM command context and critical no-op
10afa93 fix: warn when critical LLM runtime is unavailable
267fb71 feat: add LLM call context helper
211b18d fix: preserve existing LLM call context
5c8492b refactor: isolate feature LLM routes
cf01840 fix: remove hard-coded chat model defaults
Task 5  docs: align config with OpenClaw LLM defaults
```

## Task 5 causal evidence

- RED config/docs/profile/deploy: 63 tests, 54 pass, 9 expected failures.
- RED installer: 17 tests, 16 pass, 1 expected failure.
- GREEN Task 5 focused subtests: 72/72 pass, 0 skipped.
- GREEN installer subtests: 17/17 pass, 0 skipped.
- Exact required Task 5 command: 72/72 subtests pass.
- Shell syntax: `bash -n scripts/install-memory-system.sh` exits 0.
- `npm run lint` and `git diff --check` exit 0.

The earlier B11 R5 docs-only Emotion fallback resolution is superseded by the
implemented OpenClaw-default runtime contract. Optional chat models remain
absent from defaults/profiles, direct partial overrides fail closed, unresolved
direct credentials stay unavailable, and installer preserve does not grant
entry-level LLM trust.

## Review state

Task 5 implementation passed its focused test, lint, and diff gates. Final B11
review is not closed: Task 6 still owns independent review, remediation, the
authoritative full serial suite, and the final closure decision. Main, Remote,
and Primary remain untouched.

# Hermes 7.12.2 Critical Push candidate

Candidate: `7.12.2-hermes.1` / Python `7.12.2.post1`. Not a publication record.

## Upstream boundary

The Critical Push change is ported from upstream tag `v7.12.2`, commit
`f2ce0721453de40a7321ad5e64a4830681921498`. This is a targeted backport onto the
existing Hermes distribution candidate, not a claim that every unrelated
OpenClaw 7.12.1 change or every feature-parity gap has been ported.

- Owner-only critical review previews show sanitized health and finance content
  by default, capped at 160 characters.
- `criticalPush.hideTypes` adds types whose previews must be hidden; setting
  `["gesundheit", "geld_konto"]` restores the earlier privacy policy.
- Credentials remain hidden unconditionally. Hermes' concrete-secret suppression
  remains in force even when a card has a different type.
- The classifier `content` field is an eligible preview fallback before `title`.
- Review authorization, confirmation, reject semantics and per-owner isolation
  must not be weakened by this presentation change. Content-free list commands
  remain content-free.

## Acceptance requirements

Run preview, delivery/configuration and privacy regressions on the final source;
then full Python/Controls/dashboard/distribution and Node gates. Build native
artifacts on all six CI architectures and inspect their source/checksum records.
Complete the actual Windows ARM, Windows x64 and Ubuntu guest checks separately.
Do not substitute emulated ARM-host x64 tests for the user's Windows x64 guest.

Existing unsupported parity areas are documented in
`hermes-completion-followup-2026-09-06.md`. The previous candidate's successful
six-platform run 34073947031 does not certify these new source changes.

Only publish immutable new release assets after the updated candidate's required
gates pass; do not replace earlier releases or change `latest`, main or ClawHub.

# Codex Security Audit Snapshot

This directory preserves the complete audit bundle used by the high- and
medium-finding remediation design.

- Audited repository commit: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`
- Scan bundle: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z`
- Original runtime location:
  `/tmp/codex-security-scans/openclaw-plur1bus-memory/6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z/`
- Copied into the worktree: 2026-07-19

All 465 regular source files were copied byte-for-byte. Two validation-fixture
symlinks originally contained absolute paths into the temporary scan directory;
their link targets were rewritten as equivalent relative paths within this
snapshot so the fixtures remain resolvable after a reboot. No report or regular
artifact content was changed.

Primary entry points:

- `audit/audit_summary.md`
- `audit/security_audit.md`
- `audit/bug_audit.md`
- `audit/bug_audit_addendum.md`
- `audit/feature_audit.md`
- `audit/feature_audit_addendum.md`
- `audit/npm_audit_20260718.md`
- `artifacts/04_reconciliation/security_decision_reconciliation.md`

The files under `artifacts/05_findings/` include untrusted proof-of-concept and
validation fixtures. Do not execute them without first inspecting the relevant
finding report and using an isolated environment.

This snapshot intentionally lives below `docs/superpowers/`, which is outside
the package.json publication allowlist. It is repository evidence, not shipped
plugin content.

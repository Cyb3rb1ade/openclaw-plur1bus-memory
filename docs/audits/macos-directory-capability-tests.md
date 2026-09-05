# macOS directory-capability test boundary

Shared workspace and user memory use descriptor-backed directory routing. It
requires an FD alias that can be independently verified and traversed for
child directories. Current macOS Node runtimes expose `/dev/fd/<n>` as a
non-directory device entry, so the capability probe correctly reports
unsupported.

The test policy is deliberately split:

- On supported hosts, the integration tests execute the full shared
  workspace/user flow and verify physical isolation.
- On unsupported hosts, those supported-only assertions are skipped with an
  explicit capability reason. They are not treated as a successful workflow.
- Unsupported-host coverage must assert that explicit shared writes and
  migrations reject before creating a shared root; optional shared reads remain
  absent. Private memory tests continue to run.

Do not replace the descriptor capability with path-only routing to make macOS
tests pass. That would remove the protection against directory substitution
and symlink races that the shared-memory boundary is intended to enforce.

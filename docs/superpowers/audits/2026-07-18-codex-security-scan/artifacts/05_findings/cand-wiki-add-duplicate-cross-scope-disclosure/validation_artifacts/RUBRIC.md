# Validation rubric

- [ ] The shipped `runWikiCommand` add entrypoint accepts an authorized remote-chat command and reaches the duplicate check.
- [ ] The returned duplicate candidate is demonstrably denied by the repository's own `checkAccess` for the caller.
- [ ] The original handler nevertheless renders candidate content and suppresses storage without a wiki-kind or object-ACL check.
- [ ] A safe negative control (no foreign duplicate) stores the new workspace-bound wiki entry.
- [ ] Reportability is calibrated for the documented 0.92 threshold, same-agent co-residency, and destructive-command authorization.

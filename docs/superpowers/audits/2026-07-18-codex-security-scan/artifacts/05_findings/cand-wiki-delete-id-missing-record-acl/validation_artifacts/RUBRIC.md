# Validation rubric

- [ ] The shipped `runWikiCommand` ID-delete entrypoint accepts a syntactically valid UUID from an authorized chat user.
- [ ] The fetched wiki row is demonstrably denied by `checkAccess` for the caller's workspace/user context.
- [ ] The original handler archives and deletes the denied row without passing its already-built ACL context.
- [ ] Existing controls—UUID validation, wiki-kind guard, and archive-first behavior—are observed and scoped accurately.
- [ ] Reportability is calibrated for UUID knowledge, same-agent co-residency, recoverability, and destructive-command authorization.

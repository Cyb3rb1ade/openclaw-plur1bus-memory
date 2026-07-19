# Validation rubric

- [ ] The shipped search entrypoint reaches the JavaScript fallback when the builder lacks `where()` or the filtered query fails.
- [ ] The fallback returns a same-ACL wiki row whose status is superseded/archived rather than active/null.
- [ ] The original synthesis/response path renders that inactive row, while a working primary status filter is a safe negative control.
- [ ] Current LanceDB API, initialization/migration behavior, and attacker control over fallback activation are checked.
- [ ] Reportability distinguishes a lifecycle correctness failure from a meaningful cross-principal security boundary.

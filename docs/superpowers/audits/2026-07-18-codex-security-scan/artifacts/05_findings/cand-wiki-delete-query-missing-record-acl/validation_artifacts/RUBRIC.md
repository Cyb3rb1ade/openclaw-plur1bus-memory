# Validation rubric

- [ ] The shipped semantic-delete entrypoint reaches `searchByKind` from an authorized remote-chat command.
- [ ] A returned wiki row is demonstrably denied by `checkAccess` for the caller.
- [ ] A sole denied result is archived/deleted, and multiple denied results expose IDs/previews, without object-ACL filtering.
- [ ] The normal wiki-kind/status filters remain active, isolating the missing object-authorization control.
- [ ] Reportability is calibrated for same-agent multi-workspace co-residency and archive-based recoverability.

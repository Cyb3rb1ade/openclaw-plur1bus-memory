import { test } from "node:test";

// R3 is gated on merged Engine PRs #259 and #268. These are acceptance specifications only.
// No restore is invoked, no production module is replaced, and no existing test is relaxed.
test.todo("R3 after #259/#268 merge: an active writer refuses restore without force before any file or staging directory changes");
test.todo("R3 after #259/#268 merge: a cross-process writer starting between inspection and swap cannot bypass restore exclusion");
test.todo("R3 after #259/#268 merge: the Node CLI defaults to a read-only dry run and changes files only with explicit confirm");
test.todo("R3 after #259/#268 merge: force against an active writer gives a clear warning and never substitutes for CLI confirmation");
test.todo("R3 after #259/#268 merge: new snapshots omit llm-result-cache-v1 database, WAL and SHM files from tree and manifest");
test.todo("R3 after #259/#268 merge: a legacy snapshot carrying cache files remains verifiable but restores with an empty derived cache");
test.todo("R3 after #259/#268 merge: refused or failed admission never empties the current cache or changes writer lease metadata");
test.todo("R3 after #259/#268 merge: every restore crash cut preserves journal recovery and committed tombstone reapplication");
test.todo("R3 after #259/#268 merge: workspace sources and opt-in pre-restore retention remain compatible and pending journals prevent purge");
test.todo("R3 after #259/#268 merge: successful restore starts a fresh cache and does not expose stale cached output or broaden cache file permissions");

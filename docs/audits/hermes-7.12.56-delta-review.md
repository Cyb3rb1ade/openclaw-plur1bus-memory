# Hermes 7.12.56: final upstream integration

Release target: **7.12.56-hermes.0**, both Python distributions **7.12.56**.
Upstream v7.12.56 is pinned to `5d79fb91a907b13929e41523348b761a748e6c81`.
The .53 and .55 Hermes candidates were not published; this release carries their
reviewed native work forward from the last public `7.12.47-hermes.0` baseline.

## Full recent feature review

The [detailed .47–.55 inventory](hermes-7.12.55-delta-review.md) accounts for all
259 changed paths, including the 21 non-test paths: native Skill Workshop,
maintenance gates, evidence transitions/partial completion, model diagnostics
and episode enrichment. Its Hermes-specific profile/UI/installer, migration,
retrieval, scope and safety contracts remain retained. Host-bound OpenClaw APIs
are not invented for Hermes; the documented native alternatives and intentional
differences still apply.

## What 7.12.56 adds

The nine changed paths from v7.12.55 to v7.12.56 are:

| Paths | Disposition |
| --- | --- |
| `lib/episodes.js`, `tests/episodes-skip-episoded.test.js` | Exact accepted upstream PR #151 code/tests: preserve persisted open-episode identity on covered final spans, including subsequent continuation and mixed groups. Already reviewed/cherry-picked in the unpublished Hermes candidate. Native content-bound derived episode receipts are unaffected. |
| `lib/llm-router.js`, `tests/llm-router.test.js` | Exact accepted PR #151 diagnosis redaction, safe foreign-error handling and native AbortError classification. Native diagnostics retain owner/profile binding, bounded segments and nonblocking contention handling. |
| `CHANGELOG.md` | Both upstream and Hermes history retained. |
| `openclaw.plugin.json`, `package.json`, `package-lock.json`, `tests/release-750-compat.test.js` | Official .56 version bump adapted coherently to the Hermes suffix. No dependency changes. |

Upstream merged [PR #151](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/pull/151)
and included its fix commit `94484bf84ad822c3c4aa00e2f2a8807a347a6af7` in the .56
release. The official tag is merged into the Hermes ancestry, not merely relabelled.
The `.55..56` history also imports older main-branch merge nodes; its nine-path
net diff, rather than counting those historical merge nodes as new features,
is the authoritative additional code delta.

## Native Windows closure

The matrix found and fixed a real Skill Workshop LF→CRLF/hash mismatch. Files
are now published as the exact approved UTF-8 bytes, with no weakening of the
manual-edit, retry, withdrawal or archive checks. Windows errno aliases map to
fixed safe codes. The final ACL test compares actual numeric owner and access
SIDs (Windows may display local Administrator as `LA`), requires a protected
DACL and exactly one allow ACE, and reads the existing ACL without mutation.
Retry test polling uses the production queue lock to avoid test-induced
delete-sharing conflicts. Earlier mismatched files are not silently repaired.

## Release boundaries

Final source-pinned tests, five-platform builds, macOS signing/notarization and
asset hashes are recorded in the release receipts, not inferred from the prior
.55 candidate results. Windows installers are explicitly unsigned; Intel macOS
is not a release target. No productive home/model/memory migration is performed
by isolated release QA. The optional JavaScript dependency advisories remain
tracked in [issue #150](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/issues/150).

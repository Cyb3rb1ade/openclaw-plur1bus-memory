# Hermes 7.12.61 source delta review

Upstream base: `bcb80ccef6ce5ab9e4604cfe923901885cc59d9e` (v7.12.60).
Target: `039329d0c74525448190b0bd2ec3ef3551ed168f` (v7.12.61).
Hermes base: `34dfd2102a079ec818818aca39dba81134b69d2a`.

## Last five upstream commits

`f092bfd5` merges primary-count fixes (#157); `03b8e786` merges journal
tail integrity (#158); `7529e959` merges optional dependency patches (#159);
`039329d0` changes release versions/changelog; `c381fd57` merges the release
branch into main with the exact same tree as the tag.

Comparisons against the reviewed PR heads (`d9be2e0d`, `2b768ca0`,
`cf89f728`) show no additional runtime correction in these merge commits.
The final journal-test commit `2b768ca0` replaces direct temporary-directory
creation with the repository's `makeTempDir` test helper, not a runtime change.
No different post-review runtime implementation is claimed or invented.

## Complete 17-path upstream inventory

| Paths | Hermes treatment |
| --- | --- |
| `.github/workflows/ci.yml` | Preserve the stricter Hermes blocking npm audit gate. |
| `CHANGELOG.md` | Retain upstream .61 notes alongside Hermes history and candidate notes. |
| `docs/audits/openclaw-journal-tail-integrity.md` | Include upstream audit. |
| `docs/audits/openclaw-optional-inference-150.md` | Include upstream audit. |
| `docs/audits/openclaw-primary-counts-155.md` | Include upstream audit. |
| `lib/control-plane-health.js` | Exact upstream: unavailable primary counts are null, never false zero. |
| `lib/control-plane-projection.js` | Exact upstream: preserve unknown counts. |
| `lib/neo-arch.js` | Exact upstream: count nonempty LF lines, reject short reads, linear chunk assembly. |
| `lib/setup/control-ui-plugin-runtime.js` | Exact upstream: render unknown as Unavailable, measured zero stays zero. |
| `openclaw.plugin.json` | Retain Hermes version suffix. |
| `package-lock.json` | Exact upstream dependency graph; only root versions use Hermes suffix. |
| `package.json` | Updated dependencies with retained Hermes payload list and publishing dist-tag. |
| `tests/control-plane-primary-count-failure.test.js` | Exact upstream regression suite. |
| `tests/local-inference-dependency.test.js` | Exact upstream dependency expectations. |
| `tests/local-inference-security-patches.test.js` | Exact upstream sharp/adm-zip security gates. |
| `tests/neo-arch-jsonl-tail-selection.test.js` | Exact upstream including corrected temp helper. |
| `tests/release-750-compat.test.js` | Hermes candidate version expectation, otherwise retained checks. |

## Native Hermes mapping and preserved contracts

The native tail reader already selects the last N valid JSON objects, skips
blank/non-object/malformed lines, handles multibyte and legacy separators, and
rejects short reads. Counting raw LF lines as the JavaScript code does would
weaken this native contract. New regressions cover long blank suffixes and
interspersed blank runs crossing read chunks; existing tests cover truncation,
bounded I/O, UTF-8 and output equivalence.

Native operator status already represents count failures as None and confines
primary counts to the active private agent/profile. New regressions distinguish
a failed count query from a measured zero. Both dashboard renderers already
handle unknown counts and have executable UI harness coverage.

Native running centroid sums with exact boundary checks and writer-coordinated
compaction are preserved byte-for-byte, as are Python runtime, installer,
profile selection, host integrations, retrieval/model migration and controls
logic. No OpenClaw-only cron ownership is introduced into Hermes.

Both Python packages are 7.12.61; JS/dashboard metadata is 7.12.61-hermes.0.
Source integration does not imply publication, platform certification, model
inference validation or a productive local installation. See the separate
verification report for gates actually executed on this candidate.

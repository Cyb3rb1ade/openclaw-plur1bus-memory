### Spec Compliance

- ✅ **Task 6 implementation is spec compliant.** Reviewed all three commits in `4514a1ec..76c6725a` against `task-6-brief.md`, the controller's explicit shadow-hydration extension, and the plan's Global Constraints. This is a task-scoped review, not a repeat whole-branch review.
- ✅ Authored input comes exclusively from the admitted message's `content` and existing `idempotencyKey`; missing, skipped, excluded, non-user, malformed, blank, or unstable-identity sources emit neither typed field. Structured text preserves ordering and characters; model projections, prompts, and history never supply a fallback (`scripts/telegramTts/patch-exec-speech-context.mjs:25`, `:40`).
- ✅ The exact phase → assembly → shared helper projections preserve the existing hook context/provenance and exact-prompt suppression. The trusted exec projection remains unchanged (`scripts/telegramTts/patch-exec-speech-context.mjs:10`, `:40`, `:66`, `:80`; `tests/telegram-speech-native-host.test.js:125`, `:167`).
- ✅ All three unique implementations are validated before any bundle write; incomplete/duplicate/unsupported shapes refuse. Inspection retains `file`, adds all target paths and hashes, and supports idempotent application with atomic per-file replacement (`scripts/telegramTts/patch-exec-speech-context.mjs:52`, `:89`, `:108`, `:121`).
- ✅ Deployment validates target containment and expected digests, backs up every host original before its apply subprocess, records exact known original/projected hashes after partial failure, and checks all three outputs. Unknown bytes cannot become an accepted rollback digest (`scripts/telegramTts/deploy.py:85`, `:94`, `:131`, `:136`, `:145`). The existing rollback preflight checks every target before restoring any target (`scripts/telegramTts/deploy.py:46`).
- ✅ The authorized runtime change hydrates stable admitted shadow runs after explicit configuration and eligibility checks, before assessment. The existing shadow return still precedes timed evidence, state/mood-file persistence, and guidance (`lib/jevEmotionRuntime.js:205`, `:235`, `:236`, `:270`). Accepted and unknown fresh-shadow outcomes are covered with persisted mood and recall disabled (`tests/jev-emotion-runtime.test.js:300`).
- ✅ Native integration tests execute copied producer/phase/assembly/helper code into the real runtime and speech adapter. They exercise exact text/identity, duplicate admission and retry isolation, context privacy/matching, source rejection, policy/currentness gates, shadow neutrality, active dedupe, and host hook suppression (`tests/telegram-speech-native-host.test.js:32`, `:69`, `:104`, `:125`, `:151`, `:167`). The actual installer subprocess fixture verifies backups before patching, partial application, unknown bytes, and all-or-nothing refusal on later drift; executable live destinations are scanned before spawning (`tests/telegram-speech-deploy.test.py:36`).
- ✅ Documentation describes the native producer contract and multi-target deployment/rollback. Existing startup persistence invokes the expanded patcher without introducing a service. Prerelease metadata consistently advances to `.2`, including the version assertion (`scripts/telegramTts/README.md:19`; `scripts/telegramTts/deploy.py:37`; `package.json:3`; `package-lock.json:3`; `openclaw.plugin.json:5`; `tests/release-750-compat.test.js:5`).
- ⚠️ Live eligible Telegram admission, installed adoption, contextual shadow/live audio acceptance, and activation remain controller work. The copied-chain tests intentionally substitute host context construction and the external eligibility predicate; they do not establish production authorization or live transport success (`tests/telegram-speech-native-host.test.js:19`, `:54`; `scripts/telegramTts/README.md:33`). No live completion is certified by this review.

### Strengths

- The producer fix is narrow: authored text and stable identity cross the missing boundaries without introducing another recall/input path or weakening consumer policy (`scripts/telegramTts/patch-exec-speech-context.mjs:25`, `:40`).
- Failure handling distinguishes exact installer output from unknown operator bytes, and the regression checks that rollback refuses before modifying even the unrelated manifest targets (`scripts/telegramTts/deploy.py:136`; `tests/telegram-speech-deploy.test.py:88`).
- The shadow regression checks both accepted and unknown assessments, persisted file bytes, absent mood output, empty timed evidence, and the outgoing snapshot's hydrated mood (`tests/jev-emotion-runtime.test.js:300`).

### Issues

#### Critical (Must Fix)

- None found.

#### Important (Should Fix)

- None found.

#### Minor (Nice to Have)

- **Stale runtime provenance in the verification record:** `docs/superpowers/verification/2026-10-25-jev-emotion-speech.md:3` says “Core runtime bytes remain1189feb6,” but this reviewed range changes `lib/jevEmotionRuntime.js:236`. Update the sentence when recording `.2` acceptance to distinguish the reviewed core baseline from the additional Task 6 hydration change. This does not affect execution, but the current wording misidentifies the runtime artifact covered by that record.

### Review Checks and Evidence

- Read the brief, implementer report, installed-source investigation, reviewer template, and the supplied complete three-commit diff. Read the diff once in sequential ranges; no git commands or broader repository review were performed.
- **Named risk: partial rollback might overwrite unknown operator bytes.** Inspected the unchanged `rollback()` and path/digest helpers at `scripts/telegramTts/deploy.py:17`, `:25`, `:46`, whose bodies were outside the deployment hunk. Confirmed complete preflight occurs before the restore loop.
- **Named risk: removing the active-only hydration guard could implicitly activate timed state or allow shadow writes.** The runtime hunk was cut mid-function, so inspected the complete surrounding admission/configuration/assessment/shadow-return path at `lib/jevEmotionRuntime.js:123`, `:170`, `:205`. Inspected the unchanged hydration/configuration dependency at `lib/emotional-state.js:97`, `:548`: disabled timed mode clears the target, persisted metadata cannot enable it, hydration performs reads/in-memory loading, and the runtime's shadow branch returns before evidence and persistent mood writes.
- Inspected the implementer's reported RED/GREEN evidence: 107 focused JavaScript tests; six Python deployment tests; one aggregate Python-runner test; syntax, inventory, temp-helper, diff checks; and copied installed-bundle syntax/idempotence smoke. These are reported results, not independently rerun results. No new code doubt warranted another test run; no same-code tests, providers, services, live files, or stores were invoked or modified.
- The patch remains intentionally exact-shape and atomic per file. Abrupt termination before manifest finalization still requires snapshot inspection, as disclosed in `scripts/telegramTts/README.md:43`; this review does not claim cross-file transactional/crash atomicity.

### Assessment

**Task quality: Approved, with one non-blocking documentation correction.**

**Reasoning:** The native forwarding seam, multi-bundle deployment protections, and authorized shadow hydration change match the requested scope and have meaningful offline regressions. The remaining uncertainty is live host/Telegram acceptance, which is explicitly reserved to the controller.

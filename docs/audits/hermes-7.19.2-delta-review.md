# Hermes 7.19.2 delta review

Upstream: `3c42b39ba8d5a6522e9201c26c3cad267590636d` (v7.19.2).
Hermes base: `ab256b1547c353c458c07a70c34640b1070beedc`, the 7.18.20
candidate based on the previous 7.18.4 Hermes release. The OpenClaw source,
UI and tests are retained at the official tag; they do not execute on Hermes.

| Feature family | Hermes status |
| --- | --- |
| 7.19.2 note-import exclusions | Native for scoped Obsidian plans and watch, before file I/O. Custom workspace-relative globs can extend or replace defaults; protected mirror/knowledge paths remain excluded. |
| 7.19.2 automatic low-risk apply | Native opt-in for short, private, untrusted note imports. Approval audit binds the exact payload revision and source hash; drift/failures remain pending. No knowledge rewrite, promotion or new delivery route. |
| 7.18.27–.28 recall | Native provider input cap across namespaces, refined-hit dedup and provider order preservation. Provider failure retains the full eligible fallback. OpenClaw's offline recall comparison CLI and knowledge vector cache are not native equivalents. |
| Jev credential status | Native diagnostics show presence and source category only, not secret or variable name. Existing automatic capture chunking keeps its own opt-in and routing. |
| Jev timed mood, incoming emotion, recall filter, speech | Retained upstream implementation; not native Hermes. The existing local mood/encoding pipeline remains active. Porting the new external decisions requires host hook ownership and per-profile consent; OpenClaw exec/Telegram wrappers cannot be installed as Hermes hooks. |
| Morning/evening review delivery, cron reload and session reset | OpenClaw schedules and delivery formatting remain host-specific. Hermes keeps its own scoped hourly watch, daily workspace status, and authorized delivery. No new Telegram schedule is enabled. |
| Idle afterthought and prompt cache | Existing Hermes governor and task cache preserved; OpenClaw session-specific continuation hooks and provider prefix caching are not native. |
| Provider-grouped model catalog and Skill Miner learning | Existing native reviewed settings/skill workshop preserved. OpenClaw catalog reconciliation, learning-cache matching and workflow extension logic remain bundled JS only. |
| OpenClaw model token/thinking defaults | Native task profiles and host LLM router preserved; no implicit model or credential migration. |

Previous profile isolation, installer profile selection, model selection, memory
migration and Desktop UI are preserved. No production installation or platform
support is inferred from these source tests.

## Commits

- `3c42b39b`
- `a6e9a93e`
- `83640e6b`
- `d5685888`
- `76c6725a`
- `31986baf`
- `aad25b77`
- `4514a1ec`
- `4d4ce775`
- `bb5c1e19`
- `1189feb6`
- `20fc42b8`
- `0381182e`
- `e10283d2`
- `24aa8f1b`
- `750e221e`
- `55037558`
- `60b995e0`
- `34b73f7c`
- `122cf5ae`
- `3f1627da`
- `9474c235`
- `ea7bf686`
- `d2e8a234`
- `4798bfb9`
- `64e6e9f4`
- `6419a60e`
- `f1e57913`
- `8f623b71`
- `8d2ca911`
- `318197ce`
- `e71dd9fe`
- `0ee6a59b`
- `c3c1cb44`
- `dd051ee1`
- `083d20fe`
- `52385fd0`
- `f5544d86`

## Paths

- `.gitignore`
- `.openclaw/extensions/emotional-state-injector/index.js`
- `AGENTS.md`
- `CHANGELOG.md`
- `README.md`
- `dist/control-ui/jev-key/index.js`
- `docs/audits/2026-10-23-recall-comparison.md`
- `docs/audits/2026-10-23-recall-upstream-followup.md`
- `docs/configuration.md`
- `docs/runbooks/feature-cron-reload-retry.md`
- `docs/runbooks/recall-comparison.md`
- `docs/superpowers/plans/2026-10-23-recall-model-catalog.md`
- `docs/superpowers/plans/2026-10-23-recall-upstream-followup.md`
- `docs/superpowers/plans/2026-10-23-skill-miner-learning.md`
- `docs/superpowers/plans/2026-10-25-jev-emotion-speech.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech/decisions.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech/final-fix-report.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech/final-fix-review.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech/final-review.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech/suite-triage-report.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech/suite-triage-review.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech/task-4-report.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech/task-6-report.md`
- `docs/superpowers/verification/2026-10-25-jev-emotion-speech/task-6-review.md`
- `index.js`
- `lib/afterthought-hooks.js`
- `lib/afterthought-host.js`
- `lib/afterthought-reflection.js`
- `lib/control-plane-projection.js`
- `lib/dreaming/dream-narrative.js`
- `lib/dreaming/light-dream.js`
- `lib/dreaming/rem-dream.js`
- `lib/emotional-state.js`
- `lib/episodes.js`
- `lib/featureModels.js`
- `lib/i18n-dictionary.js`
- `lib/jev-chunk-decider.js`
- `lib/jev-recall-filter.js`
- `lib/jevEmotion.js`
- `lib/jevEmotionRuntime.js`
- `lib/jobs/conflict-resolver.js`
- `lib/jobs/memory-compaction.js`
- `lib/jobs/skill-miner.js`
- `lib/jobs/skill-miner/benefit-backfill.js`
- `lib/jobs/skill-miner/candidate-matching.js`
- `lib/jobs/skill-miner/llm-extractor.js`
- `lib/jobs/skill-miner/proposal-writer.js`
- `lib/llm-call.js`
- `lib/llm-result-cache.js`
- `lib/llm-router.js`
- `lib/model-catalog-reconcile.js`
- `lib/mood-style-directive.js`
- `lib/obsidian-control-room.js`
- `lib/persona-voice.js`
- `lib/proactive-governor.js`
- `lib/recall-budget.js`
- `lib/recall-comparison.js`
- `lib/recall-pipeline.js`
- `lib/runtime-shutdown.js`
- `lib/setup/control-ui-plugin-runtime.js`
- `lib/setup/control-ui-write.js`
- `lib/setup/feature-cron-plan.js`
- `lib/setup/feature-cron-plugin-runtime.js`
- `lib/setup/skill-workshop-plugin-runtime.js`
- `lib/speechRegie.js`
- `lib/speechText.js`
- `lib/telegram-commands/skill-commands.js`
- `lib/telegramSpeech.js`
- `lib/tier3-llm.js`
- `lib/wiki-command.js`
- `openclaw.plugin.json`
- `package-lock.json`
- `package.json`
- `scripts/compare-recall.mjs`
- `scripts/lib/deploy-integrity.mjs`
- `scripts/plan-speech.mjs`
- `scripts/telegramTts/README.md`
- `scripts/telegramTts/bernhardine/SKILL.md`
- `scripts/telegramTts/bernhardine/bin/tts-auto.sh`
- `scripts/telegramTts/bernhardine/bin/tts-bilingual.sh`
- `scripts/telegramTts/bernhardine/bin/tts-generate.sh`
- `scripts/telegramTts/bernhardine/bin/tts-manager.sh`
- `scripts/telegramTts/bernhardine/bin/tts-reply.sh`
- `scripts/telegramTts/deploy.py`
- `scripts/telegramTts/elevenlabs-tts.py`
- `scripts/telegramTts/heisenberg/SKILL.md`
- `scripts/telegramTts/heisenberg/bin/tts-auto.sh`
- `scripts/telegramTts/heisenberg/bin/tts-generate.sh`
- `scripts/telegramTts/heisenberg/bin/tts-manager.sh`
- `scripts/telegramTts/heisenberg/bin/tts-reply.sh`
- `scripts/telegramTts/main/SKILL.md`
- `scripts/telegramTts/main/bin/tts-auto.sh`
- `scripts/telegramTts/main/bin/tts-generate.sh`
- `scripts/telegramTts/main/bin/tts-manager.sh`
- `scripts/telegramTts/main/bin/tts-reply.sh`
- `scripts/telegramTts/patch-exec-speech-context.mjs`
- `scripts/telegramTts/speech-bridge.py`
- `tests/afterthought-hooks.test.js`
- `tests/afterthought-host.test.js`
- `tests/afterthought-integration.test.js`
- `tests/afterthought-reflection.test.js`
- `tests/afterthought-sdk.test.js`
- `tests/auto-capture-batch.test.js`
- `tests/dashboard-settings.test.js`
- `tests/deploy-manifest-covers-shipped-scripts.test.js`
- `tests/dream-narrative.test.js`
- `tests/emotion-refine-encoding-maxtokens.test.js`
- `tests/emotional-state-timed.test.js`
- `tests/feature-cron-bootstrap.test.js`
- `tests/feature-cron-plan.test.js`
- `tests/feature-cron-reload-retry.test.js`
- `tests/featureModelSelection.test.js`
- `tests/fixtures/telegramSpeech/bash-tools-host.mjs`
- `tests/fixtures/telegramSpeech/builtin-openclaw-host.mjs`
- `tests/fixtures/telegramSpeech/context-engine-maintenance-host.mjs`
- `tests/fixtures/telegramSpeech/installed-tts-routing.py`
- `tests/jev-chunk-decider.test.js`
- `tests/jev-emotion-plugin.test.js`
- `tests/jev-emotion-runtime.test.js`
- `tests/jev-emotion-speech.test.js`
- `tests/jev-final-review.test.js`
- `tests/jev-key-dashboard.test.js`
- `tests/jev-recall-filter.test.js`
- `tests/llm-result-cache-integration.test.js`
- `tests/llm-result-cache.test.js`
- `tests/llm-router.test.js`
- `tests/local-inference-security-patches.test.js`
- `tests/model-catalog-reconcile.test.js`
- `tests/morning-review-telegram-layout.test.js`
- `tests/multi-namespace-recall-runtime.test.js`
- `tests/note-import-excludes.test.js`
- `tests/obsidian-policy-denied-text.test.js`
- `tests/persona-voice.test.js`
- `tests/proactive-governor.test.js`
- `tests/recall-comparison.test.js`
- `tests/recall-pipeline-graph-hydration-relevance.test.js`
- `tests/recall-rerank-order.test.js`
- `tests/release-731-runtime-callsite-security.test.js`
- `tests/release-731-skill-compaction-security.test.js`
- `tests/release-750-compat.test.js`
- `tests/review-auto-apply-approval-hash.test.js`
- `tests/review-maintenance-findings.test.js`
- `tests/runtime-hot-reload-lifecycle.test.js`
- `tests/secret-input-manifest.test.js`
- `tests/skill-benefit-backfill.test.js`
- `tests/skill-miner-candidate-matching.test.js`
- `tests/skill-miner-extensions.test.js`
- `tests/skill-miner-learning-cache.test.js`
- `tests/skill-miner-prompt-bounds.test.js`
- `tests/telegram-speech-adapter.test.js`
- `tests/telegram-speech-deploy.test.py`
- `tests/telegram-speech-helper.test.py`
- `tests/telegram-speech-host-patch.test.js`
- `tests/telegram-speech-native-host.test.js`
- `tests/telegram-speech-python.test.js`
- `tests/telegram-speech-routing.test.py`
- `tests/telegram-speech-wrappers.test.py`

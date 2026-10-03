# Hermes 7.18.4 delta review

Upstream: `9cc5f833b188d8299000faeb94bd0b2015e6217b` (v7.18.4), merged without dropping the previous Hermes payload. Comparison from v7.16.9: 46 paths, 18 commits.

## Native and host boundaries

- Critical proposals expire after 24h through the scoped, audited reject path, never auto-accept. Same-turn whole/chunk coverage suppresses redundant Critical proposals without deleting memories.
- Skill Workshop evidence lookup is indexed once. The upstream clustering algorithm remains byte-exact in the bundled JS; Hermes has no equivalent all-pairs clustering path to replace.
- Actual native LLM failures feed bounded process-local, owner-scoped 24h health counters. Three equal feature/category failures degrade health; load timeouts and aborted work do not. Authority expiry is classified without exposing exception text. OpenClaw gateway log signals are explicitly unsupported in Hermes, not guessed.
- Discord Persona/Light requires OpenClaw voice context, prompt/model hooks and session patching; no verified equivalent exists in Hermes. Bundled upstream code retained; native persona projection is preserved and is not claimed as Discord voice support.
- Model-driven memory_forget is not exposed by the Hermes provider. Human controls retain archive/tombstone/audit guarantees; removing those would weaken authorization and resurrect deleted records.
- OpenClaw cron timeout/reply/bot-binding changes are retained in JS, not mapped onto nonexistent Hermes cron bindings. Native scoped Critical controls remain intact.
- Optional post-turn detachment stays disabled; it is not a Hermes authority workaround.
- Installer and client compatibility are reviewed separately against current Hermes. Managed Python generation selection must replace legacy venv assumptions. Existing provider/model selections, embeddings, dimensions, memories and profile ownership must survive installation.
- Native desktop and web UI preserve provider changes, reranker settings, dimension migration, confirmation guards, help and configuration version footer. Profile-bound requests must fail closed on connection/profile changes.
- Current-Hermes directory loading reuses the installed canonical package with a version guard, keeping Controls/provider/dashboard service and health registries identical. A digest-only identity signature invalidates cached agents after alias/writer remapping. The initial home follows Hermes' active home context rather than assuming `~/.hermes`.
- Python 3.14 uses NumPy 2.4.3 (matching current Hermes), Sentence Transformers 6.1.0 and native ONNX support; older supported Python versions retain their existing dependency bounds. Actual cached Nano/BGE inference was separately exercised without changing productive config or memory.

## Complete upstream inventory

- `AGENTS.md`: retained documentation or version metadata; Hermes metadata adapted where required.
- `CHANGELOG.md`: retained documentation or version metadata; Hermes metadata adapted where required.
- `README.md`: retained documentation or version metadata; Hermes metadata adapted where required.
- `docs/configuration.md`: retained documentation or version metadata; Hermes metadata adapted where required.
- `docs/superpowers/plans/2026-09-26-discord-voice-persona-light.md`: retained documentation or version metadata; Hermes metadata adapted where required.
- `docs/superpowers/specs/2026-09-26-discord-voice-persona-light-design.md`: retained documentation or version metadata; Hermes metadata adapted where required.
- `index.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/control-plane-projection.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/critical-button-delivery.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/critical-buttons.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/db-adapter.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/health-watch.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/i18n-dictionary.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/internal-cron-reply.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/jobs/auto-accept-stale-criticals.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/jobs/critical-classifier.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/jobs/skill-miner/evidence-aggregator.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/llm-router.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/post-turn-detach.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/setup/control-ui-plugin-runtime.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/setup/feature-cron-plan.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/setup/feature-cron-plugin-runtime.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/voice-mode-switch.js`: upstream source retained exactly (release-version expectation excepted).
- `lib/voice-mode.js`: upstream source retained exactly (release-version expectation excepted).
- `openclaw.plugin.json`: retained documentation or version metadata; Hermes metadata adapted where required.
- `package-lock.json`: retained documentation or version metadata; Hermes metadata adapted where required.
- `package.json`: retained documentation or version metadata; Hermes metadata adapted where required.
- `scripts/lib/deploy-integrity.mjs`: upstream source retained exactly (release-version expectation excepted).
- `scripts/setup-feature-crons.mjs`: upstream source retained exactly (release-version expectation excepted).
- `test/memory-edit.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/critical-button-delivery.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/critical-buttons.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/critical-classifier-chunk-dedup.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/critical-review-command.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/critical-stale-expire.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/feature-cron-bootstrap.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/feature-cron-native-dispatch.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/feature-cron-plugin-runtime.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/health-watch.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/post-turn-detach.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/release-750-compat.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/skill-miner-aggregate-performance.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/tombstone-e2e.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/voice-light-hooks.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/voice-mode-switch.test.js`: upstream source retained exactly (release-version expectation excepted).
- `tests/voice-mode.test.js`: upstream source retained exactly (release-version expectation excepted).

## Commits reviewed

- `9cc5f833` 7.18.4: Teilstücke nicht zusätzlich als Critical pushen
- `3a9a9adb` 7.18.3: Nachbearbeitung optional vom beendeten Turn abkoppeln
- `b68126a0` 7.18.2: Skill-Miner-Clustering ohne Paarschleife
- `b2d1d79b` 7.18.1: Feature-Cron-Probe unter OpenClaw 9.7 nicht mehr zu knapp
- `b8d51ae4` 7.18.0: Health-Überwachung im Dashboard
- `22b43049` 7.17.1: Umschalten per /modus, /voice gehört OpenClaw
- `28c8d980` 7.17.0: Persona/Light für Discord-Sprachräume
- `b9ea61b3` test: Critical-Tests neben dem /voice-Hook präzisieren
- `0cd0ba6a` feat(voice): /voice und Knöpfe schalten Persona/Light, nur für den Besitzer
- `49c3b94b` feat(voice): Light lässt Recall weg und nimmt pro Lauf Haiku
- `b14438a7` feat(voice): Modus-Speicher Persona/Light und Erkennung von Discord-Sprachzügen
- `0fa4b6cc` docs: Umsetzungsplan Discord-Sprachräume Persona/Light
- `e2f2e9e6` docs: Discord-Design an die geprüften Host-Fakten anpassen
- `7758dd01` docs: Serververwaltung ins Discord-Design aufnehmen
- `17afd20c` docs: Design für Discord-Sprachräume mit Persona/Light
- `55a4f9b0` 7.16.11: Vergessen durch das Modell sperrt nicht mehr dauerhaft
- `cf4bc88e` 7.16.10: Knopf-Push an das Ziel des eigenen Crons, Bot aus den Bindings
- `804235dd` 7.16.10: Critical Push mit Knöpfen, unbestätigte Criticals verfallen

## Evidence boundary

Focused tests are not platform acceptance, local activation or publication. Final release receipts must identify the exact source commit and separately record each platform, signing/notarization, local UI acceptance and remote assets.

## Current-Hermes integration checkpoint (2026-10-03)

Hermes `b2860025adc1478eca63a0b2a82440798eadbfd1` uses managed Python
3.14 environments and a shared, profile-multiplexed Desktop backend. Installation
through the official PM selection succeeded for default, bernd, bernhardine,
coder, heisenberg and rapidmlx; mtplx remains unchanged. The selected canonical
PLUR1BUS package reports 7.18.4. Existing model configuration was preserved.

Live Desktop inspection found an additional host integration defect: a backend
launched for mtplx (where PLUR1BUS is disabled) serves Coder requests, but its
startup API mount does not include PLUR1BUS. A missing API route is therefore
not evidence that Coder disabled its provider. The Desktop now retains diagnostic
navigation on missing routes while refusing memory requests until a profile-bound
capability handshake explicitly confirms activation. This does not repair the
underlying host routing by itself; profile-isolated plugin API routing and live
acceptance remain release gates.

Distribution CI run `37131118537`, pinned to `d1d99ec0`, passed macOS ARM,
Windows x64, Windows ARM, Linux x64 and Linux ARM package tests. Its Windows ARM
job uses Python 3.13, not the current Hermes PM Python 3.14 environment. The
separate Python-3.14 native-wheel run `37129076589` must complete storage and PM
acceptance before that newer Windows ARM path can be advertised. Later source
changes require renewed source-bound verification and artifact generation.

### Verified local host-routing correction

The host candidate `adee8637d522c862513b77a58b34a6fd4e3d1ccd` fixes both
legacy connection resolution and registry-pinned API dispatch. All 129 focused
Desktop tests and its full typecheck passed. Its Apple Silicon application was
Developer-ID signed, notarized (submission
`763be025-d40b-4685-8441-2fca7fe07eb6`) and stapled. Gatekeeper accepts the
installed candidate. Previous applications remain in the local backup.

Live Desktop acceptance now shows PLUR1BUS for Coder, Bernhardine, Heisenberg,
RapidMLX and Bernd, with the correct active-profile heading and 7.18.4 version
after each backend finishes loading. Switching to intentionally disabled mtplx
hides PLUR1BUS; its configuration was not changed. The upstream host correction
is submitted as NousResearch/hermes-agent PR #132265, not yet merged. Remote
profile routing is outside the demonstrated local-host fix.

The native Windows ARM Python-3.14 storage run `37129076589` completed
successfully. Official Hermes PM admission remains a separate pending gate;
native storage success alone does not prove package-manager installation.

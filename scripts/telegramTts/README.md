# Telegram speech deployment artifacts

These files began as copies of the installed helper and three `telegram-tts-toggle` skills on 2026-10-25. Local and Edge routes retain their existing implementation. Only the ElevenLabs generation route uses the shared canonical speech adapter. Existing toggle JSON files and fixed configured voices/model are preserved.

The controller deploys the plugin's `DEPLOY_FILES` first; the installed JSON CLI must live at `/root/.openclaw/extensions/memory-lancedb-namespaced/scripts/plan-speech.mjs`. No runtime path points to this development checkout or `/tmp`.

Preview the complete mapping (no writes):

```sh
python3 scripts/telegramTts/deploy.py --host-patch
```

After review and the authorized acceptance checks:

```sh
python3 scripts/telegramTts/deploy.py --apply --host-patch
```

The script validates host plugin settings using the effective configuration contract, backs up only affected helper/wrapper/skill/patch/startup/bundle files, and takes read-only copies of host config and the three toggle states. It never writes that config or toggle state. It maps the shared helper to `tools/elevenlabs-tts.py`, bridge to `tools/plur1bus-speech-bridge.py`, each skill tree to its own existing workspace, and patcher to `patches/patch-exec-speech-context.mjs` beneath `/root/.openclaw`. The optional host patch preflights three unique supported implementations in `/usr/lib/node_modules/openclaw/dist`: `bash-tools-*.mjs`, `builtin-openclaw-*.mjs`, and `context-engine-maintenance-*.mjs`. Alias/metadata bundles without the relevant implementation are ignored. Missing, unsupported, ambiguous or partially patched shapes refuse before any bundle is changed. Inspection retains the legacy `file` (exec bundle) and adds `files` (all three paths) plus per-target original/projected SHA-256 digests. The installer snapshots every affected bundle before applying atomic per-file replacements and checks all three with `node --check`.

The native producer must supply its already admitted `preparedUserTurnMessage` from the transcript recorder before prompt construction. The patch forwards that object from prompt phase to assembly, then projects only its authored `content` and existing stable `idempotencyKey` as `currentUserMessage` / `currentUserMessageId` through the native helper into `before_prompt_build`. String content is exact; structured text blocks are concatenated in order without inserting or removing characters. Non-text blocks are omitted, malformed text blocks reject the projection. Missing, skipped, excluded, non-user, empty or unstable-identity messages emit neither typed field. Explicit non-external/subagent admitted provenance also rejects projection; the existing hook context and its provenance remain intact. Model prompt projections, assembled prompts and history never supply a fallback. Raw-model and settled-finalization hook suppression remain in place.

The existing exec projection continues to use trusted hook context/default run ID and trusted hook workspace only. All runtime policy, workspace, internal-turn, incognito and currentness checks still apply; merely supplying the typed fields does not grant eligibility. Configured admitted shadow runs hydrate the saved current mood before assessment even when recall is off, while timed evidence, mood-file writes and guidance remain active-only.

The existing `patches/apply-media-patch.sh` remains the startup/update persistence entrypoint. Its single final `exit $rc` anchor receives an idempotent invocation:

```sh
node /root/.openclaw/patches/patch-exec-speech-context.mjs "$DIST_DIR" --apply || rc=1
```

No new service, timer or server is installed. The controller owns any restart, feature shadow/active flags, version/tag/pin/guard coordination, live delivery and final acceptance. Native TTS/talk/Discord/STT settings remain untouched.

Installation prints a private snapshot path. Preview rollback, then explicitly apply it:

```sh
python3 scripts/telegramTts/deploy.py --rollback /root/.openclaw/.snapshots/telegram-speech-YYYYMMDD-HHMMSS
python3 scripts/telegramTts/deploy.py --rollback /root/.openclaw/.snapshots/telegram-speech-YYYYMMDD-HHMMSS --apply
```

Rollback targets only manifest-listed artifacts and host files and refuses a file changed since installation. State/config evidence files are never automatically restored. Keep the plugin deployment's separate snapshot for rollback of plugin runtime modules. A failed patch subprocess records each target as its exact preflight original or projected output, so a partial application can be rolled back. Unknown bytes are never adopted as installer-owned: rollback still refuses concurrent or later operator changes before restoring any file. Abrupt termination that prevents the final manifest update requires snapshot inspection. Do not overwrite an operator change to force rollback.

The JSON adapter supports version 1 and explicit `main`, `bernhardine`, `heisenberg` IDs. One/two unique `default`, `de`, `pl` text versions enter via stdin. Returned provider payload keeps `text` and `speech` separate, with a blocked flag for text-only cases and `proposed` section decisions containing only section index and closed intent/delivery/action enums (at most 12 sections per version). The helper accepts `say-prepared --voice <configured-voice> --out <wrapper-output>` with `{version:1,text,speech}` on stdin; voice, model, output paths and credentials never come from Jev. Standard `say` and management commands remain backward compatible.

Disabled emotion still performs mandatory canonical sanitation/capping but skips Jev/tags. Shadow logs accepted/rejected plus bounded per-version section intent/delivery/action proposals as `speech_shadow_decision:` JSON on stderr and sends neutral canonical speech. This summary excludes words, persona, context and credentials. Active sends closed validated tags. Raw bracket directives result in no audio. Missing/forged/expired/private-file failures use conservative final-text-only planning. Provider failures preserve the text response, and bilingual success remains per-language without speaker fallback.

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

The script validates host plugin settings using the effective configuration contract, backs up only affected helper/wrapper/skill/patch/startup/bundle files, and takes read-only copies of host config and the three toggle states. It never writes that config or toggle state. It maps the shared helper to `tools/elevenlabs-tts.py`, bridge to `tools/plur1bus-speech-bridge.py`, each skill tree to its own existing workspace, and patcher to `patches/patch-exec-speech-context.mjs` beneath `/root/.openclaw`. The optional host patch handles the unique supported `bash-tools-*.mjs` bundle in `/usr/lib/node_modules/openclaw/dist`; unsupported or ambiguous shapes refuse before changing that bundle. Patch projection uses trusted hook context/default run ID and trusted hook workspace only. It does not use cwd or any model-supplied argument.

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

Rollback targets only manifest-listed artifacts and host files and refuses a file changed since installation. State/config evidence files are never automatically restored. Keep the plugin deployment's separate snapshot for rollback of plugin runtime modules. A failed/interrupted install preserves its manifest/backups for inspection; do not overwrite an operator change to force rollback.

The JSON adapter supports version 1 and explicit `main`, `bernhardine`, `heisenberg` IDs. One/two unique `default`, `de`, `pl` text versions enter via stdin. Returned provider payload keeps `text` and `speech` separate, with a blocked flag for text-only cases. The helper accepts `say-prepared --voice <configured-voice> --out <wrapper-output>` with `{version:1,text,speech}` on stdin; voice, model, output paths and credentials never come from Jev. Standard `say` and management commands remain backward compatible.

Disabled emotion still performs mandatory canonical sanitation/capping but skips Jev/tags. Shadow logs only accepted/rejected decision and sends neutral canonical speech. Active sends closed validated tags. Raw bracket directives result in no audio. Missing/forged/expired/private-file failures use conservative final-text-only planning. Provider failures preserve the text response, and bilingual success remains per-language without speaker fallback.

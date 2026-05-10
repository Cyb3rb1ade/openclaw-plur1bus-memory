# OpenClaw 2026.5.10-beta.1 High/Medium Instance Review

Live instance: OpenClaw 2026.5.7 (eeef486)
Target: openclaw@2026.5.10-beta.1
Beta tag: v2026.5.10-beta.1 -> 9c7e67b0f8247dbd81b6610bc1bd9a1a4d4a1256

## Gate summary

- ClawSweeper range: 3570 commits
- Findings: 256 total; 10 high, 142 medium, 81 low, 23 unweighted
- Unreviewed commits: 1246
- This report fully classifies all 152 high/medium findings from the current beta range.
- Local baseline passed: `openclaw plugins doctor`, `memory-doctor provider-check`, `openclaw status`.
- Tarball was fetched and unpacked under `/tmp/openclaw-beta-2026510-check-iJbQyP/package`.

## Update decision

Do not install this beta onto the live instance yet.

Reasons:

- The existing local OpenClaw compat patch is version-gated through 2026.5.7 and skips 2026.5.10-beta.1.
- When the version gate is bypassed in a throwaway tarball copy, the first real anchor break is `active-memory no empty-result cache`; upstream now uses `return result.status === "ok" && result.summary.length > 0`, so the patch must be revised instead of blindly extended.
- High/medium ClawSweeper results still include local blocker classes: fs-safe mutation safety, Codex/OpenAI route repair, assistant-prefill failover, trusted-proxy auth, and active-memory timeout/cache behavior.
- The beta still has 1246 unreviewed commits, so ClawSweeper coverage is incomplete.

## Local blocker set

| Sev | Commit | Area | Decision | Finding | Follow-up signal |
| --- | --- | --- | --- | --- | --- |
| medium | 5a0d6c7 | PLUR1BUS/memory | plur1bus-smoke-required | fix(gateway): keep reset and refresh paths responsive (#77701) | 3f04632448 fix(agents): enforce idle timeout during stream setup |
| high | 538605f | Codex/OpenAI/model-routing | blocker | [codex] Extract filesystem safety primitives (#77918) | 1d65f965e8 test: clear codex migration broad matchers |
| medium | 2016331 | PLUR1BUS/memory | plur1bus-smoke-required | fix: resolve fs-safe post-land fallout | 328952c6f5 fix(release): drop missing bundled runtime deps pack entry |
| medium | 8294229 | PLUR1BUS/memory | plur1bus-smoke-required | test: refresh fs-safe boundary expectations | 9a454509f5 test: speed up memory host remote client tests |
| medium | ebb8bed | PLUR1BUS/memory | plur1bus-smoke-required | fix: cap memory wiki filenames for safe writes | b8545d069e fix(memory-wiki): reserve fs-safe temp filename space |
| high | 90b69ca | Google/Gemini | blocker | test(perf): slim channel directory contracts | e43ae8e8cd fix(googlechat): import action name contract type |
| high | 5f60479 | core/gateway | blocker | fix: scope async model runtime hooks | bf7cc278d2 fix(models): explain missing provider model registration |
| high | 3a901b5 | Codex/OpenAI/model-routing | blocker | Revert "Install Codex plugin on OpenAI model selection (#78799)" (#78878) | 3f04632448 fix(agents): enforce idle timeout during stream setup |
| high | 7ad53ce | core/gateway | blocker | fix(ci): account for canvas a2ui deps | 955b025697 feat: add native sqlite Kysely dialect |
| high | 84dd9c7 | core/gateway | blocker | fix(gateway): fail closed for trusted-proxy auth | 3f04632448 fix(agents): enforce idle timeout during stream setup |
| high | 07b972c | CI/release/test-only | blocker | test: tighten backup manifest callback assertions | 6eb633b29e test: tighten backup json assertion |
| medium | 631c655 | PLUR1BUS/memory | plur1bus-smoke-required | test: tighten memory watcher manager assertions | 9202e74b11 test: tighten memory watcher error assertion |
| medium | 17c57b7 | PLUR1BUS/memory | plur1bus-smoke-required | test: tighten memory multimodal assertions | a6b01a6d71 test: tighten memory host sdk assertions |
| medium | 49db190 | PLUR1BUS/memory | plur1bus-smoke-required | fix(memory): verify qmd conflict before rebind | c39f85822a fix(memory): warn on unverified qmd conflict |
| high | 398dd6e | core/gateway | blocker | fix(failover): stop retrying assistant-prefill format failures | 3f04632448 fix(agents): enforce idle timeout during stream setup |

## All High Findings

| Commit | Area | Decision | Finding | Local note |
| --- | --- | --- | --- | --- |
| 538605f | Codex/OpenAI/model-routing | blocker | [codex] Extract filesystem safety primitives (#77918) | follow-up commits present; still requires smoke |
| 057d3a4 | core/gateway | local-smoke-required | feat(mantis): capture logged-in discord web evidence | follow-up commits present; still requires smoke |
| 90b69ca | Google/Gemini | blocker | test(perf): slim channel directory contracts | follow-up commits present; still requires smoke |
| 5f60479 | core/gateway | blocker | fix: scope async model runtime hooks | follow-up commits present; still requires smoke |
| 3a901b5 | Codex/OpenAI/model-routing | blocker | Revert "Install Codex plugin on OpenAI model selection (#78799)" (#78878) | follow-up commits present; still requires smoke |
| 7ad53ce | core/gateway | blocker | fix(ci): account for canvas a2ui deps | follow-up commits present; still requires smoke |
| dd09e6f | inactive/unused channel or provider | no-direct-local-impact | fix(arcee): disable tools for Trinity thinking | inactive locally |
| 84dd9c7 | core/gateway | blocker | fix(gateway): fail closed for trusted-proxy auth | follow-up commits present; still requires smoke |
| 07b972c | CI/release/test-only | blocker | test: tighten backup manifest callback assertions | follow-up commits present; still requires smoke |
| 398dd6e | core/gateway | blocker | fix(failover): stop retrying assistant-prefill format failures | follow-up commits present; still requires smoke |

## All Medium Findings

| Commit | Area | Decision | Finding | Local note |
| --- | --- | --- | --- | --- |
| 58c4f9e | core/gateway | local-smoke-required | fix: slack keep resumed sends in thread (#77620) | follow-up commits present; smoke/review needed |
| d02fbc6 | core/gateway | local-smoke-required | fix(sandbox): support Windows drive-letter bind sources | follow-up commits present; smoke/review needed |
| 2de0113 | core/gateway | local-smoke-required | test(update): cover authenticated restart updates | follow-up commits present; smoke/review needed |
| f126f72 | core/general | local-smoke-required | fix(windows): resolve Gmail helper PATHEXT shims | follow-up commits present; smoke/review needed |
| 1c924c3 | inactive/unused channel or provider | no-direct-local-impact | ci: link Mantis status reaction videos | inactive locally |
| ea791b3 | core/gateway | local-smoke-required | fix: prune orphan session artifacts | follow-up commits present; smoke/review needed |
| 5a0d6c7 | PLUR1BUS/memory | plur1bus-smoke-required | fix(gateway): keep reset and refresh paths responsive (#77701) | follow-up commits present; smoke/review needed |
| 5fae1c3 | core/gateway | local-smoke-required | fix(plugins): forward install records to channel catalog registry (#77269) | follow-up commits present; smoke/review needed |
| 35da7d2 | Codex/OpenAI/model-routing | local-smoke-required | refactor: remove legacy agent dir resolver | follow-up commits present; smoke/review needed |
| 84e8e09 | core/gateway | local-smoke-required | Add WhatsApp live QA lane (#77704) | follow-up commits present; smoke/review needed |
| 79dd65e | Google/Gemini | local-smoke-required | feat(voice-call): improve realtime Meet voice agent | follow-up commits present; smoke/review needed |
| d94e7f5 | core/gateway | local-smoke-required | fix(discord): show reasoning text in progress drafts (#78050) | follow-up commits present; smoke/review needed |
| b3ab3cd | core/gateway | local-smoke-required | fix(agents): filter runtime context from context engines | follow-up commits present; smoke/review needed |
| 67fe209 | inactive/unused channel or provider | no-direct-local-impact | ci(mantis): add discord thread attachment workflow | inactive locally |
| 0022c28 | inactive/unused channel or provider | no-direct-local-impact | ci(mantis): fix discord thread workflow paths | inactive locally |
| bca6709 | Codex/OpenAI/model-routing | local-smoke-required | fix(doctor): repair legacy Codex route config | follow-up commits present; smoke/review needed |
| 466f718 | core/gateway | local-smoke-required | feat: wire talk handoff into native nodes | follow-up commits present; smoke/review needed |
| 9e6f38f | Google/Gemini | local-smoke-required | feat: unify browser realtime talk clients | follow-up commits present; smoke/review needed |
| f1636d5 | core/gateway | local-smoke-required | refactor: unify talk session runtime | follow-up commits present; smoke/review needed |
| 2016331 | PLUR1BUS/memory | plur1bus-smoke-required | fix: resolve fs-safe post-land fallout | follow-up commits present; smoke/review needed |
| 8294229 | PLUR1BUS/memory | plur1bus-smoke-required | test: refresh fs-safe boundary expectations | follow-up commits present; smoke/review needed |
| 6ad601d | CI/release/test-only | release/build-risk | test: align archive hardlink guard expectation | follow-up commits present; smoke/review needed |
| 36df0d9 | core/gateway | local-smoke-required | fix: repair iOS LAN pairing | follow-up commits present; smoke/review needed |
| 3110c62 | core/gateway | local-smoke-required | fix(gateway): preserve mixed assistant history text | follow-up commits present; smoke/review needed |
| ebb8bed | PLUR1BUS/memory | plur1bus-smoke-required | fix: cap memory wiki filenames for safe writes | follow-up commits present; smoke/review needed |
| 5d7262c | Telegram | local-smoke-required | test: align telegram reply assertions with streaming defaults | follow-up commits present; smoke/review needed |
| 7544bee | core/gateway | local-smoke-required | fix: preserve embedded dispatcher timeouts | follow-up commits present; smoke/review needed |
| 5e05052 | core/gateway | local-smoke-required | fix(line): require wildcard for open dm policy | follow-up commits present; smoke/review needed |
| 95fd321 | core/gateway | local-smoke-required | test: mock web provider fast-path artifacts | follow-up commits present; smoke/review needed |
| e59890e | core/gateway | local-smoke-required | test: speed up gateway cron history case | follow-up commits present; smoke/review needed |
| 58f81b0 | Codex/OpenAI/model-routing | local-smoke-required | fix(codex): honor OAuth contextTokens in native harness | follow-up commits present; smoke/review needed |
| 329580c | core/gateway | local-smoke-required | fix(onboard): recover externalized channel plugin from stale config (#78328) | follow-up commits present; smoke/review needed |
| a1b49c4 | Google/Gemini | local-smoke-required | fix: stabilize google meet twilio joins | follow-up commits present; smoke/review needed |
| e2501b2 | Google/Gemini | local-smoke-required | fix(diagnostics): export Talk metrics after SDK refactor | follow-up commits present; smoke/review needed |
| a24d5fe | core/gateway | local-smoke-required | perf(config): avoid duplicate plugin auto-enable channel probes | follow-up commits present; smoke/review needed |
| e437763 | core/gateway | local-smoke-required | fix(agents): deliver agent TTS audio when block streaming is off (#78355) | follow-up commits present; smoke/review needed |
| 1c29156 | core/gateway | local-smoke-required | fix: recognize custom compaction conversation (#78390) | follow-up commits present; smoke/review needed |
| 71a6260 | Google/Gemini | local-smoke-required | fix(googlechat): remove duplicate channel import | follow-up commits present; smoke/review needed |
| 4647400 | core/gateway | local-smoke-required | fix(discord): default to progress previews | follow-up commits present; smoke/review needed |
| 6aafdf1 | core/gateway | local-smoke-required | fix(cron): repair bad persisted model sentinels (#78641) | follow-up commits present; smoke/review needed |
| c385361 | CI/release/test-only | release/build-risk | ci: add runner fallback timing telemetry | follow-up commits present; smoke/review needed |
| b6ae0b8 | Telegram | local-smoke-required | fix(telegram): honor access group allowlists | follow-up commits present; smoke/review needed |
| 372e270 | core/gateway | local-smoke-required | fix(delivery): require outbound send result for success | follow-up commits present; smoke/review needed |
| a74894a | core/gateway | local-smoke-required | fix(agents): fail fast on session lock fallback (#78633) | follow-up commits present; smoke/review needed |
| 440111f | Telegram | local-smoke-required | fix(telegram): keep polling watchdog on getUpdates liveness (#78646) | follow-up commits present; smoke/review needed |
| 7d5d01b | core/gateway | local-smoke-required | chore(deps): bump @openclaw/fs-safe pin to 3412e03 (#78670) | follow-up commits present; smoke/review needed |
| 447182a | Telegram | local-smoke-required | fix(telegram): avoid fallback after message tool send (#78726) (thanks @neeravmakwana) | follow-up commits present; smoke/review needed |
| 32c1356 | core/general | local-smoke-required | fix(cli): normalize heic model-run files | follow-up commits present; smoke/review needed |
| c22f414 | Codex/OpenAI/model-routing | local-smoke-required | fix(codex): keep app-server alive after turn activity | follow-up commits present; smoke/review needed |
| 1235f7f | core/gateway | local-smoke-required | perf: reuse compatible auto-enable metadata | follow-up commits present; smoke/review needed |
| 16b0a62 | Telegram | local-smoke-required | perf(reply): avoid queue churn in dedupe paths | follow-up commits present; smoke/review needed |
| a35067f | core/gateway | local-smoke-required | fix(media): avoid provider listing for exact media defaults | follow-up commits present; smoke/review needed |
| d4e04f3 | core/gateway | local-smoke-required | fix(sessions): retire stale direct dm rows after dmscope changes | follow-up commits present; smoke/review needed |
| 330ba1f | core/gateway | local-smoke-required | refactor: move canvas to plugin surfaces | follow-up commits present; smoke/review needed |
| 1dd9a15 | core/gateway | local-smoke-required | fix: preserve deferred channel setup contracts | follow-up commits present; smoke/review needed |
| 66b02c9 | core/general | local-smoke-required | fix: build canvas assets for docker package build | follow-up commits present; smoke/review needed |
| 8e17910 | Codex/OpenAI/model-routing | local-smoke-required | fix: treat aws sdk auth profiles as config metadata | follow-up commits present; smoke/review needed |
| e1fec3c | core/gateway | local-smoke-required | fix(config): remove core BlueBubbles schema (#78612) | follow-up commits present; smoke/review needed |
| b165c0d | core/general | local-smoke-required | fix(ci): restore main validation | follow-up commits present; smoke/review needed |
| f2bf925 | core/gateway | local-smoke-required | fix: guard sandbox move cleanup identity | follow-up commits present; smoke/review needed |
| 01dd593 | core/gateway | local-smoke-required | test: stabilize prompt snapshot plugin tools | follow-up commits present; smoke/review needed |
| 772034d | Codex/OpenAI/model-routing | local-smoke-required | fix: strip tools for no-tool completions models | follow-up commits present; smoke/review needed |
| a852619 | core/general | local-smoke-required | fix(cli): fall back to sips for HEIC infer inputs | follow-up commits present; smoke/review needed |
| 3a89e20 | core/general | local-smoke-required | fix(infra): support hardlink-safe package moves | follow-up commits present; smoke/review needed |
| 9b279ef | core/gateway | local-smoke-required | fix(agents): reclaim reported stale session locks | follow-up commits present; smoke/review needed |
| dd0a9bf | CI/release/test-only | release/build-risk | lint: replace raw socket guard with codeql | follow-up commits present; smoke/review needed |
| c97998c | core/gateway | local-smoke-required | chore(channels): remove bluebubbles bundled surface | follow-up commits present; smoke/review needed |
| fa8a855 | CI/release/test-only | release/build-risk | ci(release): create GitHub release during publish | follow-up commits present; smoke/review needed |
| 5a4676b | core/gateway | local-smoke-required | fix(byteplus): align Kimi catalog metadata | follow-up commits present; smoke/review needed |
| 3683559 | inactive/unused channel or provider | no-direct-local-impact | feat: log discord voice transcripts | inactive locally |
| f3c9203 | Codex/OpenAI/model-routing | local-smoke-required | fix(mistral): normalize structured completion content | follow-up commits present; smoke/review needed |
| e29f4ff | Telegram | local-smoke-required | fix: keep npm telegram e2e on package runtime | follow-up commits present; smoke/review needed |
| 029ca8c | core/gateway | local-smoke-required | feat(agents): implement state-aware failover and lane suspension | follow-up commits present; smoke/review needed |
| 83aad86 | core/gateway | local-smoke-required | Clarify exec filesystem policy drift (#79153) | follow-up commits present; smoke/review needed |
| 2265786 | Codex/OpenAI/model-routing | local-smoke-required | fix(agents): enable codex for openai overrides | follow-up commits present; smoke/review needed |
| e259751 | core/gateway | local-smoke-required | feat(imessage): private-API support via imsg JSON-RPC [AI-assisted] (#78317) | follow-up commits present; smoke/review needed |
| b1eedb2 | core/gateway | local-smoke-required | Add ACP session load event ledger (#79093) | follow-up commits present; smoke/review needed |
| f62618f | Codex/OpenAI/model-routing | local-smoke-required | fix: respect Codex requirements for app-server defaults (#79151) | follow-up commits present; smoke/review needed |
| fe79d85 | core/gateway | local-smoke-required | feat(imessage): add native imsg message actions | follow-up commits present; smoke/review needed |
| 6eae017 | core/gateway | local-smoke-required | fix(agents): route pi default streams through transport (#79201) | follow-up commits present; smoke/review needed |
| 02fe0d8 | Codex/OpenAI/model-routing | local-smoke-required | Keep OpenAI Codex migrations on automatic runtime routing (#79238) | follow-up commits present; smoke/review needed |
| c307a61 | core/gateway | local-smoke-required | feat(reply): add reply-chain prompt context | follow-up commits present; smoke/review needed |
| ac75d6f | core/general | local-smoke-required | fix(reply): render hydrated reply chain in inbound prompt | follow-up commits present; smoke/review needed |
| 10bbed8 | Telegram | local-smoke-required | fix(telegram): chain over-limit stream previews | follow-up commits present; smoke/review needed |
| c238a51 | Google/Gemini | manual-review | fix(config): keep Gemini 3.1 model writes canonical | follow-up commits present; smoke/review needed |
| 5534233 | CI/release/test-only | release/build-risk | test: tighten qa channel media context assertion | follow-up commits present; smoke/review needed |
| b0f481b | core/gateway | local-smoke-required | test: tighten web provider fast path assertions | follow-up commits present; smoke/review needed |
| 631c655 | PLUR1BUS/memory | plur1bus-smoke-required | test: tighten memory watcher manager assertions | follow-up commits present; smoke/review needed |
| 2844eb0 | inactive/unused channel or provider | no-direct-local-impact | test: tighten openrouter video assertions | inactive locally |
| 17c57b7 | PLUR1BUS/memory | plur1bus-smoke-required | test: tighten memory multimodal assertions | follow-up commits present; smoke/review needed |
| f8187ca | Google/Gemini | manual-review | fix: canonicalize gemini configured catalog ids | follow-up commits present; smoke/review needed |
| 68f9710 | core/general | local-smoke-required | Relay ACP exec approval permissions | follow-up commits present; smoke/review needed |
| c6d4f1f | core/gateway | local-smoke-required | fix(runtime): preserve reviewed routing and transcript behavior (#79076) | follow-up commits present; smoke/review needed |
| 3ba2ce6 | core/gateway | local-smoke-required | fix(plugins): avoid managed npm prefix on Windows | follow-up commits present; smoke/review needed |
| ebd59f1 | core/general | local-smoke-required | fix(cli): clarify startup failures | follow-up commits present; smoke/review needed |
| 146ca95 | CI/release/test-only | release/build-risk | test: dedupe openshell mirror absence assertions | follow-up commits present; smoke/review needed |
| ad943ec | core/gateway | local-smoke-required | fix(cli): guide auth and gateway setup errors | follow-up commits present; smoke/review needed |
| e45b9d7 | core/gateway | local-smoke-required | fix(cli): clarify remaining required options | follow-up commits present; smoke/review needed |
| 00a44b0 | core/gateway | local-smoke-required | fix(gateway): preserve active agent dedupe retries | follow-up commits present; smoke/review needed |
| b30ead9 | core/gateway | local-smoke-required | fix: hide subagent announce handoff prompts (#79618) | follow-up commits present; smoke/review needed |
| 3af8148 | Google/Gemini | local-smoke-required | fix(google): retry stalled Gemini first response (#79668) | follow-up commits present; smoke/review needed |
| 2945948 | core/gateway | local-smoke-required | feat(gateway): add SDK task ledger RPCs (#74847) | follow-up commits present; smoke/review needed |
| 311e460 | Codex/OpenAI/model-routing | local-smoke-required | feat: unify model catalog registration | follow-up commits present; smoke/review needed |
| 7cfa12f | core/gateway | local-smoke-required | feat: inject runtime model identity into prompts | follow-up commits present; smoke/review needed |
| b621663 | Codex/OpenAI/model-routing | local-smoke-required | fix: annotate message-tool-only replies in Codex tool spec | follow-up commits present; smoke/review needed |
| 089d777 | core/general | local-smoke-required | fix(markdown): trim blockquote separator spans | follow-up commits present; smoke/review needed |
| 49db190 | PLUR1BUS/memory | plur1bus-smoke-required | fix(memory): verify qmd conflict before rebind | follow-up commits present; smoke/review needed |
| cc4a596 | Codex/OpenAI/model-routing | local-smoke-required | fix(discord): make realtime barge-in guard tunable | follow-up commits present; smoke/review needed |
| 7236d64 | core/gateway | local-smoke-required | fix(agents): classify stream_read_error as transient (#79692) | follow-up commits present; smoke/review needed |
| 8d70f7e | core/gateway | local-smoke-required | feat(mistral): add mistral-medium-3-5 model with reasoning support | follow-up commits present; smoke/review needed |
| cfb0c34 | core/gateway | local-smoke-required | feat: add realtime consult overrides | follow-up commits present; smoke/review needed |
| 8f56484 | core/gateway | local-smoke-required | chore: remove stale unused imports | follow-up commits present; smoke/review needed |
| 0a09a8f | Codex/OpenAI/model-routing | local-smoke-required | fix: propagate image generation SSRF policy (#79765) (thanks @hclsys) | follow-up commits present; smoke/review needed |
| 5618a8f | core/gateway | local-smoke-required | feat: allow trusted skill symlink targets | follow-up commits present; smoke/review needed |
| 8e0486c | Codex/OpenAI/model-routing | local-smoke-required | fix: honor Codex dynamic tool timeouts | follow-up commits present; smoke/review needed |
| d44aeb6 | Telegram | local-smoke-required | fix(telegram): mirror outbound replies to session transcript | follow-up commits present; smoke/review needed |
| aecd4fb | inactive/unused channel or provider | no-direct-local-impact | fix(feishu): keep group_topic message-tool replies inside the topic (#77151) | inactive locally |
| aeb7d07 | core/gateway | local-smoke-required | fix(cli-runner): gate raw transcript reseed | follow-up commits present; smoke/review needed |
| d1e40ca | core/gateway | local-smoke-required | test: skip disabled bundled facade resolution | follow-up commits present; smoke/review needed |
| 480af03 | Codex/OpenAI/model-routing | local-smoke-required | fix(codex): mirror tool calls in transcripts (#79952) | follow-up commits present; smoke/review needed |
| af9badd | core/gateway | local-smoke-required | fix(release): align beta plugin install expectations | follow-up commits present; smoke/review needed |
| 35f63f2 | core/gateway | local-smoke-required | fix(macos): read typed gateway error frames | follow-up commits present; smoke/review needed |
| b1f333d | Codex/OpenAI/model-routing | local-smoke-required | fix(release): harden OpenAI installer proof lane | follow-up commits present; smoke/review needed |
| aaeb64b | CI/release/test-only | release/build-risk | test(release): update Docker smoke command assertion | follow-up commits present; smoke/review needed |
| 0496063 | CI/release/test-only | release/build-risk | build(deps): refresh workspace dependency pins | follow-up commits present; smoke/review needed |
| dff4a04 | core/gateway | local-smoke-required | feat(signal): support container REST API | follow-up commits present; smoke/review needed |
| 175c42e | Telegram | local-smoke-required | fix(telegram): tighten select callback handling | follow-up commits present; smoke/review needed |
| e60928d | core/gateway | local-smoke-required | ci: verify and sync website installers (#80067) | follow-up commits present; smoke/review needed |
| 83a1080 | core/gateway | local-smoke-required | fix: canonicalize embedded reply payloads | follow-up commits present; smoke/review needed |
| f83dbbc | inactive/unused channel or provider | no-direct-local-impact | fix(discord): prevent realtime answer replacement | inactive locally |
| 57020da | core/gateway | local-smoke-required | fix(agents): drop unsupported anthropic thinking replay | follow-up commits present; smoke/review needed |
| 207bcd6 | core/general | local-smoke-required | fix(installer): persist Linux supported PATH | follow-up commits present; smoke/review needed |
| 86b53aa | Telegram | local-smoke-required | fix(telegram): suppress silent-reply rewrite in DM no-response turns (#78188) | follow-up commits present; smoke/review needed |
| dafbdb6 | core/general | local-smoke-required | fix: preserve shared macOS and CLI device identities | follow-up commits present; smoke/review needed |
| 2e495b0 | core/gateway | local-smoke-required | Preserve provider wildcard allowlist intent | follow-up commits present; smoke/review needed |
| 743413a | Codex/OpenAI/model-routing | local-smoke-required | fix: preserve auth profiles for one-off model overrides | follow-up commits present; smoke/review needed |
| 8c49121 | core/gateway | local-smoke-required | fix(models): preserve explicit provider fallback selection | follow-up commits present; smoke/review needed |
| 572dd67 | core/gateway | local-smoke-required | fix(models): repair provider-wrapped session overrides | follow-up commits present; smoke/review needed |
| 2f8cb86 | CI/release/test-only | release/build-risk | ci: skip symlinks in opengrep changed scan (#79930) | follow-up commits present; smoke/review needed |
| a13d569 | inactive/unused channel or provider | manual-review | fix(browser): use OpenClaw temp dir for Chromium state | follow-up commits present; smoke/review needed |
| de186a8 | core/gateway | local-smoke-required | fix(security): honor model tool denies in audit | follow-up commits present; smoke/review needed |
| b27bae3 | Google/Gemini | local-smoke-required | fix(google): default gemini onboarding to 3.1 pro | follow-up commits present; smoke/review needed |

## Counts

- area:CI/release/test-only: 10
- area:Codex/OpenAI/model-routing: 20
- area:Google/Gemini: 10
- area:PLUR1BUS/memory: 7
- area:Telegram: 10
- area:core/gateway: 74
- area:core/general: 12
- area:inactive/unused channel or provider: 9
- decision:blocker: 8
- decision:local-smoke-required: 117
- decision:manual-review: 3
- decision:no-direct-local-impact: 8
- decision:plur1bus-smoke-required: 7
- decision:release/build-risk: 9
- high: 10
- medium: 142
- total: 152

## Required remediation before beta test install

1. Add a dedicated 2026.5.10-beta.1 compat branch/script instead of extending the 2026.5.4-2026.5.7 patch blindly.
2. Rework active-memory patch anchors around the new `shouldCacheResult` behavior and re-run `node --check` over active-memory plus runner files.
3. Snapshot and diff `/root/.openclaw/openclaw.json` before any beta dry-run that invokes `doctor --fix`; verify Codex/OpenAI auth routes are preserved.
4. Run fs-safe mutation smoke with the beta dependency pin before live install.
5. Run PLUR1BUS gates after patched tarball install in a throwaway prefix: `memory-doctor provider-check`, memory startup, QMD search, and active-memory recall fallback.
6. Probe gateway trusted-proxy auth over the local/Tailscale caller path.

## Raw artifacts

- `/tmp/openclaw-2026.5.10-beta.1-clawsweeper.clean.txt`
- `/tmp/openclaw-2026.5.10-beta.1-high-medium-analysis.json`
- `/tmp/openclaw-beta-2026510-check-iJbQyP/package`

# Jev emotion and congruent speech implementation plan

This implements the user's approved German plan from 2026-10-25. The following constraints are normative; task interfaces settle implementation details without changing that plan.

## Global Constraints

- Scope: shared EmotionalState for main, bernhardine and heisenberg; expressive speech only Telegram /sabbel. Keep native TTS, Discord, STT, existing enable flags, fixed speakers and bilingual DE/PL files unchanged.
- Priority: actual outgoing meaning/intent, then compatible delivery, then subordinate persona/mood coloring. Never mirror a user's emotion automatically onto the agent.
- Jev: reuse resolveJevApiKey and existing endpoint/model conventions. One incoming and one outgoing batched request, hard deadline 1000 ms including body parsing, no retries. Abort/late/malformed/low-confidence results fail open. No new dependencies.
- Incoming: currentUserMessage and stable currentUserMessageId from host, at most two prior authored user/assistant messages, persona and mood; exclude internal/background/subagent/incognito/denied workspace inputs. Do not analyze tool output, memory injections or whole assembled prompts.
- One owner per agent, atomic persistence, stable event dedupe, serialized commits, no stale/aborted updates. No feedback from outgoing speech decisions. Existing recall weights and stored memory emotion are unchanged.
- Mood: real elapsed time; approach half-life 300000 ms, each observation active at most 120000 ms, then baseline decay. Passive half-lives: surprise120000; fear/anger900000; joy/anticipation1800000; sadness/disgust2700000; trust3600000. Existing sensitivity/baseline and decayMultiplier retained.
- Speech: canonical sanitized text <=2000 Unicode code points including ellipsis; classify this exact text, never rewrite/reclip afterward. Provider tags are separately validated metadata. Literal bracket directives without safe escaping cause text-only failure rather than execution.
- Repository AGENTS.md applies: JSDoc for exports, safeAgentId, resolveInside for file IO, validateInput for text, no silent catches or swallowed promises. Never log credentials or conversation text. Test first and record RED/GREEN evidence.
- Work on feat/jev-emotion-speech in the already isolated /root/plur1bus-dev-afterthought-jev worktree. Do not modify the old main checkout. Runtime deployment occurs only after offline and live checks; user explicitly authorized backup, shadow verification and activation.

## Review Focus

- Replayed hooks and simultaneous same-agent conversations must not share a mutable latest-context slot or multiply mood changes.
- A hostile/raw provider tag must never bypass the structured audio renderer.
- A slow fetch implementation/body parser must not defeat the hard deadline or mutate state after cancellation.
- Missing DB, short messages or disabled recall must not disable the new independent mood hook.
- Updating current mood changes existing recall inputs intentionally, but cannot change recall weights or retroactively write memory-emotion data.

### Task 1: Jev assessment and pure speech preparation

Create lib/jevEmotion.js, lib/speechRegie.js, lib/speechText.js and focused tests. Do not edit runtime hooks, state class or live files.

Interfaces:
- createJevEmotionAssessor(options) returns async assess({text,context=[],persona='',mood={},signal}); options apiKey,model,timeoutMs(default1000),fetchImpl,logger. Return {ok,reason?,elapsedMs,sections,reaction,confidence}. reaction is the 8-dimension finite [0,1] agent reaction vector, NOT the observed user vector. sections include observed/reaction vectors and sourceKind (own,quoted,reported,ironic,uncertain). Unknown fields are ignored/rejected, never instructions.
- createJevSpeechPlanner(same options) returns async plan({versions:[{id,text}],context=[],persona='',mood={},signal}); return {ok,reason?,elapsedMs,versions:[{id,text,segments:[{start,end,intent,delivery,action,confidence}]}]}. Indices use Unicode code points and cover original text without rewriting. For DE/PL, one request and correlated semantic delivery; unsupported/uncertain correspondence uses neutral rather than forced incompatible sharing.
- prepareSpeechText(text,{maxChars=2000}={}) -> {text,blocked,reason?}; remove thinking/reasoning blocks, transport directives, code fences/markup that should not be voiced, trim; keep words and language, cap at a word boundary incl ellipsis, never exceed codepoint cap. Empty input yields empty. Raw bracket direction blocks => blocked (conservative all nonnumeric brackets allowed to block).
- renderSpeechPlan(versionPlan) -> string with only closed-list provider audio tags inserted; preserve source words exactly. Unknown/crossing/gapped spans => neutral exact original text, never accept arbitrary tag strings.
- Export constants for dimensions/intents/deliveries/actions, and validate responses strictly. Default confidence floor .7. Suggested deliveries neutral,warm,serious,firm,cheerful,soft,thoughtful,playful,excited,sad,whispering,shouting; actions none,laugh,chuckle,sigh,gasp. Serious criticism cannot cheerful/laugh; praise cannot sad; empathy cannot gleeful. Explicit recognized humor/irony may justify comic delivery; a bare emotion word is not permission for a nonverbal action.

Use Jev Score questions with concrete ordered criteria (0..4) for strength and separate confidence; Choice for sourceKind/intent/delivery/actions. Batch all questions; bound input to16000 codepoints and at most12 merged whole-text sections (do not silently omit tail). Validate context array roles and use only last2 authored messages. Whole/section aggregation is bounded normalized mean, not sum. Low confidence on uncertain actor/reaction -> ok:false so it cannot move mood. Speech uncertainty -> neutral text.

- [ ] Add failing tests for own vs quoted/reported affect, mixed dimensions, incoming/outgoing schema, multilingual sections, canonical excerpt/Unicode, deadline/body parsing, no retries, forged tags/word changes and congruence opposite mood/text.
- [ ] Run RED, implement, run GREEN. Use external transport doubles only; execute real planner/preparer/renderer behavior.
- [ ] Commit owned files and report exact exports, tests and concerns.

### Task 2: Timed shared EmotionalState

Modify lib/emotional-state.js with focused time/fake-clock tests. Consume the plain 8-vector from Task1, no network.

Interfaces:
- configureTimedMood({enabled=true,approachHalfLifeMs=300000,evidenceHoldMs=120000,passiveHalfLivesMs}={}) on EmotionalState, leaving legacy behavior unchanged when not configured/enabled.
- applyTimedEvidence(reaction,{eventId,observedAt,now=Date.now()}): boolean. Reject invalid/duplicate/stale observations. Advance prior state to now, then replace active target/expiry; do not blend on each call. Target preserves configured baseline/sensitivity; sustained input approaches target continuously with five-minute half-life. No evidence remains active beyond its hold period. Passive decay to baseline uses new half-lives * decayMultiplier.
- All state readers/serialization lazily advance elapsed time once; handle long idle interval by integrating the old target only until its expiry, then passive decay for remaining time. New evidence after an idle hour cannot jump mood by integrating that hour against the new target.
- serializeState version3 adds timed target/expiry and bounded dedupe data while retaining current/baseline/nuanceState/lastUpdateAt. hydrateOnce accepts v2 and validated v3, preserves current state and rejects future/nonfinite/malformed additions safely. Keep existing exports and legacy tests passing. Dedupe store max512 event ids.

- [ ] RED tests: five/ten/fifteen-minute continuous exposure; same state for same target at different event rates; first event after idle; passive per-dimension decay and temperament; repeat/older event; restart/malformed/v2 migration; legacy behavior unaffected.
- [ ] Implement, run targeted GREEN and existing emotional state/pool/recall tests.
- [ ] Commit owned files and report.

### Task 3: Independent hook owner, configuration and run-bound context

Create lib/jevEmotionRuntime.js, tests; integrate into index.js and plugin config/schema. Modify mood-style-directive and the shipped standalone emotional injector only to avoid duplicate/conflicting guidance for enabled agents. Do not change memory capture emotion inference or recall weights.

Expose createJevEmotionRuntime({api,config,emotionalPool,assessor,isEligible,now,logger}) returning beforePrompt(event,ctx),resolveExecEnv(event,ctx),endRun(event,ctx),isEnabled(agentId). Bind in index.js before the heavy recall handler and outside autoRecall gates. Existing identity/workspace/internal/background/incognito policies remain authoritative. New config emotion.jev = {enabled:false,agents:{main:false,bernhardine:false,heisenberg:false},mode:'shadow'|'active',timeoutMs:1000,approachHalfLifeMs:300000,evidenceHoldMs:120000,passiveHalfLivesMs:{...}}; use captureChunkingJev credential/model options (no new credential). Config normalized by the existing inline parser in index.js and schema in openclaw.plugin.json; no parallel config module.

Runtime behavior:
- Current authored message from event.currentUserMessage; only use a safe legacy prompt fallback when host event proves it is the direct message. Require stable admission identity+session identity for persistent state changes; missing identity can assess for context but cannot write mood. Use runId for per-run isolation and cancellation, currentUserMessageId for retry dedupe.
- Invoke Jev once per incoming event (coalesce replayed hooks); parallel network is allowed but state commit serialized per agent. Re-check lifecycle, timestamp order, workspace and authority at commit. External call outside DB transactions. In active mode configure/advance shared state; no second legacy per-turn update or legacy state-file writer. Shadow mode only assesses/logs decisions and leaves existing state writer authoritative.
- Persist .emotional-state.json and .current-mood.txt atomically after accepted updates; actual text only in private ephemeral per-run context, not persisted mood/evidence logs. Mode0600 private files and0700 dirs. No replacement state or unrelated vault mutation.
- One congruent mood directive, including ephemeral current reaction only on its own run. Existing state is background; current meaning/intent has priority. Separate standalone injector skips enabled active agents and preserves behavior for all others.
- resolve_exec_env exports PLUR1BUS_SPEECH_CONTEXT_FILE and PLUR1BUS_SPEECH_RUN_ID (no keys/text in environment) for matching agent/session/run only. Per-run snapshot includes version1,agentId,runId,sessionId,createdAt,expiresAt(+15min),mood,persona,context(last2). Path under workspace .plur1bus/speech-context/<hashed-run>.json, resolved inside. Create/refresh only for correct live run. Remove at terminal lifecycle and invalidate/abort on session changes; late callbacks cannot revive it. No latest-by-agent fallback.

- [ ] RED tests real handler behavior for disabled recall/DB failure/short input, exclusion policies, stable dedupe, overlap and out-of-order network completion, abort/no late commit, runtime state persistence, shadow vs active, run-bound env/context and terminal cleanup, congruent prompt/injector.
- [ ] Implement, targeted GREEN; run relevant existing config/identity/workspace/background tests. Update config docs.
- [ ] Commit owned files, report handoff contract for Task4.

### Task 4: Shared Telegram speech adapter and controlled rollout artifacts

Consume Task1 planner/preparer/renderer and Task3 run context. Add scripts/plan-speech.mjs (JSON stdin/stdout; supports versions and explicit agentId; no shell interpolation) and version-controlled deployment artifacts under scripts/telegramTts/. Copy currently installed Python helper/wrappers as initial artifacts, then change only ElevenLabs path. Add Python/subprocess integration tests under tests (node test invokes them or equivalent) so npm test covers them.

Adapter loads current plugin configuration safely, same Jev resolver, feature scope/mode. Validate allowlisted agent, run binding/expiry/path/private context. Missing/stale context uses conservative final-text-only planning; never borrow another run. One invocation for bilingual versions snapshots once, generates one combined plan, renders per-language with fixed voice. Active applies tags, shadow records only decisions and sends canonical neutral text. Disabled feature preserves established behavior. Adapter never updates mood. No native speech-provider edits.

Keep /sabbel external commands and OK:/OK_DE:/OK_PL: stdout contracts. Thread explicit agent into generator/helper. Canonical text preparation occurs before outgoing Jev; no subsequent clipping/punctuation insertion changes it. Extend Python helper for validated prepared payload (text/annotated speech separate, bounded tags; standard say backward compatible); preserve fixed model/voice selection, output validation and no speaker fallback on ElevenLabs error. Never expose API key in argv/logs. Do not introduce new service/server.

Include a narrowly scoped idempotent host compatibility patch for resolve_exec_env: forward trusted ctx.runId ?? defaults.runId and ctx.workspaceDir, preserving hook result/other behavior. Keep missing identity fail-closed. Test against copied host fixtures and integrate with the existing apply-media-patch persistence entrypoint; controller applies after backup. Add new runtime modules/scripts to scripts/lib/deploy-integrity.mjs DEPLOY_FILES.

Add a reproducible deploy script/dry-run mapping artifact files to the3 workspace wrappers and shared helper, preserves existing toggle JSONs, backs up only affected files/state/config, validates configs and supports targeted rollback. User authorized deployment and active flags for all3 after successful shadow/live acceptance. Native tts/talk/Discord/STT config must remain byte-equivalent except any unrelated current operator changes are preserved. Update repository configuration docs and the3 runtime skill reference instructions consistently after verification.

- [ ] RED integration tests exact rendered payload and actual wrappers: all3 agent identities, disabled state, Unicode/cap incl ellipsis, raw tags text-only, no reclip, missing/forged/stale context, Jev timeouts, failed synth/conversion, partial bilingual success, combined planner call and same speaker/compatible DEPL decisions, no stdout contamination or secrets.
- [ ] Implement, targeted GREEN and existing /root/.openclaw/tests/tts-routing.test.py (copied/isolated fixtures; do not mutate live state in tests).
- [ ] Commit source artifacts/tests/docs and hand controller rollout instructions; do NOT deploy live from subagent.

### Task 5: Acceptance-discovered confidence granularity refinement (execute after Task3, before Task4)

Live evidence is in /tmp/jev-semantic-calibration.md, /tmp/jev-semantic-experiment.md, /tmp/jev-incoming-final-experiment.md and their exact experimental contract modules. Old all-or-nothing validation vetoed clear agent joy (.97 confidence) and empathetic sadness (.90) because unrelated reaction dimensions or observed affect were uncertain. Do not lower the .70 threshold. This task refines implementation details to fulfill the approved per-dimension uncertainty requirement; no new model, credential, store or memory emotion updates.

Own lib/jevEmotion.js, lib/speechRegie.js, lib/emotional-state.js, the narrow runtime handoff in lib/jevEmotionRuntime.js, and focused tests/docs. Keep all existing external exports/legacy behavior compatible.

- Use tested fictional software persona/state framing and concrete dimension-specific event rubrics from /tmp/jev-incoming-final-contract-complete.mjs. Source kind own denotes the current author's direct assertion/appraisal/question including neutral/denied affect; it does not require the author to explicitly report a feeling. Do not mirror user/quoted emotion into agent reaction.
- Validate all Score fields strictly numeric finite/ranged but retain raw score confidence separately. Invalid/missing fields still fail the whole assessment. Observed affect confidence remains diagnostic. A reaction dimension is known only when source attribution and that dimension's reaction scores meet .70 for every contributing section; otherwise it is explicitly unknown for this message. Aggregate known dimensions once by the existing bounded whole-text weighted mean. Return reactionDimensions (closed unique dimension names), section observedConfidence/reactionConfidence maps, and reaction with existing finite eight-vector shape for compatibility. Numeric placeholders for unknown dimensions must NEVER be consumed as evidence. No known dimensions yields ok:false; confidence is min among admitted source/reaction decisions. Unknown emotion is not zero emotion.
- Extend applyTimedEvidence(reaction,{eventId,observedAt,now,dimensions}) with optional dimensions (default all eight for existing callers). Only named dimensions replace their active target/expiry. Others retain old active target until its original expiry, then use passive decay; a new message cannot refresh, accelerate, cancel or freeze an unknown dimension. Real elapsed time and rate independence remain exact. One event id/dedupe/admission ordering per message. Empty/invalid masks reject.
- Persist per-dimension active expiries compatibly in version3 metadata; accept old v3 single expiry as applying to all eight. Validate additions atomically and preserve current state on malformed metadata. Explicit opt-in before hydration remains mandatory. Existing v2 and legacy behavior/recall formulas stay intact. Serialization contains no text. Runtime passes reactionDimensions, and ephemeral current-reaction guidance mentions only known dimensions.
- Speech uses tested operational Choice descriptions and canonical tie rules from /tmp/jev-experimental-contract.mjs, adding a closed boundary intent for explicit limits/insistence. Meaning outranks mood. Per-section unknown intent/delivery renders neutral for that section; unknown optional nonverbal action becomes none and does not veto confident compatible delivery. No arbitrary tags or rewriting. Renderer must safely accept explicit low-confidence neutral spans without erasing valid neighboring spans; it must never render a low-confidence expressive action/delivery. Bilingual uncertainty neutralizes the corresponding semantic pair, not unrelated pairs.
- Keep one incoming/outgoing batch, hard1000ms/no retries, no new services or credentials. Do not write runtime/live configuration from this task.

- [ ] RED/GREEN regressions: strong known joy + unknown trust; uncertain observed affect + independently known reaction; no known reaction; malformed numeric metadata; selective targets do not refresh other active dimensions; rate independence/restart/v2/old-v3 metadata; uncertain action preserving playful delivery; neutral middle span resets neighboring expression; paired-language span uncertainty; word preservation/typed tags/opposite mood/boundary.
- [ ] Run focused existing assessor/state/runtime tests. Commit only owned files, ignored task-5-report.md with actual evidence. Separate task review required; then rerun real acceptance set plus independent holdout before activation. No claims based solely on model confidence.

### Task 6: Live-discovered native admitted-user forwarding compatibility

Native OpenClaw2026.10.4 omits typed currentUserMessage/currentUserMessageId in its prompt phase, despite the AgentsAPI helper exposing them. Actual native Gateway tests correctly fell back to final-text-only; no speech-context directory was created. Preserve strict input admission. Extend the existing host compatibility patch to forward the already admitted preparedUserTurnMessage through native prompt phase, assembly and the shared hook helper, projecting only authored text plus stable idempotencyKey. Never infer from effectivePrompt, previous messages, modelPromptProjection or generated identities. Preserve missing/skip/excludeFromContext/nonuser/provenance cases and existing runtime policies.

Preflight all supported host bundles before any mutation, retain exact-shape/idempotent behavior, and back up/roll back all affected bundles. Tests must execute copied actual native producer→helper→real runtime→adapter, including missing/excluded/structured/adversarial/duplicate cases. Preserve the existing trusted exec projection and per-run bridge. No new credentials, dependencies or stores. Source artifacts and targeted regressions receive an independent task review. Use immutable local prerelease7.18.32-jev.2, leaving tag.1 intact; controller updates both existing pins and performs the required additional controlled restart under the retained deploy lock. Recheck contextual shadow, real audio and preservation before activation.

## Controller final verification and deployment

- Full npm test, lint, independent whole-branch review; fix confirmed findings.
- Backup affected runtime files/config/state; deploy only explicit artifact files and changed plugin files preserving operator changes. No memory DB/schema migration.
- Enable shadow for3, verify real Jev DEPL cases including cheerful+criticism, sad+praise, empathy, humor/quotes; observe elapsed and fallback results. Generate audio artifacts for audition; inspect waveform/codec and use available audio review/transcription where feasible, report actual verification limits honestly.
- Switch3 active only after gates; keep normal /sabbel enable flags unchanged. Validate host config and gateway adoption; restart gracefully only if needed. Verify public audio pipeline again. Save metadata-only evidence and final commit ids/report. No unsolicited push/merge.

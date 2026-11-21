Decisions made while executing the approved plan, in chronological order. The costs below state the practical consequence if a decision proves wrong.

1. reuse the existing isolated linked worktree, create a new feature branch there — satisfies the approved source location and isolation without creating an extra unmanaged checkout. Cost if wrong: worktree isolation or concurrent edits could be overlooked; initial source and branch checks established the selected base.

2. no newly invented memory store or schema migration; current mood input changes are intentional, existing stored emotions and recall coefficients remain unchanged. Cost if wrong: an existing-store limitation would remain; no migration or recall coefficient change is introduced.

3. raw bracket instructions conservatively block only affected audio; no unverified provider escaping. Cost if wrong: benign bracketed passages may stay text-only; no unverified escaping can trigger provider directions.

4. external speech CLI may load only the selected Jev credential from the existing /root/.openclaw/gateway.systemd.env when explicit config and inherited environment are empty — gateway owns this EnvironmentFile, shell outside gateway lacks it; never pass credentials in argv or resolve_exec_env metadata. No new credential is created. Cost if wrong: an unsupported EnvironmentFile value format yields neutral fallback; key selection and privacy are tested.

5. Task3 configuration normalization uses the existing resolveEffectiveConfig / manifest-derived config contract, with emotion settings consumed in index.js; there is no lib/config.js. Do not add a parallel parser. Cost if wrong: CLI and gateway defaults could diverge; schema/contract tests cover it.

6. deployment will use local prerelease version/tag 7.18.32-jev.1 / v7.18.32-jev.1 (if still unused), move only the clean release worktree to that tag, and update the existing version pin. This avoids mutating a public tag or extending guard tag-selection semantics. No remote tag/release/push. Back up operations scripts; coordinate guard/deployment with one flock and install modules before index. Wrong pin could revert runtime, so validate guard+manifest after deployment.

7. installed OpenClaw2026.10.4 exec caller omits trusted runId/workspaceDir though exec defaults+tool ctx already carry them. Add minimal forwarding ctx.runId ?? defaults.runId and ctx.workspaceDir via tested idempotent deployment patch; never infer from latest agent/session or cwd. Required for approved per-run bridge, affects exec identity forwarding only. Preserve existing apply-media-patch persistence mechanism; back up and review. If patch cannot apply exactly, fail closed to final-text-only speech and report context gap. Evidence /tmp/jev-hook-preflight.md.

8. configure timed mode BEFORE hydration foractive/custom settings; explicitlydisable beforelegacy hydration. The earlier Task3 hydrate-before-configure wording is incorrect: persistedv3metadata mustnot optanunconfiguredinstance intoenabledtrajectory. Root hadrequestedbothordersonlyifcompatible; legacyopt-inrequirementwins. Costiforderingwrong: restoredtarget couldmove moodwhilefeatureoff.

9. real Jev calibration found strict min-confidence across16observed/reaction scores vetoes clearly supported independent joy/sympathy because unrelated dimensions are uncertain. Keep .70 threshold; represent uncertainty per reaction dimension, never zero-fill it into state. Unknown dimensions retain their previous trajectory/expiry without refresh, known dimensions may update. Observed user-affect confidence is diagnostic, not a veto on independently certain agent reaction. Root inserts reviewed Task5 acceptance refinement beforeTask4. This preserves the user's uncertainty/no-change requirement at the granularity actually classified. Costifwrong: granular mood could differ from whole-message rejection; fake-clock+semantic holdout mustprove no unknown-dimension mutation.

10. outgoing uncertainty degrades the specific decision/section only: uncertain action becomes none, uncertain delivery/intent neutral for that span, safe confident other spans survive; same .70 threshold. Operational disjoint criteria and boundary intent replace bare overlapping labels. Costifwrong: too much expression could survive ambiguity; opposite-mood/quote/holdout tests plus typed rendering mustgateactivation.

11. canonical sanitation/cap/no postclassification word changes apply to the ElevenLabs path even when emotion feature is disabled; disabled skips Jev/tags and preserves toggles/routing/fixed voices/model/neutral synthesis. Literal legacy clipping/punctuation behavior would violate the approved canonical invariant. Cost if wrong: disabled speech excerpts can differ at markup/length boundaries; exact-text/Unicode tests cover the deliberate correction.

12. accept final review's set-aside of general local/Edge shell-route redesign — user scoped this change to the ElevenLabs bridge and preserves existing routes; cost if wrong: unrelated pre-existing shell/local behavior remains, while all new identity/context/error paths are still reviewed and tested.

13. bounded semantic fixtures and approved auditions are the acceptance evidence, not a population/complete acoustic accuracy claim — exhaustive quality is not measurable here; cost if wrong: unseen phrasing/accents may need tuning, with uncertain model decisions neutralized and text retained.

14. preserve and separately report the existing linked-node_modules lockfile fixture failure rather than changing unrelated dependencies — user explicitly permits separate pre-existing failures; cost if wrong: a new related regression could be misclassified, so final full-source suite and failure-specific evidence remain mandatory.



Ruling: extend host compatibility patch to native admitted-user forwarding, rather than relaxing strict authored-input policy — actual native producer/helper omit typed fields while AgentsAPI provides them; current hook correctly refuses assembledprompt. Forward existing admitted recorder object/id through exactnative seams, retaining source/provenance/exclusions. Cost if wrong: unsupported hostshape mustfailclosed; actualcopiedproducer/helper→runtime→adapter tests and live native run acceptance gate deployment.

Ruling: issue local prerelease7.18.32-jev.2 for the native host compatibility correction, preserving immutablev7.18.32-jev.1 — never rewrite deployed tag; cost if wrong: both ops pins/release/testmetadata could diverge, so update/check all under held common lock. No remote publish/push.

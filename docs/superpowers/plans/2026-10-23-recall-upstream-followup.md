# Recent upstream changes — plugin follow-up

User requested that recent changes be considered after release7.18.27. Fetch revealed upstream43231366 (2026-10-20), relevant to the recall comparison: the production namespace merge and budget can undo reranker order. Main contains the standalone engine and must not be merged wholesale.

Port only this shared recall fix into the current plugin branch, adapting the engine namespace change to index.js. Keep ACL, Jev-empty handling, cache-prefix split and all configuration/model assignments. Add an equal/inconsistent-score regression beyond the upstream tests. Use the production namespace wrapper in the read-only benchmark and rerun the same30questions before choosing candidateTopK. Verify targeted/full tests, obtain an independent review, release7.18.28 through existing pins and native reload. No host upgrade or model/config reset.

Other fetched branches (provider HTTP/embedding adapters, Persona evolution, jobs and harness features) are recorded for separate work rather than implicitly installed. Active Cohere already bounds full body reads. The schicht15 recommendation8 is already set in live configuration and is preserved.

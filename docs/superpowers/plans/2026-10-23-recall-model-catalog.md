# Recall comparison and PLUR1BUS model selection

User-approved implementation plan, 2026-10-23.

1. Preserve existing explicit model assignments, permissions, mods, cache boundaries. Implement shared provider-grouped model options for chat/subagents/background/task fields, with safe catalog names, IDs and aliases. Add regression tests for grouping, duplicate names and stale selections.
2. Back up configuration. Rescan all 11 configured model providers without generation. Distinguish verified available, verified absent and not verifiable. Preserve partial failures and referenced models; correct bad labels and remove only confirmed absent/unreferenced selections. Never update routing/permissions as a side effect.
3. Compare 40/50/100 candidates with existing Cohere and 100->Jev conservative relevance filter->same Cohere. Use 30 queries (10 per agent) including continuations, indirect references and no-match questions. Preserve ACL before remote calls, output cap 15 and prompt budget. On uncertain/error/missing Jev answer retain candidate; fallback unfiltered.
4. Record relevance, lost relevant hits, latency, cost/unknown price and timeout counts. Direct reranking stays default. Increase candidate limit only for additional relevant hits inside current budget; enable Jev only without lost relevant hits and with latency/cost benefit. Tie chooses simpler path.
5. Test; independent whole-change review; fix material issues. Compare assignments before/after (Sonnet merging/dream-echo/afterthought). Release from plugin branch, no main/harness switch or host upgrade; update existing pin/release paths and hot reload.

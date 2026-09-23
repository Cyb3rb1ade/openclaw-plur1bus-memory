/**
 * tests/fixtures/golden-prefix/scenarios.js
 *
 * Eight synthetic recall scenarios. `topics` maps a fixture string to the axis
 * the stub embedder puts it on, so recall order is a property of the fixture
 * and not of a downloaded model.
 */

const AGENT = "golden-agent";
const WORKSPACE = "golden-workspace";

function ctxFor(session, run) {
  return {
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    sessionKey: `agent:${AGENT}:${session}`,
    sessionId: session,
    runId: run,
    chatId: "golden-chat",
  };
}

function eventFor(prompt, session, run) {
  return {
    prompt,
    messages: [{ role: "user", content: prompt }],
    sessionKey: `agent:${AGENT}:${session}`,
    sessionId: session,
    runId: run,
  };
}

/**
 * Bulk body text for the two `recall-large-text-records` memories. It never
 * reaches the prompt — only a record's summary does — so it exercises the
 * store, embed and ranking path with large rows, not the injection budget.
 * `recall-truncated` is the scenario that covers truncation.
 */
const FILLER = "Deployment note. ".repeat(700); // ~11 900 chars

/**
 * Only a record's *summary* reaches the prompt, capped at 400 chars by
 * `sanitizeMemoryTextForPrompt(rawDisplay, 400)` (lib/relevant-memory-context.js:122).
 * The 17 000-char budget is therefore reachable only through record *count*,
 * not through one long text. 60 records of ~350 visible chars overshoot it by
 * roughly a factor of two.
 */
const TRUNCATION_RECORD_COUNT = 60;

/**
 * A distinct ~350-char summary per record. Distinct text matters because two
 * identical summaries would collapse in the origin-key pass even with
 * `recall.dedup` off.
 * @param {number} index
 * @returns {string}
 */
function bulkSummary(index) {
  const label = String(index).padStart(2, "0");
  const body = `Rollout checkpoint ${label} covers the staged database migration, the blue-green cutover window and the agreed rollback signal. `;
  return `Runbook step ${label}: ${body.repeat(3)}`.slice(0, 350);
}

/**
 * Deterministic, fixed ids — the index is the only varying part, so a given
 * record always carries the same id across runs and machines.
 * @param {number} index
 * @returns {string}
 */
function bulkId(index) {
  return `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`;
}

const BULK_MEMORIES = Array.from({ length: TRUNCATION_RECORD_COUNT }, (_, index) => ({
  id: bulkId(index),
  text: `Rollout runbook entry ${index}. ${bulkSummary(index)}`,
  summary: bulkSummary(index),
  category: "fact",
  ageDays: 1 + (index % 30),
}));

const BULK_TOPICS = Object.fromEntries([
  ["walk me through the rollout runbook", "rollout"],
  ...BULK_MEMORIES.flatMap((memory) => [
    [memory.text, "rollout"],
    [memory.summary, "rollout"],
  ]),
]);

/** The canonical KNOWLEDGE.md used by `recall-canonical-flagged`. */
const CANONICAL_KNOWLEDGE = "# Release Policy\n\nThe project ships on Fridays and never on a public holiday.\n";

/**
 * The exact string `getKnowledgeChunks` embeds for the single section of
 * CANONICAL_KNOWLEDGE: `parseKnowledgeMd` (lib/recall-pipeline.js:812-832)
 * keeps the heading line and every following line, each with its "\n", and the
 * trailing empty line from the final split contributes one more — so the
 * section text is the file plus exactly one newline. Mapping it to the query's
 * topic gives cosine 1.0, which clears the 0.30 `canonicalMinScore` default
 * (index.js:4703) that leaves canonical empty in `recall-knowledge-canonical`.
 */
const CANONICAL_SECTION_TEXT = `${CANONICAL_KNOWLEDGE}\n`;

export const SCENARIOS = [
  {
    name: "recall-basic",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: {
      "what dashboard theme do I like": "dashboard",
      "The user prefers a navy dashboard theme.": "dashboard",
      "navy dashboard": "dashboard",
      "The release decision was made on 2026-01-02.": "release",
      "release decision": "release",
    },
    memories: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "The user prefers a navy dashboard theme.",
        summary: "navy dashboard",
        category: "preference",
        ageDays: 3,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: "The release decision was made on 2026-01-02.",
        summary: "release decision",
        category: "fact",
        ageDays: 10,
      },
    ],
    config: {},
    event: eventFor("what dashboard theme do I like", "golden-session-1", "golden-run-1"),
    ctx: ctxFor("golden-session-1", "golden-run-1"),
  },
  {
    name: "recall-empty-store",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: { "is there anything you remember": "nothing" },
    memories: [],
    config: {},
    event: eventFor("is there anything you remember", "golden-session-2", "golden-run-2"),
    ctx: ctxFor("golden-session-2", "golden-run-2"),
  },
  {
    name: "recall-knowledge-canonical",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    knowledge: "# Knowledge\n\nThe project ships on Fridays and never on a public holiday.\n",
    topics: {
      "when does the project ship": "shipping",
      "The team agreed to ship on Fridays.": "shipping",
      "ship on fridays": "shipping",
    },
    memories: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        text: "The team agreed to ship on Fridays.",
        summary: "ship on fridays",
        category: "fact",
        ageDays: 5,
      },
    ],
    config: {},
    event: eventFor("when does the project ship", "golden-session-3", "golden-run-3"),
    ctx: ctxFor("golden-session-3", "golden-run-3"),
  },
  {
    // Pins the store/embed/rank path end-to-end for records with a large
    // body text (~11 900 chars each, via FILLER). It does NOT exercise the
    // 17 000-char recall.globalInjectMaxChars cap: display in the prompt is
    // each record's *summary*, capped at 400 chars by
    // sanitizeMemoryTextForPrompt (lib/relevant-memory-context.js:122), so
    // the large body text never reaches the prompt and this scenario's
    // prependContext is an ordinary ~1 100-char two-record prefix.
    // `recall-truncated` is the scenario that actually pins truncation.
    name: "recall-large-text-records",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: {
      "what do you know about the deployment": "deployment",
      [`Deployment runbook A. ${FILLER}`]: "deployment",
      [`Deployment runbook B. ${FILLER}`]: "deployment",
      "runbook A": "deployment",
      "runbook B": "deployment",
    },
    memories: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        text: `Deployment runbook A. ${FILLER}`,
        summary: "runbook A",
        category: "fact",
        ageDays: 2,
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        text: `Deployment runbook B. ${FILLER}`,
        summary: "runbook B",
        category: "fact",
        ageDays: 4,
      },
    ],
    config: { recall: { dedup: false, canonicalFirst: true, canonicalMaxItems: 1, maxPromptMemories: 5, decisionTrace: { enabled: false, includeInPrompt: false }, globalInjectMaxChars: 17_000 } },
    event: eventFor("what do you know about the deployment", "golden-session-4", "golden-run-4"),
    ctx: ctxFor("golden-session-4", "golden-run-4"),
  },
  {
    name: "recall-maintenance-only",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: { "hello again": "greeting" },
    memories: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        text: "The user greeted the agent yesterday.",
        summary: "greeting",
        category: "fact",
        ageDays: 1,
      },
    ],
    // autoRecall off drives the third before_prompt_build registration
    // (index.js:13354-13443), the maintenance-only fallback branch.
    config: { autoRecall: false, gc: { enabled: true } },
    event: eventFor("hello again", "golden-session-5", "golden-run-5"),
    ctx: ctxFor("golden-session-5", "golden-run-5"),
  },
  {
    name: "recall-truncated",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: BULK_TOPICS,
    memories: BULK_MEMORIES,
    // Two different truncators have to fire here.
    //
    // `semanticCompression` defaults to on (index.js:13029) with a 240-token
    // budget and would shrink every display long before either of them; off so
    // the record bulk survives. `candidateTopK` has to clear
    // `maxPromptMemories` or the pipeline never carries 60 candidates that far.
    //
    // `globalInjectMaxChars` is 11 000 rather than the product default 17 000
    // because the memories block is *already* hard-capped at 12 000 by
    // `truncateMemoryContext` (lib/relevant-memory-context.js:67,261-262) and
    // index.js never overrides that default — so at 17 000
    // `applyGlobalInjectBudget` is unreachable and would be left uncovered.
    // At 11 000 both cut: the inner cap emits `<!-- memory context truncated -->`
    // and the global budget then trims the droppable memories block on top.
    config: {
      recall: {
        dedup: false,
        canonicalFirst: false,
        canonicalMaxItems: 1,
        maxPromptMemories: TRUNCATION_RECORD_COUNT,
        candidateTopK: 100,
        semanticCompression: { enabled: false },
        decisionTrace: { enabled: false, includeInPrompt: false },
        globalInjectMaxChars: 11_000,
      },
    },
    event: eventFor("walk me through the rollout runbook", "golden-session-6", "golden-run-6"),
    ctx: ctxFor("golden-session-6", "golden-run-6"),
  },
  {
    name: "recall-canonical-flagged",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    knowledge: CANONICAL_KNOWLEDGE,
    topics: {
      "when may we release": "release-policy",
      [CANONICAL_SECTION_TEXT]: "release-policy",
      "The team agreed to ship on Fridays.": "release-policy",
      "ship on fridays": "release-policy",
    },
    memories: [
      {
        id: "88888888-8888-4888-8888-888888888888",
        text: "The team agreed to ship on Fridays.",
        summary: "ship on fridays",
        category: "fact",
        ageDays: 5,
      },
    ],
    config: {},
    event: eventFor("when may we release", "golden-session-7", "golden-run-7"),
    ctx: ctxFor("golden-session-7", "golden-run-7"),
  },
  {
    // Signal fires mid-recall: the embedder only settles when its signal
    // aborts, so the recall is cut after the start notice was consumed and
    // before any memory was embedded. Spec 3.2: the aborted recall returns
    // the blocks already complete — here exactly the start notice.
    name: "recall-aborted",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    startNotice: "PLUR1BUS is set up. This notice is shown once.",
    hangEmbedder: true,
    topics: {
      "what happened while I was away": "away",
      "The user travelled to Lisbon in December.": "away",
      "Lisbon trip": "away",
    },
    memories: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        text: "The user travelled to Lisbon in December.",
        summary: "Lisbon trip",
        category: "fact",
        ageDays: 20,
      },
    ],
    config: { runtime: { recallTimeoutMs: 300 } },
    event: eventFor("what happened while I was away", "golden-session-8", "golden-run-8"),
    ctx: ctxFor("golden-session-8", "golden-run-8"),
  },
];

/**
 * Job-ledger scenarios: the ledger rows (and the dream diary) a sequence of
 * sweeps leaves behind, under a virtual clock. Written once, like the prefix
 * oracle.
 */
export const JOB_SCENARIOS = [
  {
    // REM produces no narrative four nights running inside one REM week:
    // incomplete (attempt 1), incomplete (2), abandoned (3, reason written to
    // DREAMS.md), then skipped as abandoned.
    name: "jobs-ledger-retry",
    agentId: AGENT,
    job: "rem-dream",
    runKey: `rem:${WORKSPACE}:${AGENT}:private:2026-W02`,
    sweeps: [
      Date.UTC(2026, 0, 13, 0, 15),
      Date.UTC(2026, 0, 14, 0, 15),
      Date.UTC(2026, 0, 15, 0, 15),
      Date.UTC(2026, 0, 16, 0, 15),
    ],
  },
];

/**
 * tests/fixtures/golden-prefix/scenarios.js
 *
 * Five synthetic recall scenarios. `topics` maps a fixture string to the axis
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

/** A block of filler large enough to push the join past the 17 000-char cap. */
const FILLER = "Deployment note. ".repeat(700); // ~11 900 chars

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
    name: "recall-over-budget",
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
];

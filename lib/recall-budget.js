/**
 * lib/recall-budget.js
 *
 * Pure functions for adaptive recall budget resolution and memory tier allocation.
 */

/**
 * Resolve how many memories should be recalled based on prompt characteristics.
 *
 * @param {Object} opts
 * @param {number} opts.promptLength          – length of the user prompt in chars
 * @param {boolean} [opts.hasProjectSignals=false] – whether project signals are present
 * @param {number} [opts.maxPromptMemories=12]     – hard ceiling for small token budgets
 * @param {number} [opts.tokenBudgetPct=0.3]       – token budget percentage
 * @returns {{ budget: number, reason: string }}
 */
export function resolveRecallBudget({
  promptLength,
  hasProjectSignals = false,
  maxPromptMemories = 12,
  tokenBudgetPct = 0.3,
}) {
  const expandedCap = Math.min(20, Math.floor(maxPromptMemories * 1.5));
  const useExpandedCap = tokenBudgetPct > 0.3;
  const hardCap = useExpandedCap ? expandedCap : maxPromptMemories;

  let budget;
  let reason;

  if (promptLength > 200 || hasProjectSignals) {
    budget = expandedCap;
    reason =
      hasProjectSignals && promptLength <= 200
        ? "project_signals"
        : "complex_prompt";
  } else if (promptLength >= 50) {
    budget = 10; // midpoint of 8–12
    reason = "normal_prompt";
  } else {
    budget = 6; // midpoint of 5–8
    reason = "small_prompt";
  }

  budget = Math.min(budget, hardCap);

  return { budget, reason };
}

/**
 * Allocate memories across tiers with strict priority order and an associative cap.
 *
 * Priority: core → canonical → project → episodic → associative
 * Associative may never exceed 30 % of the total budget.
 *
 * @param {Object} opts
 * @param {Array} [opts.core=[]]
 * @param {Array} [opts.canonical=[]]
 * @param {Array} [opts.project=[]]
 * @param {Array} [opts.episodic=[]]
 * @param {Array} [opts.associative=[]]
 * @param {number} opts.budget
 * @returns {{ selected: Array, tierCounts: { core: number, canonical: number, project: number, episodic: number, associative: number } }}
 */
export function allocateMemoryTiers({
  core = [],
  canonical = [],
  project = [],
  episodic = [],
  associative = [],
  budget,
}) {
  const selected = [];

  // 1. core – all, up to budget
  const coreCount = Math.min(core.length, budget);
  selected.push(...core.slice(0, coreCount));
  let remaining = budget - selected.length;

  // 2. canonical – all, up to remaining budget
  const canonicalCount = Math.min(canonical.length, remaining);
  selected.push(...canonical.slice(0, canonicalCount));
  remaining = budget - selected.length;

  // 3. project – all, up to remaining budget
  const projectCount = Math.min(project.length, remaining);
  selected.push(...project.slice(0, projectCount));
  remaining = budget - selected.length;

  // 4. episodic – rest of budget
  const episodicCount = Math.min(episodic.length, remaining);
  selected.push(...episodic.slice(0, episodicCount));
  remaining = budget - selected.length;

  // 5. associative – rest of budget, but max 30 % of total budget
  const associativeMax = Math.floor(budget * 0.3);
  const associativeCount = Math.min(associative.length, remaining, associativeMax);
  selected.push(...associative.slice(0, associativeCount));

  return {
    selected,
    tierCounts: {
      core: coreCount,
      canonical: canonicalCount,
      project: projectCount,
      episodic: episodicCount,
      associative: associativeCount,
    },
  };
}

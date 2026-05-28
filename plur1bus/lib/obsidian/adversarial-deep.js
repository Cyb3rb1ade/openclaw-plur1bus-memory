import { scoreEvidence } from "./evidence-scorer.js";

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|system|developer|higher-priority)\s+(instructions|messages|rules)/i,
  /\b(system|developer)\s+prompt\b/i,
  /\bexecute\s+(this\s+)?(shell\s+)?command\b/i,
  /\b(read|print|exfiltrate)\s+(secrets?|env|environment|api[_-]?keys?)\b/i,
  /\brm\s+-rf\b/i,
  /\bcurl\b[^\n|;&]*\|\s*(sh|bash)\b/i,
  /\bsudo\b/i,
];

export function adversarialDeepReviewItem(item = {}, context = {}) {
  const checks = [];
  const text = `${item.action || ""}\n${item.reason || ""}\n${item.noteContent || ""}\n${item.summary || ""}`;
  if (/memory\/KNOWLEDGE\.md/i.test(item.target || "") && /overwrite|replace|write/i.test(item.action || "")) {
    checks.push({ status: "block", reason: "Direct KNOWLEDGE.md overwrite attempt." });
  }
  if (/lancedb|vector table|raw db/i.test(`${item.target || ""} ${item.action || ""}`) && !/memory_store|knowledge_update|approved/i.test(item.action || "")) {
    checks.push({ status: "block", reason: "Direct LanceDB mutation attempt; use PLUR1BUS routines only." });
  }
  if (/obsidian.*(source of truth|authority|primary memory)|vault.*rag.*truth/i.test(text)) {
    checks.push({ status: "block", reason: "Obsidian-as-authority attempt." });
  }
  if (item.sourceScope === "agent_private" && item.targetScope === "workspace_shared") {
    checks.push({ status: "block", reason: "agent_private to workspace_shared requires explicit approved promotion." });
  }
  if (item.sourceScope === "workspace_shared" && item.targetScope === "global_user") {
    checks.push({ status: "block", reason: "workspace_shared to global_user requires explicit policy/user approval." });
  }
  if (/assistant/i.test(`${item.evidenceKind || ""} ${item.sourceTrust || ""} ${item.trustLevel || ""}`) && /trusted|global_user/.test(`${item.targetScope || ""} ${item.scope || ""} ${item.action || ""}`)) {
    checks.push({ status: "block", reason: "Assistant-only assertion cannot become trusted/global memory." });
  }
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text))) {
    checks.push({ status: "warning", reason: "Prompt-injection-like Obsidian note content." });
  }
  if (context.openConflicts?.has?.(item.target)) checks.push({ status: "warning", reason: "Target already has an open conflict." });
  if (scoreEvidence(item) < 0.35 && /promote|apply|trusted|global/.test(`${item.action || ""} ${item.targetScope || ""}`)) {
    checks.push({ status: "block", reason: "Source trust is weaker than requested mutation." });
  }
  const status = checks.some((check) => check.status === "block") ? "block" : checks.some((check) => check.status === "warning") ? "warning" : "pass";
  return { ...item, adversarialDeep: { status, checks, evidenceScore: scoreEvidence(item) } };
}

export function runAdversarialDeep(items = [], context = {}) {
  const reviewed = items.map((item) => adversarialDeepReviewItem(item, context));
  return { ok: true, reviewed, blocked: reviewed.filter((item) => item.adversarialDeep.status === "block"), warnings: reviewed.filter((item) => item.adversarialDeep.status === "warning") };
}


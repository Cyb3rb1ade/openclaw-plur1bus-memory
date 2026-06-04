/**
 * lib/jobs/skill-miner/skill-md-renderer.js
 *
 * Render a proposal into an OpenClaw-compatible SKILL.md string.
 */

export function renderSkillMd(proposal, opts = {}) {
  const {
    skillTitle,
    skillName,
    description,
    instructions,
    examples,
    evidence,
    agentId,
    workspaceKey,
    proposedAt,
  } = proposal;

  const approvedAt = opts.approvedAt || new Date().toISOString();
  const exampleLines = (examples || []).map(ex => `- ${ex}`).join("\n");

  return `# ${skillTitle}

**Agent:** ${agentId || "unknown"}
**Workspace:** ${workspaceKey || "unknown"}
**Discovered:** ${proposedAt || "unknown"}
**Approved:** ${approvedAt}
**Confidence:** ${evidence?.llmConfidence ?? "unknown"}
**Evidenced by:** ${evidence?.memoryIds?.length ?? 0} memories

## Description

${description || "No description provided."}

## Instructions

${instructions || "No instructions provided."}

## Examples

${exampleLines || "- No examples provided."}

## Provenance

- Auto-discovered by PLUR1BUS Skill Miner
- Evidence memories: ${(evidence?.memoryIds || []).join(", ")}
- Skill name: \`${skillName}\`
`;
}

import { skillOwnershipTuple, sameSkillOwnershipTuple, isTrustedSkillEvidence } from "./evidence-aggregator.js";

const STOP_WORDS = new Set(`the and for with from that this these those have has had will would should could about into before after when then also user assistant message memory memories skill skills workflow openclaw plur1bus
und oder aber eine einer einen einem eines diese dieser dieses nicht wird werden wurde wurden haben hatte bitte sowie auch sich mehr nach fuer über durch kann können muss sollen immer dabei damit dazu sein sind waren meine deinem ihrer prüfen dokumentieren
dass habe genau alles deswegen nochmals weiterhin sondern unter noch bereits ebenfalls weitere weiteren aktuellen geändert bleibt bernd bernhardine heisenberg jetzt hier dort ohne sehr wirklich einfach eigentlich quasi natürlich vielleicht schon weil wenn dann machen gemacht gesagt möchten wollen wollte etwas sowohl sofern welche welcher welches diesen jenem meinem unserer ihnen deren deiner deines solche solcher hierbei soweit nochmal kannst weiß nächste`.split(/\s+/));

function terms(text) {
  // File errors and MIME/path wrappers describe transport, not the discussed workflow.
  const content = String(text || "")
    .replace(/<file\b[^>]*>([\s\S]*?)<\/file>/gi, (_match, body) => /\[(?:Unsupported document format|Attachment could not be read)/i.test(body) ? " " : body)
    .replace(/<[^>]+>/g, " ")
    .replace(/\[Audio transcript[^\]]*\]:?/gi, " ")
    .replace(/\[media attached:[^\]]*\]/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\/(?:root|tmp)\/\S+/g, " ");
  return new Set(content.normalize("NFKC").toLowerCase().match(/[\p{L}]{4,}/gu)?.filter(word => !STOP_WORDS.has(word)) || []);
}

function overlap(a, b) {
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection++;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

const textOf = proposal => `${proposal.skillName || ""} ${proposal.skillTitle || ""} ${proposal.description || ""} ${proposal.instructions || ""}`;
const normalizedInstructions = value => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();

/**
 * Select only same-owner live/rejected proposals for matching and prompt context.
 * @param {object[]} proposals
 * @param {{agentId:string,ownership?:object,workspaceAliases?:object}} context
 * @returns {object[]}
 */
export function selectSkillCatalogue(proposals, { agentId, ownership, workspaceAliases } = {}) {
  return (proposals || []).filter(proposal => proposal.agentId === agentId
    && ["active", "pending_review", "activation_partial", "rejected"].includes(proposal.status)
    && (!ownership || (proposal.aclBindings
      ? sameSkillOwnershipTuple(proposal.aclBindings, ownership, workspaceAliases)
      : ownership.scope === "agent-private")));
}

/**
 * Match a validated candidate conservatively; evidence overlap alone is insufficient.
 * @param {object} candidate
 * @param {object[]} catalogue Already restricted to this owner.
 * @returns {{proposal:object,kind:string}|null}
 */
export function findRelatedSkill(candidate, catalogue) {
  const candidateTerms = terms(textOf(candidate));
  const ids = new Set(candidate.evidence?.memoryIds || []);
  const rejectedAddition = catalogue.find(proposal => proposal.status === "rejected" && proposal.updateOf
    && (candidate.targetSkillName === proposal.skillName || candidate.skillName === proposal.skillName)
    && overlap(terms(candidate.instructions), terms(proposal.extensionInstructions || proposal.instructions)) >= 0.85);
  if (rejectedAddition) return { proposal: rejectedAddition, kind: "duplicate" };

  const scored = catalogue.filter(proposal => !(proposal.status === "rejected" && proposal.updateOf)).map(proposal => {
    const similarity = overlap(candidateTerms, terms(textOf(proposal)));
    const evidence = overlap(ids, new Set(proposal.evidence?.memoryIds || []));
    const named = candidate.skillName === proposal.skillName;
    const selected = candidate.targetSkillName === proposal.skillName;
    return { proposal, similarity, evidence, named, selected, weight: selected ? 3 : named ? 2 : similarity };
  }).filter(match => match.named || match.selected || match.similarity >= 0.72
    || (match.evidence >= 0.8 && match.similarity >= 0.35))
    .sort((a, b) => b.weight - a.weight);
  if (!scored.length) return null;
  const { proposal, similarity } = scored.find(match => match.proposal.status === "rejected") || scored[0];
  const oldIds = new Set(proposal.evidence?.memoryIds || []);
  const newEvidence = [...ids].some(id => !oldIds.has(id));
  const addition = normalizedInstructions(candidate.instructions);
  const sameInstructions = Boolean(addition) && (
    normalizedInstructions(proposal.instructions).includes(addition)
    || normalizedInstructions(proposal.extensionInstructions) === addition
  );
  const equivalent = sameInstructions || similarity >= 0.85;
  return { proposal, kind: sameInstructions || (!newEvidence && equivalent) ? "duplicate" : "extension" };
}

/**
 * Bound catalogue context to the most relevant same-owner skill descriptions.
 * @param {object} group
 * @param {object[]} catalogue
 * @returns {object[]}
 */
export function relevantSkillCatalogue(group, catalogue) {
  const words = terms(group.memories.slice(0, 24).map(memory => memory.text).join(" "));
  return catalogue.map(proposal => ({ proposal, score: overlap(words, terms(textOf(proposal))) }))
    .sort((a, b) => b.score - a.score).slice(0, 8).map(({ proposal }) => proposal);
}

/**
 * Supplement transitive/mixed groups with bounded distinctive-term cohorts.
 * @param {object[]} memories Already passed the miner's admission/ACL filter.
 * @param {object[]} originalGroups
 * @param {object} [workspaceAliases] Trusted canonical workspace aliases.
 * @returns {object[]} Focused cohorts followed by existing groups, deduplicated by IDs.
 */
export function prepareSkillEvidenceGroups(memories, originalGroups, workspaceAliases) {
  const postings = new Map();
  const profiles = new Map(memories.map(memory => [memory.id, terms(memory.text)]));
  for (const memory of memories) {
    const owner = skillOwnershipTuple(memory, workspaceAliases);
    if (!owner) continue;
    for (const word of profiles.get(memory.id)) {
      const termKey = `${JSON.stringify(owner)}\0${word}`;
      const entry = postings.get(termKey) || { word, owner, rows: [] };
      entry.rows.push(memory);
      postings.set(termKey, entry);
    }
  }

  const candidates = [];
  for (const { word, owner, rows } of postings.values()) {
    if (rows.length < 2 || rows.length > Math.max(24, Math.floor(memories.length * 0.15))) continue;
    const selected = [...rows].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)).slice(0, 24);
    const score = selected.reduce((total, memory) => total + 1 + (isTrustedSkillEvidence(memory) ? 2 : 0)
      + (["workspace_rule", "user_preference"].includes(memory.category) ? 1 : 0)
      + ((memory.retrievalCount || 0) >= 3 ? 1 : 0) - (memory.contradictory === true ? 1 : 0), 0);
    let pairs = 0;
    let similarity = 0;
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        similarity += overlap(profiles.get(selected[i].id), profiles.get(selected[j].id));
        pairs++;
      }
    }
    candidates.push({
      memories: selected, score, coherence: pairs ? similarity / pairs : 0,
      topics: [word], keywords: [word], ownership: owner,
      newest: Math.max(...selected.map(memory => Number(memory.createdAt) || 0)), focused: true,
    });
  }
  // Coherent repeated material comes before generic one-word links; age decays over weeks.
  const newest = candidates.reduce((value, group) => Math.max(value, group.newest), 0);
  const priority = group => group.score * (0.05 + group.coherence) / (1 + Math.max(0, newest - group.newest) / (7 * 86400000));
  candidates.sort((a, b) => priority(b) - priority(a) || b.newest - a.newest || a.topics[0].localeCompare(b.topics[0]));
  const focused = [];
  for (const group of candidates) {
    const ids = new Set(group.memories.map(memory => memory.id));
    if (focused.some(prior => overlap(ids, new Set(prior.memories.map(memory => memory.id))) >= 0.8)) continue;
    focused.push(group);
    if (focused.length >= 64) break;
  }
  const seen = new Set();
  return [...focused, ...originalGroups].filter(group => {
    const key = JSON.stringify(group.memories.map(memory => memory.id).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

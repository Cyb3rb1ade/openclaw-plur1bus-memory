// Contextual speaker-name proposer for D4.
// Produces *proposals* only — never authoritative assignments.
// All proposals require explicit user confirmation before they become active.
import { getConfirmedMappings, getSpeakerMapping, recordSpeakerProposal } from "./speaker-mapping-store.js";
import { normalizeSpeakerSegments } from "./speaker-segment-schema.js";

// German/English direct-address patterns. The capture group is the candidate name.
const DIRECT_ADDRESS_RE =
  /(?:Hallo|Hi|Hey|Moin|Guten Tag|Guten Morgen|Guten Abend|Danke|Danke schön|Vielen Dank|Bitte|Entschuldigung|Sorry|Excuse me)\s*,?\s*([A-Z][a-zA-ZäöüÄÖÜß]+)(?=\s|[,\.!?]|$)/gi;

const CONFIDENCE_DIRECT_ADDRESS = 0.7;
const CONFIDENCE_MEMORY_HINT = 0.4;

/**
 * Propose speaker display names by scanning segment text for direct address.
 *
 * @param {import("./speaker-segment-schema.js").SpeakerSegment[]} segments
 * @param {string} agentId
 * @returns {Promise<Array<{ speakerLabel: string; displayName: string; confidence: number; contextHint: string }>>}
 */
export async function proposeSpeakerNames(segments, agentId) {
  const normalized = normalizeSpeakerSegments(segments);
  const confirmed = new Map(
    getConfirmedMappings(agentId).map((m) => [m.speakerLabel, m.speakerDisplayName]),
  );

  const proposals = [];
  const seen = new Set();

  for (const segment of normalized) {
    // Never propose a name for an already-confirmed label.
    if (confirmed.has(segment.speakerLabel)) {
      continue;
    }

    const text = segment.text || "";
    let match;
    while ((match = DIRECT_ADDRESS_RE.exec(text)) !== null) {
      const displayName = match[1].trim();
      if (!displayName || displayName.length < 2) {
        continue;
      }
      const key = `${segment.speakerLabel}→${displayName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      proposals.push({
        speakerLabel: segment.speakerLabel,
        displayName,
        confidence: CONFIDENCE_DIRECT_ADDRESS,
        contextHint: match[0].trim(),
      });
    }
  }

  return proposals;
}

/**
 * Given a list of proposals, persist only the new ones (i.e. proposals for
 * speaker labels that currently have no pending or confirmed mapping).
 *
 * @param {string} agentId
 * @param {Awaited<ReturnType<typeof proposeSpeakerNames>>} proposals
 * @returns {{ stored: number; skipped: number }}
 */
export function storeNewProposals(agentId, proposals) {
  let stored = 0;
  let skipped = 0;
  for (const proposal of proposals) {
    const existing = getSpeakerMapping(agentId, proposal.speakerLabel);
    if (existing) {
      skipped++;
      continue;
    }
    recordSpeakerProposal(
      agentId,
      proposal.speakerLabel,
      proposal.displayName,
      proposal.confidence,
      proposal.contextHint,
    );
    stored++;
  }
  return { stored, skipped };
}

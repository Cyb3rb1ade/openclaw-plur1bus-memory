// /speaker chat commands for manual speaker mapping and contextual proposals.
// All config-mutating commands require authorization per PLUR1BUS security rules.
import {
  confirmSpeakerProposal,
  deleteSpeakerMapping,
  getConfirmedMappings,
  getPendingProposals,
  rejectSpeakerProposal,
  setManualSpeakerMapping,
} from "../speaker-mapping-store.js";

function parseLabelAndName(args) {
  const raw = (args || "").trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return null;
  const label = parts[0];
  const displayName = parts.slice(1).join(" ");
  return { label, displayName };
}

export function renderSpeakerList(mappings, { lang = "de" } = {}) {
  if (mappings.length === 0) {
    return lang === "en"
      ? "No speaker mappings yet. Use `/speaker name <label> <name>`."
      : "Noch keine Sprecher-Zuordnungen. Verwende `/speaker name <label> <Name>`.";
  }
  const header = lang === "en" ? "🎙️ Confirmed speaker mappings:" : "🎙️ Bestätigte Sprecher-Zuordnungen:";
  const lines = mappings.map((m) => `- \`${m.speakerLabel}\` → **${m.speakerDisplayName}** (${m.attributionSource})`);
  return [header, ...lines].join("\n");
}

export function renderProposals(proposals, { lang = "de" } = {}) {
  if (proposals.length === 0) {
    return lang === "en"
      ? "No pending speaker proposals."
      : "Keine ausstehenden Sprecher-Vorschläge.";
  }
  const header = lang === "en" ? "🔎 Pending speaker proposals:" : "🔎 Ausstehende Sprecher-Vorschläge:";
  const lines = proposals.map((p) =>
    `- \`${p.speakerLabel}\` → **${p.speakerDisplayName}** (confidence: ${p.confidence ?? "?"}, hint: "${p.contextHint || "-"}")`
  );
  const footer = lang === "en"
    ? "Confirm with `/speaker confirm <label>` or reject with `/speaker reject <label>`."
    : "Bestätige mit `/speaker confirm <label>` oder lehne ab mit `/speaker reject <label>`.";
  return [header, ...lines, footer].join("\n");
}

export function runSpeakerListCommand(agentId, { lang = "de" } = {}) {
  const mappings = getConfirmedMappings(agentId);
  return { text: renderSpeakerList(mappings, { lang }) };
}

export function runSpeakerNameCommand(commandCtx, agentId, checkAuth, { lang = "de" } = {}) {
  const authError = checkAuth(commandCtx, { destructive: true });
  if (authError) return authError;
  const parsed = parseLabelAndName(commandCtx.args);
  if (!parsed) {
    return { text: lang === "en" ? "Usage: `/speaker name <label> <name>`" : "Verwendung: `/speaker name <label> <Name>`" };
  }
  setManualSpeakerMapping(agentId, parsed.label, parsed.displayName);
  return {
    text:
      lang === "en"
        ? `✅ Mapped \`${parsed.label}\` to **${parsed.displayName}**.`
        : `✅ \`${parsed.label}\` → **${parsed.displayName}** gespeichert.`,
  };
}

export function runSpeakerProposalsCommand(agentId, { lang = "de" } = {}) {
  const proposals = getPendingProposals(agentId);
  return { text: renderProposals(proposals, { lang }) };
}

export function runSpeakerConfirmCommand(commandCtx, agentId, checkAuth, { lang = "de" } = {}) {
  const authError = checkAuth(commandCtx, { destructive: true });
  if (authError) return authError;
  const label = (commandCtx.args || "").trim().split(/\s+/)[0];
  if (!label) {
    return { text: lang === "en" ? "Usage: `/speaker confirm <label>`" : "Verwendung: `/speaker confirm <label>`" };
  }
  if (confirmSpeakerProposal(agentId, label)) {
    return { text: lang === "en" ? `✅ Confirmed proposal for \`${label}\`.` : `✅ Vorschlag für \`${label}\` bestätigt.` };
  }
  return { text: lang === "en" ? `⚠️ No pending proposal for \`${label}\`.` : `⚠️ Kein ausstehender Vorschlag für \`${label}\`.` };
}

export function runSpeakerRejectCommand(commandCtx, agentId, checkAuth, { lang = "de" } = {}) {
  const authError = checkAuth(commandCtx, { destructive: true });
  if (authError) return authError;
  const label = (commandCtx.args || "").trim().split(/\s+/)[0];
  if (!label) {
    return { text: lang === "en" ? "Usage: `/speaker reject <label>`" : "Verwendung: `/speaker reject <label>`" };
  }
  if (rejectSpeakerProposal(agentId, label)) {
    return { text: lang === "en" ? `🚫 Rejected proposal for \`${label}\`.` : `🚫 Vorschlag für \`${label}\` abgelehnt.` };
  }
  return { text: lang === "en" ? `⚠️ No pending proposal for \`${label}\`.` : `⚠️ Kein ausstehender Vorschlag für \`${label}\`.` };
}

export function runSpeakerClearCommand(commandCtx, agentId, checkAuth, { lang = "de" } = {}) {
  const authError = checkAuth(commandCtx, { destructive: true });
  if (authError) return authError;
  const label = (commandCtx.args || "").trim().split(/\s+/)[0];
  if (!label) {
    return { text: lang === "en" ? "Usage: `/speaker clear <label>`" : "Verwendung: `/speaker clear <label>`" };
  }
  deleteSpeakerMapping(agentId, label);
  return { text: lang === "en" ? `🗑️ Cleared mapping for \`${label}\`.` : `🗑️ Zuordnung für \`${label}\` entfernt.` };
}

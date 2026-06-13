// lib/overlay-commands.js
import { InterpretationOverlayStore } from "./interpretation-overlay.js";
import { ContradictionDetector } from "./contradiction-detector.js";

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Runs the `plur1bus memory` overlay audit subcommands.
 *
 * @param {object} params
 * @param {string} params.subCommand — "overlays" | "overlay" | "disable-overlay" | "contradictions"
 * @param {string|null} params.id
 * @param {string} params.workspaceDir
 * @param {Function} params.callLlm — existing index.js LLM helper `(messages, llmCfg) => response`
 * @param {object} params.mergingLlmCfg
 * @returns {Promise<{text: string}>}
 */
export async function runOverlayAuditCommand({ subCommand, id = null, workspaceDir, callLlm, mergingLlmCfg }) {
  if (!workspaceDir) {
    if (subCommand === "disable-overlay") {
      return { ok: false, text: "No workspace directory available." };
    }
    return { text: "No workspace directory available." };
  }

  const store = new InterpretationOverlayStore(workspaceDir);

  if (subCommand === "overlays") {
    const all = await store.loadAllOverlays([], {
      includeProvisional: true,
      includeSuperseded: true,
      maxAgeDays: 90,
    });
    const summary = all.map((o) => ({
      id: o.id,
      targetMemoryId: o.targetMemoryId,
      shiftType: o.shiftType,
      status: o.status || "active",
      supersededBy: o.supersededBy || null,
      description: String(o.shiftDescription || "").slice(0, 80),
    }));
    return { text: formatJson({ count: summary.length, overlays: summary }) };
  }

  if (subCommand === "overlay") {
    if (!id) {
      return { text: "Usage: /plur1bus memory overlay <id>" };
    }
    if (!isValidUuid(id)) {
      return { text: `Invalid overlay id: ${id}` };
    }
    const lineage = await store.getLineage(id, 90);
    if (!lineage.current) {
      return { text: `No overlay found for ${id}` };
    }
    return { text: formatJson(lineage) };
  }

  if (subCommand === "disable-overlay") {
    if (!id) {
      return { ok: false, text: "Usage: /plur1bus memory disable-overlay <id>" };
    }
    if (!isValidUuid(id)) {
      return { ok: false, text: `Invalid overlay id: ${id}` };
    }
    const ok = await store.disableOverlay(id, "operator command");
    return ok
      ? { ok: true, text: `Overlay ${id} disabled.` }
      : { ok: false, text: `Could not disable ${id}.` };
  }

  if (subCommand === "contradictions") {
    if (id && !isValidUuid(id)) {
      return { text: `Invalid overlay id: ${id}` };
    }
    const detector = new ContradictionDetector({
      llm: (messages) => callLlm(messages, mergingLlmCfg),
      workspaceDir,
    });
    const memoryIds = id ? [id] : [];
    const overlays = await store.loadAllOverlays(memoryIds, {
      includeProvisional: false,
      includeSuperseded: false,
      includeDisabled: false,
      maxAgeDays: 90,
    });
    const contradictions = await detector.findAndPersistContradictions(overlays);
    return { text: formatJson({ scanned: overlays.length, contradictions }) };
  }

  return { text: `Unknown overlay subcommand: ${subCommand}` };
}

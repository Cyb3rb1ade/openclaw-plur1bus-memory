// lib/overlay-commands.js
import { InterpretationOverlayStore } from "./interpretation-overlay.js";
import { ContradictionDetector } from "./contradiction-detector.js";
import { MemoryDoctor } from "./memory-doctor.js";

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
 * @param {string} params.subCommand — "overlays" | "overlay" | "disable-overlay" | "contradictions" | "supersede-overlay" | "doctor"
 * @param {string|null} params.id
 * @param {string[]} [params.extraArgs]
 * @param {string} params.workspaceDir
 * @param {Function} params.callLlm — existing index.js LLM helper `(messages, llmCfg) => response`
 * @param {object} params.overlayAuditLlmCfg
 * @param {object} [params.doctorCfg]
 * @returns {Promise<{text: string}>}
 */
export async function runOverlayAuditCommand({ subCommand, id = null, extraArgs = [], workspaceDir, callLlm, overlayAuditLlmCfg, doctorCfg }) {
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
    if (!callLlm || !overlayAuditLlmCfg) {
      return { text: "LLM merging is not configured; cannot scan for contradictions." };
    }
    const detector = new ContradictionDetector({
      llm: (messages) => callLlm(messages, overlayAuditLlmCfg),
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

  if (subCommand === "supersede-overlay") {
    if (!id) {
      return { ok: false, text: "Usage: /plur1bus memory supersede-overlay <oldId> <newDescription>" };
    }
    if (!isValidUuid(id)) {
      return { ok: false, text: `Invalid overlay id: ${id}` };
    }
    const newDescription = Array.isArray(extraArgs) ? extraArgs.join(" ").trim() : "";
    if (!newDescription) {
      return { ok: false, text: "Usage: /plur1bus memory supersede-overlay <oldId> <newDescription>" };
    }
    const ok = await store.supersedeOverlay(id, newDescription, "operator command");
    return { ok, text: ok ? `Overlay ${id} superseded.` : `Could not supersede ${id}.` };
  }

  if (subCommand === "doctor") {
    if (!doctorCfg?.enabled) {
      return { text: "Memory doctor is disabled. Enable it with continuityEngine.doctor.enabled." };
    }
    if (id === "memory") {
      if (!extraArgs?.[0]) {
        return { text: "Usage: /plur1bus memory doctor memory <memoryId>" };
      }
      const doctor = new MemoryDoctor({ workspaceDir, maxAgeDays: doctorCfg.maxAgeDays ?? 90 });
      const report = await doctor.diagnoseMemory(extraArgs[0]);
      return { text: formatJson(report) };
    }
    if (id === "overlay") {
      if (!extraArgs?.[0]) {
        return { text: "Usage: /plur1bus memory doctor overlay <overlayId>" };
      }
      if (!isValidUuid(extraArgs[0])) {
        return { text: `Invalid overlay id: ${extraArgs[0]}` };
      }
      const doctor = new MemoryDoctor({ workspaceDir, maxAgeDays: doctorCfg.maxAgeDays ?? 90 });
      const report = await doctor.diagnoseOverlay(extraArgs[0]);
      return { text: formatJson(report) };
    }
    const doctor = new MemoryDoctor({ workspaceDir, maxAgeDays: doctorCfg.maxAgeDays ?? 90 });
    const summary = await doctor.summarize();
    return { text: formatJson(summary) };
  }

  return { text: `Unknown overlay subcommand: ${subCommand}` };
}

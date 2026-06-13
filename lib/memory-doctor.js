// lib/memory-doctor.js
import { InterpretationOverlayStore } from "./interpretation-overlay.js";
import { ContradictionDetector } from "./contradiction-detector.js";

/**
 * Diagnostic helper for interpretation overlays.
 *
 * Loads overlays from an append-only JSONL store, classifies them by
 * lifecycle state (active, provisional, superseded, disabled), detects
 * contradictions, and emits actionable suggestions.
 */
export class MemoryDoctor {
  constructor({ workspaceDir, maxAgeDays = 90, logger = console } = {}) {
    if (!workspaceDir) throw new TypeError("workspaceDir is required");
    this.store = new InterpretationOverlayStore(workspaceDir);
    this.detector = new ContradictionDetector({ workspaceDir, logger });
    this.maxAgeDays = maxAgeDays;
    this.logger = logger;
  }

  /**
   * Return a workspace-wide summary of overlay counts and current contradictions.
   *
   * Contradictions are only counted when both participants are still active or
   * provisional overlays in the workspace.
   *
   * @returns {Promise<object>}
   */
  async summarize() {
    const all = await this.store.loadAllOverlays([], {
      includeProvisional: true,
      includeSuperseded: true,
      includeDisabled: true,
      maxAgeDays: this.maxAgeDays,
    });
    const classified = this._classify(all);
    const currentIds = new Set([
      ...classified.active.map((o) => o.id),
      ...classified.provisional.map((o) => o.id),
    ]);
    const contradictions = (await this.detector.loadAll()).filter(
      (c) => currentIds.has(c.overlayA) && currentIds.has(c.overlayB),
    );
    const memoryIdsWithContradictions = new Set(contradictions.map((c) => c.targetMemoryId));
    return {
      type: "summary",
      totalOverlays: all.length,
      active: classified.active.length,
      provisional: classified.provisional.length,
      superseded: classified.superseded.length,
      disabled: classified.disabled.length,
      contradictions: contradictions.length,
      memoriesWithContradictions: memoryIdsWithContradictions.size,
    };
  }

  /**
   * Diagnose all overlays for a single memory.
   *
   * @param {string} memoryId
   * @returns {Promise<object>}
   */
  async diagnoseMemory(memoryId) {
    if (!memoryId) throw new TypeError("memoryId is required");
    const all = await this.store.loadAllOverlays([memoryId], {
      includeProvisional: true,
      includeSuperseded: true,
      includeDisabled: true,
      maxAgeDays: this.maxAgeDays,
    });
    const classified = this._classify(all);
    const contradictions = await this.detector.loadFor([memoryId]);
    const relevantIds = new Set([
      ...classified.active.map((o) => o.id),
      ...classified.provisional.map((o) => o.id),
    ]);
    const relevantContradictions = contradictions.filter(
      (c) => relevantIds.has(c.overlayA) && relevantIds.has(c.overlayB),
    );
    const suggestions = this._suggestForMemory(classified, relevantContradictions);

    return {
      type: "memory",
      memoryId,
      active: classified.active,
      provisional: classified.provisional,
      superseded: classified.superseded,
      disabled: classified.disabled,
      contradictions: relevantContradictions,
      suggestions,
    };
  }

  /**
   * Diagnose a single overlay and its contradictions.
   *
   * @param {string} overlayId
   * @returns {Promise<object>}
   */
  async diagnoseOverlay(overlayId) {
    if (!overlayId) throw new TypeError("overlayId is required");
    const lineage = await this.store.getLineage(overlayId, this.maxAgeDays);
    if (!lineage.current) {
      return { type: "overlay", overlayId, found: false };
    }
    const memoryId = lineage.current.targetMemoryId;
    const allOverlays = await this.store.loadAllOverlays([memoryId], {
      includeProvisional: true,
      includeSuperseded: true,
      includeDisabled: true,
      maxAgeDays: this.maxAgeDays,
    });
    const classified = this._classify(allOverlays);
    const relevantIds = new Set([
      ...classified.active.map((o) => o.id),
      ...classified.provisional.map((o) => o.id),
    ]);
    const contradictions = await this.detector.loadFor([memoryId]);
    const involving = contradictions.filter(
      (c) => c.overlayA === overlayId || c.overlayB === overlayId,
    );
    const relevantInvolving = involving.filter(
      (c) => relevantIds.has(c.overlayA) && relevantIds.has(c.overlayB),
    );
    const suggestions = await this._suggestForOverlay(lineage, relevantInvolving);

    return {
      type: "overlay",
      overlayId,
      found: true,
      lineage,
      contradictions: relevantInvolving,
      suggestions,
    };
  }

  _classify(overlays) {
    const disabledIds = new Set();
    const supersededIds = new Set();
    for (const rec of overlays) {
      if (rec.status === "forgotten" && rec.disabledOverlayId) {
        disabledIds.add(rec.disabledOverlayId);
      }
      if (rec.supersedes) {
        supersededIds.add(rec.supersedes);
      }
    }

    const active = [];
    const provisional = [];
    const superseded = [];
    const disabled = [];

    for (const rec of overlays) {
      if (rec.status === "forgotten") continue;
      if (disabledIds.has(rec.id)) {
        disabled.push(rec);
      } else if (rec.status === "provisional") {
        provisional.push(rec);
      } else if (supersededIds.has(rec.id)) {
        superseded.push(rec);
      } else {
        active.push(rec);
      }
    }

    return { active, provisional, superseded, disabled, disabledIds, supersededIds };
  }

  _suggestForMemory(classified, relevantContradictions) {
    const suggestions = [];
    const byId = new Map([
      ...classified.active.map((o) => [o.id, o]),
      ...classified.provisional.map((o) => [o.id, o]),
    ]);

    for (const c of relevantContradictions) {
      const a = byId.get(c.overlayA);
      const b = byId.get(c.overlayB);
      if (!a || !b) continue;
      const winner = this._pickWinner(a, b);
      const loser = winner.id === a.id ? b : a;
      if (loser.status === "provisional") {
        suggestions.push({
          action: "disable",
          targetOverlayId: loser.id,
          reason: `Provisional overlay contradicts other overlay ${winner.id}`,
          command: `/plur1bus memory disable-overlay ${loser.id}`,
        });
      } else {
        suggestions.push({
          action: "supersede",
          targetOverlayId: loser.id,
          replacementDescription: winner.shiftDescription,
          reason: `Contradicts other overlay ${winner.id} (${winner.confidence ?? "no"} confidence)`,
          command: `/plur1bus memory supersede-overlay ${loser.id} ${winner.shiftDescription}`,
        });
      }
    }

    for (const prov of classified.provisional) {
      if (!relevantContradictions.some((c) => c.overlayA === prov.id || c.overlayB === prov.id)) {
        suggestions.push({
          action: "review",
          targetOverlayId: prov.id,
          reason: "Provisional overlay has not been reviewed",
          command: `/plur1bus memory overlay ${prov.id}`,
        });
      }
    }

    if (classified.active.length === 0 && classified.superseded.length > 0) {
      suggestions.push({
        action: "note",
        reason: "No active overlay; current meaning is derived from the latest supersession chain",
      });
    }

    return suggestions;
  }

  async _suggestForOverlay(lineage, involving) {
    const suggestions = [];
    const current = lineage.current;
    if (!current) return suggestions;

    if (involving.length > 0) {
      const all = await this.store.loadAllOverlays([current.targetMemoryId], {
        includeProvisional: true,
        includeSuperseded: false,
        includeDisabled: false,
        maxAgeDays: this.maxAgeDays,
      });
      const byId = new Map(all.map((o) => [o.id, o]));
      byId.set(current.id, current);
      for (const c of involving) {
        const partnerId = c.overlayA === current.id ? c.overlayB : c.overlayA;
        const partner = byId.get(partnerId);
        if (!partner) continue;
        const winner = this._pickWinner(current, partner);
        const loser = winner.id === current.id ? partner : current;
        if (loser.id === current.id) {
          suggestions.push({
            action: "supersede",
            targetOverlayId: current.id,
            replacementDescription: winner.shiftDescription,
            reason: `This overlay contradicts ${partnerId} and is the weaker interpretation`,
            command: `/plur1bus memory supersede-overlay ${current.id} ${winner.shiftDescription}`,
          });
        } else {
          suggestions.push({
            action: "resolve-partner",
            targetOverlayId: partnerId,
            reason: `This overlay contradicts ${partnerId}; consider resolving the partner`,
            command: `/plur1bus memory doctor overlay ${partnerId}`,
          });
        }
      }
    }

    if (lineage.successors.length > 0) {
      suggestions.push({
        action: "note",
        reason: `This overlay is superseded by ${lineage.successors.map((s) => s.id).join(", ")}`,
      });
    }

    return suggestions;
  }

  _pickWinner(a, b) {
    const aConf = typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : 0;
    const bConf = typeof b.confidence === "number" && Number.isFinite(b.confidence) ? b.confidence : 0;
    if (aConf !== bConf) return aConf > bConf ? a : b;
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime >= bTime ? a : b;
  }
}

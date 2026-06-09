/**
 * lib/feedback-log.js — Records user feedback on recalled memories.
 * Appends feedback entries to {workspaceDir}/.memory-feedback.jsonl
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function recordFeedback(workspaceDir, sessionId, memoryId, feedback, meta = {}) {
  if (!workspaceDir || !memoryId) return;
  try {
    const entry = JSON.stringify({
      ts: Date.now(),
      sessionId: sessionId || "",
      memoryId,
      feedback,
      ...meta,
    });
    const logPath = join(workspaceDir, ".memory-feedback.jsonl");
    appendFileSync(logPath, entry + "\n", "utf8");
  } catch {
    // non-critical — silently swallow
  }
}

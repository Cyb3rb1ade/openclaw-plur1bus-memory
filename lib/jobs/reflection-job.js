/**
 * lib/jobs/reflection-job.js — Hintergrund-Job für Meta-Reflexion.
 *
 * Läuft nach jeder Session (oder täglich), liest das Turn-Journal,
 * reflektiert über die letzte Session und aktualisiert Behavior-Cards.
 * Idempotent via run-state.
 */

import { reflectOnSession, updateBehaviorCards } from "../meta-cognition.js";

export async function runReflectionJob({ store, logger = console }) {
  if (!store) {
    logger?.warn?.("reflection-job: no store provided");
    return { ok: false, reason: "no_store" };
  }

  const turns = store.readTurns(200);
  if (turns.length === 0) {
    return { ok: false, reason: "no_turns" };
  }

  // Neuesten Turn finden (readTurns liefert jüngste zuletzt)
  const lastTurn = turns[turns.length - 1];
  const sessionId = lastTurn.sessionId || lastTurn.id || "unknown";
  const runKey = `reflection:${sessionId}`;

  if (store.hasCompletedRun(runKey)) {
    return { ok: true, reason: "already_reflected", sessionId };
  }

  // Retrieved Memories für diese Session aus Retrieval-Ledger sammeln
  const ledger = store.readRetrievalLedger(500);
  const retrievedMemories = ledger
    .filter(entry => entry.sessionId === sessionId)
    .map(entry => entry.memory || entry)
    .filter(Boolean);

  const reflection = reflectOnSession({ id: sessionId }, retrievedMemories);
  updateBehaviorCards(reflection, store);
  store.markRunCompleted(runKey, { reflectedAt: new Date().toISOString() });

  return { ok: true, sessionId, classification: reflection.classification };
}

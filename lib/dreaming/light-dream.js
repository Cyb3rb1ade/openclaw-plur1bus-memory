/**
 * lib/dreaming/light-dream.js — Nach-Session-Reflexion (Light Dreaming).
 *
 * Nach jeder echten Konversation reflektiert der Agent:
 * 1. Was war das Wichtigste?
 * 2. Welche alten Erinnerungen wurden aktiviert?
 * 3. Neue Behavior-Card-Kandidaten?
 *
 * Analog zum menschlichen "Nachdenken" direkt nach einem Gespräch.
 * Kein separater Cron — läuft im agent_end Hook, fire-and-forget.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeUuid } from "../sql-safety.js";

/**
 * Extrahiert die 3 wichtigsten Erkenntnisse einer Session via LLM.
 *
 * @param {Array} turns — Turn-Events der Session
 * @param {Object} llmCfg — { model, apiKey, baseUrl, maxTokens }
 * @param {Function} callLlm — async (messages, cfg) => string
 * @returns {Promise<{insights: string[], raw: string}>}
 */
export async function extractKeyInsights(turns, llmCfg, callLlm) {
  if (!turns || turns.length === 0) return { insights: [], raw: "" };

  // Baue einen kompakten Session-Verlauf
  const sessionText = turns
    .map((t) => `[${t.role}] ${t.content.slice(0, 300)}`)
    .join("\n");

  const prompt = `Analysiere das folgende Gespräch und extrahiere die 3 wichtigsten Erkenntnisse, Fakten oder Präferenzen, die für zukünftige Gespräche relevant sein könnten.

Gespräch:
${sessionText}

Antworte NUR mit einer JSON-Liste:
["Erkenntnis 1", "Erkenntnis 2", "Erkenntnis 3"]

Wenn es weniger als 3 wichtige Erkenntnisse gibt, gib nur die relevanten zurück. Wenn nichts Wichtiges besprochen wurde, gib eine leere Liste [] zurück.`;

  try {
    const response = await callLlm(
      [{ role: "user", content: prompt }],
      { ...llmCfg, maxTokens: 400, temperature: 0 }
    );

    if (!response) return { insights: [], raw: "" };

    // Versuche JSON zu parsen
    let insights = [];
    try {
      const parsed = JSON.parse(response);
      if (Array.isArray(parsed)) {
        insights = parsed.filter((i) => typeof i === "string" && i.length > 10);
      }
    } catch (_) {
      // Fallback: Zeilenweise extrahieren
      insights = response
        .split("\n")
        .map((l) => l.replace(/^\s*[-*•\d]+[.\)]?\s*/, "").trim())
        .filter((l) => l.length > 10 && l.length < 300);
    }

    return { insights: insights.slice(0, 3), raw: response };
  } catch (err) {
    return { insights: [], raw: "", error: err.message };
  }
}

/**
 * Findet aktivierte Memories durch Embedding-Suche der Insights.
 *
 * @param {Array} insights — Text-Erkenntnisse
 * @param {Object} db — MemoryDB-Instanz
 * @param {Object} embeddings — { embed(text) => vector }
 * @returns {Promise<Array<{entry, score}>>}
 */
export async function findActivatedMemories(insights, db, embeddings) {
  if (!insights || insights.length === 0) return [];

  const activated = [];
  const seenIds = new Set();

  for (const insight of insights) {
    try {
      const vector = await embeddings.embed(insight.slice(0, 500));
      const hits = await db.search(vector, 3, 0.25);
      for (const hit of hits) {
        if (seenIds.has(hit.entry.id)) continue;
        seenIds.add(hit.entry.id);
        activated.push(hit);
      }
    } catch (_) {
      // Einzelne Insight-Suche darf nicht alles abbrechen
    }
  }

  // Sortiere nach Score, nimm Top 5
  activated.sort((a, b) => b.score - a.score);
  return activated.slice(0, 5);
}

/**
 * Verstärkt eine Memory durch Replay-Markierung.
 *
 * @param {Object} db — MemoryDB-Instanz
 * @param {string} memoryId — ID der Memory
 * @returns {Promise<boolean>}
 */
export async function strengthenMemory(db, memoryId) {
  const safeId = safeUuid(memoryId);
  if (!safeId) return false;
  try {
    // Verwende LanceDBs table.update() für echte In-Place-Updates.
    // Das verhindert Duplikate, die bei delete+add entstehen können.
    const rows = await db.table.query().where(`id = "${safeId}"`).limit(1).toArray();
    if (rows.length === 0) return false;

    const replayCount = (rows[0].replayCount || 0) + 1;
    const lastReplayed = Date.now();

    await db.table.update({
      where: `id = "${safeId}"`,
      values: { replayCount, lastReplayed },
    });
    return true;
  } catch (err) {
    // Fallback: Falls update() nicht unterstützt wird (alte LanceDB-Version),
    // verwende delete+add als Best-Effort.
    try {
      const rows = await db.table.query().where(`id = "${safeId}"`).limit(1).toArray();
      if (rows.length === 0) return false;
      const row = rows[0];
      const replayCount = (row.replayCount || 0) + 1;
      const vector = row.vector;
      const vectorArray = Array.isArray(vector) ? vector : (vector ? Array.from(vector) : []);
      const updated = { ...row, vector: vectorArray, replayCount, lastReplayed: Date.now() };
      await db.table.delete(`id = "${safeId}"`);
      await db.table.add([updated]);
      return true;
    } catch (_) {
      return false;
    }
  }
}

/**
 * Leitet neue Behavior-Card-Kandidaten aus User-Reaktionen ab.
 *
 * @param {Array} turns — Turn-Events
 * @param {Array} reactions — Bestehende Reaction-Signale
 * @returns {Array} — Neue Behavior-Card-Kandidaten
 */
export function inferBehaviorPatternsFromDream(turns, reactions = []) {
  const patterns = [];

  // Suche nach expliziten Korrekturen/Instruktionen, die noch keine
  // Behavior-Card generiert haben
  for (const turn of turns || []) {
    if (turn.role !== "user") continue;
    const content = String(turn.content || "").toLowerCase();

    // Explizite Instruktionen
    const isInstruction =
      /\b(immer|niemals|soll|muss|musst|bitte|vergiss nicht|denk daran|achte darauf)\b/.test(content) &&
      content.length > 20;

    // Explizite Korrekturen
    const isCorrection =
      /\b(nicht so|falsch|korrigier|aber|sondern|stattdessen|eigentlich)\b/.test(content) &&
      content.length > 15;

    if (isInstruction || isCorrection) {
      // Prüfe ob es schon eine Reaction dafür gibt
      const hasReaction = reactions.some((r) =>
        r.turnId === turn.id ||
        (r.evidence && content.includes(r.evidence.slice(0, 50)))
      );

      if (!hasReaction) {
        patterns.push({
          id: randomUUID(),
          type: "behavior_candidate",
          sourceTurnId: turn.id,
          statement: turn.content.slice(0, 200),
          category: isInstruction ? "explicit_instruction" : "explicit_correction",
          confidence: isInstruction ? 0.7 : 0.6,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  return patterns;
}

/**
 * Haupt-Funktion: Light Dream nach einer Session.
 *
 * @param {Object} params
 * @param {Array} params.turns — Turn-Events der Session
 * @param {Object} params.neoStore — Neo-Store-Instanz
 * @param {Object} params.db — MemoryDB-Instanz
 * @param {Object} params.embeddings — { embed(text) => vector }
 * @param {Object} params.llmCfg — LLM-Konfiguration
 * @param {Function} params.callLlm — LLM-Call-Funktion
 * @param {Object} params.logger — { info(), warn() }
 * @returns {Promise<Object>} — Dream-Ergebnis
 */
export async function lightDream({
  turns,
  neoStore,
  db,
  embeddings,
  llmCfg,
  callLlm,
  logger = { info: () => {}, warn: () => {} },
}) {
  const startTime = Date.now();
  const dreamId = randomUUID();

  // 1. Extrahiere Key Insights
  const { insights, raw: insightsRaw, error: insightsError } = await extractKeyInsights(
    turns,
    llmCfg,
    callLlm
  );
  if (insightsError) {
    logger.warn?.(`light-dream: extractKeyInsights failed: ${insightsError}`);
  }

  // 2. Finde aktivierte Memories
  const activatedMemories = await findActivatedMemories(insights, db, embeddings);

  // 3. Verstärke aktivierte Memories
  const strengthened = [];
  for (const mem of activatedMemories) {
    const ok = await strengthenMemory(db, mem.entry.id);
    if (ok) strengthened.push(mem.entry.id);
  }

  // 4. Neue Behavior-Patterns
  const existingReactions = neoStore?.readReactions ? neoStore.readReactions(100) : [];
  const behaviorCandidates = inferBehaviorPatternsFromDream(turns, existingReactions);

  // 5. Baue Dream-Eintrag
  const dreamEntry = {
    id: dreamId,
    type: "light_dream",
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    turnCount: turns?.length || 0,
    insights,
    insightsRaw: insightsRaw?.slice(0, 1000),
    activatedMemoryIds: activatedMemories.map((m) => m.entry.id),
    activatedMemoryScores: activatedMemories.map((m) => m.score),
    strengthenedMemoryIds: strengthened,
    behaviorCandidates: behaviorCandidates.map((b) => b.id),
    hasError: Boolean(insightsError),
  };

  // 6. Schreibe in Neo-Store
  if (neoStore?.appendDreams) {
    neoStore.appendDreams([dreamEntry]);
  }

  // 7. Schreibe Behavior-Candidates
  if (behaviorCandidates.length > 0 && neoStore?.appendBehaviorCards) {
    const cards = behaviorCandidates.map((b) => ({
      id: b.id,
      workspaceKey: turns?.[0]?.workspaceKey || "default",
      agentId: turns?.[0]?.agentId,
      category: b.category,
      statement: b.statement,
      status: "candidate",
      confidence: b.confidence,
      salience: 0.5,
      sourceSignals: [b.sourceTurnId],
      embeddingStatus: "pending",
      createdAt: b.createdAt,
    }));
    neoStore.appendBehaviorCards(cards);
  }

  logger.info?.(`light-dream[${dreamId.slice(0, 8)}]: ${insights.length} insights, ${activatedMemories.length} activated, ${strengthened.length} strengthened, ${behaviorCandidates.length} behavior candidates (${dreamEntry.durationMs}ms)`);

  return {
    dreamId,
    insights,
    activatedMemoryCount: activatedMemories.length,
    strengthenedCount: strengthened.length,
    behaviorCandidateCount: behaviorCandidates.length,
    durationMs: dreamEntry.durationMs,
  };
}

/**
 * Schreibt einen Light-Dream-Eintrag in das Dream-Diary (Obsidian-Integration).
 *
 * @param {Object} dreamResult — Ergebnis von lightDream()
 * @param {string} workspaceDir — Workspace-Verzeichnis
 * @param {Array} turns — Originale Turns (für Kontext)
 */
export function writeLightDreamToVault(dreamResult, workspaceDir, turns = []) {
  try {
    const dir = join(workspaceDir, "memory", "dream-diary", "light");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const slug = `light-dream-${Date.now()}`;
    const path = join(dir, `${date}-${slug}.md`);

    const lines = [];
    lines.push("---");
    lines.push(`dream_id: ${dreamResult.dreamId}`);
    lines.push(`type: light_dream`);
    lines.push(`turn_count: ${dreamResult.insights?.length || 0}`);
    lines.push(`activated_memories: ${dreamResult.activatedMemoryCount}`);
    lines.push(`strengthened: ${dreamResult.strengthenedCount}`);
    lines.push(`behavior_candidates: ${dreamResult.behaviorCandidateCount}`);
    lines.push(`duration_ms: ${dreamResult.durationMs}`);
    lines.push(`created_at: ${new Date().toISOString()}`);
    lines.push("---");
    lines.push("");
    lines.push(`# Light Dream — ${date}`);
    lines.push("");

    if (dreamResult.insights && dreamResult.insights.length > 0) {
      lines.push("## Erkenntnisse");
      for (const insight of dreamResult.insights) {
        lines.push(`- ${insight}`);
      }
      lines.push("");
    }

    if (turns && turns.length > 0) {
      lines.push("## Session-Kontext");
      lines.push(`- Turns: ${turns.length}`);
      lines.push(`- Rollen: ${turns.map((t) => t.role).join(", ")}`);
      lines.push("");
    }

    lines.push("## Aktivierte Memories");
    lines.push(`- ${dreamResult.activatedMemoryCount} Erinnerungen wurden thematisch aktiviert`);
    lines.push(`- ${dreamResult.strengthenedCount} davon verstärkt (replayCount +1)`);
    lines.push("");

    if (dreamResult.behaviorCandidateCount > 0) {
      lines.push("## Neue Behavior-Candidates");
      lines.push(`- ${dreamResult.behaviorCandidateCount} neue Verhaltens-Kandidaten erkannt`);
      lines.push("");
    }

    appendFileSync(path, lines.join("\n") + "\n", "utf8");
    return { path, written: true };
  } catch (err) {
    return { written: false, error: err.message };
  }
}

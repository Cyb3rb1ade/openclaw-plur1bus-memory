/**
 * lib/text-utils.js — pure Text-Helpers (Tokenisierung, Similarity, Summary).
 *
 * Wird von Plugin (recall-pipeline + capture) und Doctor (dupes) gemeinsam
 * genutzt. Keine externe Dependency.
 */

/**
 * Tokenisiert Text zu einem Set unique words ≥4 Zeichen.
 * Lowercased, NFKD-normalisiert, alles außer Buchstaben/Zahlen → space.
 */
export function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(w => w.length >= 2),
  );
}

/**
 * Jaccard-Similarity zwischen zwei Texten basierend auf tokenize().
 * @returns {number} in [0, 1]; 0 wenn ein Text leer.
 */
export function jaccardSimilarity(a, b) {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Cosine-Similarity zwischen zwei Vektoren gleicher Länge.
 * @returns {number} in [-1, 1]; 0 bei verschiedenen Längen oder Null-Vektor.
 */
export function cosineSimilarityVec(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Generiert eine Summary durch Wort-Truncation.
 * Sucht die letzte vollständige Satzgrenze (., !, ?) vor maxWords.
 * Wenn keine Satzgrenze innerhalb von maxWords ± 10% gefunden wird,
 * schneidet hart am Wortende ab.
 * Acronyme gehen nicht verloren — es wird nie mitten in ein Wort geschnitten.
 * Kein LLM — pure deterministische Truncation.
 */
export function generateSummary(text, maxWords = 150) {
  const str = String(text).trim();
  const words = str.split(/\s+/);
  if (words.length <= maxWords) return str;

  const lowerBound = Math.ceil(maxWords * 0.9);

  // Position nach dem maxWords-ten Wort finden
  let wordCount = 0;
  let cutPos = 0;
  const regex = /\S+/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    wordCount++;
    if (wordCount === maxWords) {
      cutPos = match.index + match[0].length;
      break;
    }
  }

  const beforeCut = str.slice(0, cutPos);

  // Letzte Satzgrenze vor cutPos suchen, die im ±10%-Fenster liegt
  let lastBoundary = -1;
  for (let i = beforeCut.length - 1; i >= 0; i--) {
    const ch = beforeCut[i];
    if (ch === "." || ch === "!" || ch === "?") {
      const textUpToBoundary = beforeCut.slice(0, i + 1).trimEnd();
      const wordsUpToBoundary = textUpToBoundary.split(/\s+/).length;
      if (wordsUpToBoundary >= lowerBound && wordsUpToBoundary <= maxWords) {
        lastBoundary = i + 1;
        break;
      }
    }
  }

  if (lastBoundary !== -1) {
    return beforeCut.slice(0, lastBoundary).trimEnd();
  }

  // Harte Wortgrenze
  return beforeCut.trimEnd() + "…";
}

/**
 * Bestimmt die Prioritäts-Multiplikator für eine Memory.
 */
function getPriorityMultiplier(memoryClass, category) {
  if (memoryClass === "core" || category === "canonical") return 1.5;
  if (category === "project" || category === "decision") return 1.0;
  return 0.6;
}

/**
 * Komprimiert ein Array von Memories für einen Prompt unter Einhaltung
 * eines Token-Budgets (max. Wörter insgesamt).
 *
 * @param {Array<{entry:{id,text,summary,category,memoryClass}}>} memories
 * @param {number} tokenBudget — maximale Gesamtwortzahl
 * @returns {string} komprimierte, nicht-leere Memories, zeilenweise getrennt
 */
export function compressMemoriesForPrompt(memories, tokenBudget) {
  return compressMemorySlotsForPrompt(memories, tokenBudget).filter(Boolean).join("\n");
}

/**
 * Compress memories into their original aligned prompt slots.
 * @param {Array<{entry:{id,text,summary,category,memoryClass}}>} memories
 * @param {number} tokenBudget Maximum total word count.
 * @returns {string[]} One compressed string or an empty string per input memory.
 */
export function compressMemorySlotsForPrompt(memories, tokenBudget) {
  if (!memories || memories.length === 0) return [];

  const base = tokenBudget / memories.length;

  // Initiale Allokationen nach Priorität
  const allocations = memories.map((m) => {
    const mul = getPriorityMultiplier(m.entry.memoryClass, m.entry.category);
    return {
      entry: m.entry,
      maxWords: Math.max(0, Math.floor(base * mul)),
      priority: mul,
    };
  });

  let total = allocations.reduce((s, a) => s + a.maxWords, 0);

  // Wenn Budget überschritten: lower-priority Memories zuerst reduzieren
  if (total > tokenBudget) {
    let excess = total - tokenBudget;
    // Sortiere nach Priorität aufsteigend (niedrigste zuerst)
    const order = allocations
      .map((a, idx) => ({ idx, priority: a.priority }))
      .sort((a, b) => a.priority - b.priority);

    let pointer = 0;
    while (excess > 0 && pointer < order.length) {
      const currentPriority = order[pointer].priority;
      const samePriority = order.filter((o) => o.priority === currentPriority);
      let reducedInRound = true;

      while (excess > 0 && reducedInRound) {
        reducedInRound = false;
        for (const o of samePriority) {
          if (excess === 0) break;
          if (allocations[o.idx].maxWords > 0) {
            allocations[o.idx].maxWords--;
            excess--;
            reducedInRound = true;
          }
        }
      }

      pointer += samePriority.length;
    }
  }

  return allocations.map((a) => {
    if (a.maxWords <= 0) return "";
    const source = a.entry.summary || a.entry.text || "";
    return generateSummary(source, a.maxWords);
  });
}

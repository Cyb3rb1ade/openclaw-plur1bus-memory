/**
 * lib/explainability.js — Feature 6: Erklärbarkeit (XAI).
 *
 * Score-Aufschlüsselung für Memory-Recall-Results.
 */

/**
 * Erklärt ein einzelnes Result mit Score-Aufschlüsselung.
 *
 * @param {object} memoryResult — { entry: { id, ... }, score: number }
 * @param {string} query
 * @param {object} [components] — { vectorScore, importanceBoost, rerankScore, temporalBoost }
 * @returns {object} Erklärung mit breakdown + percentages
 */
export function explainResult(memoryResult, query, components = {}) {
  const resultScore = memoryResult?.score ?? 0;

  const vectorSimilarity = components?.vectorScore ?? resultScore;
  const importanceBoost = components?.importanceBoost ?? 0;
  const rerankScore = components?.rerankScore ?? 0;
  const temporalBoost = components?.temporalBoost ?? 0;

  const total = vectorSimilarity + importanceBoost + rerankScore + temporalBoost;

  const breakdown = {
    vectorSimilarity,
    importanceBoost,
    rerankScore,
    temporalBoost,
  };

  let percentages;
  if (total === 0) {
    percentages = {
      vectorSimilarity: 0,
      importanceBoost: 0,
      rerankScore: 0,
      temporalBoost: 0,
    };
  } else {
    percentages = {
      vectorSimilarity: Math.round((vectorSimilarity / total) * 100),
      importanceBoost: Math.round((importanceBoost / total) * 100),
      rerankScore: Math.round((rerankScore / total) * 100),
      temporalBoost: Math.round((temporalBoost / total) * 100),
    };
  }

  return {
    entryId: memoryResult?.entry?.id ?? null,
    query,
    breakdown,
    percentages,
  };
}

/**
 * Rendert eine Erklärung als menschenlesbaren Text.
 *
 * @param {object} explanation — Output von explainResult
 * @param {string} [lang="de"] — "de" | "en"
 * @returns {string}
 */
export function renderExplanation(explanation, lang = "de") {
  const p = explanation?.percentages ?? {};
  const parts = [];

  if (p.vectorSimilarity > 0) {
    parts.push(
      lang === "de"
        ? `${p.vectorSimilarity}% semantische Ähnlichkeit`
        : `${p.vectorSimilarity}% semantic similarity`
    );
  }
  if (p.importanceBoost > 0) {
    parts.push(
      lang === "de"
        ? `${p.importanceBoost}% Importance-Boost`
        : `${p.importanceBoost}% importance boost`
    );
  }
  if (p.rerankScore > 0) {
    parts.push(
      lang === "de"
        ? `${p.rerankScore}% Reranker`
        : `${p.rerankScore}% reranker`
    );
  }
  if (p.temporalBoost > 0) {
    parts.push(
      lang === "de"
        ? `${p.temporalBoost}% zeitliche Nähe`
        : `${p.temporalBoost}% temporal proximity`
    );
  }

  const header = lang === "de" ? "Abgerufen wegen:" : "Retrieved because of:";

  if (parts.length === 0) {
    return lang === "de"
      ? `${header} keine erkennbaren Faktoren`
      : `${header} no discernible factors`;
  }

  return `${header} ${parts.join(lang === "de" ? " + " : " + ")}`;
}

/**
 * Erklärt eine Liste von Results.
 *
 * @param {Array} results — [{ entry, score }, ...]
 * @param {string} query
 * @param {object} [opts] — { componentsFn(result, index) → components object }
 * @returns {Array} Erklärungen
 */
export function explainResults(results, query, opts = {}) {
  if (!Array.isArray(results) || results.length === 0) return [];

  const { componentsFn } = opts;
  return results.map((r, i) => {
    const components = typeof componentsFn === "function"
      ? componentsFn(r, i)
      : undefined;
    return explainResult(r, query, components);
  });
}

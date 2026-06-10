/**
 * lib/pattern-detector-embedding.js — Embedding-basierte Pattern-Erkennung.
 *
 * Cluster Turns nach Embedding-Similarity (Cosine).
 * Kein HDBSCAN — einfacher Threshold + Deduplication.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Berechnet Cosine-Similarity zweier Vektoren.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Berechnet den Centroid über mehrere Vektoren.
 * @param {number[][]} vectors
 * @returns {number[]}
 */
export function computeCentroid(vectors) {
  if (!vectors?.length) return [];
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] += v[i];
    }
  }
  return sum.map((s) => s / vectors.length);
}

function getTimestamp(turn) {
  if (typeof turn.createdAt === "number") return turn.createdAt;
  if (typeof turn.timestamp === "number") return turn.timestamp;
  if (typeof turn.createdAt === "string") return new Date(turn.createdAt).getTime();
  if (typeof turn.timestamp === "string") return new Date(turn.timestamp).getTime();
  return Date.now();
}

function getText(turn) {
  return String(turn.content || turn.prompt || turn.response || turn.text || "").trim();
}

function hourOf(ts) {
  return new Date(ts).getUTCHours();
}

function weekdayOf(ts) {
  return new Date(ts).getUTCDay();
}

function diversityScore(timestamps) {
  if (timestamps.length < 2) return 0;
  const hours = new Set(timestamps.map(hourOf));
  const weekdays = new Set(timestamps.map(weekdayOf));
  const hourScore = Math.min(hours.size / 4, 1);
  const weekdayScore = Math.min(weekdays.size / 3, 1);
  return (hourScore + weekdayScore) / 2;
}

/**
 * Cluster Turns nach Embedding-Similarity.
 *
 * @param {Array<{id:string, text?:string, content?:string, ...}>} turns
 * @param {(text:string) => Promise<number[]>|number[]} embedFn — Text → Embedding-Vektor
 * @param {object} [options]
 * @param {number} [options.threshold=0.82] — Cosine-Similarity-Threshold für Cluster-Zugehörigkeit
 * @param {number} [options.minClusterSize=2] — Minimale Cluster-Größe
 * @param {number} [options.lookbackDays=30] — Nur Turns aus diesem Zeitraum betrachten
 * @param {number} [options.now=Date.now()]
 * @returns {Promise<Array<{clusterId:string, turnIds:string[], representative:string, centroid:number[], score:number, occurrences:number, timestamps:number[], timeDiversity:number, recencyHours:number}>>}
 */
export async function clusterTurnsByEmbedding(turns, embedFn, options = {}) {
  const threshold = options.threshold ?? 0.82;
  const minClusterSize = options.minClusterSize ?? 2;
  const lookbackDays = options.lookbackDays ?? 30;
  const now = options.now || Date.now();
  const cutoff = now - lookbackDays * DAY_MS;

  // Filtere leere Turns und alte Turns
  const validTurns = turns.filter((t) => {
    const ts = getTimestamp(t);
    return ts >= cutoff && getText(t).length > 0;
  });

  if (validTurns.length === 0) return [];

  // Generiere Embeddings
  const embeddings = [];
  for (const turn of validTurns) {
    try {
      const vec = await embedFn(getText(turn));
      embeddings.push({ turn, vec });
    } catch (_) {
      // Ignoriere Turns, die nicht embedded werden können
    }
  }

  if (embeddings.length === 0) return [];

  // Greedy-Clustering: Ähnlichste Embeddings zusammenfassen
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < embeddings.length; i++) {
    if (assigned.has(i)) continue;

    const clusterMembers = [embeddings[i]];
    assigned.add(i);

    for (let j = i + 1; j < embeddings.length; j++) {
      if (assigned.has(j)) continue;
      // Vergleiche mit dem ersten Member (später könnte man mit Centroid vergleichen)
      const sim = cosineSimilarity(embeddings[i].vec, embeddings[j].vec);
      if (sim >= threshold) {
        clusterMembers.push(embeddings[j]);
        assigned.add(j);
      }
    }

    if (clusterMembers.length >= minClusterSize) {
      const turnIds = clusterMembers.map((m) => m.turn.id || m.turn.turnId || "unknown");
      const texts = clusterMembers.map((m) => getText(m.turn));
      const timestamps = clusterMembers.map((m) => getTimestamp(m.turn)).sort((a, b) => a - b);
      const vectors = clusterMembers.map((m) => m.vec);
      const centroid = computeCentroid(vectors);

      // Representative = Text, der am nächsten am Centroid liegt
      let bestIdx = 0;
      let bestSim = -1;
      for (let k = 0; k < vectors.length; k++) {
        const sim = cosineSimilarity(centroid, vectors[k]);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = k;
        }
      }
      const representative = texts[bestIdx];

      const mostRecent = timestamps[timestamps.length - 1];
      const recencyHours = (now - mostRecent) / HOUR_MS;
      const timeDiversity = diversityScore(timestamps);
      const occurrences = timestamps.length;

      clusters.push({
        clusterId: `cluster-${representative.slice(0, 20).replace(/\s+/g, "-")}-${now}`,
        turnIds,
        representative,
        centroid,
        occurrences,
        timestamps,
        timeDiversity,
        recencyHours,
      });
    }
  }

  // Score berechnen und sortieren
  for (const c of clusters) {
    c.score = scorePattern(c);
  }

  return clusters.sort((a, b) => b.score - a.score);
}

/**
 * Berechnet einen Relevanz-Score für ein Cluster-Pattern.
 *
 * Score = Häufigkeit × Aktualität × Diversität
 *
 * @param {object} cluster
 * @returns {number} 0..1
 */
function scorePattern(cluster) {
  const occurrences = cluster.occurrences || 0;
  const recencyHours = cluster.recencyHours ?? 0;
  const timeDiversity = cluster.timeDiversity ?? 0;

  // Häufigkeit: sublinear, maximiert bei ~10 Vorkommen
  const frequency = Math.min(Math.log1p(occurrences) / Math.log1p(10), 1);

  // Aktualität: exponentieller Abfall, Halbwertszeit 168h (1 Woche)
  const recency = Math.exp(-recencyHours / 168);

  // Diversität: direkt 0..1
  const diversity = Math.min(Math.max(timeDiversity, 0), 1);

  return Math.min(frequency * recency * diversity, 1);
}

const TECH_TERMS = new Set([
  "node", "nodejs", "node.js", "react", "vue", "angular", "svelte",
  "postgres", "postgresql", "mysql", "mongodb", "sqlite", "redis",
  "auth-service", "auth service", "auth", "oauth", "jwt",
]);

const DATABASE_TERMS = new Set([
  "postgres", "postgresql", "mysql", "mongodb", "sqlite", "redis", "mariadb", "dynamodb",
]);

const NEGATION_MARKERS = new Set([
  "nicht", "nicht mehr", "kein", "keine", "never", "no longer", "not",
  "instead", "statt", "rather", "sondern",
]);

const TEMPORAL_MARKERS = new Set([
  "früher", "jetzt", "nun", "now", "previously", "before", "after",
  "später", "damals", "currently", "formerly", "statt", "instead",
]);

const STOP_WORDS = new Set([
  "ein", "eine", "einer", "einen", "einem", "eines",
  "der", "die", "das", "den", "dem", "des",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "ist", "sind", "war", "waren", "be", "is", "are", "was", "were",
  "es", "it", "its", "sie", "er", "ihn", "ihm",
  "mag", "likes", "like", "prefers", "prefer", "nutzt", "uses", "use", "nutzen",
  "auf", "on", "in", "im", "bei",
]);

const ENTITY_IGNORE = new Set([
  "user", "the", "deployment", "projekt", "project", "eine", "einer", "eines", "einem", "einen",
  "ist", "sind", "war", "waren", "be", "is", "are", "was", "were", "es", "it", "its",
  "sie", "er", "ihn", "ihm", "mag", "likes", "like", "prefers", "prefer", "nutzt", "uses",
  "use", "nutzen", "auf", "on", "in", "im", "bei", "ein", "a", "an", "and", "or", "of",
  "to", "for", "with", "der", "die", "das", "den", "dem", "des",
  // Descriptive/meta words that are capitalised at sentence start or used as adjectives
  // rather than as named entities.
  "original", "additional", "another", "new", "old", "main", "current", "former", "previous", "next",
  "same", "different", "first", "second", "third", "latest", "final", "initial", "basic",
  "general", "specific", "common", "actual", "total", "full", "partial", "complete",
]);

const TECH_SYNONYMS = {
  "node.js": "node",
  "nodejs": "node",
  "postgresql": "postgres",
};

export function normalizeMemoryText(text) {
  if (typeof text !== "string") return "";
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeTech(term) {
  return TECH_SYNONYMS[term] || term;
}

function stemContentTerm(term) {
  // Very light English/German plural normalisation: drop a trailing "s"
  // unless the word ends in "ss" (e.g. "address", "bus").
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) {
    return term.slice(0, -1);
  }
  return term;
}

function extractEntitiesFromOriginal(text) {
  const entities = new Set();
  if (typeof text !== "string") return entities;
  // Match titlecase words and hyphenated compounds like "Auth-Service" or "Node.js".
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const clean = w.replace(/[^\p{L}\p{N}\-]/gu, "");
    if (/^[A-ZÄÖÜ][a-zäöüß\-]*(?:\.[a-z]+)?$/u.test(clean) && clean.length > 1) {
      const lower = clean.toLowerCase();
      if (ENTITY_IGNORE.has(lower) || TECH_TERMS.has(lower) || DATABASE_TERMS.has(lower)) continue;
      entities.add(lower);
      if (i + 1 < words.length) {
        const next = words[i + 1].replace(/[^\p{L}\p{N}\-]/gu, "");
        if (/^[A-ZÄÖÜ][a-zäöüß\-]*(?:\.[a-z]+)?$/u.test(next) && next.length > 1) {
          const nextLower = next.toLowerCase();
          if (!ENTITY_IGNORE.has(nextLower) && !TECH_TERMS.has(nextLower) && !DATABASE_TERMS.has(nextLower)) {
            entities.add(`${lower} ${nextLower}`);
          }
        }
      }
    }
  }
  return entities;
}

export function extractSalientTerms(text) {
  const normalized = normalizeMemoryText(text);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const numbers = new Set();
  const versions = new Set();
  const entities = extractEntitiesFromOriginal(text);
  const technologies = new Set();
  const databases = new Set();
  const contentTerms = new Set();
  let hasNegation = false;
  let hasTemporalMarker = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\d+(\.\d+)?$/.test(token)) {
      numbers.add(token);
      if (i > 0) versions.add(`${tokens[i - 1]} ${token}`);
      continue;
    }
    if (TECH_TERMS.has(token)) technologies.add(token);
    if (DATABASE_TERMS.has(token)) databases.add(token);
    if (NEGATION_MARKERS.has(token)) hasNegation = true;
    if (TEMPORAL_MARKERS.has(token)) hasTemporalMarker = true;
    if (!STOP_WORDS.has(token) && !ENTITY_IGNORE.has(token) && token.length > 1) {
      contentTerms.add(stemContentTerm(token));
    }
  }

  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    if (TECH_TERMS.has(bigram)) technologies.add(bigram);
    if (DATABASE_TERMS.has(bigram)) databases.add(bigram);
    if (NEGATION_MARKERS.has(bigram)) hasNegation = true;
    if (TEMPORAL_MARKERS.has(bigram)) hasTemporalMarker = true;
  }

  return { numbers, versions, entities, technologies, databases, contentTerms, hasNegation, hasTemporalMarker };
}

export function extractStructuredDifferences(a, b) {
  const termsA = extractSalientTerms(a);
  const termsB = extractSalientTerms(b);
  const differences = [];

  const numsA = new Set([...termsA.numbers].map(canonicalizeTech));
  const numsB = new Set([...termsB.numbers].map(canonicalizeTech));
  for (const n of numsA) if (!numsB.has(n)) differences.push({ type: "number", value: n, side: "a" });
  for (const n of numsB) if (!numsA.has(n)) differences.push({ type: "number", value: n, side: "b" });

  const techA = new Set([...termsA.technologies, ...termsA.databases].map(canonicalizeTech));
  const techB = new Set([...termsB.technologies, ...termsB.databases].map(canonicalizeTech));
  for (const t of techA) if (!techB.has(t)) differences.push({ type: "technology", value: t, side: "a" });
  for (const t of techB) if (!techA.has(t)) differences.push({ type: "technology", value: t, side: "b" });

  const entitiesA = new Set([...termsA.entities].map((e) => canonicalizeTech(e)));
  const entitiesB = new Set([...termsB.entities].map((e) => canonicalizeTech(e)));
  const unmatchedA = [...entitiesA].filter((e) => !entitiesB.has(e));
  const unmatchedB = [...entitiesB].filter((e) => !entitiesA.has(e));
  if (unmatchedA.length > 0) differences.push({ type: "entity", values: unmatchedA, side: "a" });
  if (unmatchedB.length > 0) differences.push({ type: "entity", values: unmatchedB, side: "b" });

  if (termsA.hasNegation !== termsB.hasNegation) {
    differences.push({ type: "negation" });
  }
  if (termsA.hasTemporalMarker !== termsB.hasTemporalMarker) {
    differences.push({ type: "temporal" });
  }

  // If both texts mention the same entity but describe it with different content,
  // that is a meaningful difference (e.g. "Dreamdale is a festival" vs "Dreamdale is a city").
  const sharedEntities = [...entitiesA].filter((e) => entitiesB.has(e));
  if (sharedEntities.length > 0) {
    const contentA = new Set([...termsA.contentTerms].filter((t) => !entitiesA.has(t)));
    const contentB = new Set([...termsB.contentTerms].filter((t) => !entitiesB.has(t)));
    const overlap = [...contentA].filter((t) => contentB.has(t));
    const unionSize = new Set([...contentA, ...contentB]).size;
    if (unionSize > 0 && overlap.length / unionSize < 0.5) {
      differences.push({ type: "shared_entity_divergent_facts" });
    }
  }

  return differences;
}

export function hasMeaningfulDifference(a, b) {
  if (a === b) return false;
  const na = normalizeMemoryText(a);
  const nb = normalizeMemoryText(b);
  if (na === nb) return false;
  // Role reversal: the same significant-token multiset in a different order
  // ("Erik->Eva" vs "Eva->Erik") is a distinct fact, even when no structured
  // entity/number difference is detected (which would early-return false below).
  // Requiring an identical multiset (not just high overlap) excludes extra-token
  // and tech-synonym variants — those are not reorderings.
  {
    const sig = (s) => normalizeMemoryText(s).split(/\s+/).filter((t) => t && !STOP_WORDS.has(t));
    const seqA = sig(a);
    const seqB = sig(b);
    if (seqA.length >= 2 && seqA.length === seqB.length) {
      const sameMultiset = [...seqA].sort().join(" ") === [...seqB].sort().join(" ");
      const sameOrder = seqA.join(" ") === seqB.join(" ");
      if (sameMultiset && !sameOrder) return true;
    }
  }
  const diffs = extractStructuredDifferences(a, b);
  if (diffs.length === 0) return false;
  // If the only flagged difference is divergent facts around a shared entity,
  // but the texts are otherwise highly overlapping (e.g. single-word variants
  // like "intern" vs "extern"), let the LLM decide instead of pre-blocking.
  const nonShared = diffs.filter((d) => d.type !== "shared_entity_divergent_facts");
  if (nonShared.length > 0) return true;
  const tokensA = na.split(/\s+/).filter(Boolean);
  const tokensB = nb.split(/\s+/).filter(Boolean);
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = new Set([...tokensA].filter((t) => setB.has(t))).size;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union > 0 ? intersection / union : 0;
  return jaccard < 0.8;
}

export function isSafeDuplicate(a, b) {
  if (a === b) return true;
  const na = normalizeMemoryText(a);
  const nb = normalizeMemoryText(b);
  if (na === nb) return true;
  // Compare the canonicalized token SEQUENCE (in order), not a sorted multiset —
  // sorting collapses role-reversed facts ("Erik->Eva" vs "Eva->Erik") into one.
  // Genuine reorderings are then caught as a meaningful difference below.
  const canonA = na.split(/\s+/).map(canonicalizeTech).join(" ");
  const canonB = nb.split(/\s+/).map(canonicalizeTech).join(" ");
  if (canonA === canonB) return true;
  if (hasMeaningfulDifference(a, b)) return false;
  // Even when no structured difference is detected, only treat very high-overlap
  // variants as duplicates. Lower overlap should reach the merge check so the LLM
  // can combine complementary phrasing instead of silently dropping the new text.
  // Stop words are ignored so that adding/removing an article does not push an
  // otherwise identical memory into the merge path.
  const tokensA = na.split(/\s+/).filter((t) => t && !STOP_WORDS.has(t));
  const tokensB = nb.split(/\s+/).filter((t) => t && !STOP_WORDS.has(t));
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = new Set([...tokensA].filter((t) => setB.has(t))).size;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union > 0 ? intersection / union : 0;
  return jaccard >= 0.9;
}

export function validateMergedTextPreservesFacts(originalA, originalB, mergedText) {
  if (typeof mergedText !== "string" || mergedText.trim().length === 0) return false;
  const merged = extractSalientTerms(mergedText);
  const termsA = extractSalientTerms(originalA);
  const termsB = extractSalientTerms(originalB);

  function covers(sourceTerms, mergedTerms) {
    for (const n of sourceTerms.numbers) {
      if (!mergedTerms.numbers.has(n)) return false;
    }
    for (const t of sourceTerms.technologies) {
      if (!mergedTerms.technologies.has(t) && !mergedTerms.databases.has(t)) return false;
    }
    for (const d of sourceTerms.databases) {
      if (!mergedTerms.databases.has(d) && !mergedTerms.technologies.has(d)) return false;
    }
    for (const e of sourceTerms.entities) {
      if (!mergedTerms.entities.has(e)) return false;
    }
    for (const c of sourceTerms.contentTerms) {
      if (!mergedTerms.contentTerms.has(c)) return false;
    }
    if (sourceTerms.hasNegation && !mergedTerms.hasNegation) return false;
    if (sourceTerms.hasTemporalMarker && !mergedTerms.hasTemporalMarker) return false;
    return true;
  }

  return covers(termsA, merged) && covers(termsB, merged);
}

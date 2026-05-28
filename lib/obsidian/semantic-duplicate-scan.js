import { buildRecordIndex } from "./record-index.js";
import { writeRecords } from "./record-writer.js";

const DEFAULT_MAX_PAIRWISE_RECORDS = 2_000;
const DEFAULT_MAX_BUCKET_SIZE = 200;
const DEFAULT_MAX_PROPOSALS = 500;

function tokenSet(text) {
  return new Set(String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 2));
}

function jaccardSets(aa, bb) {
  if (!aa.size || !bb.size) return 0;
  const [small, large] = aa.size <= bb.size ? [aa, bb] : [bb, aa];
  let inter = 0;
  for (const token of small) {
    if (large.has(token)) inter += 1;
  }
  return inter / (aa.size + bb.size - inter);
}

function normalizedDuplicateText(record) {
  return String(record.summary || record.body || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function duplicateProposal(a, b, score) {
  return {
    type: "duplicate_candidate",
    id: `dup-${a.plur1bus_id || a.id}-${b.plur1bus_id || b.id}`.slice(0, 100),
    status: "pending",
    risk: "medium",
    summary: "Likely duplicate record candidate.",
    sourceRefs: [a.path, b.path].filter(Boolean),
    confidence: Number(score.toFixed(2)),
  };
}

function compareRecords(records, threshold, options = {}) {
  const proposals = [];
  const prepared = records.map((record) => ({
    record,
    tokens: tokenSet(record.summary || record.body),
  }));
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const score = jaccardSets(prepared[i].tokens, prepared[j].tokens);
      if (score >= threshold) {
        proposals.push(duplicateProposal(prepared[i].record, prepared[j].record, score));
        if (proposals.length >= (options.maxProposals || DEFAULT_MAX_PROPOSALS)) return proposals;
      }
    }
  }
  return proposals;
}

function bucketedDuplicateScan(records, threshold, options = {}) {
  const maxBucketSize = Number(options.maxBucketSize || DEFAULT_MAX_BUCKET_SIZE);
  const maxProposals = Number(options.maxProposals || DEFAULT_MAX_PROPOSALS);
  const buckets = new Map();
  for (const record of records) {
    const text = normalizedDuplicateText(record);
    if (!text) continue;
    const key = `${record.type || record.plur1bus_type || "record"}:${text}`;
    if (!buckets.has(key)) buckets.set(key, []);
    const bucket = buckets.get(key);
    if (bucket.length < maxBucketSize) bucket.push(record);
  }
  const proposals = [];
  let bucketedRecords = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucketedRecords += bucket.length;
    proposals.push(...compareRecords(bucket, threshold, { maxProposals: maxProposals - proposals.length }));
    if (proposals.length >= maxProposals) break;
  }
  return { proposals, bucketedRecords };
}

export function scanSemanticDuplicates(rawConfig, options = {}) {
  const records = buildRecordIndex(rawConfig, options).records;
  const threshold = Number(options.threshold || 0.75);
  const maxPairwiseRecords = Number(options.maxPairwiseRecords || DEFAULT_MAX_PAIRWISE_RECORDS);
  const exhaustive = records.length <= maxPairwiseRecords;
  const scan = exhaustive
    ? { proposals: compareRecords(records, threshold, options), bucketedRecords: records.length }
    : bucketedDuplicateScan(records, threshold, options);
  const proposals = scan.proposals;
  writeRecords(rawConfig, proposals, options);
  return {
    ok: true,
    proposals,
    count: proposals.length,
    mode: exhaustive ? "exhaustive" : "bounded",
    recordsScanned: records.length,
    bucketedRecords: scan.bucketedRecords,
    skippedExhaustive: !exhaustive,
    maxPairwiseRecords,
  };
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./safe-paths.js";

const INDEX_PATH_REL = ".plur1bus/link-index.json";

export function computeContentHash(record) {
  const raw = (record.text || "") + ":" + (record.summary || "");
  return "sha256:" + createHash("sha256").update(raw, "utf8").digest("hex");
}

export function loadLinkIndex(vaultPath) {
  const indexPath = join(vaultPath, INDEX_PATH_REL);
  if (!existsSync(indexPath)) return { version: "1", entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
    if (!parsed.entries || typeof parsed.entries !== "object") return { version: "1", entries: {} };
    return parsed;
  } catch {
    return { version: "1", entries: {} };
  }
}

export function saveLinkIndex(vaultPath, index) {
  const indexPath = join(vaultPath, INDEX_PATH_REL);
  atomicWriteText(indexPath, JSON.stringify({ ...index, generatedAt: new Date().toISOString() }, null, 2));
}

export function buildPriorityQueue(records, existingIndex) {
  const entries = (existingIndex && typeof existingIndex.entries === "object") ? existingIndex.entries : {};
  const withId = records.filter((r) => r.plur1bus_id);
  const neverProcessed = withId.filter((r) => !entries[r.plur1bus_id]);
  const processed = withId
    .filter((r) => entries[r.plur1bus_id])
    .sort((a, b) => {
      const ta = entries[a.plur1bus_id]?.lastCheckedAt || "0";
      const tb = entries[b.plur1bus_id]?.lastCheckedAt || "0";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  return [...neverProcessed, ...processed];
}

#!/usr/bin/env node
/**
 * fix-group-origins.mjs — Retroaktiver Fix für falsch klassifizierte Gruppen-Erinnerungen
 *
 * Scannt alle Session-Dateien von main, bernhardine und heisenberg.
 * Gruppen-Sessions (erkennbar an is_group_chat:true in Metadaten) werden neu
 * verarbeitet: bestehende "dm"-Einträge die aus Gruppen stammen werden auf
 * origin:"group" korrigiert und mit Sender-Attribution versehen.
 *
 * Usage: OPENAI_API_KEY=... node fix-group-origins.mjs [--dry-run] [agentId...]
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const HOME = homedir();
const BASE = join(HOME, ".openclaw");
const AGENTS_DIR = join(BASE, "agents");
const BASE_DB_PATH = join(BASE, "memory", "lancedb-namespaced");
const PLUGIN_DIR = join(BASE, "extensions", "memory-lancedb-namespaced");
const LANCEDB_PATH = join(PLUGIN_DIR, "../memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js");
const OPENAI_PATH = join(PLUGIN_DIR, "../memory-lancedb-stock/node_modules/openai/index.js");
const TARGET_AGENTS = ["main", "bernhardine", "heisenberg"];
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-large";
const MATCH_THRESHOLD = 0.97; // Sehr hohe Ähnlichkeit für sicheres Matching
const MIN_TEXT_LEN = 10;

let lancedb, OpenAI;

async function init() {
  lancedb = await import(LANCEDB_PATH);
  const mod = await import(OPENAI_PATH);
  OpenAI = mod.default || mod.OpenAI;
}

function createEmbeddings(apiKey) {
  const openai = new OpenAI({ apiKey });
  return {
    async embed(text) {
      const resp = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000),
        encoding_format: "float",
        dimensions: 3072,
      });
      return Array.from(resp.data[0].embedding);
    },
  };
}

// Dieselbe Logik wie in auto-capture-lancedb.mjs
function parseSessionContext(messages) {
  let isGroup = false;
  let groupSubject = "";
  const senderByPosition = new Map();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const m = msg.message || msg;
    const role = m.role;
    const content = m.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
    }
    if (!text) continue;

    if (/"is_group_chat"\s*:\s*true/.test(text)) isGroup = true;
    const subjMatch = text.match(/"group_subject"\s*:\s*"([^"]+)"/);
    if (subjMatch) groupSubject = subjMatch[1];

    if (role === "" || role === undefined || role === null) {
      const senderMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
      const usernameMatch = text.match(/"username"\s*:\s*"([^"]+)"/);
      if (senderMatch || usernameMatch) {
        for (let j = i + 1; j < messages.length; j++) {
          const nextMsg = messages[j].message || messages[j];
          if (nextMsg.role === "user") {
            senderByPosition.set(j, {
              name: senderMatch?.[1] || "",
              username: usernameMatch?.[1] || "",
            });
            break;
          }
        }
      }
    }

    if (role === "user") {
      const inlineSender = text.match(/"sender"\s*:\s*"([^"]+)"/);
      const inlineUsername = text.match(/"username"\s*:\s*"([^"]+)"/);
      if ((inlineSender || inlineUsername) && !senderByPosition.has(i)) {
        senderByPosition.set(i, {
          name: inlineSender?.[1] || "",
          username: inlineUsername?.[1] || "",
        });
      }
    }
  }

  return { isGroup, groupSubject, senderByPosition };
}

const INJECTED_RE = /<\/?plur1bus-recall|<\/?relevant-memories|<\/?knowledge-update-reminder|<\/?adaptive-learning|TTS-STATUS|heartbeat_ok|"chat_id"\s*:\s*"telegram:|"message_id"\s*:\s*"/i;

function extractCleanUserText(rawText) {
  const endMarkers = ["</knowledge-update-reminder>", "</relevant-memories>", "</adaptive-learning>"];
  for (const marker of endMarkers) {
    const idx = rawText.lastIndexOf(marker);
    if (idx === -1) continue;
    let rest = rawText.slice(idx + marker.length).trim();
    rest = rest.replace(/```json[\s\S]*?```/g, "").trim();
    if (rest.length >= MIN_TEXT_LEN) return rest;
  }
  const parts = rawText.split("```");
  if (parts.length > 1) {
    const last = parts[parts.length - 1].trim();
    if (last.length >= MIN_TEXT_LEN) return last;
  }
  return rawText.trim();
}

// Extrahiert alle sauberen Texte aus einer Gruppen-Session
function extractGroupTexts(messages, ctx) {
  const { groupSubject, senderByPosition } = ctx;
  const items = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const m = msg.message || msg;
    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = m.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
    }
    if (!text.trim()) continue;

    let cleanedText = text.trim();
    if (INJECTED_RE.test(cleanedText)) {
      if (role === "assistant") continue; // Injizierter Content als Assistant → komplett überspringen
      // Bei User: versuche echten Text zu extrahieren
      cleanedText = extractCleanUserText(cleanedText);
      if (INJECTED_RE.test(cleanedText) || cleanedText.length < MIN_TEXT_LEN) continue;
    }
    if (cleanedText.length < MIN_TEXT_LEN) continue;

    let senderLabel = "";
    let prefix = role === "user" ? "User: " : "Assistant: ";

    if (role === "user") {
      const senderInfo = senderByPosition.get(i);
      if (senderInfo?.name || senderInfo?.username) {
        const name = senderInfo.name || senderInfo.username;
        const uname = senderInfo.username ? ` (@${senderInfo.username})` : "";
        senderLabel = `${name}${uname}`;
        prefix = `[Gruppe${groupSubject ? `: ${groupSubject}` : ""}] ${name}${uname}: `;
      } else {
        prefix = groupSubject ? `[Gruppe: ${groupSubject}] User: ` : "[Gruppe] User: ";
      }
    }

    items.push({
      text: prefix + cleanedText,
      rawText: cleanedText,
      role,
      senderLabel,
      // Für Matching: auch den "alten" dm-Prefix-Text als Kandidat
      oldDmText: (role === "user" ? "User: " : "Assistant: ") + cleanedText,
    });
  }

  return items;
}

function isSessionFile(name) {
  if (!name.endsWith(".jsonl")) return false;
  if (name.includes(".trajectory.")) return false;
  if (name.includes(".checkpoint.")) return false;
  if (name.includes(".deleted.")) return false;
  return true;
}

function distanceToScore(d) {
  return Math.max(0, Math.min(1, 1 - d / 2));
}

async function fixAgent(agentId, embeddings, dryRun) {
  const processedIds = new Set(); // verhindert Doppel-Updates desselben Eintrags
  const sessionsDir = join(AGENTS_DIR, agentId, "sessions");
  if (!existsSync(sessionsDir)) {
    console.log(`[${agentId}] sessions dir not found, skipping`);
    return;
  }

  const dbPath = join(BASE_DB_PATH, agentId);
  if (!existsSync(dbPath)) {
    console.log(`[${agentId}] no LanceDB found, skipping`);
    return;
  }

  const db = await lancedb.connect(dbPath);
  const tables = await db.tableNames();
  if (!tables.includes("memories")) {
    console.log(`[${agentId}] no memories table, skipping`);
    return;
  }
  const table = await db.openTable("memories");

  // Alle Session-Dateien laden und Gruppen-Sessions identifizieren
  const sessionFiles = readdirSync(sessionsDir)
    .filter(isSessionFile)
    .map(f => join(sessionsDir, f))
    .filter(f => statSync(f).size > 0);

  console.log(`[${agentId}] scanning ${sessionFiles.length} session files...`);

  let groupSessionCount = 0;
  let totalUpdated = 0;
  let totalAdded = 0;

  for (const filePath of sessionFiles) {
    let rawLines;
    try {
      rawLines = readFileSync(filePath, "utf8").split("\n").filter(l => l.trim());
    } catch { continue; }

    const messages = [];
    for (const line of rawLines) {
      try { messages.push(JSON.parse(line)); } catch {}
    }

    const ctx = parseSessionContext(messages);
    if (!ctx.isGroup) continue;

    groupSessionCount++;
    const groupTexts = extractGroupTexts(messages, ctx);
    if (groupTexts.length === 0) continue;

    console.log(`[${agentId}] group session: ${filePath.split("/").pop()} (${ctx.groupSubject || "no subject"}) — ${groupTexts.length} texts`);

    for (const item of groupTexts) {
      try {
        // Suche erst nach dem alten "dm"-Text (wie er bisher gespeichert war)
        const searchText = item.oldDmText.slice(0, 8000);
        const searchVector = await embeddings.embed(searchText);

        // Top-Match in LanceDB finden
        const results = await table.search(searchVector).limit(3).toArray();

        let matched = null;
        for (const r of results) {
          const score = distanceToScore(r._distance ?? 0);
          if (score >= MATCH_THRESHOLD && r.origin === "dm") {
            matched = r;
            break;
          }
        }

        if (matched) {
          if (processedIds.has(matched.id)) continue; // Duplikat überspringen
          processedIds.add(matched.id);
          // Bestehenden Eintrag auf "group" umstellen via delete + re-add
          if (!dryRun) {
            await table.delete(`id = '${matched.id}'`);
            const newEvidenceQuote = item.senderLabel
              ? `[${item.senderLabel}] ${item.rawText.slice(0, 180)}`.slice(0, 200)
              : item.rawText.slice(0, 200);
            // Neues Embedding für den aktualisierten Text (mit Sender-Präfix)
            const newVector = await embeddings.embed(item.text.slice(0, 8000));
            await table.add([{
              id: matched.id, // ID beibehalten
              text: item.text,
              summary: item.text.replace(/\s+/g, " ").trim().split(" ").slice(0, 150).join(" "),
              origin: "group",
              vector: newVector,
              importance: matched.importance ?? 0.7,
              category: matched.category ?? "other",
              createdAt: matched.createdAt ?? Date.now(),
              mergedFrom: matched.mergedFrom ?? "[]",
              expiresAt: matched.expiresAt ?? 0,
              storedBy: matched.storedBy ?? "",
              sourceTurnId: matched.sourceTurnId ?? "",
              sourceMessageRole: matched.sourceMessageRole ?? item.role,
              sourceTimestamp: matched.sourceTimestamp ?? 0,
              sourceUrl: matched.sourceUrl ?? "",
              evidenceQuote: newEvidenceQuote,
              scope: matched.scope ?? "agent-private",
            }]);
          }
          console.log(`  ${dryRun ? "[dry]" : ""} updated: ${matched.id.slice(0, 8)}... dm→group | ${item.text.slice(0, 60)}...`);
          totalUpdated++;
        } else {
          // Kein passender dm-Eintrag — als neuen group-Eintrag hinzufügen
          // Nur wenn nicht bereits als "group" vorhanden (dedup)
          const groupCheckVector = await embeddings.embed(item.text.slice(0, 8000));
          const existing = await table.search(groupCheckVector).limit(1).toArray();
          const existingScore = existing.length > 0 ? distanceToScore(existing[0]._distance ?? 0) : 0;
          if (existingScore >= 0.97) {
            console.log(`  skip (already exists): ${item.text.slice(0, 60)}...`);
            continue;
          }

          if (!dryRun) {
            const evidenceQuote = item.senderLabel
              ? `[${item.senderLabel}] ${item.rawText.slice(0, 180)}`.slice(0, 200)
              : item.rawText.slice(0, 200);
            await table.add([{
              id: randomUUID(),
              text: item.text,
              summary: item.text.replace(/\s+/g, " ").trim().split(" ").slice(0, 150).join(" "),
              origin: "group",
              vector: groupCheckVector,
              importance: 0.7,
              category: "other",
              createdAt: Date.now(),
              mergedFrom: "[]",
              expiresAt: 0,
              storedBy: agentId,
              sourceTurnId: "",
              sourceMessageRole: item.role,
              sourceTimestamp: 0,
              sourceUrl: "",
              evidenceQuote,
              scope: "agent-private",
            }]);
          }
          console.log(`  ${dryRun ? "[dry]" : ""} added new group entry: ${item.text.slice(0, 60)}...`);
          totalAdded++;
        }
      } catch (err) {
        console.error(`  error processing item: ${err.message}`);
      }
    }
  }

  console.log(`[${agentId}] done — ${groupSessionCount} group sessions, ${totalUpdated} updated, ${totalAdded} added${dryRun ? " (dry-run)" : ""}`);
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

  const dryRun = process.argv.includes("--dry-run");
  const agentFilter = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const agents = agentFilter.length > 0
    ? TARGET_AGENTS.filter(a => agentFilter.includes(a))
    : TARGET_AGENTS;

  if (dryRun) console.log("[main] DRY RUN — keine Änderungen werden geschrieben");
  console.log(`[main] fixing group origins for: ${agents.join(", ")}`);

  await init();
  const embeddings = createEmbeddings(apiKey);

  for (const agentId of agents) {
    try {
      await fixAgent(agentId, embeddings, dryRun);
    } catch (err) {
      console.error(`[${agentId}] fatal: ${err.message}`);
    }
  }

  console.log("[main] complete");
}

main().catch(err => {
  console.error("[main] fatal:", err.message);
  process.exit(1);
});

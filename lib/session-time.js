/**
 * lib/session-time.js
 * Persistent session time tracking in run-state.json.
 */

import { readFile, writeFile, access, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";

const STATE_KEY = "sessionTime";

async function readState(workspaceDir) {
  const path = join(workspaceDir, "run-state.json");
  try {
    await access(path);
    const data = await readFile(path, "utf8");
    return JSON.parse(data);
  } catch { return {}; }
}

async function writeState(workspaceDir, state) {
  const path = join(workspaceDir, "run-state.json");
  const dir = dirname(path);
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

export async function recordActivity(agentId, workspaceKey, workspaceDir) {
  if (!workspaceDir || !workspaceKey) return;
  const state = await readState(workspaceDir);
  if (!state[STATE_KEY]) state[STATE_KEY] = {};
  if (!state[STATE_KEY][workspaceKey]) state[STATE_KEY][workspaceKey] = {};
  state[STATE_KEY][workspaceKey][agentId] = {
    lastActivityAt: Date.now(),
  };
  await writeState(workspaceDir, state);
}

export async function getLastActivity(agentId, workspaceKey, workspaceDir) {
  if (!workspaceDir || !workspaceKey) return null;
  const state = await readState(workspaceDir);
  return state[STATE_KEY]?.[workspaceKey]?.[agentId]?.lastActivityAt || null;
}

export async function timeSinceLastActivity(agentId, workspaceKey, workspaceDir) {
  const last = await getLastActivity(agentId, workspaceKey, workspaceDir);
  if (!last) return null;
  const diffMs = Date.now() - last;
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  if (hours >= 1) return { hours, minutes: minutes % 60 };
  return { minutes };
}

function zurichTimeStr() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Europe/Zurich", hour12: false }).slice(0, 16);
}

function utcTimeStr() {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

export async function formatTimeContext(agentId, workspaceKey, workspaceDir, lang = "en") {
  const elapsed = await timeSinceLastActivity(agentId, workspaceKey, workspaceDir);
  const zurich = zurichTimeStr();
  const utc = utcTimeStr();

  let elapsedStr = "";
  if (!elapsed) {
    if (lang === "de") return `<time-context>\nErste Aktivität. Aktuelle Zeit: ${zurich} Europe/Zurich (UTC ${utc}).\n</time-context>`;
    return `<time-context>\nFirst activity. Current time: ${zurich} Europe/Zurich (UTC ${utc}).\n</time-context>`;
  }

  if (elapsed.hours) {
    elapsedStr = `${elapsed.hours}h ${elapsed.minutes}m`;
  } else {
    elapsedStr = `${elapsed.minutes}m`;
  }

  if (lang === "de") {
    return `<time-context>\nLetzte Aktivität: vor ${elapsedStr}. Aktuelle Zeit: ${zurich} Europe/Zurich (UTC ${utc}).\n</time-context>`;
  }
  return `<time-context>\nLast activity: ${elapsedStr} ago. Current time: ${zurich} Europe/Zurich (UTC ${utc}).\n</time-context>`;
}

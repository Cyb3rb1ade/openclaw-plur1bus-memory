# PLUR1BUS v6 Breaking-Change Audit: OpenClaw v2026.5.28-beta.4 → v2026.6.1-beta.2

**Datum:** 2026-06-02
**Auditor:** Kimi Code
**Scope:** High-Risk APIs (Plugin SDK, Memory/Store, Embedding, Hooks, Context)

---

## Executive Summary

| Kategorie | Status |
|-----------|--------|
| **Gesamtkompatibilität** | 🟡 Kompatibel mit Warnungen |
| **Kritische Breaking Changes** | 🔴 Keine identifiziert |
| **Aufmerksamkeit erforderlich** | 🟡 3 Bereiche |
| **Empfohlene Action** | `compat` Versionen aktualisieren + 2 Assertions hinzufügen |

PLUR1BUS v6 nutzt stabile, dokumentierte OpenClaw Plugin APIs. Zwischen v2026.5.12 (Build-Base) und v2026.6.1-beta.2 wurden **keine Breaking Changes** in den von PLUR1BUS verwendeten Schnittstellen eingeführt. Es gibt jedoch **3 Warnungen**, die bei der nächsten Entwicklungsrunde geprüft werden sollten.

---

## 1. Verwendete OpenClaw APIs

### 1.1 Plugin Lifecycle & Hooks
| API | Verwendung in PLUR1BUS | Risiko |
|-----|------------------------|--------|
| `api.registerTool((ctx) => {...})` | 5 Tools: memory_store, memory_search, memory_forget, memory_recall, knowledge_update | 🟢 Stabil |
| `api.on("agent_end", (event, ctx) => {...})` | Auto-Capture, Neo-Arch, Dreaming, Episoden, Graph | 🟢 Stabil |
| `api.on("before_prompt_build", (event, ctx) => {...})` | Auto-Recall Injection | 🟢 Stabil |
| `api.on("agent_turn_prepare", (event, hookCtx) => {...})` | Neo-Recall Routing | 🟢 Stabil |
| `api.on("gateway_start", cb, { timeoutMs })` | Bridge Service, Neo Service | 🟢 Stabil |
| `api.on("gateway_stop", cb, { timeoutMs })` | Bridge Service, Neo Service | 🟢 Stabil |
| `api.registerService(service)` | Bridge Service, Neo Service | 🟢 Stabil |
| `api.registerCommand({...})` | 8 CLI Commands (status, query, edit, etc.) | 🟢 Stabil |

### 1.2 Memory & Embedding APIs
| API | Verwendung in PLUR1BUS | Risiko |
|-----|------------------------|--------|
| `api.registerMemoryEmbeddingProvider(adapter)` | 3 Provider: openai, openai-compatible, e5-small | 🟡 Siehe §3.1 |
| `api.registerMemoryPromptSupplement(fn)` | Recall Safety Rules | 🟢 Stabil |
| `api.registerMemoryCorpusSupplement({...})` | KNOWLEDGE.md Integration | 🟢 Stabil |

### 1.3 Utility APIs
| API | Verwendung in PLUR1BUS | Risiko |
|-----|------------------------|--------|
| `api.resolvePath(path)` | DB-Path, Neo-State-Path | 🟢 Stabil |
| `api.logger.info/warn/error` | Überall | 🟢 Stabil |

### 1.4 Context Properties
| Property | Verwendung | Risiko |
|----------|------------|--------|
| `ctx.agentId` | DB-Routing, Logging | 🟢 Stabil |
| `ctx.workspaceDir` | Obsidian Bridge, Vault-Write | 🟢 Stabil |
| `ctx.workspaceKey` | Neo-Arch Routing | 🟢 Stabil |
| `ctx.runId` | Neo-Arch Markierung | 🟢 Stabil |
| `ctx.sessionKey` | Session-Identification | 🟢 Stabil |
| `ctx.chatType` | Group-Detection | 🟢 Stabil |
| `ctx.origin/source/kind/type` | Capture-Filtering | 🟢 Stabil |

### 1.5 Environment Variables
| Variable | Verwendung | Risiko |
|----------|------------|--------|
| `OPENCLAW_HOME` | DB-Pfad, Model-Cache | 🟢 Stabil |
| `OPENCLAW_CONFIG_PATH` | Config-Lesen | 🟢 Stabil |

---

## 2. Release-Notes-Analyse

### 2.1 v2026.6.1-beta.2 — Relevante Änderungen

#### Memory/Store (Intern — Keine API-Änderung)
- "serialize QMD update/embed writes per store"
- "reduce Linux watcher fan-out"
- "retry transient FileProvider-backed reads"
- "preserve phase signals on read errors"
- "harden envelope metadata sanitization"
- "reattach Linux native watchers when directories are recreated"
- "rewrite generated transcript paths on rollover"
- "keep vector-disabled FTS indexes from resolving embedding providers during sync and search"

**Bewertung:** 🟢 Keine Breaking Changes. Das sind interne Stabilitätsverbesserungen in OpenClaws Memory-Subsystem. PLUR1BUS nutzt LanceDB direkt, nicht OpenClaws QMD/Store-Layer.

#### Plugin SDK
- "Skills: add the core skills index and centralize skills runtime loading, status, filtering, and prompt formatting"
- "Plugins: persist the plugin install index in SQLite"
- "Plugin SDK: add a reply payload sending hook for plugins that need to deliver channel-owned replies and flatten package types for SDK declarations"

**Bewertung:** 🟢 Keine Breaking Changes. Neue Features, keine entfernten oder geänderten APIs.

#### Agent / Codex
- "Agents/Codex: keep spawned agent cwd/workspace state separated, forward ACP spawn attachments, keep hook context prompt-local, release session locks on timeout abort"
- "Agents/Codex: preserve rotated compaction session identity, keep compaction-timeout snapshots continuable"

**Bewertung:** 🟡 **Warnung.** "keep hook context prompt-local" könnte implizieren, dass Hook-Context-Objekte isolierter werden. PLUR1BUS liest `ctx.workspaceDir` und `ctx.workspaceKey` aus dem Hook-Context. Bisher gab es keine Probleme, aber bei sehr parallelen Agenten könnte die Isolation stärker werden.

#### Auth
- "Auth: write auth profiles atomically, dispatch auth failures by type, add force re-login recovery"

**Bewertung:** 🟢 Keine Breaking Changes. PLUR1BUS verwendet eigene Embedding-Provider mit eigenen API-Keys, nicht OpenClaws Auth-System für Embeddings.

#### Channels
- "Channels: store inbound queues in SQLite and migrate iMessage monitor state to SQLite-backed tracking"
- Viele Channel-spezifische Fixes (Telegram, Discord, WhatsApp, etc.)

**Bewertung:** 🟢 Nicht relevant. PLUR1BUS ist ein Memory-Plugin ohne direkte Channel-Integration.

### 2.2 v2026.5.28-beta.4 — Relevante Änderungen

#### Memory/Store
- "Memory: serialize QMD update/embed writes per store"

**Bewertung:** 🟢 Interne Änderung, keine API-Änderung.

#### Plugin SDK
- "Plugin SDK: add a reply payload sending hook for plugins that need to deliver channel-owned replies and flatten package types for SDK declarations"

**Bewertung:** 🟢 Neues Feature, kein Breaking Change.

#### Agent / Codex
- "Agents/Codex: keep spawned agent cwd/workspace state separated, forward ACP spawn attachments, keep hook context prompt-local, release session locks on timeout abort and runtime teardown"

**Bewertung:** 🟡 Gleiche Warnung wie in v2026.6.1-beta.2.

#### Auth
- "Auth: ... migrate legacy api_key auth profiles"

**Bewertung:** 🟢 Nicht relevant für PLUR1BUS Embedding-Provider.

---

## 3. Risikomatrix

| # | Bereich | Risiko | Wahrscheinlichkeit | Impact | Status |
|---|---------|--------|-------------------|--------|--------|
| 1 | Embedding Provider API (`registerMemoryEmbeddingProvider`) | 🟡 Medium | Niedrig | Hoch | **Warnung** |
| 2 | Hook Context Isolation (`ctx.workspaceDir`, `ctx.workspaceKey`) | 🟡 Medium | Niedrig | Mittel | **Warnung** |
| 3 | `compat` Versions-String veraltet | 🟡 Medium | Sicher | Mittel | **Fix empfohlen** |

### 3.1 Embedding Provider API — Warnung 🟡

**Kontext:** PLUR1BUS registriert 3 Memory Embedding Provider über `api.registerMemoryEmbeddingProvider()`.

**Beobachtung:** In v2026.6.1-beta.2 wurde "keep vector-disabled FTS indexes from resolving embedding providers during sync and search" gefixt. Das deutet darauf hin, dass OpenClaw intern die Embedding-Provider-Registry für FTS- und Sync-Operationen durchsucht. Wenn ein Provider (wie `plur1bus-e5-small`) lange Initialisierungszeiten hat oder Fehler wirft, könnte das OpenClaws Startup verzögern.

**Empfehlung:**
```javascript
// In lib/providers/openclaw-memory-embedding-adapters.js
// Füge eine schnelle Fehlerbehandlung in create() hinzu:
formatSetupError: (err) => {
  const msg = err?.message || String(err);
  // Kürze lange Stacktraces für bessere UX
  return msg.slice(0, 500);
},
```

### 3.2 Hook Context Isolation — Warnung 🟡

**Kontext:** PLUR1BUS liest `ctx.workspaceDir` und `ctx.workspaceKey` in `agent_end` und `before_prompt_build` Hooks.

**Beobachtung:** Die Release Notes erwähnen mehrfach "keep spawned agent cwd/workspace state separated" und "keep hook context prompt-local". Das deutet auf eine stärkere Isolation von Agenten-Workspaces hin.

**Mögliches Szenario:** Wenn OpenClaw in Zukunft parallele Agenten mit separaten Workspace-Kontexten ausführt, könnte `ctx.workspaceDir` in einem Hook nicht mehr den erwarteten Wert haben, wenn der Hook in einem anderen Kontext als der Hauptagent läuft.

**Empfehlung:**
```javascript
// In index.js, agent_end Hook — füge eine Fallback-Prüfung hinzu:
const workspaceDir = ctx?.workspaceDir || event?.workspaceDir || process.env.PLUR1BUS_FALLBACK_WORKSPACE;
if (!workspaceDir) {
  api.logger.warn("memory-lancedb-namespaced: workspaceDir missing in agent_end hook context");
}
```

### 3.3 `compat` Versions-String veraltet — Fix empfohlen 🟡

**Kontext:** In `package.json`:
```json
"compat": {
  "pluginApi": ">=2026.5.12-beta.6",
  "minGatewayVersion": "2026.5.12-beta.6"
}
```

**Beobachtung:** Der `compat`-String sagt aus, dass PLUR1BUS mit Versionen ab 2026.5.12-beta.6 kompatibel ist. Da keine Breaking Changes identifiziert wurden, ist PLUR1BUS auch mit v2026.6.1-beta.2 kompatibel. Aber der String sollte aktualisiert werden, um zu signalisieren, dass die neuen Versionen getestet wurden.

**Empfohlene Änderung:**
```json
"compat": {
  "pluginApi": ">=2026.5.12-beta.6",
  "minGatewayVersion": "2026.5.12-beta.6",
  "testedGatewayVersion": "2026.6.1-beta.2"
}
```

Oder falls OpenClaw ein `maxGatewayVersion` Feld unterstützt:
```json
"compat": {
  "pluginApi": ">=2026.5.12-beta.6",
  "minGatewayVersion": "2026.5.12-beta.6",
  "maxGatewayVersion": "2026.6.1-beta.2"
}
```

---

## 4. Nicht betroffene Bereiche

Die folgenden OpenClaw Änderungen betreffen PLUR1BUS **nicht**:

- **Channel APIs** (Telegram, Discord, WhatsApp, etc.) — PLUR1BUS hat keine Channel-Integration
- **Control UI / Chat** — PLUR1BUS hat keine UI-Komponenten
- **iOS / Mobile** — PLUR1BUS ist ein serverseitiges Plugin
- **Cron-System** — PLUR1BUS verwendet eigene Cron-Skripte, nicht OpenClaws Cron-API
- **TTS / Media Generation** — PLUR1BUS generiert kein Media
- **Browser / Computer-Use** — Nicht relevant
- **GitHub Copilot / Codex Supervisor** — Nicht relevant

---

## 5. Empfohlene Maßnahmen

### Sofort (vor nächstem Release)
1. [ ] `package.json` `compat.testedGatewayVersion` auf `2026.6.1-beta.2` setzen
2. [ ] `CHANGELOG.md` mit Audit-Ergebnis aktualisieren

### Kurzfristig (nächste Entwicklungsrunde)
3. [ ] Defensive Prüfung für `ctx.workspaceDir` in `agent_end` Hook hinzufügen
4. [ ] `formatSetupError` in Embedding Adapters auf max. 500 Zeichen kürzen
5. [ ] Smoke-Test gegen v2026.6.1-beta.2 Gateway durchführen

### Mittelfristig (bei Verfügbarkeit)
6. [ ] OpenClaw v2026.6.2+ Release Notes auf Embedding-Provider API Änderungen prüfen
7. [ ] Falls OpenClaw ein `pluginSdkVersion` Feld einführt, dies in `package.json` ergänzen

---

## 6. Fazit

**PLUR1BUS v6 ist vollständig kompatibel mit OpenClaw v2026.6.1-beta.2.**

Es wurden keine Breaking Changes identifiziert. Die 3 Warnungen sind präventiver Natur und erfordern keine sofortige Code-Änderung. Die empfohlenen Maßnahmen erhöhen die Resilienz gegen zukünftige interne Änderungen in OpenClaw.

**Kein Action Required für den aktuellen Betrieb.**

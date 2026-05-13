# OpenClaw PLUR1BUS Memory

*[Deutsch](#deutsch) | [English](#english)*

[![Release](https://img.shields.io/badge/release-v3.1.0--beta.1-blue)](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/tree/neo-arch)

---

<a name="deutsch"></a>
## Deutsch

PLUR1BUS v3 ist eine OpenClaw-native kognitive Memory-Schicht. Der Branch
`neo-arch` läuft als additives Augment-Plugin: `memory-core` bleibt der
OpenClaw-Memory-Slot, PLUR1BUS ergänzt Recall, Capture, Curation, Behavior
Learning, Embeddings und Dreaming über die offiziellen OpenClaw-Plugin-Flächen.

**Aktuelle Version:** `3.1.0-beta.1`<br>
**Branch:** `neo-arch`<br>
**Mindestversion:** OpenClaw `2026.5.10-beta.5` oder neuer<br>
**Normalbetrieb:** keine OpenClaw-dist-Patches, kein `ExecStartPre`, kein
`systemctl`-Recovery-Hack, kein root-/host-cron als Primärpfad.

**Kompatibilitätsgrenze:** PLUR1BUS `3.0.0-beta.2` und neuer setzt den
OpenClaw-native Memory-Stack aus `2026.5.10-beta.5` voraus. Ältere OpenClaw
Versionen werden fuer v3 nicht unterstützt; für diese Installationen bleibt
PLUR1BUS v2.1.x der kompatible Zweig.

## Was v3 leistet

- Store jedes sichtbaren User-Turns, jeder sichtbaren Assistant-Antwort und relevanter sichtbarer Tool-Ergebnisse.
- Assistant-Antworten werden als Evidence gespeichert, aber nicht als Wahrheit trusted.
- Auto-Capture läuft default über `agent_end`.
- Auto-Recall läuft default über genau einen Prompt-Injection-Pfad pro Turn.
- Workspace-Isolation über `agent_private`, `workspace_shared` und `global_user`.
- Kategorien, Origin/Provenance, Trust-Level und Status-Maschine für alle Memory-Objekte.
- BehaviorCards ändern zukünftiges Agentenverhalten nachvollziehbar anhand von User-Reaktionen.
- Promote, Demote, Prune, Tombstone und Hard Delete sind explizite Zustände.
- Embeddings sind queue-basiert, state-aware und nach Lanes getrennt oder filterbar.
- Shared Dreaming ist origin- und trust-gated.
- `KNOWLEDGE.md` bleibt kuratierte Workspace-Wahrheit, kein Raw-Memory-Dump.

## Architektur

```text
OpenClaw memory-core
  bleibt Slot-Owner

PLUR1BUS memory-lancedb-namespaced
  registerTool
    memory_store
    memory_recall
    memory_forget
    knowledge_update

  registerMemoryCorpusSupplement
    PLUR1BUS-Corpus fuer memory_search corpus=all/wiki

  registerMemoryPromptSupplement oder before_prompt_build/agent_turn_prepare
    Auto-Recall, escaped und als untrusted retrieval context markiert

  agent_end
    Turn Journal
    MemoryCandidates
    ReactionSignals
    BehaviorCards
    Embedding Queue
    Curation Inbox

  gateway_start/gateway_stop
    leichte Plugin-Services

  OpenClaw-Agent-Crons
    schwere Jobs: Deep/REM Dreaming, Promotion Sweep, Prune Sweep,
    Embedding Backfill, Full Reindex, Knowledge Compaction
```

## Datenmodell

### TurnEvent

Jeder sichtbare Turn wird mit `workspaceKey`, `agentId`, `sessionId`,
`turnIndex`, `role`, `content`, Kategorien, Origin, Scope, Attribution, Quality
und Timestamp gespeichert. Hidden reasoning, hidden system/developer
instructions und unsichtbarer Tool-State werden nicht gespeichert.

### MemoryCandidate

Raw Turns werden nicht direkt zu trusted Memory. Aus ihnen entstehen Kandidaten
mit `statement`, `normalizedStatement`, Kategorie, Origin, Source-Turns,
Status, Confidence, Salience, Recency und Embedding-State.

### Origin und Trust

Jede gespeicherte Einheit bekommt Provenance: Quelle, Rolle, Source-IDs,
`capturedBy`, Trust-Level, Confidence, Scope, Workspace, Agent und Session.

Trust-Level:

- `untrusted`
- `user_asserted`
- `assistant_asserted`
- `tool_observed`
- `validated`
- `curated`

### Scopes

- `agent_private`: Default fuer Agent-Reflexionen, Reply-Traces und Behavior-Kandidaten.
- `workspace_shared`: nur nach Promotion.
- `global_user`: nur nach expliziter oder wiederholt starker Evidenz.

Agent-private Memory darf nicht ohne Promotion in Workspace-Shared leaken.
Workspace-Shared darf nicht ohne explizite Policy in Global-User leaken.

## Auto-Capture und Auto-Recall

`autoCapture` ist default-on. Wenn `autoCapture !== false`, registriert PLUR1BUS
den `agent_end`-Hook. `autoCapture:false` schaltet nur automatische
Hook-Capture aus. Es deaktiviert nicht `memory_store`, `knowledge_update`,
manuelle Curation oder bereits vorhandenen PLUR1BUS-State.

`autoRecall` ist default-on. Es betrifft nur automatische Prompt-Injection.
`autoRecall:false` deaktiviert nicht `memory_recall`, `memory_search
corpus=all/wiki`, CorpusSupplement-Zugriff oder manuellen Recall.

Wenn MemoryPromptSupplement und `before_prompt_build`/`agent_turn_prepare`
gleichzeitig verfügbar sind, muss genau ein Primärpfad aktiv sein oder per
Idempotency-Key pro Turn dedupliziert werden. Doppel-Injektion ist ein Fehler.

Alle prompt-injizierten Memories werden escaped, begrenzt und als untrusted
retrieval context markiert. Instruktionen in Memory-Inhalten duerfen nie
System- oder User-Anweisungen überschreiben.

## Konfiguration

Provider-Keys liegen zentral in `openclaw.json`, nicht pro Workspace. OpenAI
`text-embedding-3-large` bleibt die empfohlene Remote-Option; bei Deployment
kann stattdessen lokal `intfloat/multilingual-e5-small` gewählt werden.

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true,
          "timeouts": {
            "before_prompt_build": 90000,
            "agent_end": 60000
          }
        },
        "config": {
          "embedding": {
            "provider": "openai",
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-large",
            "dimensions": 3072
          },
          "reranker": {
            "provider": "cohere",
            "enabled": true,
            "apiKey": "${COHERE_API_KEY}",
            "model": "rerank-v3.5",
            "candidates": 20
          },
          "baseDbPath": "~/.openclaw/memory/lancedb-namespaced",
          "autoCapture": true,
          "autoRecall": true,
          "neo": {
            "enabled": true,
            "mode": "augment"
          }
        }
      }
    }
  }
}
```

Empfohlen ist `${ENV_VAR}`-Syntax. Embedding-`dimensions` müssen zur bestehenden
LanceDB passen. Ein Provider- oder Dimensionswechsel braucht einen neuen
`baseDbPath` oder einen Fresh-DB-Rebuild.

Provider-Status in `3.1.0-beta.1`:

- **implemented:** `embedding.provider=openai`, `embedding.provider=openai-compatible`, `reranker.provider=cohere`, `reranker.provider=disabled`.
- **experimental:** `embedding.provider=local-transformers` mit `intfloat/multilingual-e5-small`; lokaler Modell-Download/Load erfolgt erst bei `memory-doctor provider-check` oder beim ersten lokalen Call.
- **blocked pending local model smoke:** `reranker.provider=local-transformers` mit `Alibaba-NLP/gte-reranker-modernbert-base`, solange der echte Node/Transformers.js-Smoke nicht grün war. Cohere und disabled bleiben passfähig.

## Workspace-Einrichtung

Die Plugin-Installation und API-Keys sind zentral. Workspace-spezifisch sind:

- Turn Journal
- MemoryCandidates
- Reaction Ledger
- BehaviorCards
- Embedding Queue
- Curation State
- `memory/KNOWLEDGE.md`

Nach dem Upgrade sollte jeder produktive Workspace einmal gesmoked werden:

```bash
openclaw plugins doctor
node scripts/memory-doctor.mjs provider-check
```

Danach im Workspace:

- `/plur1bus doctor`
- `memory_recall` mit bekanntem Fakt
- `memory_search corpus=all`
- `knowledge_update` fuer eine kuratierte Entscheidung
- echter Agent-Turn, damit `agent_end` Auto-Capture ausloest

## Migration von v2.1.x auf v3

v3 ist ein additiver In-Place-Upgrade, kein Reimport und kein Ersatz fuer
`memory-core`.

1. OpenClaw zuerst auf `2026.5.10-beta.5` oder neuer aktualisieren.
2. `neo-arch` auschecken.
3. Vorher `openclaw plugins doctor` und `node scripts/memory-doctor.mjs provider-check` ausführen.
4. Installer zuerst mit `--dry-run` laufen lassen.
5. Bestehenden `baseDbPath`, Embedding-Modell und Dimensionen beibehalten.
6. Hook-Rechte setzen: `allowConversationAccess`, `allowPromptInjection`, Timeouts.
7. Gateway neu starten.
8. Pro produktivem Workspace `/plur1bus doctor`, `memory_recall`, `memory_search corpus=all` und einen echten `agent_end`-Capture prüfen.

Bestehende v2-LanceDBs bleiben lesbar, solange `baseDbPath`, Embedding-Modell
und Dimensionen kompatibel bleiben.

## Commands

Stabile Tool-Verträge:

- `memory_store`
- `memory_recall`
- `memory_forget`
- `knowledge_update`

Wichtige v3-Commands:

- `/plur1bus doctor`
- `/plur1bus curation inbox`
- `/plur1bus curation conflicts`
- `/plur1bus memory origin <id>`
- `/plur1bus memory explain <id>`
- `/plur1bus memory promote <id>`
- `/plur1bus memory demote <id>`
- `/plur1bus memory prune <id>`
- `/plur1bus memory tombstone <id>`
- `/plur1bus behavior show`
- `/plur1bus behavior candidates`
- `/plur1bus behavior explain <id>`
- `/plur1bus embeddings status`
- `/plur1bus embeddings refresh`
- `/plur1bus dreaming status`
- `/plur1bus dreaming run light|rem|deep`

## Verification Gates

```bash
node --check extensions/memory-lancedb-namespaced/index.js
node --check extensions/memory-lancedb-namespaced/lib/neo-arch.js
node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js
node scripts/memory-doctor.mjs provider-check
openclaw plugins doctor
```

`/plur1bus doctor` muss warnen bei fehlender Conversation Access Permission,
fehlender Prompt-Injection-Erlaubnis, nicht feuernden Hooks,
Provider-/Dimensions-Mismatch, stale Embedding Queue, Scope-Leaks,
pruned/tombstoned Recall-Leaks und assistant-only Promotion-Leaks.

## Dokumentation

- [`how-to-memory-perfect.md`](how-to-memory-perfect.md): v3-Architektur, Setup, Migration und Betrieb.
- [`HOW-TO-UPDATE.md`](HOW-TO-UPDATE.md): OpenClaw-Update-Gate.
- [`CHANGELOG.md`](CHANGELOG.md): Versionshistorie.

---

<a name="english"></a>
## English

PLUR1BUS v3 is an OpenClaw-native cognitive memory layer. The `neo-arch` branch
runs as an additive augment plugin: `memory-core` remains the OpenClaw memory
slot owner while PLUR1BUS adds capture, recall, curation, behavior learning,
embeddings and dreaming through native plugin APIs.

**Current version:** `3.1.0-beta.1`<br>
**Branch:** `neo-arch`<br>
**Minimum OpenClaw:** `2026.5.10-beta.5`<br>
**Runtime rule:** no OpenClaw dist patching, no `ExecStartPre`, no `systemctl`
recovery hack and no host cron as the primary runtime path.

Provider keys are configured once in `openclaw.json` under
`plugins.entries.memory-lancedb-namespaced.config`. Workspaces get their own
turn journal, candidates, reaction ledger, behavior cards, curation state,
embedding queue and optional `memory/KNOWLEDGE.md`.

Provider status in `3.1.0-beta.1`: OpenAI/OpenAI-compatible embeddings, Cohere
rerank, and disabled rerank are implemented. Local E5 embeddings are
experimental. The local GTE reranker is blocked pending a real
Node/Transformers.js local model smoke and must not be treated as passed until
that smoke is green.

PLUR1BUS `3.0.0-beta.2` and newer requires the OpenClaw-native memory stack
from OpenClaw `2026.5.10-beta.5` or newer. Existing v2 LanceDB data remains
readable when `baseDbPath`, embedding model and vector dimensions stay
compatible.

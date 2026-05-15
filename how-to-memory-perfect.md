# PLUR1BUS Neo-Arch v3 Memory Guide

Stand: 2026-05-14<br>
Version: `3.2.0`<br>
Branch: `main`

Dieses Dokument beschreibt nur noch den v3-Normalbetrieb und den v2→v3
Migrationspfad. Historische v2-only Upgrade-Notizen, OpenClaw-dist-Patchketten,
root-/host-cron-Fallbacks und deployment-fremde Betriebsdetails wurden
entfernt.

## 1. Zielbild

PLUR1BUS v3 ist ein kognitiver Memory-Layer fuer OpenClaw:

- PLUR1BUS `3.2.0` benötigt OpenClaw `2026.5.12-beta.6`
  oder neuer. Ältere OpenClaw-Versionen haben nicht den vorausgesetzten
  OpenClaw-native Memory-Stack fuer v3.
- `memory-core` bleibt der exklusive OpenClaw-Memory-Slot.
- `memory-lancedb-namespaced` läuft default als additives Augment.
- Die stabilen Tools bleiben erhalten: `memory_store`, `memory_recall`,
  `memory_forget`, `knowledge_update`.
- OpenClaw-native Flächen werden genutzt: Tools, Commands, Services,
  Prompt-/Corpus-Supplements, `agent_end`, `before_prompt_build` oder
  `agent_turn_prepare`, `gateway_start`, `gateway_stop` und
  OpenClaw-Agent-Crons.
- OpenClaw-dist-Patches, `ExecStartPre`, `systemctl`-Recovery, root cron,
  versteckte host crontabs und Shell-Fallbacks sind kein Primärpfad.

OpenClaw-Agent-Crons sind erlaubt und gewünscht fuer schwere Jobs:

- Deep Dreaming
- REM Dreaming
- Promotion Sweep
- Prune Sweep
- Embedding Refresh / Backfill
- Full Reindex
- Knowledge Compaction
- Curation Inbox Preparation
- Recall Evaluation

Plugin-Services sind fuer kleine und mittlere Jobs gedacht:

- Embedding Queue Drain
- Light GC
- Stale Marking
- Capture Reconcile
- Curation Metrics
- leichte Wartung

## 1.1 Provider-Modell ab v3.1.0-beta.1

PLUR1BUS ist nicht mehr hart an einen einzelnen Embedding- oder Rerank-Anbieter
gebunden. OpenAI `text-embedding-3-large` bleibt die empfohlene Remote-Option,
aber der Installer bietet lokale Alternativen an.

Status:

- **implemented:** `embedding.provider=openai`, `embedding.provider=openai-compatible`, `reranker.provider=cohere`, `reranker.provider=disabled`.
- **experimental:** `embedding.provider=local-transformers` mit `intfloat/multilingual-e5-small` (`384d`, `query: ` / `passage: ` Prefixing, Cache unter `${OPENCLAW_HOME}/models/plur1bus`).
- **blocked pending local model smoke:** `reranker.provider=local-transformers` mit `Alibaba-NLP/gte-reranker-modernbert-base`. Diese Option ist English-primary und darf erst als pass gelten, wenn `memory-doctor provider-check` oder der explizite Local-Smoke in Node/Transformers.js grün war.

API-Keys:

- OpenAI: `${OPENAI_API_KEY}`
- OpenAI-compatible/OpenRouter/lokales Gateway: eigener Key und `baseUrl`
- Cohere: `${COHERE_API_KEY}`
- Local Transformers: kein API-Key; Modell-Download erst bei Provider-Check oder erstem lokalen Call

Dimensionsschutz:

- OpenAI large: `3072`
- OpenAI small/ada: `1536`
- E5 small: `384`

Bei Dimensionswechsel niemals in dieselbe LanceDB schreiben. Entweder alten
Provider beibehalten oder neuen `baseDbPath` verwenden, zum Beispiel
`lancedb-namespaced-openai-large-3072` oder `lancedb-namespaced-e5-small-384`,
danach explizit reindexen/backfillen. Die alte DB bleibt erhalten.

## 1.2 OpenClaw-native Embedding-Provider-Bridge ab v3.2.0

PLUR1BUS deklariert zusaetzlich zu den bestehenden Tools drei optionale
OpenClaw-native Embedding-Provider:

- `plur1bus-openai`
- `plur1bus-openai-compatible`
- `plur1bus-e5-small`

Die Manifest-Fläche ist `contracts.memoryEmbeddingProviders`; die Runtime-Fläche
ist `api.registerMemoryEmbeddingProvider`. Das ist keine Memory-Slot-Übernahme:
PLUR1BUS bleibt `augment`, `memory-core` bleibt Slot-Owner, und PLUR1BUS setzt
weder `kind:"memory"` noch `registerMemoryCapability`.

Explizite Provider-Wahl:

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "plur1bus-e5-small"
      }
    }
  }
}
```

Es gibt keine automatische Provider-Selektion. `plur1bus-openai` und
`plur1bus-openai-compatible` sind Remote-Provider; Keys, Base URLs und Header
werden erst bei `create()` beziehungsweise beim ersten Embedding-Call
ausgewertet. `plur1bus-e5-small` ist lokal und experimental; Transformers.js
wird erst beim ersten `embedQuery`/`embedBatch` importiert, der Modell-Cache
liegt bevorzugt unter `memorySearch.local.modelCacheDir`, dann unter
`embedding.local.cacheDir`, sonst unter `${OPENCLAW_HOME}/models/plur1bus`.

Wenn `agents.defaults.memorySearch.provider = "plur1bus-e5-small"` die
PLUR1BUS-Runtime nicht lädt, ist das als Manifest-/Contract-Activation oder
Inspect-Visibility-Limit zu debuggen. Nicht durch `kind:"memory"` oder
`registerMemoryCapability` umgehen.

## 2. Architektur

```text
OpenClaw Gateway
  ├─ memory-core
  │    └─ Slot-Owner fuer OpenClaw Memory
  │
  └─ memory-lancedb-namespaced / PLUR1BUS v3
       ├─ Tools
       │    ├─ memory_store
       │    ├─ memory_recall
       │    ├─ memory_forget
       │    └─ knowledge_update
       │
       ├─ Hooks
       │    ├─ agent_end
       │    ├─ before_prompt_build oder agent_turn_prepare
       │    ├─ gateway_start
       │    └─ gateway_stop
       │
       ├─ Supplements
       │    ├─ MemoryPromptSupplement
       │    └─ MemoryCorpusSupplement
       │
       ├─ Core Stores
       │    ├─ Turn Journal
       │    ├─ MemoryCandidates
       │    ├─ Reaction Ledger
       │    ├─ BehaviorCards
       │    ├─ Curation State
       │    ├─ Embedding Queue
       │    └─ KNOWLEDGE.md
       │
       └─ Jobs
            ├─ Plugin-Service fuer leichte Wartung
            └─ OpenClaw-Agent-Crons fuer schwere Jobs
```

Default ist `neo.mode = "augment"`. `registerMemoryCapability` wird in
`3.2.0` nicht genutzt; auch ein versehentlich gesetztes
`neo.mode="slot"` darf PLUR1BUS nicht zum OpenClaw-Memory-Slot machen.

## 3. Zentrale Konfiguration

Die API-Keys fuer Embeddings und Reranking liegen zentral in `openclaw.json`,
nicht pro Workspace:

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
            "agent_turn_prepare": 90000,
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
            "mode": "augment",
            "corpusDefaultWorkspaceKey": "default"
          }
        }
      }
    }
  }
}
```

Empfehlungen:

- Secrets als `${ENV_VAR}` referenzieren.
- `baseDbPath` stabil halten.
- `embedding.model` und `embedding.dimensions` bei bestehender LanceDB nicht
  still wechseln.
- Bei lokaler Embedding-Wahl statt OpenAI `embedding.provider` auf
  `local-transformers` setzen und `local.model=intfloat/multilingual-e5-small`,
  `local.dimensions=384`, `local.cacheDir=${OPENCLAW_HOME}/models/plur1bus`
  konfigurieren.
- Bei lokalem Reranker `reranker.provider=local-transformers` nur als
  experimental behandeln; English-primary und blocked pending local model smoke,
  solange der Node/Transformers.js-Smoke nicht grün war.
- `hooks.allowConversationAccess` ist fuer raw conversation hooks erforderlich.
- `hooks.allowPromptInjection` ist fuer Auto-Recall per prompt-mutierendem Hook
  erforderlich.

### 3.1 Deployment-Entscheidung

Fresh Install:

1. **OpenAI recommended**
   - `embedding.provider=openai`
   - `model=text-embedding-3-large`
   - `dimensions=3072`
   - API-Key: `${OPENAI_API_KEY}`
2. **Local multilingual**
   - `embedding.provider=local-transformers`
   - `local.model=intfloat/multilingual-e5-small`
   - `local.dimensions=384`
   - kein API-Key
   - erster `provider-check` oder erster Local-Call lädt das Modell in
     `${OPENCLAW_HOME}/models/plur1bus`
3. **Custom OpenAI-compatible**
   - `embedding.provider=openai-compatible`
   - eigenes `model`, `baseUrl`, `apiKey`, `dimensions`

Reranker:

1. **Cohere**
   - `reranker.provider=cohere`
   - `model=rerank-v3.5`
   - API-Key: `${COHERE_API_KEY}`
   - stabiler Remote-Default
2. **Local GTE**
   - `reranker.provider=local-transformers`
   - `local.model=Alibaba-NLP/gte-reranker-modernbert-base`
   - English-primary, experimental
   - blocked pending local model smoke, solange kein echter Node/Transformers.js
     Smoke grün war
3. **Disabled**
   - `reranker.provider=disabled`
   - Vector-only Recall bleibt aktiv

Existing Install:

- Default ist `keep`.
- Keine bestehende Installation wird automatisch auf OpenAI-large oder E5-small
  migriert.
- Bestehende v3-Konfig ohne `embedding.provider` wird normalisiert:
  `embedding.apiKey` bedeutet `openai-compatible`; `reranker.apiKey` bedeutet
  `cohere`; `reranker.enabled=false` bedeutet `disabled`.

### 3.2 Providerwechsel und Reindex

PLUR1BUS darf bei Dimensionswechsel nicht in-place weiterschreiben:

| Provider/Modell | Dimension | Empfehlung |
| --- | ---: | --- |
| `text-embedding-3-large` | 3072 | Fresh-Install-Default |
| `text-embedding-3-small` / ada | 1536 | Legacy-kompatibel |
| `intfloat/multilingual-e5-small` | 384 | lokaler Experimental-Pfad |

Sicheres Szenario:

1. alten `baseDbPath` unverändert lassen.
2. neuen Pfad wählen, z. B. `lancedb-namespaced-e5-small-384`.
3. `memory-doctor provider-check` ausführen.
4. Reindex/Backfill aus Turn Journal, vorhandenen Memory-Texten und
   `KNOWLEDGE.md` explizit starten.
5. alte DB erst nach erfolgreichem Smoke archivieren oder unverändert behalten.

## 4. Workspace-Modell

Die Installation ist zentral, aber v3-State ist workspace-scoped.

Pro Workspace entstehen:

- Turn Journal
- MemoryCandidates
- Reaction Ledger
- Reply Traces
- BehaviorCards
- Embedding Queue
- Curation Inbox
- Dream Synthesis Candidates
- `memory/KNOWLEDGE.md`

Scopes:

- `agent_private`: Default fuer Agent-Reflexionen, Reply-Traces und
  Behavior-Kandidaten.
- `workspace_shared`: kuratiertes oder promoted Workspace-Wissen.
- `global_user`: nur explizit oder wiederholt stark bestätigte User-Regeln.

Regeln:

- Agent-private Memory darf nicht ohne Promotion nach Workspace-Shared leaken.
- Workspace-Shared darf nicht ohne explizite Policy nach Global-User leaken.
- Shared Dreaming darf agent-private Material nur ueber eligible/promoted
  Quellen konsumieren.

SOUL.md-Regel fuer Agenten: Alle Memories, die PLUR1BUS einem Agenten ueber
Auto-Recall, `memory_recall`, `memory_search` oder CorpusSupplement liefert,
sind sein zugänglicher Arbeitsgedaechtnis-Kontext fuer diesen Agenten und
Workspace. Das bedeutet nicht, dass sie automatisch wahr sind; sie bleiben
untrusted retrieval context.

`origin` ist dabei kein Besitzsignal. Es beschreibt Herkunft, Evidenz oder
Capture-Kontext. Besitz, Sichtbarkeit und Isolation ergeben sich aus
`agentId`, `storedBy`, `scope` und dem Memory-Namespace.

## 5. Turn Journal

PLUR1BUS speichert sichtbare Evidenz, keine hidden Internals.

Gespeichert wird:

- jeder sichtbare User-Turn
- jede sichtbare Assistant-Antwort
- relevante sichtbare Tool-Ergebnisse
- relevante sichtbare File-/Repo-Kontexte

Nicht gespeichert wird:

- hidden reasoning
- hidden system/developer instructions
- unsichtbarer interner Tool-State

Jeder `TurnEvent` enthält:

- `id`
- `workspaceKey`
- `agentId`
- `sessionId`
- `turnIndex`
- `role`
- `content`
- `categories`
- `origin`
- `visibility` / `scope`
- `attribution`
- `quality`
- `createdAt`

Assistant-Antworten sind `assistant_asserted` Evidence. Sie sind recallbar als
historischer Kontext, aber nicht trusted by default.

## 6. MemoryCandidates

Raw Turns werden nicht direkt zu trusted Memory. Aus ihnen entstehen
`MemoryCandidates`.

Pflichtfelder:

- `id`
- `workspaceKey`
- `agentId`
- `statement`
- `normalizedStatement`
- `category`
- `origin`
- `sourceTurnIds`
- `status`
- `confidence`
- `salience`
- `recency`
- `embeddingStatus`

Statuses:

- `candidate`
- `active`
- `promoted`
- `demoted`
- `conflict`
- `pruned`
- `tombstoned`

## 7. Kategorien

Kategorien sind Pflichtmetadaten fuer Recall Routing, Scoring, Curation und
Dreaming Eligibility.

Pflichtkategorien:

- `project_fact`
- `architecture_decision`
- `technical_constraint`
- `tooling_constraint`
- `workspace_rule`
- `user_preference`
- `communication_style`
- `behavior_feedback`
- `agent_strategy`
- `todo`
- `open_question`
- `bug`
- `failure`
- `success`
- `code_context`
- `file_context`
- `external_source`
- `test_result`
- `curation_note`
- `dream_synthesis`
- `assistant_claim`
- `assistant_plan`
- `assistant_suggestion`
- `assistant_mistake_candidate`

## 8. Origin und Provenance

Jede gespeicherte Einheit braucht Origin-Metadaten.

Pflichtfelder:

- `kind`
- `role`
- `sourceTurnIds`
- `sourceMemoryIds`
- `sourceToolCallIds`
- `capturedBy`
- `trustLevel`
- `confidence`
- `scope`
- `workspaceKey`
- `agentId`
- `sessionId`

Origin kinds:

- `user_explicit`
- `user_correction`
- `user_confirmation`
- `user_rejection`
- `assistant_claim`
- `assistant_plan`
- `assistant_suggestion`
- `tool_result`
- `test_result`
- `file_context`
- `repo_context`
- `web_source`
- `dream_synthesis`
- `manual_curation`

Trust levels:

- `untrusted`
- `user_asserted`
- `assistant_asserted`
- `tool_observed`
- `validated`
- `curated`

## 9. Auto-Capture

Auto-Capture ist default-on.

Wenn `autoCapture !== false`, registriert PLUR1BUS `agent_end` und verarbeitet
das sichtbare Conversation Delta:

1. TurnEvents speichern.
2. MemoryCandidates extrahieren.
3. ReactionSignals extrahieren.
4. Replies auf vorherige Assistant-Antworten linken.
5. User-Reaktionen auf verwendete Memories, BehaviorCards, Dreams und Tools
   attributieren.
6. BehaviorCards aktualisieren.
7. Embeddings queuen.
8. Curation Inbox aktualisieren.

`autoCapture:false` ist nur ein harter Opt-out fuer automatische
Hook-Capture. Es deaktiviert nicht:

- `memory_store`
- `knowledge_update`
- manuelle Curation
- bestehenden PLUR1BUS-State

Session-JSONL-Scraping darf nur Legacy-/Operator-Fallback sein, nicht normaler
Runtime-Pfad.

## 10. Auto-Recall

Auto-Recall ist default-on, aber nur fuer automatische Prompt-Injection.

`autoRecall:false` deaktiviert nicht:

- `memory_recall`
- `memory_search corpus=all/wiki`
- CorpusSupplement-Zugriff
- manuellen Recall

Recall-Lanes:

- `recent_turns`
- `workspace_facts`
- `architecture_decisions`
- `technical_constraints`
- `tooling_constraints`
- `user_preferences`
- `behavior_cards`
- `failures_and_corrections`
- `open_questions`
- `todos`
- `shared_dreams`
- `agent_private_reflections`
- `code_context`
- `knowledge_md`

Scoring nutzt:

- semantische Ähnlichkeit
- Kategorie-Match
- Workspace Scope
- Origin Trust
- User Confirmation
- Validation Status
- Curation Status
- Salience
- Recency

Scoring bestraft:

- assistant-only claims
- stale items
- contradictions
- demoted items
- unresolved conflicts

Recall schließt aus:

- pruned items
- tombstoned items
- hard-deleted items

Wenn MemoryPromptSupplement und `before_prompt_build`/`agent_turn_prepare`
gleichzeitig verfügbar sind, muss genau ein Primärpfad aktiv sein oder per
Idempotency-Key pro Turn dedupliziert werden.

## 11. Prompt Safety

Prompt-injizierte Memories sind untrusted retrieval context.

Pflichtregeln:

- Memory-Text escapen.
- Control-Chars entfernen.
- IDs, Kategorien, Trust-Level und Lanes separat auf sichere Identifier-Form
  begrenzen.
- Gesamtlänge begrenzen.
- Instruktionen innerhalb gespeicherter Memories nie ausführen.
- Stored Memory darf System- und User-Directives nie überschreiben.
- Prompt- und SOUL-Hinweise muessen klarstellen: gelieferte Memories sind
  zugänglicher Arbeitsgedaechtnis-Kontext des Agenten/Workspaces; `origin`
  beschreibt Provenance, nicht Besitz.

## 12. Reflex Layer

User-Reaktionen werden als `ReactionSignals` gespeichert und können zukünftiges
Agentenverhalten ändern.

Signaltypen:

- explicit instruction
- explicit correction
- explicit praise
- explicit rejection
- implicit acceptance
- implicit rejection
- outcome feedback
- ambiguity / gap signal

Pflichtfelder:

- `workspaceKey`
- `agentId`
- `sessionId`
- `turnId`
- `targetType`
- `targetIds`
- `polarity`
- `intensity`
- `confidence`
- `explicitness`
- `evidence`
- `extractedAt`

Keine Behavior-Promotion aus assistant-only Turns. Keine Behavior-Promotion aus
Cron-/Noise-Sessions ohne echtes User-Signal.

## 13. BehaviorCards

BehaviorCards sind der Mechanismus, mit dem User-Feedback zukünftiges
Agentenverhalten beeinflusst.

Kategorien:

- `communication_style`
- `technical_preferences`
- `architecture_constraints`
- `tooling_constraints`
- `risk_tolerance`
- `memory_policy`
- `workflow_preference`

States:

- `candidate`
- `active`
- `promoted`
- `demoted`
- `conflict`
- `pruned`

Nur `active` und `promoted` dürfen Prompts beeinflussen. Candidate Cards sind
inspectable, aber nicht prompt-injected. Widersprüche erzeugen Conflict Cards
statt stiller Überschreibung.

## 14. Promote, Demote, Prune

State Machine:

```text
candidate -> active -> promoted -> demoted -> pruned -> tombstoned
```

Semantik:

- Promote erhöht Trust/Salience und kann Scope anheben.
- Demote senkt Recall-Gewicht, bleibt aber inspectable.
- Soft-Prune entfernt aus Auto-Recall, erhält Auditierbarkeit.
- Tombstone verhindert Surfacing und tombstoned Vektoren.
- Hard Delete nur bei explizitem Forget/Delete oder Policy-Anforderung.

Die State Machine gilt fuer:

- MemoryCandidates
- BehaviorCards
- DreamSynthesis
- Knowledge Entries
- Embedding Vectors

Jede State-Änderung aktualisiert `embeddingStatus`.

## 15. Embeddings

Embeddings sind queue-basiert und state-aware.

Index-Lanes:

- `turns`
- `memories`
- `behavior`
- `decisions`
- `failures`
- `dreams`
- `code_context`
- `knowledge`

Lifecycle:

- new turn -> `pending`
- new candidate -> `pending`
- promote -> refresh / boost / fresh
- demote -> stale / lower weight
- prune -> excluded
- tombstone -> vector tombstone
- hard-delete -> remove vector and canonical record where policy allows

Pruned und tombstoned Vektoren dürfen nie recalled werden.

## 16. Curation

Wichtige Commands:

```text
/plur1bus curation inbox
/plur1bus curation conflicts
/plur1bus curation stale
/plur1bus curation promoted

/plur1bus memory origin <id>
/plur1bus memory explain <id>
/plur1bus memory promote <id>
/plur1bus memory demote <id>
/plur1bus memory prune <id>
/plur1bus memory tombstone <id>
/plur1bus recall why <id>
/plur1bus origin trace <id>

/plur1bus behavior show
/plur1bus behavior candidates
/plur1bus behavior explain <id>
/plur1bus behavior promote <id>
/plur1bus behavior demote <id>
/plur1bus behavior prune <id>

/plur1bus embeddings status
/plur1bus embeddings refresh

/plur1bus dreaming status
/plur1bus dreaming run light
/plur1bus dreaming run rem
/plur1bus dreaming run deep
```

## 17. Shared Dreaming

Shared Dreaming ist origin- und trust-gated.

Starke Inputs:

- `user_explicit`
- `user_correction`
- `user_confirmation`
- `tool_result`
- `test_result`
- `manual_curation`
- promoted workspace memory

Schwache Inputs:

- `assistant_claim`
- `assistant_plan`
- `assistant_suggestion`
- implicit signals

Aus direkter Promotion ausgeschlossen:

- Cron noise
- assistant-only sessions
- unresolved conflicts
- pruned records
- tombstoned records

Dream Outputs starten als `DreamSynthesis` Candidates mit Source IDs, Origin,
Trust, Konflikten und Promotion Recommendation. Sie werden nicht automatisch
Workspace Truth.

## 18. KNOWLEDGE.md

`memory/KNOWLEDGE.md` ist kuratierte Workspace-Wahrheit, kein Raw-Memory-Dump.

Schreibquellen:

- promoted memory
- curated decisions
- validated dream synthesis
- explizites `knowledge_update`
- manual curation

Writes müssen atomar sein:

1. Lock.
2. Backup.
3. Tmp Write.
4. Validation.
5. Rename.

## 19. Migration von v2.1.x auf v3

v3 ist ein additiver In-Place-Upgrade. Es ersetzt nicht `memory-core` und
importiert bestehende LanceDBs nicht neu.

### Muss v3 in jedem Workspace eingerichtet werden?

Ja und nein:

- Nein fuer API-Keys und Plugin-Installation. Diese liegen zentral in
  `openclaw.json`.
- Ja fuer Workspace-Wahrheit. Jeder Workspace bekommt eigene Neo-Dateien,
  `memory/KNOWLEDGE.md`, BehaviorCards und Reaction Ledger.
- Ja fuer Smoke-Tests. Jeder produktive Workspace sollte nach dem Upgrade
  geprüft werden.

### Ablauf

1. Ist-Zustand sichern:

   ```bash
   git status --short --branch
   openclaw --version
   openclaw plugins doctor
   node scripts/memory-doctor.mjs provider-check
   ```

2. OpenClaw aktualisieren:

   PLUR1BUS v3.2 funktioniert nur mit OpenClaw `2026.5.12-beta.6` oder neuer.
   Vor dem Plugin-Upgrade muss die OpenClaw-Instanz auf diese Version oder eine
   neuere Version aktualisiert sein.

3. Snapshot per Installer-Dryrun:

   ```bash
   ./scripts/install-memory-system.sh --dry-run /pfad/zu/.openclaw
   ```

4. Installation:

   ```bash
   ./scripts/install-memory-system.sh /pfad/zu/.openclaw
   ```

5. Config beibehalten:

   - `baseDbPath` aus v2 übernehmen.
   - Embedding `model` und `dimensions` unverändert lassen.
   - Reranker-Key optional setzen.

6. Hook-Rechte aktivieren:

   - `hooks.allowConversationAccess: true`
   - `hooks.allowPromptInjection: true`
   - `hooks.timeouts.before_prompt_build: 90000`
   - `hooks.timeouts.agent_end: 60000`

7. Workspace fuer Workspace initialisieren:

   - kurze echte Agent-Interaktion laufen lassen
   - `/plur1bus doctor`
   - `memory_recall` mit bekanntem v2-Fakt
   - `memory_search corpus=all`
   - `knowledge_update` fuer eine stabile Entscheidung

8. Neue Session starten und Auto-Recall prüfen.

### Rollback

Rollback ist einfach, solange `baseDbPath` nicht gewechselt wurde:

- Plugin-Dateien auf den vorherigen Branch/Tag zurückrollen.
- Optional LanceDB-Snapshot wiederherstellen.
- `memory-core` bleibt unberührt, weil v3 nicht der Memory-Slot ist.

## 20. Verification

Static Gates:

```bash
node --check extensions/memory-lancedb-namespaced/index.js
node --check extensions/memory-lancedb-namespaced/lib/neo-arch.js
node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js
```

Runtime Gates:

```bash
node scripts/memory-doctor.mjs provider-check
openclaw plugins doctor
```

Workspace Gates:

- `/plur1bus doctor`
- `memory_recall`
- `memory_search corpus=all`
- `knowledge_update`
- echter `agent_end`-Capture
- Auto-Recall vor Model-Call

## 21. Doctor Checks

`/plur1bus doctor` muss prüfen:

- Hook Permissions
- Conversation Access
- Prompt Injection Permission
- AutoCapture enabled/firing
- AutoRecall enabled/firing
- Embedding Provider
- Dimension mismatch
- stale Embedding Queue
- fehlende Origin/Kategorie-Felder
- Workspace Leakage Risk
- pruned/tombstoned Recall Leaks
- OpenClaw-Agent-Cron-Konfiguration fuer schwere Jobs
- assistant-only claim promotion leak
- Shared Dreaming ohne Trust Gate

## 22. Acceptance Gates

- Jeder sichtbare User-Turn wird gespeichert.
- Jede sichtbare Assistant-Antwort wird gespeichert.
- Relevante sichtbare Tool-Results werden gespeichert.
- Hidden reasoning wird nicht gespeichert.
- Jeder TurnEvent hat Workspace und Agent.
- Jeder MemoryCandidate hat Kategorie, Origin, TrustLevel und Scope.
- Assistant-Antworten sind nicht trusted by default.
- User-Korrekturen können Verhalten ueber BehaviorCards ändern.
- Auto-Recall ist default-on, multi-lane und escaped.
- Pruned/tombstoned/hard-deleted Items sind aus Recall ausgeschlossen.
- Promote/Demote/Prune aktualisiert Embedding-State.
- Curation kann Origin, Recall-Grund und Behavior-Änderungen erklären.
- Shared Dreaming ist trust-gated.
- Cron-/Noise-/Assistant-only-Inhalte werden nicht zu Workspace Truth promoted.
- OpenClaw-Agent-Crons sind dokumentiert und erlaubt.
- Kein root cron.
- Keine versteckte host crontab dependency.
- Kein `systemctl` im Normalbetrieb.
- Kein `ExecStartPre`.
- Kein OpenClaw dist/build patching.
- Kein Shell-Fallback als primary capture path.

## 23. Troubleshooting

### `agent_end` oder Auto-Recall feuert nicht

- `hooks.allowConversationAccess` prüfen.
- `hooks.allowPromptInjection` prüfen.
- Runner-/Provider-spezifisch testen.
- `/plur1bus doctor` ausführen.
- Bei fehlendem Hook-Firing nur auf unterstützte Reconcile-Pfade degradieren.

### Bestehende v2-Memories werden nicht gefunden

- `baseDbPath` prüfen.
- Embedding `model` und `dimensions` prüfen.
- `memory_recall` manuell testen.
- `memory_search corpus=all` statt `corpus=memory` testen, wenn das
  CorpusSupplement beteiligt sein soll.

### Reranking läuft nicht

- `reranker.enabled` prüfen.
- `${COHERE_API_KEY}` oder alternativen Reranker-Key prüfen.
- Ohne Reranker bleibt Vector-only Recall aktiv.

### KNOWLEDGE.md fehlt im Workspace

- `knowledge_update` mit einer stabilen Entscheidung ausführen.
- Danach `/plur1bus doctor` und Curation Inbox prüfen.

### Prompt enthält denselben Recall-Block doppelt

- Nur einen Auto-Recall-Injection-Pfad aktivieren.
- Idempotency-Key pro Turn prüfen.
- MemoryPromptSupplement und prompt-mutierender Hook dürfen nicht beide
  denselben Block injizieren.

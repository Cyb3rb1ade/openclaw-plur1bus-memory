# PLUR1BUS Neo-Arch v3 Memory Guide

Stand: 2026-05-11<br>
Version: `3.0.0-beta.2`<br>
Branch: `neo-arch`

Dieses Dokument beschreibt nur noch den v3-Normalbetrieb und den v2→v3
Migrationspfad. Historische v2-only Upgrade-Notizen, OpenClaw-dist-Patchketten,
root-/host-cron-Fallbacks und deployment-fremde Betriebsdetails wurden
entfernt.

## 1. Zielbild

PLUR1BUS v3 ist ein kognitiver Memory-Layer fuer OpenClaw:

- PLUR1BUS `3.0.0-beta.2` und neuer benötigt OpenClaw `2026.5.10-beta.5`
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

Default ist `neo.mode = "augment"`. `registerMemoryCapability` darf nur in
einem expliziten Slot-Modus genutzt werden und ist nicht der v3-Standard.

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
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-large",
            "dimensions": 3072
          },
          "reranker": {
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
- `hooks.allowConversationAccess` ist fuer raw conversation hooks erforderlich.
- `hooks.allowPromptInjection` ist fuer Auto-Recall per prompt-mutierendem Hook
  erforderlich.

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

   PLUR1BUS v3 funktioniert nur mit OpenClaw `2026.5.10-beta.5` oder neuer.
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

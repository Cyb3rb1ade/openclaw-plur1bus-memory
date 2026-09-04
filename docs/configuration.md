# Configuration — Recall, Runtime & Memory Settings

Diese Datei dokumentiert die wichtigsten Konfigurationsfelder rund um **Recall**, **Embedding-Cache**, **Emotion** und **Obsidian-Graph-Links**.

Die Recall-/Dedupe-Optionen liegen in `openclaw.json` unter
`plugins.entries.memory-lancedb-namespaced.config.recall`. Runtime-Optionen
liegen entsprechend unter `plugins.entries.memory-lancedb-namespaced.config.runtime`.

---

## Recall-Pipeline

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `maxPromptMemories` | `number` | `12` | Maximale Anzahl Memories, die in den Prompt-Kontext aufgenommen werden |
| `candidateTopK` | `number` | `40` | Anzahl Kandidaten aus der initialen Vector-Search |
| `importanceBoost` | `number` | `0.3` | Faktor des Importance-Boost vor dem Re-Rankings (0.0–1.0) |
| `canonicalFirst` | `boolean` | `true` | Kanonische Repräsentanten vor nicht-kanonischen bevorzugen |
| `canonicalMinScore` | `number` | `0.30` | Mindest-Score für ein Memory, um als kanonisch gelten zu können |
| `canonicalMaxItems` | `number` | `5` | Maximal `N` kanonische Items pro Cluster im finalen Prompt |

---

## Deduplizierung

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `dedup` | `boolean` | `true` | Near-Duplicate-Erkennung aktivieren |
| `dedupJaccard` | `number` | `0.78` | Jaccard-ähnlichkeits-Threshold für Near-Duplicates (0.0–1.0) |

> **Hinweis:** Ein höherer `dedup`-Wert führt zu aggressiverer Entfernung. `0.78` bedeutet, dass Memories mit ≥78 % Token-Überlappung als Duplikate gelten.

---

## Benannte Storage-Namespaces

`namespaces` ist ein optionales, striktes Top-Level-Objekt unter der
Plugin-Konfiguration. Ohne dieses Objekt bleibt das bestehende Flat-Layout
unverändert: `{baseDbPath}/{agentId}`. Es werden dann weder Namespace-Pfade
ergänzt noch bestehende Daten verschoben.

| Key | Typ | Implizites Verhalten | Beschreibung |
|-----|-----|----------------------|--------------|
| `namespaces.activeWriteNamespace` | `string` | `lancedb-namespaced` innerhalb eines expliziten Objekts | Einziger Namespace für neue und verändernde DB-Operationen |
| `namespaces.activeRecallNamespaces` | `string[]` | `[activeWriteNamespace]` | Aktive Recall-Namespaces; neue Writes gehen weiterhin ausschließlich in den Writer |
| `namespaces.legacyReadOnlyNamespaces` | `string[]` | `[]` | Zusätzliche, strikt nicht mutierende Legacy-Quellen |
| `namespaces.crossNamespaceRecall` | `boolean` | `false` | Nimmt Legacy-Quellen nur bei exakt `true` in Recall auf |

Alle Namespace-IDs müssen `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` erfüllen.
`activeRecallNamespaces` muss den Writer enthalten; aktive und
Legacy-Read-only-Rollen müssen disjunkt sein. Doppelte Einträge werden stabil
zusammengeführt. Ungültige, leere, überlappende oder mehrdeutige Layouts werden
beim Laden der Plugin-Konfiguration abgelehnt.

```json
{
  "baseDbPath": "~/.openclaw/memory",
  "namespaces": {
    "activeWriteNamespace": "lancedb-local",
    "activeRecallNamespaces": ["lancedb-local"],
    "legacyReadOnlyNamespaces": ["lancedb-namespaced"],
    "crossNamespaceRecall": true
  }
}
```

Bei expliziter Konfiguration darf `baseDbPath` entweder der gemeinsame Root
(`~/.openclaw/memory`) oder bereits das aktive Writer-Leaf
(`~/.openclaw/memory/lancedb-local`) sein. Endet der Pfad stattdessen auf einem
konfigurierten Nicht-Writer, wird das Layout als mehrdeutig abgelehnt.
Aufgelöste Namespace- und Agent-Pfade bleiben kanonisch innerhalb ihres Roots;
Symlink-Substitutionen und kanonische Pfadkollisionen schlagen fail-closed fehl.

Legacy-Read-only-Tabellen werden nicht angelegt, migriert oder beschrieben.
Eine tatsächlich fehlende Legacy-Tabelle wird übersprungen; andere Init- oder
Query-Fehler brechen den gesamten öffentlichen Recall ab, ohne Teilergebnis.
Alle beteiligten Tabellen müssen zur konfigurierten Embedding-Dimension passen.

Multi-Namespace-Recall bedeutet ausschließlich: derselbe validierte `agentId`
wird in mehreren benannten Storage-Namespaces gelesen. Wenn mehrere existente
Tabellen teilnehmen, werden die Ergebnisse global und stabil nach Score
sortiert, nach ID beziehungsweise normalisiertem
Canonical-Heading+Text dedupliziert und gemeinsam durch das Tool-`limit`
beziehungsweise `maxPromptMemories`, `canonicalMaxItems` und die bestehenden
Trace-Caps begrenzt; ein einzelner Tabellenpfad bleibt direkt. Das ist kein
Cross-Agent-, Cross-Workspace- oder Cross-User-Sharing; diese ACL- und
Sharing-Verträge bleiben B13 vorbehalten.

---

## Lokale E5-, Jina- und BGE-Modelle (7.5.0)

Der freie Standard-Offline-Pfad verwendet E5. Zusaetzlich kann das
mehrsprachige `jinaai/jina-embeddings-v3` als revisions- und hashgeprüfte
Q8-ONNX-Konvertierung heruntergeladen werden; dieses Modell
steht unter CC BY-NC 4.0 und ist daher ohne gesonderte Lizenz nicht fuer
kommerzielle Nutzung freigegeben. Beide Pfade verwenden revisionsgeprüfte
Transformers.js-Artefakte.
Das Cache-Verzeichnis muss für den unprivilegierten Gateway-Benutzer schreibbar
sein. Die vollständigen erwarteten Größen und SHA-256-Werte stehen in
`lib/providers/local-model-artifacts.js`; eine falsche Revision oder eine
unvollständige Datei wird vor der Inferenz abgelehnt.

```json
{
  "embedding": {
    "provider": "local-transformers",
    "local": {
      "model": "intfloat/multilingual-e5-small",
      "revision": "614241f622f53c4eeff9890bdc4f31cfecc418b3",
      "dimensions": 384,
      "cacheDir": "${OPENCLAW_HOME}/models/plur1bus"
    }
  },
  "reranker": {
    "enabled": true,
    "provider": "local-transformers",
    "model": "jinaai/jina-reranker-v2-base-multilingual",
    "local": {
      "model": "jinaai/jina-reranker-v2-base-multilingual",
      "revision": "9cfeff2df7d40d1b78e75e5e9cebec92a99813c9",
      "cacheDir": "${OPENCLAW_HOME}/models/plur1bus"
    },
    "fallbackOnError": true,
    "fallbackProvider": "local-transformers",
    "fallbackModel": "woxpas-ai/bge-reranker-v2-m3-onnx",
    "fallbackRevision": "c44ebc43de724ae8816668bb44d2e728e17faa18",
    "fallbackCacheDir": "${OPENCLAW_HOME}/models/plur1bus"
  }
}
```

Als optionales Jina-v3-Embedding wird nur das folgende gepinnte Profil
akzeptiert. `dimensions` darf ausschliesslich 32, 64, 128, 256, 512, 768 oder
1024 sein. Query und Passage werden intern ueber die veroeffentlichten
`retrieval.query`-/`retrieval.passage`-Task-Adapter getrennt; Praefixe werden
nicht benoetigt.

```json
{
  "embedding": {
    "provider": "local-transformers",
    "dimensions": 256,
    "local": {
      "model": "jinaai/jina-embeddings-v3",
      "revision": "68ed94909d564380f954be27ae2e133214c1adc9",
      "dimensions": 256,
      "cacheDir": "${OPENCLAW_HOME}/models/plur1bus"
    }
  },
  "modelPreparation": {
    "profile": "jina-v3-multilingual-256",
    "acceptNonCommercialLicense": true
  }
}
```

Die Bestaetigung ist kein reiner UI-Hinweis: Ohne sie verweigern sowohl der
aktive Provider als auch Re-Embedding-Probes und der zentrale Artefakt-
Downloader Jina vor Netzwerk- oder Modellzugriff. Vorbereitung, Zielprobe und
der nach einem bestaetigten Switch aktive Provider verwenden exakt dasselbe
aufgeloeste `embedding.local.cacheDir`; ein Remote-Provider darf diesen
zukuenftigen lokalen Cache bereits konfigurieren.

Wer Jina abwählt, kann BGE direkt als `reranker.model` und
`reranker.local.model` setzen. Das Quellrepository
`BAAI/bge-reranker-v2-m3` ist für diesen Pfad absichtlich ungültig, weil es
keine von Transformers.js ladbare ONNX-Datei veröffentlicht. Ein Jina-Fehler
wechselt nur dann kontrolliert zu BGE, wenn der oben gezeigte freie Fallback
explizit konfiguriert ist.

### Embedding-Dimensionen

Die PLUR1BUS-Operator-Ansicht trennt Embedding- und Reranker-Modelle. Fuer
`text-embedding-3-small` sind 1 bis 1536 Dimensionen und fuer
`text-embedding-3-large` 1 bis 3072 Dimensionen zulaessig; die Ansicht bietet
dafuer bewaehrte Presets und markiert die jeweilige Standardbreite. Das lokale
`intfloat/multilingual-e5-small` liefert fest 384 Dimensionen. Das getrennte
Jina-v3-Embedding unterstuetzt exakt 32/64/128/256/512/768/1024 Dimensionen.
Der Jina-v2-Reranker und BGE sind Reranker und besitzen keine Memory-
Vektordimension.

Die Auswahl in der externen OpenClaw-Plugin-Registerkarte ist eine lesende
Planungshilfe. Ein Dimensionswechsel wird ausschliesslich ueber den bestaetigten
Re-Embedding-Adminpfad angewendet. Unbekannte OpenAI-kompatible Modelle erhalten
keine erratene Auswahlliste; fuer sie sind eine explizite Dimension und die
Validierung eines real gelieferten Vektors erforderlich. Auch bekannte Modelle
werden vor dem Umschalten durch eine echte Providerantwort validiert.

### Automatische Modellvorbereitung

OpenClaw Config bietet unter `modelPreparation.profile` eine geschlossene
Auswahl aus E5 384d und den sieben Jina-v3-Matryoshka-Profilen. Speichern der
Auswahl startet im Gateway nur Download und SHA-256-Validierung. Fortschritt,
Dateizahl, Revision und Ziel-Fingerprint werden dauerhaft unter dem
PLUR1BUS-State gespeichert und nach einem erneuten Oeffnen der Operator-Seite
weiter angezeigt. Gleichzeitige Anforderungen des aktiven Providers und der
Vorbereitung teilen denselben In-Flight-Download.

```json
{
  "modelPreparation": {
    "profile": "jina-v3-multilingual-256",
    "acceptNonCommercialLicense": true
  }
}
```

Fuer jeden Jina-v3-Embedding-Pfad ist die ausdrueckliche Bestaetigung der
nicht-kommerziellen CC-BY-NC-4.0-Lizenz erforderlich. Ohne sie werden weder
Download noch Inferenz gestartet. Sobald
alle Artefakte gueltig sind, vergleicht PLUR1BUS den Ziel-Fingerprint mit der
aktiven Generation und berechnet lesend Kartenanzahl, Zielgroesse und
Platzbedarf. Eine Abweichung erzeugt nur die Empfehlung fuer
`plur1bus.reembedding.plan`; sie startet weder Kopieren noch Umschalten. Apply
und `ready_to_switch` bleiben zwei getrennte explizite Bestaetigungen. Bei
Fehler, Abbruch oder zu wenig Platz bleibt die aktive Generation unveraendert.

---

## Träume in OpenClaws Traumseite (7.7.0)

OpenClaws Control UI zeigt unter Einstellungen → Memory → Dreams das Tagebuch
`DREAMS.md` aus dem Workspace des Agenten. PLUR1BUS schreibt seine
Traumerzählungen (Light- und REM-Traum) seit 7.7.0 in genau diese Datei, im
Eintragsformat des Hosts und innerhalb des vom Host verwalteten Blocks. Nur
Träume aus der privaten Agentenpartition landen dort; geteilte Workspace- oder
Nutzerpartitionen nie.

```json
{
  "dreaming": { "narrative": { "diary": true } }
}
```

`dreaming.narrative.diary` steht standardmässig auf `true`. Die Zeitangabe
folgt `timezone` aus der Plugin-Konfiguration. Derselbe Traum wird nicht
zweimal eingetragen; ein Fehlschlag beim Schreiben bricht den Traum nicht ab.

Damit das Tagebuch einen Autor hat, sollte das verwaltete Träumen des Hosts aus
sein. Der Host liest diesen Schalter aus dem Eintrag des Memory-Slot-Besitzers,
also `plugins.entries.memory-lancedb-namespaced.config.dreaming.enabled: false`.
Das Flag unter `memory-core` ist bei fremdem Slot-Besitzer wirkungslos; das
wurde am 04.09.2026 live geprüft.

PLUR1BUS registriert ausserdem die Speicher-Laufzeit, die der Host vom Besitzer
des Memory-Slots erwartet. Damit zeigen Übersicht und Szene derselben Seite
Anbieter, Modell und Embedding-Zustand von PLUR1BUS statt „memory plugin
unavailable", und die Speichersuche des Hosts läuft über PLUR1BUS' eigene
Recall-Pipeline, beschränkt auf die private Partition des Agenten. Die Zähler
unter „Erweitert" und die Phasen-Chips bleiben memory-core vorbehalten; dafür
gibt es keine öffentliche Schnittstelle.

## Schalter im Operator-Dashboard (7.6.0)

Der PLUR1BUS-Reiter in OpenClaws Control UI ist standardmaessig rein lesend.
`controlUi.writeActions` hebt das gezielt auf:

| Wert | Wirkung |
| --- | --- |
| `off` (Standard) | Die Seite aendert nichts und fordert nur `operator.read` an. |
| `reranker` | Die Reranking-Wahl ist von der Seite aus umschaltbar. |
| `all` | Zusaetzlich Embedding-Zielprofil, die Schritte der Re-Embedding-Migration und der Compact-Knopf je Partition (7.8.0). |

```json
{
  "controlUi": { "writeActions": "reranker" }
}
```

Alles ausser `off` gibt dem Reiter `operator.write`; nur Operatoren mit diesem
Recht bekommen ihn dann ueberhaupt angezeigt. Jede Aenderung braucht ein
einmaliges Formular-Token aus genau dem Seitenaufruf, in dem geklickt wurde,
weil das vom Host gesetzte Reiter-Cookie `SameSite=None` ist. Ohne OpenClaws
Config-Mutations-Faehigkeit bleibt die Seite lesend, unabhaengig vom Wert.

OpenClaw bettet den Reiter als Iframe mit `sandbox="allow-scripts"` ein, ohne
`allow-forms`; der Browser blockiert dort jede native Formularabgabe. Seit
7.8.1 traegt eine schreibfaehige Seite deshalb ein nonce-gebundenes Skript,
das den Klick auf den Absende-Knopf abfaengt (das `submit`-Ereignis feuert im
Sandbox-Frame nie) und die Aktion per `fetch` als GET mit dem Einmal-Token im
Query abschickt (der Host nimmt das Reiter-Cookie nur fuer GET an, ein POST
aus dem Frame bekommt 401); danach laedt die Seite sich selbst neu und zeigt
das Ergebnis als Banner. Ohne `via=fetch` oder ohne Token rendert ein GET nur
die Seite. Die CSP nennt als `connect-src` genau den Host, von dem die Seite
kam. Eine lesende Seite bleibt ohne Skript.

Die Reranker-Wahl ist eine reine Laufzeitentscheidung ohne Datenwanderung:
lokal BGE, lokal JinaAI (beide ohne Schluessel), Cohere (nur wenn ein
Schluessel hinterlegt ist) oder aus. Das Embedding-Ziel wird dagegen nur
vorbereitet; der eigentliche Wechsel laeuft ueber die bestehende Migration mit
Probelauf, Kopie und getrenntem Umschalten. Das Bestaetigungs-Token dieser
Migration bleibt im Gateway und erscheint nie im Browser.

Seit 7.8.0 steht bei `all` hinter jeder privaten Partition unter „Cards by
agent" ein Knopf **Compact**. Er startet LanceDBs Fragment-Kompaktierung
(`table.optimize()`) fuer genau diese Partition: Jeder Schreibvorgang legt ein
neues Fragment an, ohne Kompaktierung wachsen tausende kleine Dateien und
Voll-Scans werden um Groessenordnungen langsamer. Es laeuft immer nur eine
Kompaktierung; sie arbeitet im Hintergrund mit dem Zehn-Minuten-Budget des
Adapters, die Zeile zeigt „compacting…" und danach das Ergebnis. Angenommen
werden nur Partitionen, die der Health-Scan selbst gelistet hat. Der naechste
Health-Scan zeigt den neuen Speicherstand.

## B13 Shared-Memory-Routen und Hook-Grenze

Shared-Memory ist keine Konfigurations-Abkürzung für Namespace-Reads.
`/share <id>` erzeugt nach gebundener Bestätigung eine Workspace-Kopie;
`/share <id> --user` erzeugt eine User-Kopie. Eine Karte wird **copy, never
move** behandelt. Physische, nicht aus Eingaben abgeleitete Routen sind maximal
64 Zeichen und enden auf `.plur1bus-shared/workspaces/w-<62hex>` beziehungsweise
`.plur1bus-shared/users/u-<62hex>`. Workspace-Aliase werden konfliktablehnend
kanonisiert; es gibt keine versteckte Priorität. Der Zugriff bindet Kanal,
Account und User; autorisierte Shared-Recall-Quellen sind additiv und nach
kanonischem Origin dedupliziert.

Automatische User-Shared-Recall im OpenClaw-Prompt-Hook existiert nur bei
`autoRecall: true` und nur mit account-tragendem Session-Key, exaktem
Host-Run-Ticket oder konservativer default-only Account-Topologie. Native und
Slash-Kommandos minten absichtlich kein Route-Ticket, weil sie den Prompt-Hook
nicht erreichen. Bei mehrdeutigen named/multi-account Main/Group/Channel-Turns
entfällt nur die optionale User-Shared-Quelle; `/memory`, `/share --user` und
Tools nutzen weiterhin den vom Host gelieferten Account. Ein Session-last-route
Wert ist kein turn-gebundener Account-Nachweis.

Alte `workspace_shared`-Zeilen werden nicht neu gedeutet: workspace_shared
legacy rows are not reinterpreted. Nur der destruktiv autorisierte,
initialisierte Runtime-Befehl `/plur1bus migrate-legacy-shared` kann sie nach
Dry-run mit `--apply` kopieren. `--cursor <token>` ist opak und nur für den
passenden Dry-run/Quellversions-Stand gültig. Pro Lauf gelten 250 Zeilen,
4 MiB, 100 Provider-Aufrufe und 60 Sekunden; Version-/Modus-/Bindungsfehler,
Timeout oder unklare Commits brechen ab und verlangen Fortsetzung oder Neustart.
Es gibt keinen separaten DB-, Config- oder Credential-Bootstrap. Multi-Namespace,
Neo/Obsidian-Aliase, Semantic Lens, CRR, OpenClaw default LLM und per-agent
credentials ändern sich dadurch nicht.

---

## Halbwertszeit (Typbasiert)

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `halfLifeDaysMap` | `object` | siehe unten | Typ-spezifische Halbwertszeiten in Tagen |

### Defaults von `halfLifeDaysMap`

```json
{
  "transient": 60,
  "episodic": 180,
  "longContext": 600,
  "project": 600
}
```

- **`transient`** (60 d): Kurzlebige Beobachtungen, Tool-Ausgaben, flüchtige Hinweise
- **`episodic`** (180 d): Episodische Erinnerungen, Session-Zusammenfassungen
- **`longContext`** / **`project`** (600 d): Langfristiges Wissen, Projekt-Setups, Behavior Cards

> Alte, globale `halfLifeDays`-Werte bleiben erhalten, werden aber nur als Fallback verwendet, wenn kein Typ-Mapping existiert.

---

## Embedding-Cache

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `runtime.embeddingCacheEnabled` | `boolean` | `true` | LRU-Cache für Embedding-Vektoren aktivieren (seit v6.2.1 aktiv verdrahtet). |
| `runtime.embeddingCacheMaxEntries` | `number` | `128` | Maximale Anzahl im Memory-Cache; Legacy-Alias ist `embeddingCacheMaxEntries`. |
| `runtime.embeddingCacheTtlMs` | `number` | `300000` | TTL eines Cache-Eintrags in Millisekunden (5 Minuten). |
| `runtime.embeddingCachePersist` | `boolean` | `false` | SQLite-Persistenz nach `embeddingCacheScope` (`agent`/`shared`) aktivieren. |
| `runtime.embeddingCachePersistDebug` | `boolean` | `false` | Persistenz-Debugs im Logger aktivieren. |
| `runtime.embeddingCacheCoalesce` | `boolean` | `true` | Identische Anfragen deduplizieren (ein Call statt N Calls). |
| `runtime.embeddingCacheMetrics` | `boolean` | `false` | Metriken für Hits, Misses, Persist-Hits und Coalescing emitten. |
| `runtime.embeddingCacheScope` | `"agent" \| "shared"` | `"agent"` | Scope-Kennung für den Cache-Key. `shared` teilt Cache-Scope pro Plugin. |
| `runtime.embeddingCacheMaxBytes` | `number` | `1073741824` (`agent`) / `5368709120` (`shared`) | Maximale persistente Speichergröße (Soft-Limit bei 90 %). |

### Verhalten

- Der Cache-Key ist `provider + model + dimensions + scopeId + cacheVersion + sha256(normalizedText)`.
- Treffer vermeiden wiederholte Embedding-Anfragen und beschleunigen den Recall-Hot-Path typischerweise deutlich.
- Bei Cache-Miss wird der Embedding-Provider wie gewohnt aufgerufen; Ergebnis wird per Request-Coalescing in den LRU-Cache geschrieben.
- Mit aktivierter Persistenz wird der Cache zusätzlich nach `embeddingCacheScope` in SQLite (`embedding-cache-v2/*.db`) gespeichert; bei hartem Byte-Limit wird auf Soft-Limit-Backoff umgeschaltet.
- Bei Plugin-Neustart bleibt der persistente Teil erhalten; der Memory-Teil wird neu aufgebaut.

---

## LLM-Result-Cache

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `runtime.llmResultCacheEnabled` | `boolean` | `true` | Exakten Ergebnis-Cache für deterministische interne LLM-Transformationen aktivieren. |
| `runtime.llmResultCacheTtlMs` | `number` | `86400000` | Absolute TTL eines Eintrags in Millisekunden (24 h); wird auf 60 s–7 d geclampet. |
| `runtime.llmResultCacheMaxEntries` | `number` | `256` | Maximale Anzahl Einträge im Memory-Cache; Obergrenze 10.000 (Clamp mit Warnung). |
| `runtime.llmResultCachePersist` | `boolean` | `false` | SQLite-Persistenz aktivieren (benötigt Node ≥ 22.22 für `node:sqlite`; sonst Memory-only). |
| `runtime.llmResultCacheMaxBytes` | `number` | `67108864` | Maximale persistente Speichergröße (Soft-Limit bei 90 %); Obergrenze 1 GiB (Clamp mit Warnung). |
| `runtime.llmResultCacheMetrics` | `boolean` | `true` | Metriken für Hits, Misses, Persist-Hits und vermiedene Tokens emittieren (sichtbar in `/state`). |

### Verhalten

- Es werden ausschließlich exakte, agent-scoped Ergebnisse einer Allowlist deterministischer interner Transformationen gecacht (Capture-/Recall-Zusammenfassungen, Merge- und Konflikt-Entscheidungen, Emotions-, Episoden-, Skill- und REM-Analysen, KNOWLEDGE-Updates). Hauptchat, Critical-Classifier, Dream-Narrative und andere nicht-deterministische Pfade bleiben immer live.
- Der Cache-Key ist ein SHA-256 über Version, Purpose, Scope, Endpoint, Credential-Hash, Modell, Messages und Generierungsoptionen; Prompts, Credentials und Header fließen nur gehasht ein und werden nie persistiert.
- Die Persistenz speichert Antworttexte im Klartext unter `llm-result-cache-v1/{agentId}.db` (Verzeichnis `0o700`, Datei `0o600`) — daher Opt-in.
- Fehler, leere Antworten und invalide JSON-Mode-Ergebnisse werden nie gecacht; Cache-Defekte fallen immer auf Live-Calls zurück (Fail-open).
- Die integrierten Call-Sites senden `temperature: 0`; seit diesem Feature reicht `lib/llm-call.js` `temperature` auch tatsächlich an den Provider durch (vorher wurde der Wert ignoriert).

---

## Chat-LLM-Routing über OpenClaw

Ein nicht gesetztes Feature-Modell (`model` absent) verwendet das effective
OpenClaw agent model des Ziel-Agenten. PLUR1BUS hat keinen globalen
Chat-Modell-Default und erbt keine Route zwischen Features: `schicht15`,
`skillMiner`, `criticalPush` und `emotion.t3` übernehmen insbesondere weder
`merging.model` noch dessen Endpoint, Credential oder Header.

Jeder aktivierte Chat-Aufruf löst genau einen von vier Route-Modi auf:

- `openclaw-default`: native OpenClaw-Completion ohne `model`-Property; OpenClaw wählt das effektive primäre Agentenmodell.
- `openclaw-override`: ein feature-lokales `model` ohne direkte Transportfelder; OpenClaw verwaltet Provider und Credentials.
- `direct-override`: feature-lokales `model` plus `baseUrl`, aufgelöstes `apiKey` oder nicht-leere `headers`; der bestehende begrenzte OpenAI-kompatible Direktpfad wird verwendet.
- `unavailable`: die Route kann sicher keinen Request senden. Direct transport without a feature-local model fails closed as an ambiguous partial override.

`failed` ist der stabile Diagnosewert für einen gescheiterten Transport, kein
fünfter Auswahlmodus. Erfolgreiche native Ergebnisse übernehmen ausschließlich
die von OpenClaw zurückgegebenen Provider-/Modellwerte in die Diagnose; Prompts,
Credentials und Auth-Header werden nicht aufgezeichnet. Native routes bypass
the PLUR1BUS result cache; nur vollständige `direct-override`-Routen behalten
den exakten PLUR1BUS-Ergebnis-Cache.

A configured credential that is unresolved is unavailable. PLUR1BUS never
substitutes native OpenClaw host credentials, erfindet keine Host-Credential-
Fallback-Kette und bricht deshalb nicht die gesamte Plugin-Registrierung ab.
`runtime.llm.complete` missing or unavailable is fail-soft: das owning Feature
nutzt seinen bestehenden Skip-/Fallbackpfad, ohne einen zweiten Modellversuch.

### Agentenbindung und Trust

A session-bound command capability omits `agentId`, weil sie bereits an die
aktive Session gebunden ist. Global hook, tool, and background calls senden den
Ziel-Agenten und benötigen am Plugin-Entry
`llm.allowAgentIdOverride:true`. A model-only native override requires
`llm.allowModelOverride:true` und muss gegebenenfalls in `allowedModels`
zugelassen sein. Eine Policy-Ablehnung bleibt fail-soft; PLUR1BUS wiederholt
den Request nicht ohne Agent oder Modell. Installer `preserve` never grants LLM
trust; Safe und Recommended setzen ebenfalls keine dieser Entry-Level-Bits.

`runtime.llm.complete` resolves the effective primary selection and does not
execute the configured model fallback array in the installed Runtime. Die
Fallback-Policy bleibt OpenClaw-Konfiguration, aber PLUR1BUS behauptet oder
implementiert keine Host-Fallback-Kette.

Komplette explizite Direkt-Overrides bleiben möglich, müssen aber vollständig
feature-lokal sein. Beispiel:

```json
{
  "merging": {
    "enabled": true,
    "model": "vendor/merge-model",
    "baseUrl": "https://llm.example/v1",
    "apiKey": "${MERGING_LLM_API_KEY}"
  }
}
```

Das benannte Modell ist nur ein explizites Override-Beispiel, kein Default.

---

## Beispiel-Konfiguration (Minimal)

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "autoCapture": true,
          "autoRecall": true,
          "recall": {
            "maxPromptMemories": 12,
            "candidateTopK": 40,
            "importanceBoost": 0.3,
            "dedup": true,
            "dedupJaccard": 0.78,
            "canonicalFirst": true,
            "canonicalMinScore": 0.30,
            "canonicalMaxItems": 5,
            "halfLifeDaysMap": {
              "transient": 60,
              "episodic": 180,
              "longContext": 600,
              "project": 600
            }
          },
          "runtime": {
            "embeddingCacheEnabled": true,
            "embeddingCacheMaxEntries": 128,
            "embeddingCacheTtlMs": 300000,
            "embeddingCachePersist": false,
            "embeddingCachePersistDebug": false,
            "embeddingCacheCoalesce": true,
            "embeddingCacheMetrics": false,
            "embeddingCacheScope": "agent",
            "llmResultCacheEnabled": true,
            "llmResultCacheTtlMs": 86400000,
            "llmResultCacheMaxEntries": 256,
            "llmResultCachePersist": false,
            "llmResultCacheMaxBytes": 67108864,
            "llmResultCacheMetrics": true,
            "recallCacheTtlMs": 120000,
            "recallCacheMaxEntries": 128
          }
        }
      }
    }
  }
}
```

`hooks.allowConversationAccess: true` ist für das vertrauenswürdige
Memory-Plugin verpflichtend. OpenClaw registriert sonst den fail-closed
`before_agent_reply`-Schutz der direkten Feature-Crons nicht. Der Installer
stellt ausschließlich diese notwendige Berechtigung auch im Preserve-Modus
sicher; sonstige Hook- und Feature-Entscheidungen bleiben erhalten.

---

## Emotion Tier-Config

Steuert die 3-Tier-Emotions-Inferenz beim Memory-Capture.

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `emotion.tier` | `"t1" \| "t2" \| "t3" \| "auto"` | `"auto"` | Festes Tier oder automatisches Routing |
| `emotion.t2.enabled` | `boolean` | `true` | Tier-2 (Keyword-Fallback) aktivieren |
| `emotion.t3.enabled` | `boolean` | `false` | Tier-3 (LLM-basiert) aktivieren — **provider-gated/fail-soft**: kein API-Call ohne verfügbare native oder vollständige direkte Route |
| `emotion.t3.model` | `string` | — | Wenn `model` absent ist, gilt das effective OpenClaw agent model; kein Fallback zu `merging.model` |
| `emotion.t3.apiKey` | `string` | — | Optionales feature-lokales Credential für einen direkten Override; benötigt ein explizites `emotion.t3.model` |
| `emotion.t3.baseUrl` | `string` | — | Optionaler feature-lokaler Endpoint für einen direkten Override; benötigt ein explizites `emotion.t3.model` |

### Budget-Gate

Tier-3 läuft **niemals heimlich**. Der Manifest-Default ist `enabled:false`;
das explizite Recommended-Profil kann es einschalten. Auch dann erfolgt kein
API-Call, wenn keine vollständige native oder direkte Route verfügbar ist
(`onlyWhenProviderAvailable: true`). Providerfehler bleiben fail-soft
(`fallbackOnError: true` → Fallback auf Tier-2).

Ohne native OpenClaw-Completion und ohne vollständigen expliziten Direkt-
Override bleibt Tier-3 stumm. Embedding-Provider und -Credentials sind dafür
nicht maßgeblich.

Der Feature-Toggle `/disable emotionTier` steuert `emotion.t3.enabled` auf `false`.

### Explizites Override-Beispiel

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "config": {
          "emotion": {
            "tier": "auto",
            "t2": { "enabled": true },
            "t3": { "enabled": true, "model": "gpt-4o-mini", "fallbackOnError": true, "onlyWhenProviderAvailable": true }
          }
        }
      }
    }
  }
}
```

---

## Obsidian Bridge — Graph Links & Semantic Discovery

Diese Optionen steuern die wikilink-basierten Graph-Blöcke in Record-Notes und den optionalen semantischen Link-Index.

### `obsidianBridge.graphLinks`

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `maxPerNote` | `number` | `5` | Maximale Anzahl Links pro Note |
| `tiers` | `string[]` | `["explicit", "type", "semantic"]` | Verwendete Link-Tiers |
| `includeSemantic` | `boolean` | `false` | Semantische Links aus `.plur1bus/link-index.json` einbinden |
| `semanticThreshold` | `number` | `0.78` | Ähnlichkeits-Threshold für semantische Links |
| `blockId` | `string` | `"graph-links"` | ID des Managed Blocks |

- **Tier `explicit`**: Verweise aus `memoryIds`, `source_memories` und `sourceRefs`.
- **Tier `type`**: Typ-basierte Regeln (z. B. Kandidat ↔ Entscheidung, Review-Items im selben Bundle).
- **Tier `semantic`**: Vorberechnete Ähnlichkeits-Links aus dem Link-Index.

### `obsidianBridge.graphLinks.semanticDiscovery`

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `enabled` | `boolean` | `false` | Automatischen Bau des semantischen Link-Index aktivieren |
| `maxPerRun` | `number` | `500` | Maximal zu verarbeitende Records pro Lauf |
| `maxLinksPerRecord` | `number` | `5` | Maximale semantische Links pro Record |
| `threshold` | `number` | `0.78` | Cosine-Similarity-Threshold für semantische Paare |
| `topK` | `number` | `20` | Kandidaten-Fenster für die ANN-Suche |

> Der semantische Link-Index wird nur geschrieben, wenn er explizit bestätigt (`confirm: true`) oder über einen internen Befehl mit Bestätigung angestoßen wird. Er wird nicht automatisch beim Recall angewendet.

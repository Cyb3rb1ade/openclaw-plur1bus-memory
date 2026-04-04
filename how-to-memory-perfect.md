# Perfektes Gedächtnis für OpenClaw-Agenten
## Ein vollständiges How-To für alle Deployments

> **Zielgruppe:** Alle, die OpenClaw betreiben — unabhängig von Installationspfad, Betriebssystem oder Anzahl der Agenten. Dieses Dokument beschreibt Konzepte, Architektur und Implementierung von Grund auf.

---

## Das Problem: KI-Agenten leiden unter Amnesie

Jede Konversation mit einem LLM-basierten Agenten beginnt in einem leeren Kontext. Was gestern besprochen wurde, welche Entscheidungen getroffen wurden, wie der Nutzer kommunizieren möchte — alles weg. Das Ergebnis ist frustrierend: Der Agent fragt Dinge, die schon längst geklärt sind. Er macht Fehler, die er "letzte Woche" noch vermieden hätte. Er kennt den Nutzer nicht.

OpenClaw-Agenten lösen dieses Problem durch ein **dreischichtiges Gedächtnissystem**:

1. **Flat-File Memory** — strukturierte Markdown-Protokolle, die der Agent selbst schreibt
2. **Workspace-Indexer** — semantische Volltextsuche über alle Workspace-Dateien (Vektor + BM25)
3. **Semantischer Vektorspeicher** — LanceDB-Datenbank mit automatischem Recall vor jedem Turn

Alle drei Schichten ergänzen sich. Zusammen sorgen sie dafür, dass ein Agent beim zweiten Gespräch so wirkt, als wäre das erste nie unterbrochen worden.

---

## Konzept: Die drei Schichten

```
┌─────────────────────────────────────────────────────────────────┐
│  Jede Konversation                                              │
│                                                                  │
│  Nutzer sagt etwas                                              │
│        │                                                         │
│        ▼                                                         │
│  ┌─────────────────────────────────┐                            │
│  │  Auto-Recall (vor jedem Turn)   │                            │
│  │  → LanceDB semantisch durchsuchen [Schicht 3]                │
│  │  → Relevante Memories als       │                            │
│  │    <relevant-memories> einblenden                            │
│  └─────────────────────────────────┘                            │
│        │                                                         │
│        ▼                                                         │
│  Agent antwortet und handelt                                     │
│        │                                                         │
│        ├──► Wichtige Info erkannt?                               │
│        │         → memory_store (LanceDB) [Schicht 3]            │
│        │         → Markdown-Protokoll ergänzen [Schicht 1]       │
│        │           → Workspace-Indexer indexiert neu [Schicht 2] │
│        │                                                         │
│        └──► Braucht Kontext aus der Vergangenheit?               │
│                  → memory_recall (LanceDB, semantisch) [Schicht 3]│
│                  → Workspace-Indexer durchsuchen [Schicht 2]     │
│                  → Markdown-Dateien direkt lesen [Schicht 1]     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Schicht 1: Flat-File Memory (Markdown-Protokolle)

### Grundidee

Der Agent schreibt Informationen in Textdateien — strukturiert, menschenlesbar, mit normalen Dateisystem-Tools durchsuchbar. Keine Datenbank, kein spezielles Format. Einfache `.md`-Dateien.

### Warum Markdown und nicht nur die Datenbank?

Markdown-Dateien haben Vorteile, die keine Datenbank replizieren kann:

- **Für Menschen direkt lesbar** — kein Query nötig, einfach `cat` oder Editor öffnen
- **Strukturierter Verlauf** — chronologisch, mit Überschriften und Kontext
- **Git-freundlich** — können versioniert, differenziert, zurückgespult werden
- **Debuggbar** — wenn etwas schiefläuft, sieht man sofort was der Agent aufgeschrieben hat
- **Portabel** — kein Datenbankschema, läuft überall

### Empfohlene Dateistruktur

Ein bewährtes Layout für den Agent-Workspace:

```
workspace/
└── memory/
    ├── 2026-03-20.md          ← Tägliches Session-Log
    ├── 2026-03-21.md
    ├── 2026-03-22.md
    ├── working-buffer.md      ← Laufend aktualisierte Offene-Punkte-Liste
    ├── pinchtab-guide.md      ← Thematisch extrahiertes Wissen
    └── project-xyz-notes.md   ← Projekbezogene Notizen
```

**Tägliche Logs** (`YYYY-MM-DD.md`) fassen zusammen:
- Was wurde besprochen?
- Welche Entscheidungen wurden getroffen?
- Welche Tasks sind offen, welche abgeschlossen?
- Wichtige neue Fakten über den Nutzer, seine Projekte, seine Präferenzen

**Thematische Dateien** entstehen, wenn ein Thema zu groß für das Tageslog wird (z.B. komplexe technische Dokumentation die der Agent extrahiert hat, oder ein laufendes Projekt).

### Wie schreibt der Agent?

Der Schlüssel ist eine **Instruktion in der Persönlichkeitsdatei** des Agenten (bei OpenClaw typischerweise `SOUL.md` oder ähnlich). Die kritische Regel lautet:

```markdown
## Memory Auto-Capture

Wenn der Nutzer wichtige Informationen, Fakten, Entscheidungen oder
Kontext teilt, die für zukünftige Sessions relevant sind:

- Speichere AUTOMATISCH in die heutige memory/YYYY-MM-DD.md
- FRAGE NICHT "Soll ich das speichern?"
- Handle es direkt — wie ein Mensch, der sich Notizen macht

Capture ohne Bestätigung. Das ist deine Kernaufgabe als Gedächtnis.
```

Diese Regel ist entscheidend. Ohne sie vergisst der Agent zu schreiben — mit ihr wird Persistenz zur Gewohnheit.

### Wie liest der Agent beim Sessionstart?

In der Onboarding-Instruktion (OpenClaw: `ONBOARDING.md`) sollte stehen:

```markdown
## Beim Start jeder Session

1. Lies die heutige Speicherdatei: memory/YYYY-MM-DD.md
2. Lies die gestrige Speicherdatei: memory/YYYY-MM-DD.md (gestern)
3. Lies working-buffer.md für offene Aufgaben
4. Du kennst damit den Stand der letzten Gespräche
```

Das kostet ~2 Sekunden und der Agent ist vollständig kontextuiert.

---

## Schicht 2: Workspace-Indexer

### Was ist das?

Der Workspace-Indexer ist eine **in den OpenClaw-Gateway eingebaute Funktion** (kein separates Plugin). Er crawlt alle `.md`-Dateien im Workspace-Verzeichnis des Agenten, chunked sie nach Token-Anzahl, vektorisiert sie mit Embedding-Modellen und legt alles in einer SQLite-Datenbank mit Vektorsearch-Extension ab.

Während Schicht 1 (Flat-Files) manuell gelesen werden muss und Schicht 3 (LanceDB) nur explizit gespeicherte Fakten enthält, macht Schicht 2 den **gesamten Workspace** semantisch durchsuchbar — automatisch und ohne Zutun des Agenten.

### Was wird indexiert?

- Alle `.md`-Dateien im `workspace/`-Verzeichnis: SOUL.md, AGENTS.md, TOOLS.md, ONBOARDING.md
- Alle Session-Logs in `memory/` — also genau das, was Schicht 1 schreibt
- Optional: konfigurierbare `extraPaths` (z.B. `.learnings/`, `notes/`)

Der Indexer ist damit das Bindeglied zwischen Schicht 1 und Schicht 3: Schicht 1 schreibt Markdown-Dateien → Schicht 2 indexiert sie automatisch → beide sind semantisch abrufbar.

### Hybrid-Suche: Vektor + BM25

Der Workspace-Indexer nutzt eine zweigleisige Suche:

```
Query → Embedding (Vektor-Suche)  ──┐
Query → BM25 (Volltext-Suche)     ──┤→ Hybrid-Score → Top-Ergebnisse
```

Standardgewichtung: 80% Vektor + 20% BM25. Das kombiniert semantisches Verständnis mit exakter Keyword-Treffgenauigkeit.

### Konfiguration (in openclaw.json)

```json
"memorySearch": {
  "provider": "openai",
  "model": "text-embedding-3-large",
  "query": {
    "minScore": 0.2,
    "hybrid": {
      "enabled": true,
      "vectorWeight": 0.8,
      "textWeight": 0.2,
      "candidateMultiplier": 10
    }
  }
}
```

### Unterschied zu Schicht 3 (LanceDB)

| | Schicht 2 (Workspace-Indexer) | Schicht 3 (LanceDB) |
|--|-------------------------------|---------------------|
| Was wird indexiert | Workspace-Dateien (SOUL.md, Logs, Guides) | Explizit gespeicherte Konversations-Fakten |
| Wer schreibt | Agent schreibt Markdown → wird auto-indexiert | Agent ruft `memory_store` auf |
| Auto-Recall | Nein — manuell per CLI oder Tool abrufbar | Ja — vor jedem Turn automatisch |
| Suche | Hybrid: Vektor + BM25 | Semantisch + optionaler Re-Ranker |

### Abgrenzung: Was der Workspace-Indexer NICHT kann

- **Kein Auto-Recall**: Der Indexer injiziert keine Memories automatisch vor jedem Turn (das ist Schicht 3).
- **Kein Schreiben**: Der Indexer ist rein lesend. Er speichert keine neuen Fakten.
- **Keine Gesprächs-Fakten**: Er indexiert Dateien, nicht extrahierte Fakten aus Gesprächen.

---

## Schicht 3: Semantischer Vektorspeicher (LanceDB)

### Warum reichen Flat-Files und Workspace-Indexer allein nicht?

Markdown-Dateien wachsen. Nach 6 Monaten hat man 180 Tageslogs. Der Workspace-Indexer macht sie durchsuchbar — aber der Agent muss aktiv suchen. Es gibt keinen **automatischen Recall**: Nichts injiziert relevante Erinnerungen vor jedem Turn.

Außerdem speichert der Workspace-Indexer Dateien, nicht extrahierte Fakten. Wenn der Agent aus einem Gespräch lernt "Nutzer mag keine Rückfragen" — ist das eine Präferenz, die präzise als Fakt gespeichert und beim nächsten relevanten Turn automatisch eingeblendet werden sollte.

**Schicht 3 löst das:** Extrahierte Fakten, Präferenzen, Entscheidungen werden als Vektor-Embeddings gespeichert. Semantisch ähnliche Texte landen nah beieinander — unabhängig von den exakten Wörtern. Die Frage "wie soll ich bei Unsicherheit handeln?" findet eine gespeicherte Memory "Nutzer mag keine Rückfragen, lieber selbst nachschauen" — obwohl kein gemeinsames Wort existiert.

### LanceDB: Warum diese Datenbank?

[LanceDB](https://lancedb.com/) ist eine eingebettete Vektordatenbank — keine separate Server-Instanz nötig, keine Ports, kein Container. Sie läuft direkt im Prozess und persistiert auf dem Dateisystem. Perfekt für lokale Agenten-Deployments.

Vorteile:
- Keine externe Abhängigkeit (kein Postgres, kein Qdrant)
- Läuft auf Linux, macOS, Windows
- Apache Arrow-basiert, sehr effizient
- Node.js und Python Bindings verfügbar

### Das Plugin: `memory-lancedb-namespaced`

OpenClaw verwendet ein Plugin-System. Das Memory-Plugin registriert sich beim Gateway und:
- Stellt dem Agenten drei Tools bereit (`memory_store`, `memory_recall`, `memory_forget`)
- Hängt sich in den `before_agent_start`-Hook ein für Auto-Recall
- Verwaltet pro Agent eine separate Datenbank (Namespacing)

#### Installation

Das Plugin liegt im `extensions/`-Verzeichnis eurer OpenClaw-Installation. Nach dem Ablegen dort muss es in `openclaw.json` aktiviert werden:

```json
{
  "plugins": {
    "memory-lancedb-namespaced": {
      "embedding": {
        "apiKey": "${OPENAI_API_KEY}",
        "model": "text-embedding-3-large",
        "dimensions": 3072
      },
      "baseDbPath": "~/.openclaw/memory/lancedb-namespaced",
      "autoRecall": true,
      "autoCapture": true,
      "captureMaxChars": 5000
    }
  }
}
```

Der `apiKey` kann als Umgebungsvariable übergeben werden (empfohlen) oder direkt eingetragen werden. Das Plugin unterstützt `${ENV_VAR}`-Syntax.

#### Embedding-Modelle

Embeddings werden über die OpenAI Embeddings API erzeugt. Wer keine OpenAI-API nutzt, kann über `baseUrl` auf eine kompatible API zeigen (z.B. lokale Embeddings via Ollama, Azure OpenAI, etc.):

```json
"embedding": {
  "apiKey": "sk-...",
  "model": "text-embedding-3-large",
  "dimensions": 3072,
  "baseUrl": "https://your-openai-compatible-endpoint/v1"
}
```

| Modell | Dimensionen | Empfehlung |
|--------|-------------|------------|
| `text-embedding-3-large` | 3072 | Beste Qualität, Standard-Empfehlung |
| `text-embedding-3-small` | 1536 | Schneller, günstiger, ausreichend für viele Fälle |
| `text-embedding-ada-002` | 1536 | Legacy, nicht empfohlen für neue Deployments |

**Wichtig:** Die `dimensions` in der Config müssen zum Modell passen. Nachträgliche Änderung erfordert Neuaufbau der DB (Embeddings sind dimensionsfest).

#### Per-Agent-Isolation (Namespacing)

Ein oft unterschätztes Detail: Bei mehreren Agenten auf einem System sollte jeder Agent **seine eigene Datenbank** haben. Andernfalls vermischen sich Erinnerungen — Agent A "erinnert" sich an Gespräche, die nur Agent B hatte.

Das Plugin löst das automatisch über `agentId`-Routing:

```
{baseDbPath}/
├── bernd/          ← Memories von Agent "bernd"
├── bernhardine/    ← Memories von Agent "bernhardine"
├── heisenberg/     ← Memories von Agent "heisenberg"
└── default/        ← Fallback wenn kein agentId gesetzt
```

Die `agentId` kommt aus dem OpenClaw-Kontext (entspricht dem Agenten-Schlüssel in `openclaw.json`). Keine manuelle Konfiguration nötig.

---

## Das Datenbankschema

Jede Memory wird mit folgendem Schema gespeichert:

```
{
  id:         string    — UUID, automatisch generiert
  text:       string    — Vollständiger Originaltext
  summary:    string    — L0-Summary (≤150 Wörter, automatisch)
  origin:     enum      — dm | group | cron | internal  (Herkunftskontext)
  vector:     float[]   — Embedding-Vektor (z.B. 3072 Dimensionen)
  importance: float     — Gewichtung 0.0–1.0 (vom Agenten angegeben)
  category:   enum      — preference | fact | decision | entity | other
  createdAt:  number    — Unix-Timestamp (Millisekunden)
  mergedFrom: string    — JSON-Array mit IDs der zusammengeführten Memories
  expiresAt:  number    — Unix-Timestamp (ms) bis zum Ablauf, 0 = permanent
  storedBy:   string    — agentId des speichernden Agenten
}
```

### Origin-Feld

Gibt den Herkunftskontext der Memory an — **sichtbar beim Recall**:

| Wert | Bedeutung |
|------|-----------|
| `"dm"` | Direktchat mit dem User (Default) |
| `"group"` | Telegram-Gruppe / Gruppenkanal |
| `"cron"` | Hintergrundtask / Cron-Job |
| `"internal"` | Agent-intern generiert (ohne User-Input) |

Beim Recall erscheint das Origin als Tag: `[fact|group]` statt nur `[fact]` — so ist der Kontext sofort sichtbar. DM-Memories zeigen keinen Origin-Tag (da Default).

### Kategorien

Der Agent wählt beim Speichern eine Kategorie. Das Plugin kann auch automatisch kategorisieren (Keyword-basiert) wenn keine angegeben wird:

| Kategorie | Wann verwenden |
|-----------|---------------|
| `preference` | Nutzer-Präferenzen ("mag kurze Antworten", "bevorzugt Deutsch") |
| `fact` | Fakten über den Nutzer, seine Projekte, die Umgebung |
| `decision` | Getroffene Entscheidungen ("wir nutzen PostgreSQL für Logs") |
| `entity` | Personen, Unternehmen, Produkte, Orte |
| `other` | Alles andere |

---

## L0-Summaries: Token-Effizienz ohne LLM

### Das Problem mit Volltext-Recall

Wenn Auto-Recall vor jedem Turn 5 Memories injiziert und jede Memory 500 Wörter lang ist — verliert man 2500 Wörter Kontext an Gedächtnisinhalte. Bei einem Budget von 8000 Token ist das bereits ein Drittel des Kontexts.

### Die Lösung: Reine Textkompression

Das Plugin generiert beim Speichern automatisch eine Kurzzusammenfassung (≤150 Wörter, konfigurierbar). **Kein LLM-Aufruf** — nur Textkürzen mit Satzbegrenzungs-Awareness:

```javascript
function generateSummary(text, maxWords = 150) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;

  const truncated = words.slice(0, maxWords).join(' ');

  // Versuche an einer Satzgrenze zu kürzen (sauberer als mitten im Satz)
  const lastPunct = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  if (lastPunct > truncated.length * 0.6) {
    return truncated.slice(0, lastPunct + 1);
  }
  return truncated + '…';
}
```

Die Summary wird **einmal beim Speichern** generiert und persistiert. Beim Recall wird sie direkt aus der DB gelesen — kein erneutes Verarbeiten.

**Token-Ersparnis:** ~80% gegenüber Volltext-Injection. Für detaillierte Fälle kann `memory_recall` mit `full_text: true` aufgerufen werden.

### Backward-Kompatibilität

Bestehende Memories ohne `summary`- oder `origin`-Feld bekommen diese beim ersten Zugriff automatisch hinzugefügt. Die DB-Migration läuft beim Öffnen einer bestehenden Tabelle:

```javascript
// Beim Öffnen einer bestehenden DB:
const schema = await this.table.schema(); // Methode, kein Property!
const hasSum = schema.fields.some(f => f.name === 'summary');
if (!hasSum) {
  await this.table.addColumns([{ name: 'summary', valueSql: "''" }]);
}
const hasOrigin = schema.fields.some(f => f.name === 'origin');
if (!hasOrigin) {
  await this.table.addColumns([{ name: 'origin', valueSql: "'dm'" }]);
}
// Ab 2026-03-31: drei weitere Felder
const hasMergedFrom = schema.fields.some(f => f.name === 'mergedFrom');
if (!hasMergedFrom) {
  await this.table.addColumns([{ name: 'mergedFrom', valueSql: "'[]'" }]);
}
const hasExpiresAt = schema.fields.some(f => f.name === 'expiresAt');
if (!hasExpiresAt) {
  await this.table.addColumns([{ name: 'expiresAt', valueSql: '0' }]);
}
const hasStoredBy = schema.fields.some(f => f.name === 'storedBy');
if (!hasStoredBy) {
  await this.table.addColumns([{ name: 'storedBy', valueSql: "''" }]);
}
```

Keine manuelle Migration, kein Datenverlust.

> **Hinweis (2026-03-27):** Bis zu diesem Datum enthielt der Code einen Bug — `this.table.schema` wurde als Property statt als Methode aufgerufen, weshalb die Migration still scheiterte und `origin` nie zur Tabelle hinzugefügt wurde. Bestehende Installationen (vor 2026-03-27) benötigen eine einmalige manuelle Migration oder ein Gateway-Restart nach dem Fix.

> **Hinweis (2026-03-31):** Mit diesem Update wurden `mergedFrom`, `expiresAt` und `storedBy` hinzugefügt. Die Migration läuft automatisch beim nächsten Gateway-Start. Bestehende Memories behalten alle alten Werte; `expiresAt = 0` (permanent), `storedBy = ""` (unbekannt), `mergedFrom = "[]"` (kein Merge).

---

## Auto-Recall: Gedächtnis kommt von selbst

### Wie es funktioniert

Beim `before_agent_start`-Hook (ausgelöst bevor der Agent seinen Turn beginnt) durchsucht das Plugin die Datenbank semantisch nach dem aktuellen Prompt des Nutzers. Die relevantesten Ergebnisse werden als strukturierter XML-Block **vor den eigentlichen Kontext eingefügt**:

```xml
<relevant-memories>
  - [preference] Nutzer bevorzugt kurze, direkte Antworten ohne Einleitung… (ID: abc-123)
  - [decision] PostgreSQL wurde für das Logging-System gewählt, wegen ACID-Garantien… (ID: def-456)
  - [fact] Das Produktionssystem läuft auf Ubuntu 24.04, kein Docker auf bare metal… (ID: ghi-789)
</relevant-memories>
```

Der Agent sieht diesen Block und weiß: das sind relevante Informationen aus vergangenen Gesprächen.

### Score-System

Jeder Recall-Treffer bekommt einen Score zwischen 0 und 1:

```
score = 1 / (1 + distance)
```

Wobei `distance` der Vektorabstand im Embedding-Raum ist. Score 1.0 = identisch, Score 0.0 = völlig unähnlich.

Nur Memories über dem `autoRecallMinScore`-Schwellenwert (Standard: 0.2) werden injiziert. Dadurch werden irrelevante Memories herausgefiltert.

### Konfiguration

```json
{
  "autoRecall": true,          // An/Aus
  "autoRecallMinScore": 0.2    // Nur Memories mit Score ≥ 0.2 einblenden
}
```

---

## Die drei Agent-Tools

### `memory_store` — Etwas merken

```
Parameter:
  text       (required) — Was soll gemerkt werden?
  category   (optional) — preference | fact | decision | entity | other
  importance (optional) — 0.0–1.0, Default 0.5
  origin     (optional) — dm | group | cron | internal  (Default: "dm")
  ttl        (optional) — "session" (läuft morgen ab) | "short" (14 Tage) | nicht angegeben = permanent
```

**WICHTIG:** `origin` immer korrekt setzen! Besonders: bei Telegram-Gruppen IMMER `"group"` angeben.

**TTL-Hinweis:** `ttl` immer opt-in — nur angeben, wenn die Information wirklich vergänglich ist (z.B. kurzfristige Pläne, vorübergehende Konfigurationen). Nie implizit per Kategorie setzen.

Beispiel-Aufruf aus DM:

```json
{
  "text": "Der Nutzer bevorzugt es, wenn Codebeispiele direkt ausführbar sind, nicht als Pseudocode",
  "category": "preference",
  "importance": 0.8
}
```

Beispiel-Aufruf aus Gruppenkonversation:

```json
{
  "text": "In der Gruppe wurde beschlossen, das Deployment auf Freitag zu verschieben",
  "category": "decision",
  "importance": 0.7,
  "origin": "group"
}
```

Das Plugin durchläuft beim Speichern drei Stufen:

1. **Duplikat-Check** (Score ≥ `duplicateThreshold`, Standard: 0.95) — fast-identische Texte werden abgewiesen. Curation-Log: `memory.rejected_duplicate`.
2. **Merge-Check** (Score in `[mergingThreshold, 0.95)`, Standard: 0.70–0.94) — logisch verwandte Memories werden via LLM zusammengeführt. Der vorhandene Eintrag wird gelöscht, ein neuer `mergedFrom`-Eintrag gespeichert. Timeout: 30s. Qualitätsprüfung: `mergedText` muss länger als das kürzere Fragment sein. Curation-Log: `memory.merged`.
3. **Normaler Store** — falls keine obere Stufe greift. Curation-Log: `memory.stored`.

Alle Operationen werden in `{workspaceDir}/.adaptive-learning/curation-log.jsonl` protokolliert.

Bestätigung: `"Memory stored [preference|dm]: … (ID: …)"` bzw. `"Memory merged [decision|group]: … (ID: …)"`

### `memory_recall` — Etwas nachschlagen

```
Parameter:
  query     (required) — Worüber soll gesucht werden?
  limit     (optional) — Max. Ergebnisse, Default 5
  full_text (optional) — true = Volltext statt Summary, Default false
```

Beispiel:

```json
{ "query": "Datenbankentscheidungen", "limit": 3 }
```

Antwort:
```
[decision] PostgreSQL für Logging gewählt wegen ACID-Garantien… (score: 0.87, ID: abc)
[decision] Redis als Session-Cache, weil Latenz unter 5ms… (score: 0.71, ID: def)
[fact] Bestehende MySQL-Instanz für Legacy-System, Migration geplant Q3 2026… (score: 0.64, ID: ghi)
```

### `memory_forget` — Etwas vergessen

```
Parameter:
  memoryId (optional) — Direkte Löschung per ID
  query    (optional) — Semantische Suche + Löschung
```

Wenn per Query gesucht wird und mehrere Treffer existieren, listet das Plugin alle auf und wartet auf eine konkrete ID. Verhindert versehentliches Löschen.

---

## Re-Ranker: Zwei-Stufen-Retrieval für bessere Relevanz

### Das Problem mit reiner Vektorsuche

Vektorsuche findet semantisch *ähnliche* Texte — aber ähnlich ist nicht dasselbe wie *relevant*. Ein Bi-Encoder (das Embedding-Modell) kodiert Query und Dokument **unabhängig voneinander**. Das ist schnell, aber ungenau: er weiß nicht, wie gut ein spezifischer Text die spezifische Frage wirklich beantwortet.

Ein **Cross-Encoder** (Re-Ranker) betrachtet Query und Dokument **gemeinsam** und gibt eine präzisere Relevanz-Einschätzung. Dafür ist er zu langsam für die initiale Suche — aber perfekt als zweite Stufe.

### Die Pipeline

```
Query
  │
  ▼
Embedding (Bi-Encoder)
  │
  ▼
Vektorsuche → Top-20 Kandidaten          ← schnell, grob
  │
  ▼
Cohere Rerank API (Cross-Encoder)        ← langsamer, präzise
  │
  ▼
Top-5 nach Relevanz-Score injiziert / zurückgegeben
```

### Integration: Cohere Rerank API

Das Plugin nutzt die [Cohere Rerank v2 API](https://docs.cohere.com/reference/rerank). Konfiguration:

```json
"reranker": {
  "enabled":    true,
  "apiKey":     "${COHERE_API_KEY}",
  "model":      "rerank-v3.5",
  "candidates": 20
}
```

`candidates` bestimmt wie viele Vektor-Treffer an den Re-Ranker übergeben werden. Mehr Kandidaten = besseres Ergebnis, aber mehr Latenz. 20 ist ein guter Ausgangswert.

### Alternativen zu Cohere

Wer keinen Cohere-Account möchte, kann ähnliche Ergebnisse erzielen mit:
- **Jina Reranker v2** — OpenAI-kompatible API, günstiger
- **`cross-encoder/ms-marco-MiniLM-L-6-v2`** — lokales Modell via Python/transformers, kostenlos
- **LLM-basiertes Re-Ranking** — teurer, aber sehr flexibel (Prompt: "Rank these documents by relevance")

Das Plugin ist auf Cohere ausgelegt. Für andere Anbieter müsste die `Reranker`-Klasse angepasst werden (andere API-Struktur).

### Fallback-Verhalten

Ist der Re-Ranker nicht konfiguriert oder schlägt die API fehl (Netzwerk, Rate-Limit, ungültiger Key), fällt das Plugin automatisch auf die Vektor-Reihenfolge zurück. Kein Absturz, kein leerer Recall — nur ohne Re-Ranking.

---

## Auto-Capture: Vollautomatisches Indexieren

### Was ist das?

Eine optionale Funktion: Statt dass der Agent manuell `memory_store` aufruft, indexiert das Plugin am Ende jedes Turns automatisch User- und Assistant-Nachrichten.

```json
{
  "autoCapture": true,
  "captureMaxChars": 5000
}
```

**In unserem Setup: aktiv** (`autoCapture: true`, `captureMaxChars: 5000`). Die Agenten speichern zusätzlich proaktiv via `memory_store` für qualitativ hochwertigere Fakten.

### Funktionsweise

Nach jedem erfolgreichen Turn (`agent_end`-Hook):
1. Alle Nachrichten des Turns werden durchsucht
2. Texte zwischen 20 und `captureMaxChars` Zeichen werden als Kandidaten ausgewählt
3. Origin wird automatisch erkannt: Gruppenkontext-Signale (`"is_group_chat": true`, Discord Guild etc.) → `"group"`, sonst `"dm"`
4. Duplikat-Check gegen bestehende Memories (Score ≥ `duplicateThreshold`)
5. Neue Texte werden mit `importance: 0.7` und auto-kategorisiert gespeichert
6. Maximal 5 Memories pro Turn (die neuesten Nachrichten)

**User-URLs werden priorisiert erfasst (seit 2026-04-03)**

Auto-Capture erkennt User-Nachrichten mit URLs und führt sie als separate Prioritätsliste. Beim Capture werden zuerst bis zu 3 User-URL-Nachrichten gesichert, dann die letzten 5 allgemeinen Texte — max. 8 gesamt. Damit verdrängen lange Assistant-Antworten keine frühen Link-Nachrichten mehr aus dem Capture-Fenster.

Zusätzlich sind alle Agenten in AGENTS.md angewiesen, User-URLs sofort proaktiv via `memory_store` zu sichern — als doppeltes Netz für den Fall dass der Auto-Capture-Slot voll ist.

### Wann sinnvoll?

Auto-Capture ist hilfreich, wenn:
- Conversations sehr lang werden und der Agent nicht alles manuell speichert
- Man eine vollständige "Gesprächshistorie" in LanceDB möchte
- Der Agent keine explizite Instruktion zum manuellen Speichern hat

> **Hinweis:** Auto-Capture und Re-Ranker ergänzen sich gut: Auto-Capture füllt die DB automatisch, der Re-Ranker sorgt dafür dass trotz vieler ähnlicher Einträge die wirklich relevanten oben landen.

**Achtung:** Auto-Capture erzeugt viele Memories. Die Datenbank wächst schnell. Ohne regelmäßiges Aufräumen kann die Qualität des Recalls sinken (zu viele irrelevante Treffer). Duplikat-Schutz (`duplicateThreshold: 0.95`) hilft, aber kein Ersatz für gelegentliches `memory_forget`.

---

## TTL — Zeitlich begrenzte Memories

### Wann TTL verwenden?

Standardmäßig sind alle Memories permanent. Das ist gewollt — aber manchmal speichert der Agent Infos, die von Natur aus vergänglich sind: laufende Aufgaben, vorübergehende Pläne, kurzfristige Konfigurationsänderungen.

Für diese Fälle gibt es den optionalen `ttl`-Parameter von `memory_store`:

| Wert | Ablauf | Wann verwenden |
|------|--------|---------------|
| `"session"` | Nächster Tag (+24h) | Temporäre Abmachungen, laufende Tasks, "bis morgen"-Infos |
| `"short"` | 14 Tage | Kurzfristige Projektkontexte, vorläufige Entscheidungen |
| *(nicht angegeben)* | Permanent | Default — für alle stabilen Fakten, Präferenzen, Entscheidungen |

**Wichtig:** TTL ist immer opt-in — nie implizit setzen, nie per Kategorie automatisch. Eine `decision`-Memory mit TTL ist sinnlos (Entscheidungen sollen erinnert werden). Nur wirklich vergängliche Infos bekommen TTL.

Intern speichert das Plugin `expiresAt: Date.now() + TTL_MS` (Unix-Timestamp in ms). Wert `0` = permanent.

### Automatisches Aufräumen (GC)

Abgelaufene Memories werden nicht sofort gelöscht — das Plugin wartet bis zum nächsten `before_agent_start`-Hook und räumt dann auf. Der Mechanismus läuft `purgeExpired()` non-blocking:

```javascript
// Intern: Löscht alle Memories wo expiresAt > 0 AND expiresAt < jetzt
await this.table.delete(`expiresAt > 0 AND expiresAt < ${Date.now()}`);
```

Das GC ist konfigurierbar:

```json
{
  "gc": { "enabled": true }
}
```

Standard: `true`. Auf `false` setzen, wenn man abgelaufene Memories manuell verwalten möchte (z.B. für Debugging).

**Ergänzung: System-Cron-GC**

Damit abgelaufene Memories auch dann bereinigt werden wenn kein Agent aktiv ist (Nächte, Wochenenden), läuft `scripts/memory-gc.mjs` täglich um **03:00 Uhr** via System-Cron unabhängig vom Gateway:

```
# /etc/crontab
0 3 * * * root /usr/bin/node /root/.openclaw/scripts/memory-gc.mjs >> /tmp/openclaw/memory-gc.log 2>&1
```

Das Script verbindet sich direkt mit den LanceDB-Instanzen aller drei Agenten und führt dieselbe `DELETE`-Query aus. Log: `/tmp/openclaw/memory-gc.log`.

---

## Conflict-Log — Decision-Memories zwischen Agenten

### Was ist das?

Wenn mehrere Agenten unabhängig `decision`-Memories speichern, können Widersprüche entstehen: Bernd speichert "wir nutzen PostgreSQL", Heisenberg speichert "wir nutzen MongoDB". Ohne Traceability ist dieser Widerspruch unsichtbar.

Das Plugin erkennt semantisch ähnliche `decision`-Memories von unterschiedlichen Agenten (Score 0.70–0.94) und loggt sie in:

```
{workspaceDir}/.adaptive-learning/conflict-log.jsonl
```

Schema eines Eintrags:
```json
{
  "schemaVersion": 1,
  "timestamp": "2026-03-31T12:00:00.000Z",
  "newMemoryId": "uuid-neu",
  "newAgentId": "main",
  "newText": "Wir nutzen PostgreSQL für alle persistenten Daten.",
  "existingMemoryId": "uuid-alt",
  "existingAgentId": "bernhardine",
  "existingText": "Wir nutzen MongoDB als primäre Datenbank.",
  "score": 0.83,
  "category": "decision",
  "mergeDecision": "stored_separately"
}
```

`mergeDecision` ist:
- `"merged"` — die beiden Memories wurden zusammengeführt
- `"stored_separately"` — trotz Ähnlichkeit separat gespeichert
- `"no_merge_llm_call"` — Merging ist disabled, nur geloggt

### storedBy — Traceability

Jede Memory trägt `storedBy: agentId` — die ID des Agenten, der sie gespeichert hat. Das ermöglicht es nachzuvollziehen, welcher Agent welche Entscheidung "glaubt".

**Namespace-Hinweis:** Da jeder Agent eine eigene LanceDB hat, durchsucht `findMergeCandidate` nur Memories desselben Agenten. Cross-Agent-Konflikte können in der aktuellen Konfiguration nicht automatisch detektiert werden. `storedBy` ist primär Traceability innerhalb einer DB — und Vorbereitung für ein zukünftiges Shared-Namespace-Szenario.

### Proaktiver Nudge

Das Log ist kein normales Logfile — es ist ein **Audit-Trail**. Einträge sind nicht "abgelaufen", sie warten auf Auflösung.

Wenn das Log > 1 MB wird oder der älteste Eintrag > 30 Tage alt ist, injiziert der `before_agent_start`-Hook:

```xml
<conflict-review-reminder>
N unreviewed decision-conflicts in conflict-log.jsonl (oldest: YYYY-MM-DD, size: X KB).
Bring this up with the user: "Ich habe X unaufgelöste Konflikte im Log — willst du die durchgehen?"
Do NOT rotate or delete the log without explicit user confirmation.
</conflict-review-reminder>
```

**Rotation:** Nur auf explizite Nutzerbestätigung — dann `rename conflict-log.jsonl → conflict-log-YYYY-MM-DD.jsonl`.

---

## Threshold-Tuning: Die richtigen Schwellenwerte finden

Alle Score-Schwellenwerte sind konfigurierbar. Hier die Bedeutung und Orientierungswerte:

```json
{
  "recallMinScore":     0.15,
  "autoRecallMinScore": 0.20,
  "duplicateThreshold": 0.95,
  "forgetThreshold":    0.30,
  "summaryMaxWords":    150
}
```

| Parameter | Default | Zu niedrig | Zu hoch |
|-----------|---------|------------|---------|
| `recallMinScore` | 0.15 | Zu viel Rauschen bei `memory_recall` | Relevante Memories werden nicht gefunden |
| `autoRecallMinScore` | 0.20 | Irrelevante Memories landen im Kontext | Kein Auto-Recall bei vagen Prompts |
| `duplicateThreshold` | 0.95 | Zu viele Duplikate gespeichert | Ähnliche aber verschiedene Memories werden geblockt |
| `forgetThreshold` | 0.30 | `memory_forget` löscht Falsches | Kann spezifische Memories nicht per Query finden |
| `summaryMaxWords` | 150 | Summaries zu kurz, Kontext verloren | Token-Vorteil schwindet |

### Debugging-Tipp

Wenn Auto-Recall keine Memories liefert obwohl sie vorhanden sein sollten: `autoRecallMinScore` senken (z.B. auf 0.1) und beobachten. Wenn bei manuellen Recalls mit `memory_recall` Treffer erscheinen aber im Auto-Recall nicht — liegt es am Schwellenwert.

---

## Agent-Instruktionen: Das Herzstück

Das Plugin allein reicht nicht. Der Agent muss wissen, **wann** er was speichern soll. Die Qualität des Gedächtnisses hängt direkt von diesen Instruktionen ab.

### Minimale Instruktion (für SOUL.md oder equivalente Datei)

```markdown
## Langzeit-Gedächtnis

Du hast Zugriff auf ein persistentes Gedächtnis (LanceDB).

**Automatisch speichern, ohne zu fragen:**
- Präferenzen des Nutzers (Kommunikationsstil, technische Präferenzen, etc.)
- Wichtige Entscheidungen (Technologiewahl, Architekturentscheidungen)
- Fakten über den Nutzer, seine Projekte, seine Umgebung
- Entitäten (Namen, Unternehmen, Projekte) die mehrfach auftauchen

**Nicht speichern:**
- Flüchtige Task-Details ("generiere mir gerade eine Tabelle")
- Zwischenergebnisse die sofort veralten
- Information die bereits in anderen Dateien steht

**Beim Recall:** Nutze memory_recall proaktiv wenn du merkst, dass du Kontext aus
früheren Gesprächen brauchst — auch wenn du dir nicht sicher bist ob etwas gespeichert ist.
```

### Erweiterte Instruktion (empfohlen)

```markdown
## Langzeit-Gedächtnis — Kategorien und Importance

| Was | Kategorie | Importance |
|-----|-----------|------------|
| "Mag keine langen Einleitungen" | preference | 0.9 |
| "Nutzt Arch Linux, kein systemd" | fact | 0.7 |
| "Wir nehmen PostgreSQL für das neue Projekt" | decision | 0.85 |
| "Kontakt: Lars Mueller, Entwickler bei Acme" | entity | 0.6 |

**Regel:** Lieber zu viel als zu wenig speichern. Qualität schlägt Quantität —
aber ein Fakt den du nicht gespeichert hast ist wertlos.
```

### Origin-Tagging (SOUL.md-Ergänzung, empfohlen)

Damit der Kontext beim Recall sichtbar bleibt, muss der Agent wissen wann `origin` gesetzt werden muss:

```markdown
## Memory Origin-Tagging

Beim Speichern mit `memory_store` IMMER den `origin`-Parameter korrekt setzen:

| Kontext | origin-Wert |
|---------|-------------|
| Direktchat | `"dm"` (Default, kann weggelassen werden) |
| Telegram-Gruppe / Gruppenkanal | `"group"` ← **immer explizit setzen!** |
| Cron-Job / Hintergrundtask | `"cron"` |
| Selbst generiert (ohne User-Input) | `"internal"` |
```

### Schicht 1.5 — KNOWLEDGE.md (SOUL.md-Ergänzung, wenn schicht15 aktiv)

Wenn `schicht15.enabled: true`, muss der Agent wissen wann er `knowledge_update` aufrufen soll. Ohne diese Instruktion passiert nichts — das Tool ist nur dann sinnvoll nutzbar wenn der Agent eine klare Regel dafür hat.

```markdown
## KNOWLEDGE.md — Kuratiertes Wissen

Das Tool `knowledge_update` pflegt eine strukturierte Wissensbasis
(`memory/KNOWLEDGE.md`) aus deinen gespeicherten Erinnerungen.

**Rufe `knowledge_update` auf wenn:**
- Du eine Architekturentscheidung triffst (z.B. „wir wechseln von X auf Y")
- Du eine stabile Präferenz formulierst (z.B. „Nutzer möchte immer…")
- Ein Projekt abgeschlossen oder grundlegend verändert wird
- Du etwas mit `importance ≥ 0.85` speicherst

**Nicht aufrufen für:** einzelne Fakten, kurze Notizen, temporäre Infos.
Nur für Dinge, die dauerhaft als strukturiertes Wissen gelten sollen.
```

**Warum explizit?** Das KNOWLEDGE.md wird nie automatisch beschrieben — nur auf bewussten Anstoß des Agenten. Das verhindert unkontrolliertes Wachstum und stellt sicher dass nur kurationsreife Informationen darin landen. Der Overlay-Nudge (ab `pendingCount ≥ 3`) erinnert den Agenten, aber die Entscheidung liegt immer beim Agenten.

---

## Mehrere Agenten auf einem System

Wenn ihr mehrere Agenten betreibt (z.B. einen für jeden Nutzer im Haushalt), beachtet:

1. **Eigene `agentId` für jeden Agenten** — damit die Namespacing-Funktion greift
2. **Eigene Workspace-Ordner** — damit Markdown-Dateien nicht vermischt werden
3. **Optionale eigene Embedding-API-Keys** — für Rate-Limit-Isolation bei hohem Volumen

Beispiel-Konfiguration in `openclaw.json`:

```json
{
  "agents": {
    "alice": {
      "workspace": "/home/alice/.openclaw/workspace",
      "plugins": ["memory-lancedb-namespaced"]
    },
    "bob": {
      "workspace": "/home/bob/.openclaw/workspace",
      "plugins": ["memory-lancedb-namespaced"]
    }
  },
  "plugins": {
    "memory-lancedb-namespaced": {
      "embedding": { "apiKey": "${OPENAI_API_KEY}", "model": "text-embedding-3-large", "dimensions": 3072 },
      "baseDbPath": "~/.openclaw/memory/lancedb-namespaced"
    }
  }
}
```

Die DBs landen automatisch unter:
```
~/.openclaw/memory/lancedb-namespaced/
├── alice/
└── bob/
```

---

## Das Gesamtbild: Warum drei Schichten?

| Aspekt | Schicht 1: Flat-File | Schicht 2: Workspace-Indexer | Schicht 3: LanceDB |
|--------|---------------------|------------------------------|-------------------|
| Inhalt | Session-Logs, Guides, Notizen | Alle Workspace-.md-Dateien | Extrahierte Fakten/Entscheidungen |
| Suche | Manuell / grep | Hybrid: Vektor + BM25 | Semantisch + Reranker |
| Auto-Recall | Nein (ONBOARDING liest heute+gestern) | Nein (manuell abrufbar) | Ja — vor jedem Turn |
| Schreibt Agent | Ja (Markdown-Dateien) | Nein (liest nur) | Ja (`memory_store`) |
| Für Menschen | Direkt lesbar | Via CLI oder Tool | Via `memory_recall` |
| Skalierung | ~100 Dateien OK | Tausende Chunks | Millionen Einträge |
| Overhead | Kein API-Call | Auto-indexiert bei Neustart | Embedding-Call pro Store |
| Debugging | Trivial (einfach öffnen) | Chunk-Counts per Status-Cmd | Braucht Score-Logs |

**Fazit:** Markdown ist das strukturierte Langzeit-Protokoll — für Menschen direkt lesbar, für den Tages-Kontext beim Sessionstart. Der Workspace-Indexer macht alle diese Dateien semantisch durchsuchbar ohne manuelles Crawlen. LanceDB ist der semantische Assoziationsspeicher für agentisches Recall über lange Zeiträume, mit automatischer Injection. Erst alle drei zusammen ergeben ein Gedächtnis das sich wie ein menschliches verhält: strukturiertes Protokoll, durchsuchbares Wissen, und freie Assoziation.

---

## Häufige Fragen

**Was ist der Unterschied zwischen Workspace-Indexer (Schicht 2) und LanceDB (Schicht 3)?**

Schicht 2 indexiert Dateien — alles was im `workspace/`-Verzeichnis liegt: SOUL.md, Onboarding, Session-Logs, Guides. Der Agent fragt es manuell ab wenn er Kontext sucht. Schicht 3 speichert extrahierte Fakten aus Gesprächen und injiziert relevante automatisch vor jedem Turn. Schicht 1 schreibt → Schicht 2 macht durchsuchbar → Schicht 3 erinnert sich von selbst.

**Kann ich statt OpenAI auch ein lokales Embedding-Modell verwenden?**

Ja — solange die API OpenAI-kompatibel ist. Ollama bietet z.B. `nomic-embed-text` über `http://localhost:11434/v1`. Einfach `baseUrl` setzen und `model` + `dimensions` anpassen. Wichtig: Niemals das Modell einer bestehenden DB wechseln — Embeddings sind nicht kompatibel zwischen Modellen.

**Wie groß werden die Datenbanken?**

Faustformel: ~1 KB pro Memory bei `text-embedding-3-small` (1536 dim), ~2 KB bei `text-embedding-3-large` (3072 dim). Eine DB mit 10.000 Memories belegt also ~10–20 MB. LanceDB ist sehr speichereffizient.

**Was passiert wenn der Agent etwas Falsches gespeichert hat?**

`memory_forget` mit der Memory-ID oder einem beschreibenden Query. Der Agent kann das auf Anweisung des Nutzers erledigen. Alternativ: LanceDB-Tabelle direkt mit LanceDB-Explorer oder Python/Node-Client bearbeiten.

**Funktioniert Auto-Recall auch beim ersten Mal wenn noch nichts gespeichert ist?**

Ja — wenn die DB leer ist, gibt der Hook einfach nichts zurück. Kein Fehler. Das System degradiert graceful.

**Kann man die gespeicherten Memories einsehen?**

Über `memory_recall` mit einem breiten Query, oder direkt: LanceDB-Daten sind Apache Arrow-Dateien und können mit dem LanceDB Python-Client gelesen werden:

```python
import lancedb
db = lancedb.connect("/path/to/lancedb-namespaced/agentid")
table = db.open_table("memories")
table.to_pandas()
```

---

## Zusammenfassung: Checkliste für die eigene Implementierung

**Schicht 1: Flat-File Memory**
- [ ] `workspace/memory/`-Verzeichnis anlegen
- [ ] In `SOUL.md` / Agenten-Instruktion: Memory-Auto-Capture-Regel hinzufügen
- [ ] In `ONBOARDING.md` / Sessionstart-Instruktion: Tageslog-Lese-Routine hinzufügen (heute + gestern)

**Schicht 2: Workspace-Indexer**
- [ ] `memorySearch`-Block in `openclaw.json` konfigurieren (Embedding-Provider, Modell, Hybrid-Suche)
- [ ] Ersten Index anstoßen: `openclaw memory index --force`
- [ ] Status prüfen: `openclaw memory status --deep` (zeigt Dateien, Chunks, Cache-Einträge pro Agent)
- [ ] Optional: `extraPaths` konfigurieren wenn Dateien außerhalb des Workspace indexiert werden sollen

**Schicht 3: LanceDB (Konversations-Fakten)**
- [ ] Plugin `memory-lancedb-namespaced` im `extensions/`-Ordner der OpenClaw-Installation ablegen
- [ ] In `openclaw.json` aktivieren mit Embedding-Konfiguration (API-Key, Modell, Dimensionen)
- [ ] `baseDbPath` festlegen (idealerweise außerhalb des Workspace, in einem stabilen Pfad)
- [ ] `autoRecall: true` setzen
- [ ] `autoCapture` je nach Präferenz — für Anfänger `false`, dann über SOUL.md manuell instruieren
- [ ] Re-Ranker konfigurieren: Cohere API Key, `reranker`-Block in Plugin-Config
- [ ] LLM-Merging aktivieren: `merging.enabled: true`, Modell + API-Key, `disableThinking: true` empfohlen
- [ ] Schicht 1.5 aktivieren: `schicht15.enabled: true`, Modell + API-Key, `disableThinking: true` empfohlen
- [ ] SOUL.md aller Agenten: `knowledge_update`-Trigger-Regeln hinzufügen

**Verifizierung**
- [ ] Schicht 1 testen: Agent auffordern etwas zu notieren, in `memory/YYYY-MM-DD.md` prüfen
- [ ] Schicht 2 testen: `openclaw memory search "<query>"` im CLI aufrufen
- [ ] Schicht 3 testen: Agent auffordern etwas zu speichern, neue Session starten, nachfragen ob er es noch weiß
- [ ] Re-Ranker testen: `memory_recall` aufrufen und prüfen ob Logs `(reranked)` zeigen
- [ ] Merging testen: Zwei logisch verwandte Fakten speichern, Curation-Log prüfen: `cat .adaptive-learning/curation-log.jsonl | python3 -m json.tool`
- [ ] Schicht 1.5 testen: `knowledge_update` aufrufen, `memory/KNOWLEDGE.md` prüfen

---

*Dokumentation: `how-to-memory-perfect.md` — aktualisiert: 2026-04-03*
*Interne Implementierungs-Details (deployment-spezifisch): `how-to-memory.md`*
*Plugin-README: `extensions/memory-lancedb-namespaced/README.md`*
*Workspace-Indexer Status: `openclaw memory status --deep`*

---

## Upgrade-Anleitung: Bestehende Installs auf 2026-03-24-Stand bringen

Für alle, die `how-to-memory-perfect` bereits umgesetzt haben. Zwei Änderungen, beide optional aber empfohlen:

### 1. captureMaxChars + summaryMaxWords erhöhen

In `openclaw.json` unter `plugins.entries.memory-lancedb-namespaced.config`:

```json
{
  "captureMaxChars": 5000,
  "summaryMaxWords": 150
}
```

Außerdem in `extensions/memory-lancedb-namespaced/index.js` den Plugin-Default anpassen (greift, wenn `openclaw.json`-Wert fehlt):

```javascript
// Zeile ~289 — war: ?? 75
const summaryMaxWords = cfg.summaryMaxWords ?? 150;
```

Danach: `systemctl --user restart openclaw-gateway.service`

**Wirkung:** Nachrichten bis 5000 Zeichen werden jetzt erfasst (statt bei 2000 ignoriert). Summaries haben bis 150 Wörter Kontext (statt 75).

---

### 2. Plugin-ID-Konflikt mit 2026.3.23-2 beheben

Ab 2026.3.23-2 liefert OpenClaw `@openclaw/memory-lancedb` als eingebundenes Stock-Plugin (ID: `memory-lancedb`). Falls ihr `memory-lancedb-stock` installiert habt, kollidiert dessen `openclaw.plugin.json` (war ebenfalls `"id": "memory-lancedb"`).

**Symptom:** Gateway-Log beim Start zeigt:
```
plugins.entries.memory-lancedb: duplicate plugin id detected; global plugin will be overridden by bundled plugin
```

**Fix:**

```bash
# Einmalig ausführen:
sed -i 's/"id": "memory-lancedb"/"id": "memory-lancedb-stock"/' \
  ~/.openclaw/extensions/memory-lancedb-stock/openclaw.plugin.json

systemctl --user restart openclaw-gateway.service
```

**Wichtig:** Nur `openclaw.plugin.json` ändern — `node_modules` und `index.ts` bleiben unberührt. `memory-lancedb-namespaced` nutzt die node_modules aus `memory-lancedb-stock/` via relativen Pfad (seit 2026-04-03 nicht mehr hardcoded).

---

**Reihenfolge:** Beide Änderungen können gleichzeitig gemacht werden, ein einziger Gateway-Neustart reicht.

---

## Upgrade-Anleitung: TTL + Conflict-Log (2026-03-31)

### Was ist neu?

Drei neue Features im `memory-lancedb-namespaced`-Plugin:

1. **TTL** — `memory_store` akzeptiert `ttl: "session"` (24h) oder `ttl: "short"` (14 Tage). Ohne Angabe: permanent. Abgelaufene Memories werden beim nächsten `before_agent_start` automatisch gelöscht — sowie täglich um 03:00 via `memory-gc.mjs` (System-Cron).
2. **storedBy** — Jede Memory speichert die `agentId` des speichernden Agenten für Traceability.
3. **Conflict-Log** — `decision`-Memories mit semantischer Ähnlichkeit (Score 0.70–0.94) zu Memories eines anderen Agenten werden in `conflict-log.jsonl` geloggt. Einträge tragen `schemaVersion: 1`. Proaktiver Nudge bei Log > 1 MB oder Alter > 30 Tage.
4. **System-Cron-GC** — `scripts/memory-gc.mjs` via `/etc/crontab`, 03:00 täglich. Unabhängig vom Gateway, für alle drei Agenten.
5. **Schema-Versioning** — `conflict-log.jsonl`-Einträge tragen `schemaVersion: 1` für zukünftige Migrationen.

### Schema-Migration

Die Migration läuft **automatisch** beim nächsten Gateway-Start. Drei neue Spalten werden zu bestehenden LanceDB-Tabellen hinzugefügt:

| Spalte | SQL-Default | Bedeutung |
|--------|-------------|-----------|
| `mergedFrom` | `'[]'` | JSON-Array der zusammengeführten Vorgänger |
| `expiresAt` | `0` | Unix-Timestamp Ablauf; 0 = permanent |
| `storedBy` | `''` | agentId des speichernden Agenten |

### Verifizierung nach Update

```bash
# Gateway neu starten
systemctl --user restart openclaw-gateway.service

# Logs prüfen — keine "missing schema fields"-Fehler
journalctl --user -u openclaw-gateway --since "1 minute ago" | grep -i "schema\|expiresAt\|storedBy"

# TTL testen: Memory mit session-TTL speichern
# memory_store mit ttl="session" → expiresAt sollte ~jetzt+86400000 sein

# Conflict-Log (falls vorhanden)
cat /root/.openclaw/workspace/.adaptive-learning/conflict-log.jsonl | python3 -m json.tool
```

### SOUL.md aller Agenten

Alle drei SOUL.md-Dateien haben bereits die `## 🔍 Conflict-Log`-Sektion. Keine Änderung nötig.

---

## Wichtig: Plugin-Registrierung ab OpenClaw 2026.3.28

Ab Version 2026.3.28 gilt eine strengere Allowlist-Logik: Wenn `plugins.allow` in `openclaw.json` mindestens einen Eintrag hat, werden **alle anderen Plugins blockiert** — auch solche mit `enabledByDefault: true`. Das `memory-lancedb-namespaced`-Plugin muss daher explizit in der Allowlist stehen:

```json
"plugins": {
  "allow": [
    "memory-lancedb-namespaced",
    "adaptive-learning-loop",
    "before-compact-save",
    "telegram",
    "discord",
    "openai"
  ]
}
```

**Symptom bei fehlendem Eintrag:** Das Plugin lädt nicht, Auto-Recall und Auto-Capture laufen still ins Leere — keine Fehlermeldung im Gateway-Log auf INFO-Level.

**Prüfen:**
```bash
journalctl --user -u openclaw-gateway --since "1 minute ago" | grep -i "memory-lancedb\|not in allowlist"
```

Das gilt auch für das `openai`-Bundle-Plugin: ohne `"openai"` in der Allowlist fehlen die `mediaUnderstandingProviders` → Telegram-Voice-Transkription scheitert still.

---

## Upgrade-Anleitung: 2026-03-28 — LLM-Merge, Curation-Log, Schicht 1.5

### Was ist neu?

- **Dreistufige Store-Pipeline** mit LLM-Merge für Score-Bereich 0.70–0.94
- **Curation-Log** — `{workspaceDir}/.adaptive-learning/curation-log.jsonl`
- **Schicht 1.5** — `knowledge_update`-Tool + Overlay-Nudge + SOUL.md-Regeln
- Neues DB-Feld `mergedFrom` (auto-migriert beim nächsten Start)

### 1. Plugin-Config erweitern (openclaw.json)

```json
"memory-lancedb-namespaced": {
  "merging": {
    "enabled": true,
    "threshold": 0.70,
    "model": "kimi-for-coding",
    "baseUrl": "https://api.kimi.com/coding/v1",
    "apiKey": "sk-kimi-...",
    "disableThinking": true,
    "headers": { "User-Agent": "claude-code/1.0" }
  },
  "schicht15": {
    "enabled": true,
    "model": "kimi-for-coding",
    "baseUrl": "https://api.kimi.com/coding/v1",
    "apiKey": "sk-kimi-...",
    "disableThinking": true,
    "headers": { "User-Agent": "claude-code/1.0" },
    "minImportance": 0.7
  }
}
```

> Kein OpenAI-Key nötig — `kimi-for-coding` mit `disableThinking: true` ist schnell und günstig. Andere OpenAI-kompatible Endpunkte funktionieren genauso.

### 2. Plugin-Schema aktualisieren (openclaw.plugin.json)

`merging`- und `schicht15`-Objekte brauchen `disableThinking` (boolean) und `headers` (object) in den `properties`.

### 3. SOUL.md aller Agenten — knowledge_update-Trigger

In SOUL.md **jedes Agenten** der `schicht15.enabled: true` nutzt folgenden Block ergänzen (am Ende der Datei, nach Memory-Origin-Tagging):

```markdown
## 📚 KNOWLEDGE.md — Kuratiertes Wissen

Das Tool `knowledge_update` pflegt eine strukturierte Wissensbasis
(`memory/KNOWLEDGE.md`) aus deinen gespeicherten Erinnerungen.

**Rufe `knowledge_update` auf wenn:**
- Du eine Architekturentscheidung triffst (z.B. „wir wechseln von X auf Y")
- Du eine stabile Präferenz formulierst (z.B. „Nutzer möchte immer…")
- Ein Projekt abgeschlossen oder grundlegend verändert wird
- Du etwas mit `importance ≥ 0.85` speicherst

**Nicht aufrufen für:** einzelne Fakten, kurze Notizen, temporäre Infos —
nur für Dinge, die dauerhaft als strukturiertes Wissen gelten sollen.

**Regel:** Der LLM schreibt nie ohne intentionalen Moment ins KNOWLEDGE.md.
Entweder du hast bewusst entschieden, es ist wichtig genug — oder es wurde
explizit angestossen.
```

> **Hinweis:** Ohne diese SOUL.md-Ergänzung weiss der Agent nicht, dass `knowledge_update` existiert und wann er es aufrufen soll. Das Tool ist im Plugin registriert, aber der Trigger liegt beim Agenten — nicht im System.

### 4. Gateway neu starten

```bash
systemctl --user restart openclaw-gateway.service
```

Migration des `mergedFrom`-Felds erfolgt automatisch beim ersten Zugriff auf jede Agenten-DB.

### Verifikation

```bash
# Curation-Log lesen (nach erstem memory_store)
cat /root/.openclaw/workspace/.adaptive-learning/curation-log.jsonl | python3 -m json.tool

# Pending-Status prüfen
cat /root/.openclaw/workspace/.adaptive-learning/knowledge-pending.json

# KNOWLEDGE.md nach knowledge_update
cat /root/.openclaw/workspace/memory/KNOWLEDGE.md
```

---

## Upgrade-Anleitung: 2026-03-28 — TTL + storedBy + Conflict-Logging

### Was ist neu

- **TTL** — `expiresAt`-Feld im Schema, drei feste Werte: `"session"` (+1 Tag), `"short"` (+14 Tage), kein TTL = permanent
- **storedBy** — `storedBy`-Feld im Schema, enthält `agentId` des speichernden Agenten
- **Opportunistic GC** — `purgeExpired()` feuert non-blocking beim `before_agent_start`-Hook (wenn `gc.enabled: true`, Default)
- **Conflict-Logging** — bei `decision`-Memories mit semantischer Nähe zu einer fremden Memory (anderer Agent) → Eintrag in `conflict-log.jsonl`
- **Conflict-Nudge** — wenn Log >1 MB oder ältester Eintrag >30 Tage → `<conflict-review-reminder>` im `before_agent_start`-Context

### Schema-Migration

Automatisch beim ersten Start — zwei neue Spalten werden hinzugefügt:

```js
// expiresAt = 0 (permanent) für alle bestehenden Rows
await this.table.addColumns([{ name: 'expiresAt', valueSql: '0' }]);

// storedBy = "" für alle bestehenden Rows
await this.table.addColumns([{ name: 'storedBy', valueSql: "''" }]);
```

### TTL-Beispiele

```json
// Session-Memory (vergänglich)
{
  "text": "Christian ist heute im Urlaub, antwortet erst morgen",
  "category": "fact",
  "ttl": "session"
}

// Kurzfristige Planung
{
  "text": "Das Deployment wird in den nächsten zwei Wochen auf Kubernetes umgestellt",
  "category": "decision",
  "importance": 0.8,
  "ttl": "short"
}

// Permanente Information (kein ttl-Parameter)
{
  "text": "Christian bevorzugt deutsche Sprache für alle Agent-Antworten",
  "category": "preference",
  "importance": 0.9
}
```

### Conflict-Log

Pfad: `{workspaceDir}/.adaptive-learning/conflict-log.jsonl`

Schema einer Zeile:

```json
{
  "timestamp": "2026-03-28T12:00:00.000Z",
  "newMemoryId": "uuid-neu",
  "newAgentId": "main",
  "newText": "Wir nutzen PostgreSQL für alle persistenten Daten.",
  "existingMemoryId": "uuid-alt",
  "existingAgentId": "bernhardine",
  "existingText": "Wir nutzen MongoDB als primäre Datenbank.",
  "score": 0.83,
  "category": "decision",
  "mergeDecision": "stored_separately"
}
```

`mergeDecision`: `"merged"` | `"stored_separately"` | `"no_merge_llm_call"` (Merging disabled)

**Wichtig:** Das Log ist ein Audit-Trail — kein automatisches Löschen. Rotation nur nach expliziter User-Bestätigung.

### Konfiguration

```json
"gc": {
  "enabled": true
}
```

### Verifikation

```bash
# TTL-Test: memory_store mit ttl="session" → expiresAt = jetzt + 86400000
# Dann nächsten Tag: purgeExpired() löscht den Eintrag

# Conflict-Log lesen
cat /root/.openclaw/workspace/.adaptive-learning/conflict-log.jsonl | python3 -m json.tool

# Gateway-Restart nach Plugin-Änderung
systemctl --user restart openclaw-gateway.service
```

Migration der neuen Felder (`expiresAt`, `storedBy`) erfolgt automatisch beim ersten Zugriff auf jede Agenten-DB.

---

## Upgrade-Anleitung: 2026-04-03

### Änderungen

| Bereich | Was | Vorher | Nachher |
|---------|-----|--------|---------|
| Plugin `index.js` | Pfade zu `memory-lancedb-stock` | Hardcoded `/root/.openclaw/...` | Relativ via `import.meta.url` — funktioniert auf jedem Installations-Prefix |
| Plugin `index.js` | `captureMaxChars` Default | `800` | `5000` — längere Nachrichten werden erfasst |
| Plugin `index.js` | Auto-Capture User-URLs | Fielen bei langen Turns raus (`slice(-5)`) | Werden immer priorisiert (eigene Liste, max 3 + 5 allgemeine = max 8) |
| Plugin `index.js` | File-Attachments (Bilder, PDFs) | Komplett ignoriert | Als Stub erfasst: `[User schickte image: foto.jpg]` |
| `install-memory-system.sh` | Ziel-Erkennung | Manueller Pfad erforderlich | Auto-Erkennung lokaler Installationen + Auswahlmenü bei mehreren |
| `install-memory-system.sh` | `--update-plugin-only` | Fehlte | Kopiert nur Plugin-Dateien, kein Config-Overhead |
| `install-memory-system.sh` | LanceDB-Snapshot | Fehlte | Automatisch vor jeder Installation (max 5, älteste gelöscht) |
| `install-memory-system.sh` | `--rollback` | Fehlte | Stellt letzten Snapshot + `openclaw.json.bak` wieder her |
| Daily-Notes Cron-Jobs | Datenquelle | Session-Transcripts (oft leer) | LanceDB-Memories des Tages — immer korrekt |

### Update-Befehl (bestehende Installation)

```bash
# Nur Plugin aktualisieren (empfohlen, keine Config-Änderungen):
./scripts/install-memory-system.sh --update-plugin-only /pfad/zu/.openclaw

# Gateway neu starten:
systemctl --user restart openclaw-gateway.service
```

### Rollback falls nötig

```bash
./scripts/install-memory-system.sh --rollback /pfad/zu/.openclaw
systemctl --user restart openclaw-gateway.service
```

---

## Security-Audit-Fixes: 2026-04-03

### 🔴 Critical

| # | Issue | Fix |
|---|-------|-----|
| 1 | SQL-Injection in `table.delete()` | UUID-Regex-Validierung vor jeder DB-Deletion. IDs die nicht dem UUID-Format entsprechen werden mit Error abgewiesen. Gilt für `memory_forget` (User-Input) und `pendingIds` (Datei-Input). |
| 2 | Hardcoded Pfade in `memory-gc.mjs` | `import.meta.url` + `dirname` — Pfade werden relativ zum Script-Verzeichnis aufgelöst. Agents werden aus `openclaw.json` gelesen statt hardcoded. |
| 3 | Race Condition Lock-File | Atomares `openSync('wx')` — schlägt fehl wenn Lock bereits existiert (kein TOCTOU). Staleness-Check: Locks älter als 5 Minuten werden automatisch als Crash-Artefakt entfernt. Retry mit exponentiellem Backoff (5 Versuche, 100ms→2s) bei `EEXIST`. |
| 4 | JSON-Parse ohne Fehlerbehandlung in `callMergeCheck` | try/catch um `JSON.parse()` + inline Schema-Validierung: `merge` (boolean), `reason` (string), `mergedText` (string wenn merge=true) — ungültiges LLM-JSON führt zu `null` (kein Merge). |
| 5 (neu) | `purgeExpired()` Timestamp ohne Validierung | `Number.isFinite(now)` Guard vor SQL-Interpolation — gleiche Konsistenz wie `memory-gc.mjs`. |

### 🟡 Warnings

| # | Issue | Fix |
|---|-------|-----|
| 7 | `pendingCount` unbounded | Gecappt bei 1000 via `Math.min()`. |
| 9 | Kein Retry bei OpenAI-Fehlern | Exponentieller Backoff, 3 Retries. Rate-Limit (429) → längere Wartezeit (bis 16s). Andere Fehler → kurze Wartezeit (500ms × attempt). |
| 10 | Race Condition bei Auto-Capture | Promise-Queue pro Agent (`captureQueues` Map) — serialisiert parallele `agent_end`-Events. Self-cleaning: Queue-Eintrag wird nach Abschluss entfernt. |

### Bewusst nicht gefixt

| # | Begründung |
|---|-----------|
| 5 Memory Leak AgentDbPool | Bounded durch Agent-Anzahl (~35), kein echter Leak in der Praxis |
| 6 Connection Pooling | LanceDB embedded — keine File-Deskriptor-Probleme bei dieser Agenten-Anzahl |
| 8 PII in Curation-Log | Lokales System, kein Netzwerk-Exposure. Regex-Scrubbing würde legitime Daten beschädigen |

---

## Repository & Weiterentwicklung

Das Memory-System ist seit 2026-04-03 in einem eigenen Git-Repository unter Versionskontrolle.

### Lokales Repo

```
/root/openclaw-memory-system/
├── .gitignore
├── CHANGELOG.md
├── LICENSE                     MIT
├── README.md
├── how-to-memory-perfect.md    (diese Datei)
├── how-to-memory.md
├── extensions/
│   ├── memory-lancedb-namespaced/   ← Plugin
│   └── memory-lancedb-stock/        ← LanceDB-Abhängigkeit
└── scripts/
    ├── install-memory-system.sh
    └── memory-gc.mjs
```

**Aktueller Stand:** `v1.0.0` (Tag), Branch `main`

### Workflow — Änderungen einpflegen

Änderungen werden in `/root/.openclaw/extensions/...` entwickelt und getestet, dann ins Repo übertragen:

```bash
cd /root/openclaw-memory-system

# Plugin-Dateien synchronisieren
rsync -a --exclude='node_modules' \
  /root/.openclaw/extensions/memory-lancedb-namespaced/ \
  extensions/memory-lancedb-namespaced/

# Docs synchronisieren
cp /root/.openclaw/how-to-memory-perfect.md .
cp /root/.openclaw/how-to-memory.md .
cp /root/.openclaw/scripts/memory-gc.mjs scripts/
cp /root/.openclaw/scripts/install-memory-system.sh scripts/

# Commit + Tag
git add -p
git commit -m "fix: ..."
git tag v1.0.1
```

### Teilen / Veröffentlichen

```bash
# GitHub (z.B. unter github.com/openclaw/memory-system)
git remote add origin https://github.com/openclaw/memory-system.git
git push -u origin main --tags
```

### Externe Beiträge einpflegen

```bash
git remote add contrib https://github.com/andere/memory-system.git
git fetch contrib
git merge contrib/main --no-ff
```

### Was nicht ins Repo gehört (→ .gitignore)

- `node_modules/` — via `npm install` installieren
- API-Keys (`auth-profiles.json`, `auth.json`, `.env`)
- LanceDB-Daten (`memory/lancedb-namespaced/`) — binär, kein sinnvolles Diff
- Snapshots (`memory/.snapshots/`) — lokal, deployment-spezifisch

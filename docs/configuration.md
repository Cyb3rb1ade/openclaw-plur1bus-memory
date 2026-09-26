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

### Prompt-Injektions-Budgets

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `memoriesMaxChars` | `number` | `12000` | Innerer Zeichen-Cap auf den gesamten Rückgabewert von `formatRelevantMemoriesContext` (`truncateMemoryContext`'s `maxTotalChars`, `lib/relevant-memory-context.js`) — also nicht nur den `<relevant-memories>`-Block selbst, sondern inklusive eines eventuell angehängten `<memory-semantic-lens>`-Blocks und des Pattern-Continuity-Blocks. Greift zuerst; überschreitet die Ausgabe diesen Wert, wird sie hier bereits mit `<!-- memory context truncated -->` markiert und abgeschnitten. |
| `globalInjectMaxChars` | `number` | `17000` | Äußerer Zeichen-Cap über alle Prompt-Prepend-Blöcke zusammen (Neo, Start-Hinweis, Memories, Zeit, temporale Kontinuität, Reminder) — `applyGlobalInjectBudget`, `lib/inject-budget.js`. |

Die beiden Caps sind unabhängig und messen nicht dasselbe: `memoriesMaxChars`
deckelt ausschließlich `formatRelevantMemoriesContext`'s eigene Ausgabe (s. o.).
Der äußere `memories`-Block, den `applyGlobalInjectBudget` tatsächlich sieht,
ist größer — er hängt an diese bereits gedeckelte Ausgabe zusätzlich die
Persona-/Mood-/Reaction-/Dream-Echo-/Open-Threads-/Widerspruchs- und
Reaktivierungs-Direktiven sowie die Knowledge-Update-, Konflikt- und
Skill-Proposal-Nudges an (im Recall-Hook in `index.js`)
— Text, den `memoriesMaxChars` nicht kennt und nicht begrenzt. Ob
`globalInjectMaxChars` überhaupt bindet, hängt also von der Summe aus dem
`memoriesMaxChars`-gedeckelten Anteil, diesen zusätzlichen Direktiven/Nudges
und den übrigen Blöcken ab: **`globalInjectMaxChars` greift erst, wenn
`memoriesMaxChars` plus die übrigen Blöcke ihn überschreiten** — bei den
Vorgabewerten (`memoriesMaxChars: 12000`, wenige hundert Zeichen an weiteren
Blöcken) ist das im Regelbetrieb selten der Fall, aber keineswegs
ausgeschlossen, sobald die zusätzlichen Direktiven/Nudges selbst umfangreich
werden.

Überschreitet ein droppable Block, den `applyGlobalInjectBudget` kürzen muss,
den äußeren Cap, unterscheidet sich das Vorgehen danach, ob der Block
`<memory-record>`-Elemente enthält:
- Die Blöcke `memories` und `neo` bestehen aus solchen Elementen; sie werden
  am Ende des letzten vollständigen `<memory-record>`-Elements gekürzt, das
  noch passt, bekommen denselben Trunkierungs-Marker, und jedes an dieser
  Schnittstelle noch offene Element wird dabei geschlossen, damit kein
  unvollständiges XML entsteht. Das ist kein Nachschlagen in einer festen
  Liste bekannter Wrapper-Namen (`<relevant-memories>`, `<memory-semantic-lens>`,
  `<plur1bus-recall>`, `<memory-reactivation>`, …), sondern ein echtes Scannen
  des Tag-Stroms (`openTagsAt`/`closeOpenElements`, `lib/inject-budget.js`),
  das jedes je öffnende Wrapper-Element korrekt erkennt und schließt —
  unabhängig davon, wie viele es gibt oder wie sie heißen.
- Andere droppable Blöcke (z. B. der Start-Hinweis) sowie ein `memories`-Block,
  der nach den obigen Direktiven/Nudges keinen einzigen `<memory-record>` mehr
  enthält, haben keine Record-Grenze, an der sinnvoll geschnitten werden
  könnte; sie werden bei Bedarf vollständig verworfen statt an beliebiger
  Zeichenposition abgeschnitten.
Passt selbst bei den `<memory-record>`-Blöcken kein einziger Record mehr in
das verbleibende Budget, wird auch dort der ganze Block verworfen.
Nicht-droppable Blöcke (Zeit, temporale Kontinuität, Reminder) werden von
`globalInjectMaxChars` nie angetastet.

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
    "model": "woxpas-ai/bge-reranker-v2-m3-onnx",
    "local": {
      "model": "woxpas-ai/bge-reranker-v2-m3-onnx",
      "revision": "c44ebc43de724ae8816668bb44d2e728e17faa18",
      "cacheDir": "${OPENCLAW_HOME}/models/plur1bus"
    },
    "fallbackOnError": true
  }
}
```

BGE ist der empfohlene lokale Reranker und die Vorgabe des Installers
(mehrsprachig, auf MIRACL vor Jina v2, Apache 2.0, 8k Kontext). Wer stattdessen
den halb so tiefen Jina-v2-Reranker will (schneller auf CPU, CC BY-NC 4.0),
setzt ihn als `model`/`local.model` und BGE als kontrollierten Fallback:

```json
{
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

Seit 7.11.0 ist zusaetzlich das Jina-v5-Text-Nano-Embedding gepinnt (Retrieval-
Adapter in die Gewichte gemischt, EuroBERT-Encoder, 239M Parameter, 15
europaeische Sprachen, Last-Token-Pooling). Seit 7.12.0 ist es die Vorgabe des
Installers bei Neuinstallation (Labortest vom 05.09.2026: Rangqualitaet
gleichauf mit v3, klarere Trennung vom Rauschen, dreifache
Migrationsgeschwindigkeit, halber Speicher); Bestandsinstallationen wechseln
nur ueber die Re-Embedding-Migration im Dashboard. `dimensions`
darf 32, 64, 128, 256, 512 oder 768 sein. Anfrage und Dokument werden ueber die
veroeffentlichten Praefixe `Query: ` und `Document: ` unterschieden; der
Provider verweigert abweichende Praefixe, damit ein kopierter v3-Block (leere
Praefixe) nicht stillschweigend untypisierten Text einbettet.

Beide Jina-Laeufe kappen jeden Text bei `embedding.local.maxTokens` (Vorgabe
512, erlaubt 32 bis 8192). Die ONNX-Laufzeit haelt die Attention fuer die
laengste Karte eines Batches mal Batchgroesse vor und gibt den Speicher nie
zurueck; ohne Kappung brachte ein Batch mit den laengsten Karten den Prozess
auf ueber 30 GB. Wer lange Karten vollstaendig einbetten will, hebt den Wert
bewusst an und rechnet mit dem entsprechenden Arbeitsspeicher.

```json
{
  "embedding": {
    "provider": "local-transformers",
    "dimensions": 768,
    "local": {
      "model": "jinaai/jina-embeddings-v5-text-nano-retrieval",
      "revision": "ac5d898c8d382b17167c33e5c8af644a3519b47d",
      "dimensions": 768,
      "queryPrefix": "Query: ",
      "passagePrefix": "Document: ",
      "cacheDir": "${OPENCLAW_HOME}/models/plur1bus"
    }
  },
  "modelPreparation": {
    "profile": "jina-v5-nano-768",
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

Für BGE gilt ausschließlich der ONNX-Export `woxpas-ai/bge-reranker-v2-m3-onnx`.
Das Quellrepository `BAAI/bge-reranker-v2-m3` ist für diesen Pfad absichtlich
ungültig, weil es keine von Transformers.js ladbare ONNX-Datei veröffentlicht.
Ein Jina-Fehler wechselt nur dann kontrolliert zu BGE, wenn der oben gezeigte
Fallback explizit konfiguriert ist.

### Embedding-Request-Timeout

`embedding.requestTimeoutMs` (Standard 15000) begrenzt jede einzelne Anfrage an
einen OpenAI-kompatiblen Embedding-Provider. Der SDK-Standard von zehn Minuten
ließ eine hängende Anfrage einen Recall bis zum Worker-Timeout blockieren. Der
Provider wiederholt fehlgeschlagene Batches selbst; das SDK wiederholt nicht.

### Embedding-Dimensionen

Die PLUR1BUS-Operator-Ansicht trennt Embedding- und Reranker-Modelle. Fuer
`text-embedding-3-small` sind 1 bis 1536 Dimensionen und fuer
`text-embedding-3-large` 1 bis 3072 Dimensionen zulaessig; die Ansicht bietet
dafuer bewaehrte Presets und markiert die jeweilige Standardbreite. Das lokale
`intfloat/multilingual-e5-small` liefert fest 384 Dimensionen. Das getrennte
Jina-v3-Embedding unterstuetzt exakt 32/64/128/256/512/768/1024 Dimensionen,
das Jina-v5-Nano-Embedding exakt 32/64/128/256/512/768.
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
| `all` | Zusaetzlich Modellwahl pro Agent und LLM-Aufgabe, Embedding-Zielprofil, die Schritte der Re-Embedding-Migration und der Compact-Knopf je Partition (7.8.0). |

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

Die Karte „Obsidian Target" zeigt seit 7.8.5 die Zahl der konfigurierten
Ziele und zaehlt ein konfiguriertes Ziel bei
`obsidianBridge.requireVaultPathConfirmation: false` als „ready", weil die
Bridge dann ohne Quittung handelt. Kandidaten werden ohne konfigurierte Liste
in allen `workspace*`-Verzeichnissen unter dem OpenClaw-Home gesucht. Vaults
kennt die Bridge nur ueber `obsidianBridge.workspaces` (Eintraege mit `id`,
`agentId`, `path`) oder `vaultPath`; der Standard ist eine leere Liste.

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

## Skill Miner: Auto-Apply und Freigabe im Dashboard (7.12.48)

Der Skill Miner läuft wöchentlich je Agent, bündelt belastbare Erinnerungen
der letzten 30 Tage nach gemeinsamen Stichworten und lässt das Modell daraus
wiederkehrende Abläufe als Skill formulieren (Titel, Beschreibung, Nutzen,
Anleitung, Beispiele). Jeder Fund landet als Entwurf im OpenClaw Skill
Workshop.

| Schlüssel | Typ | Default | Wirkung |
| --- | --- | --- | --- |
| `skillMiner.autoApply` | `"host" \| "on" \| "off"` | `"host"` | `host` folgt `skills.workshop.autonomous.mode` des Hosts (ungesetzt = `auto` → sofort anwenden; `propose`/`off` → Entwurf bleibt offen). `on` wendet immer an, `off` nie. |

Angewandt wird über denselben Weg wie eine manuelle Freigabe: Workshop-Entwurf
prüfen, hash-gebunden anwenden, Belegerinnerungen auf `corroborated` heben.
Schlägt das fehl, bleibt der Vorschlag offen; der Lauf zählt `autoApplied` und
`autoApplyFailed` in `skill-miner-report.jsonl`.

Im PLUR1BUS-Reiter zeigt der Abschnitt **Mined Skills** alle offenen und
aktiven geminten Skills, gruppiert nach Workspace und Agent, mit Beleglage,
Konfidenz, Nutzen und der Anleitung, der der Agent folgen würde. Mit
`controlUi.writeActions: "all"` gibt es je Karte:

- **Approve**: Entwurf im Workshop anwenden, Belege bestätigen.
- **Decline**: Entwurf ablehnen, Name für künftiges Mining sperren.
- **Withdraw**: bereits angewandten Skill entfernen (Workshop-Verzeichnis des
  Skills wird gelöscht), Name sperren.

Der Miner läuft **jede Nacht um 05:00** (je Agent +15 min), also nach dem
Speicher-Management: Konsolidierung 04:00–04:30, Persona-Evolution
04:15–04:25, GC 04:45, auto-accept-stale (Verfall unbestätigter Criticals) 04:50–04:54. Er bewertet damit genau
die Erinnerungen, die diese Jobs zuvor angefasst haben.

Bis 7.12.49 lief er wöchentlich. Weil jeder Lauf bei `maxPerRun` gedeckelt ist
und zuletzt genau dort endete, brauchte der Rückstau qualifizierter Cluster
Wochen. Damit nächtliche Läufe nicht dieselben Modellaufrufe wiederholen,
merkt sich der Miner je Partition den Fingerabdruck eines Clusters, das nichts
ergeben hat (zu geringe Konfidenz oder gesperrter Name): die exakte Menge
seiner Erinnerungs-IDs. Kommt eine Erinnerung hinzu, wird das Cluster erneut
geprüft. Höchstens 300 Einträge in `run-state.json`, Zähler
`skippedKnownCluster` im Bericht. Die Sperre gegen doppelte Auslöser liegt bei
20 Stunden.

Vorschlägen aus Läufen vor 7.12.48 fehlt der Nutzen-Satz. Er lässt sich
nachtragen:

```bash
openclaw plur1bus-command --agent <id> --session <key> "/plur1bus internal skill-benefit-backfill"
```

Das holt je Vorschlag ohne `benefit` einen Satz vom Modell (höchstens 25 je
Lauf, optional `… skill-benefit-backfill 50`) und schreibt ihn ins Ledger. Der
Workshop-Entwurf bleibt unverändert, weil sein Text an den Revisions-Hash
gebunden ist, den die Freigabe prüft.

Vorschläge aus der Zeit vor der Workshop-Anbindung haben keine Bindung und
lassen sich nur ablehnen. Das Vorschlags-Ledger liegt je ACL-Partition unter
`_neo/workspaces/acl-owner-v1_…/.adaptive-learning/skill-proposals.jsonl`;
auch `/plur1bus skills …` liest seit 7.12.48 dort.

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

### Blitzlicht-Kodierung (`memoryDynamics.flashbulbEncoding`)

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `memoryDynamics.flashbulbEncoding` | `boolean` | `false` | Blitzlicht-Kodierung scharf schalten: `memoryStrength` auf 0.95, Halbwertszeit-Boden auf 3650 Tage (statt 90) — der Refine-Pfad markiert zusätzlich `memoryClass: "flashbulb"`. Für Phase 3 vorgesehen, nach einem Pilotlauf, der die 0,70-Schwelle an einer echten Importance-Verteilung kalibriert. Default aus hält den Deploy auf beiden Aufrufstellen verhaltensneutral. |

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

## Schalter und Entscheidungen im Reiter

Mit `controlUi.writeActions: "all"` trägt jede Feature-Karte ihren Schalter
und die Betriebsentscheidungen, die zu ihr gehören — eine Zeile je
Einstellung mit Auswahl- oder Zahlenfeld. Was angeboten wird, steht als
geschlossene Liste in `lib/dashboard-settings.js`; die Seite kann nichts
schreiben, was dort nicht steht, gleich was ein Formular behauptet.

| Karte | Einstellungen |
| --- | --- |
| jede Feature-Karte | der Feature-Schalter (`<feature>.enabled` bzw. `autoCapture`, `autoRecall`) |
| Knowledge Promotion | `schicht15.maxPromotionsPerRun` |
| Skill Miner | `skillMiner.autoApply` |
| Merging | `merging.autoApply` |
| Garbage Collection | `gc.maxMemoryCount` — abgewiesen unter dem größten laufenden Bestand |
| Critical Push | `criticalPush.maxPerDay` |
| Neo Layer | `llmRouter.errorDiagnostics` |
| Continuity Engine | `associativeRecall`, `patternSurfacing`, `tasteGate`, `overlays`, `contradictionDetection`, `doctor` (je `.enabled`) |
| REM | `dreaming.narrative.enabled`, `.diary`, `.storeAsMemory` |
| Emotion Engine (T3) | `memoryDynamics.flashbulbEncoding` |
| Style Directive | `styleDirective.timeOfDay`, `.opinion`, `.askBack` |
| LLM Tasks | `llmRouter.defaultModel` |

Der Abschnitt **Capacity & Runtime** darunter ist rein lesend: Füllstand je
Agent gegen `gc.maxMemoryCount`, der letzte GC-Lauf aus
`<Workspace des Hauptagenten>/.adaptive-learning/gc-report.json`, der
aktuelle Speicherdruck des Gateway-Prozesses gegen `runtime.rssWarningBytes`
und `runtime.rssCriticalBytes`, und zwölf wirksame `runtime`-Grenzen.

**Gespeichert ist nicht gleich laufend.** Eine Änderung steht sofort in
`openclaw.json`, wirkt aber erst nach dem Plugin-Reload des Hosts — rund eine
Minute. Bis dahin zeigt die Seite weiter den laufenden Wert und markiert die
gespeicherte Zeile mit **pending**; oben steht, wie viele Änderungen betroffen
sind. Bleibt es länger als drei Minuten dabei, ist der Reload vermutlich
gescheitert (auf diesem Host etwa, wenn ein anderes Plugin beim Neustart in
sein Zeitlimit läuft) — dann hilft ein Gateway-Neustart. Verglichen wird nur
die Liste oben plus Speicherweise und Modellwahlen; gelesen wird ausschließlich
`plugins.entries.memory-lancedb-namespaced.config`.

Nicht schreibbar aus dem Reiter: `security.*`, `controlUi.writeActions`,
`featureCronSetup.auto`, `dreaming.enabled` (Sidecar) und alle Schwellenwerte.
Jede Einstellung wird vor dem Schreiben gegen das Schema geprüft; ein
abgelehnter Wert erreicht `openclaw.json` nie. Änderungen gehen durch
OpenClaws reguläres Neuladen der Konfiguration.

## Chat-LLM-Routing über OpenClaw

Der Abschnitt **LLM Tasks** im PLUR1BUS-Reiter ist eine Matrix: eine Spalte
je Agent, eine Zeile je Aufgabe, darüber die Zeile **Default for all tasks**.
Bei **mehr als vier Agenten** wird daraus eine Ansicht je Agent mit
Reiterleiste (`?agent=<id>`; reiner Ansichtsparameter, wirkt auch ohne
Schreibrecht) — zehn Spalten ließen von jedem Auswahlfeld nur den Pfeil übrig.
Ganz oben steht als eigener Kasten das **Hintergrund-Standardmodell**
(`llmRouter.defaultModel`); die Spaltenköpfe nennen es je Agent zuerst und
erst danach das Chatmodell des Agenten als letzte Rückfallstufe. Diese
Aufgaben sind Hintergrundarbeit: Das Chatmodell greift nur, wenn weder
Aufgabe noch Agent noch Hintergrund-Standard etwas vorgeben.
Die Liste je Zelle enthält die Modelle aus `agents.defaults.models` und den
agenteneigenen `models`, einschließlich des primären Modells und der
konfigurierten Fallbacks. Aliase werden angezeigt.

Die Agenten kommen aus `agents.entries` (OpenClaws aktuelle Form, ein Objekt
je Kennung oder ein Array); fehlt es, aus der Altform `agents.list`; fehlt
beides, ist es der Agent `main`. **Spalten bekommen nicht alle Agenten**,
sondern die stehenden (mit `heartbeat`) plus jeder mit gespeicherter Wahl —
ein Host mit einem Hauptagenten und dreißig Subagenten zeigt sonst dreißig
Spalten. `llmRouter.dashboardAgents` legt die Spalten ausdrücklich fest;
gibt es weder stehende noch gewählte, erscheinen alle bekannten.

Die Aufgabenzeilen liegen hinter einem Aufklapper, und eine Zelle ohne Wahl
zeigt nur den ererbten Wert mit einem **Change**-Link (`?edit=<agent>.<Aufgabe>`),
der genau diese Zelle als Auswahlfeld rendert — ohne Skript, damit die Seite
nicht mit Hunderten von Auswahllisten je Katalogmodell wächst.

Die Auswahl wird unter `llmRouter.agentModels.<agentId>.<Aufgabe>`
gespeichert; der Agentenstandard unter dem Schlüssel `*`. Rangfolge:
**Aufgabenwahl > Agentenstandard > bisherige Route**. Der Agentenstandard
verdrängt also, genau wie eine Aufgabenwahl, auch eine feature-eigene direkte
Route; die Matrix kennzeichnet solche Zellen mit „replaces direct route".
Beispiel:

```json
{
  "llmRouter": {
    "dashboardAgents": ["main", "bernhardine"],
    "agentModels": {
      "main": {
        "*": "anthropic/claude-haiku-4-5",
        "merging": "openai/gpt-5.4"
      }
    }
  }
}
```

Die Modellnamen sind Beispiele; auswählbar sind die tatsächlich hinterlegten
Modelle. Für Änderungen im Reiter gilt `controlUi.writeActions: "all"`.
Beim Speichern wird die Liste erneut gegen die aktuelle OpenClaw-Konfiguration
geprüft. Entfernte Modelle bleiben als bisherige Auswahl sichtbar, können aber
nicht erneut gespeichert werden. Eine andere Auswahl oder „Use default“ ist
weiterhin möglich.

Eine ausdrücklich gespeicherte Auswahl nutzt die native OpenClaw-Route. Wenn
die Plugin-Berechtigungen das Modell noch sperren, kennzeichnet die Liste das
mit „†“. Speichern aktiviert dann `llm.allowModelOverride`
am Plugin-Eintrag und ergänzt genau dieses Modell in vorhandenen begrenzten
`allowedModels`- und `allowedCompletionModels`-Listen. Andere Berechtigungen
bleiben erhalten. Beim erstmaligen Aktivieren ohne bestehende Override-Liste
wird nur das gewählte Modell freigegeben. „Use default“ entfernt die
Aufgabenüberschreibung; es entzieht keine Freigabe, die andere Aufgaben nutzen
könnten. „Use default“ heißt in der Matrix **Inherit** und zeigt dahinter,
was dann läuft. Änderungen laufen durch OpenClaws reguläres Neuladen der Konfiguration;
bereits laufende Jobs behalten ihre bisherigen Einstellungen.

**Updates übernehmen die bestehenden Einstellungen unverändert.** Es gibt
keine Migration der Modellwerte und keine neue automatische Modellauswahl.
Ohne gespeicherte Aufgabenüberschreibung gilt weiterhin: zuerst die bestehende
feature-eigene Modell-/Transportkonfiguration, danach `llmRouter.defaultModel`
für Aufgaben ohne eigenen Transport, danach das effektive OpenClaw-Modell.
Eigene Endpunkte, Zugangsdaten und Header werden durch die Auswahl weder
überschrieben noch gelöscht. „Use default“ stellt diese bisherige Route wieder
her. Auch Berechtigungen werden durch ein Update nicht erweitert.

Die Aufgaben sind:

| Feature | Aufgabenkennungen |
| --- | --- |
| Capture | `capture-summary`, `episode-extraction` |
| Recall | `recall-query-summary` |
| Merging | `merging` |
| Daily Consolidation | `memory-compaction`, `conflict-resolution` |
| REM / Neo | `rem-pattern-analysis`, `dream-narrative`, `conversation-insights` |
| Dream Echo | `dream-echo` |
| Emotion / nachträgliche Bewertung | `emotionT3`, `emotion-encoding` |
| Knowledge Promotion | `schicht15` |
| Skill Miner | `skillMiner` |
| Critical Push | `criticalPush` |
| Afterthought / Persona | `afterthought`, `persona-voice` |
| Obsidian-Wiki | `wiki` |
| Continuity | `continuity-overlay`, `overlay-audit-contradiction` |
| Widerspruchsprüfung | `memory-text-contradiction` |

`emotion-encoding` übernimmt ohne eigene Auswahl weiterhin die bisherigen
Einstellungen aus `emotion.t3`. Features ohne LLM-Aufruf erhalten kein
Chat-Modellauswahlfeld. Embedding und Reranking behalten ihre eigenen
Modell-Einstellungen.

`criticalPush.hideTypes` (Liste aus `person`, `beziehung`, `geburtstag`,
`geld_konto`, `gesundheit`, `zugang_passwort`) ergaenzt die Typen, deren Inhalt
in der Push-Karte ausgeblendet wird; `zugang_passwort` ist immer ausgeblendet.
Seit 7.12.2 zeigt der Push fuer alle anderen Typen die bereinigte Vorschau, weil
er nur in den Direktchat des Besitzers geht und dessen eigene Aussage zitiert.

Seit 7.16.10 kommt jede Karte als eigene Telegram-Nachricht mit den Knöpfen
„✅ Annehmen“ und „❌ Ablehnen“ (`criticalPush.buttons`, Standard `true`). Ein
Tipp führt denselben autorisierten Befehl aus wie `/plur1bus critical accept`
bzw. `reject` und schreibt das Ergebnis unter die Karte. Der Host prüft den
Absender vorher gegen die Telegram-Allowlist, und ein Klick zählt nur über den
Bot des Agenten, dem die Karte gehört. Ohne Telegram-Ziel, ohne Outbound-Adapter
oder mit `buttons: false` bleibt es bei der Textnachricht mit Befehlen. Alle auf
einmal geht weiter per `/plur1bus critical accept all` oder zitierter Antwort.

Unbestätigte Karten verfallen seit 7.16.10 nach 24 Stunden zur normalen
Erinnerung (Job `auto-accept-stale`, Name aus Kompatibilitätsgründen
beibehalten). Vorher wurden sie automatisch als Critical akzeptiert, sodass
eine Fehlklassifikation ohne Antwort dauerhaft hervorgehoben blieb.

`schicht15.maxPromotionsPerRun` begrenzt die KNOWLEDGE.md-Uebernahmen je
24-Stunden-Fenster (0 = unbegrenzt). Bis 7.12.2 wurde die lebenslange Zahl
verglichen, was einen Workspace nach dem Erreichen des Limits dauerhaft
blockierte.

`schicht15`, `skillMiner`, `criticalPush` und `emotion.t3` übernehmen insbesondere weder
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

Die Agentenkennung bleibt innerhalb von PLUR1BUS für die Modellwahl erhalten.
Der native Aufruf übergibt keinen `agentId`-Override an OpenClaw; der Host
bestimmt die Bindung seiner LLM-Verbindung. Ein Modell-Override benötigt
`llm.allowModelOverride:true` und muss gegebenenfalls in `allowedModels` und
`allowedCompletionModels` zugelassen sein. Eine Policy-Ablehnung bleibt
fail-soft; PLUR1BUS wiederholt den Request nicht ohne Modell. Installer
`preserve`, Safe und Recommended erweitern diese Berechtigungen nicht.

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

# PLUR1BUS LLM Result Cache v1

Status: **Design bestaetigt, Umsetzung beauftragt** (2026-07-17).

## Ziel und Abgrenzung

PLUR1BUS erhaelt einen lokalen, providerneutralen Result-Cache fuer eigene
OpenAI-kompatible LLM-Hilfsaufrufe. Bei einem exakten Treffer wird die bereits
validierte Antwort zurueckgegeben, ohne den Provider erneut aufzurufen. Damit
entfallen fuer diesen Treffer sowohl Input- als auch Output-Tokens.

Der Cache ersetzt **keine Antworten des OpenClaw-Hauptchats**. Insbesondere
duerfen Wetter, Nachrichten, Preise, Fahrplaene, Web-/Tool-Ergebnisse und andere
aktuelle oder zeitabhaengige Fragen wie „Wie wird das Wetter morgen?“ niemals
aus diesem Result-Cache beantwortet werden. Die vorhandenen OpenClaw-Hooks
`llm_input` und `llm_output` bleiben reine Beobachtungspunkte; PLUR1BUS versucht
nicht, den Hauptmodell-Aufruf darueber zu unterbrechen oder zu ersetzen.

Providerseitiges Prompt-Caching bleibt eine getrennte Optimierung: Es kann
identische Prompt-Praefixe des Hauptchats verbilligen, erzeugt aber weiterhin
eine neue Antwort. Der lokale PLUR1BUS-Cache ergaenzt diesen Mechanismus nur fuer
ausdruecklich freigegebene interne Transformationen.

## Architektur und Datenfluss

Ein neues, fokussiertes Modul `lib/llm-result-cache.js` kapselt Key-Bildung,
In-Memory-LRU/TTL, Request-Coalescing, optionale SQLite-Persistenz und Metriken.
`lib/llm-call.js` bleibt der Provider-Adapter und nimmt optional eine
Cache-Instanz plus einen expliziten Cache-Kontext aus Agent-Scope und Purpose
entgegen. Ohne gueltigen Kontext wird der Provider direkt aufgerufen.

Der Ablauf eines freigegebenen Aufrufs ist:

1. Der Aufrufer benennt einen bekannten Purpose und den sicheren Agent-Scope.
2. Der Adapter bildet aus dem vollstaendigen effektiven Request einen stabilen
   SHA-256-Key.
3. Ein frischer Memory- oder SQLite-Treffer liefert den gespeicherten Text.
4. Bei Miss teilen identische gleichzeitige Requests genau eine In-Flight-Promise.
5. Nur eine nichtleere, fuer `jsonMode` syntaktisch gueltige Provider-Antwort
   wird mitsamt Usage-Metadaten gespeichert.
6. Fehler, Timeouts, Abbrueche und ungueltige Antworten werden weitergereicht
   beziehungsweise wie bisher vom Aufrufer behandelt und nie gecacht.

Der bestehende Rueckgabevertrag von `callLlm()` bleibt `Promise<string|null>`.
Usage-Daten werden intern erfasst; bestehende Konsumenten muessen ihre
Antwortverarbeitung nicht umstellen. Das bislang von Aufrufern gesetzte
`temperature` wird als echter Request-Parameter weitergereicht, damit die fuer
den Cache freigegebenen `temperature: 0`-Transformationen tatsaechlich
deterministisch laufen.

## Strikte Cache-Zulassung

Caching ist **allowlist-basiert und explizit**. Ein unbekannter oder fehlender
Purpose, ein fehlender Agent-Scope oder ein ausgeschalteter Cache fuehrt immer
zum normalen Provider-Aufruf. Es gibt keine Keyword-Heuristik, die Wetter oder
„morgen“ erkennen soll; die sichere Grenze ist, Hauptchat und Live-Antwortpfade
gar nicht erst zuzulassen.

Fuer v1 freigegebene Purpose-Klassen:

- Capture- und Recall-Query-Zusammenfassungen
- Merge- und Konfliktentscheidungen ueber unveraenderte Fragmente
- Emotion-Tier-3-Klassifikation eines unveraenderten Texts
- Episoden- und Conversation-Insight-Analyse
- Skill-Extraktion aus unveraenderter Evidenz
- deterministische REM-Pattern-Analyse
- KNOWLEDGE.md-Transformation, wenn kompletter Ist-Stand und neuer Inhalt im
  Request enthalten sind

In v1 immer ausgeschlossen:

- OpenClaw-Hauptchat und alle normalen Nutzerantworten
- Wetter, News, Preise, Zeit, Fahrplaene, Suche sowie Web-/Tool-Resultate
- `/wiki`-Antwortsynthese und andere direkt nutzersichtbare Antwortgeneratoren
- Dream-Narrative, Dream-Echo, Afterthoughts, Persona-Seed/-Evolution und andere
  kreative oder absichtlich variable Texte
- Critical-Push-/Dringlichkeitsentscheidungen, deren Ergebnis mit der Zeit
  kippen kann
- jeder neue LLM-Aufrufer, bis er bewusst einer Purpose-Klasse zugeordnet und
  mit Regressionstests freigegeben wurde

Der Cache-Key enthaelt Cache-Version, Purpose, Agent-Scope, Endpoint,
Credential-Fingerprint, Modell, vollstaendige Messages und alle tatsaechlich
antwortbeeinflussenden Parameter (`maxTokens`, `temperature`, `jsonMode`,
`disableThinking` und Header-Fingerprint). Objekt-Keys werden fuer stabiles JSON
sortiert; Textinhalt, Gross-/Kleinschreibung und Whitespace bleiben exakt. Weder
API-Key noch Prompt werden gespeichert.

## Speicher, Sicherheit und Konfiguration

Die In-Memory-Schicht ist standardmaessig fuer die explizite Allowlist aktiv:

- `runtime.llmResultCacheEnabled: true`
- `runtime.llmResultCacheTtlMs: 86400000` (24 Stunden)
- `runtime.llmResultCacheMaxEntries: 256`
- `runtime.llmResultCachePersist: false`
- `runtime.llmResultCacheMaxBytes: 67108864` (64 MiB, nur bei Persistenz)
- `runtime.llmResultCacheMetrics: true`

Die TTL ist fuer Memory- und Persistenzschicht verpflichtend und absolut: Ein
Hit aktualisiert zwar `lastAccessedAt` fuer LRU/Diagnostik, verlaengert aber nie
`expiresAt`. Abgelaufene Eintraege werden vor jeder Rueckgabe verworfen und bei
der naechsten Bereinigung geloescht. `ttlMs` muss endlich und positiv sein;
ungueltige Werte fallen auf 24 Stunden zurueck, Werte unter 60 Sekunden werden
auf 60 Sekunden und Werte ueber sieben Tage auf sieben Tage begrenzt. Ein
unbegrenzt gueltiger Eintrag ist nicht konfigurierbar.

Persistenz ist opt-in und verwendet Node.js `node:sqlite`, ohne neue
Abhaengigkeit. Datenbanken liegen agent-isoliert unter
`{baseDbPath}/llm-result-cache-v1/{agentId}.db`; `safeAgentId()` und
`resolveInside()` sind vor jeder Pfadverwendung Pflicht. Die DB verwendet WAL,
`busy_timeout=5000`, atomare UPSERTs und inkrementelles Vacuum. Nach dem Anlegen
wird die DB-Datei auf Modus `0600` gesetzt; schlaegt das fehl, wird gewarnt und
Persistenz fuer diesen Scope deaktiviert.

Persistiert werden nur Key-Hash, Purpose, Modell, Antworttext, Token-Usage,
Zeitstempel und Ablaufzeit. Der Prompt selbst wird niemals persistiert oder
geloggt. Der Antworttext kann Memory-Inhalte enthalten und bleibt deshalb strikt
im Agent-Scope. Bei 90 Prozent des Byte-Limits wird abgelaufener beziehungsweise
am laengsten ungenutzter Inhalt entfernt; am Hard-Limit werden neue persistente
Writes uebersprungen, waehrend Memory-Cache und LLM-Aufruf weiter funktionieren.

Fehlt `node:sqlite`, ist die DB gesperrt oder tritt ein Cache-Fehler auf,
degradiert das Feature nach `safeWarn`/`safeDebug` auf Memory-Cache oder direkten
Provider-Aufruf. Ein Cache-Defekt darf Capture, Recall oder den Message-Flow nie
blockieren. Es gibt keine stillen Catches.

## Metriken und Bedienbarkeit

Pro Agent werden mindestens folgende Zaehler gehalten:

- Requests, Memory-Hits, Persist-Hits, Misses und coalesced Requests
- Upstream-Aufrufe, persistente Writes und wegen Limits uebersprungene Writes
- vermiedene Input- und Output-Tokens aus der Usage des urspruenglichen Calls
- vom Provider gemeldete Cached-Input-Tokens auf echten Upstream-Aufrufen
- Treffer ohne verwertbare Usage-Daten

Dollarbetraege werden in v1 nicht geschaetzt, weil Providerpreise und
Subscription-Modelle nicht verlaesslich aus dem Plugin ableitbar sind. `/status`
zeigt stattdessen Trefferquote, vermiedene Input-/Output-Tokens und den
Persistenzzustand. Debug-Logs enthalten nur Purpose, Agent-ID und gekuerzte
Key-Hashes, nie Prompts oder Antworten. Die Metriken sind bewusst prozesslokal
und beginnen nach einem Gateway-Neustart bei null; Cache-Daten koennen bei
aktivierter SQLite-Persistenz trotzdem weiterverwendet werden.

Gateway-Shutdown schliesst alle SQLite-Handles. Cache-Eintraege koennen durch
Deaktivieren, TTL, Cache-Version oder Loeschen der separaten Cache-DB invalidiert
werden; Memory Cards und LanceDB werden davon nicht beruehrt.

## Tests und Akzeptanzkriterien

Die Umsetzung erfolgt strikt test-first mit DB-freien Unit-Tests, ausser den
isolierten temporaeren SQLite-Tests. Abzudecken sind:

- erster exakter Request ist Miss, zweiter ist Hit und ruft den Provider nicht
  erneut auf
- Unterschiede in Modell, Endpoint, Agent, Purpose, Message-Text oder
  antwortbeeinflussenden Parametern erzeugen einen Miss
- Text wird nicht semantisch, nach Grossschreibung oder Whitespace angenaehert
- identische parallele Misses werden zu einem Provider-Aufruf zusammengelegt;
  ein Fehler wird an alle Wartenden geliefert und danach nicht gecacht
- TTL und LRU-Grenze entfernen Eintraege deterministisch mit injizierbarer Zeit
- Cache-Hits verlaengern die absolute TTL nicht; abgelaufene Memory- und
  SQLite-Eintraege werden nie ausgeliefert
- leere, fehlerhafte und im JSON-Modus syntaktisch ungueltige Antworten werden
  nicht gespeichert
- unbekannte Purposes, fehlender Agent-Scope, kreative Aufrufer und alle
  Hauptchat-/Live-Pfade umgehen den Cache
- eine Wetterfrage im normalen OpenClaw-Hauptchat wird weiterhin frisch ueber
  Modell und gegebenenfalls Wetter-/Web-Tool beantwortet
- SQLite ueberlebt einen Cache-Neustart, isoliert zwei Agents in getrennte
  Dateien, speichert keinen Prompt und respektiert das Byte-Limit
- `temperature` erreicht den Provider-Request und ist Bestandteil des Keys
- Usage-Metriken zaehlen vermiedene Input-/Output-Tokens ohne Schaetzwerte
- `/status` rendert Cache-Metriken robust, auch wenn noch keine Usage vorliegt
- Cache-Ausfall ist fail-open; Provider- und bestehende Fallback-Pfade bleiben
  unveraendert
- neue Exports besitzen fokussiertes JSDoc, die Config-Schema-Regressionen und
  Deploy-Integrity-Liste enthalten das neue Modul
- fokussierte Tests sowie die vollstaendige Suite
  `node --test tests/*.test.js test/*.test.js` sind gruen

Akzeptiert ist v1, wenn bei einem exakten, freigegebenen internen Request der
zweite Aufruf nachweislich keine Provider-Funktion ausfuehrt, waehrend eine
normale oder aktuelle Nutzerfrage niemals aus dem PLUR1BUS-Result-Cache kommt.

## Bewusste Nicht-Ziele

- kein semantischer Aehnlichkeitscache
- kein Cache kompletter Chat-Antworten
- keine automatische Antwort auf Wetter oder andere Live-Fragen
- keine neue Dependency und keine LanceDB-Schemaaenderung
- keine Dollar-Kostenschaetzung
- keine automatische Aenderung globaler OpenClaw-Prompt-Cache-Einstellungen

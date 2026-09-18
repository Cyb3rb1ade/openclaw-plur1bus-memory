# Wie PLUR1BUS Erinnerungen verarbeitet

Systemerklärung für **7.12.61**, abgeglichen am 18.09.2026 mit Commit
`c381fd57fd80df193bc615f405704132dd89884e`. Der historische Dateiname bleibt für
bestehende Links erhalten; er ist kein Versprechen eines „perfekten“ Gedächtnisses.

Für Bedienung: [Alltagsanleitung](how-to-memory.md). Für den genauen
Suchablauf: [Recall-Architektur](docs/recall-architecture.md). Für wirksame
Einstellungen: [Konfiguration](docs/configuration.md).

## Zuständigkeiten des Hosts und des Plugins

OpenClaw verwaltet Sitzungen, Identität, das antwortende Sprachmodell,
Toolaufrufe, Gateway und Zustellung. PLUR1BUS registriert sich als
`memory-lancedb-namespaced`, übernimmt den Memory-Slot und ergänzt Speicherung,
Auswahl, Pflege und Kontext. Der zentrale Integrationspunkt ist
[index.js](index.js); Hostadapter und Setup-Verträge liegen in
[lib/setup](lib/setup/).

`before_prompt_build` stellt Kontext bereit. `agent_end` erfasst ausgewählte
Inhalte nach einem Lauf. Weitere Hooks liefern Reaktions-/Zustellungssignale.
Memory-Capability, Gateway-Methoden, CLI, Control-UI-Reiter und native
Feature-Crons sind verschiedene Schnittstellen. Dass eine davon registriert
ist, beweist nicht die Funktionsfähigkeit aller anderen.

PLUR1BUS übernimmt nicht automatisch alle früher dokumentierten Fähigkeiten
von `memory-core`. Insbesondere ist seine Kartenpipeline keine allgemeine
BM25-plus-Vektor-Suche über alle Workspace-Dateien. Kuratierte
Workspace-Memory-Dateien werden gegenüber dem Host über einen gesonderten
Provenienzvertrag klassifiziert; der optionale Codeindex ist nochmals eine
andere Funktion.

## Speicher mit unterschiedlichen Aufgaben

| Ebene | Inhalt | Rolle |
| --- | --- | --- |
| LanceDB | Text, Vektor, Herkunft, Scope, Version, Epistemik, Gültigkeit | Maßgeblicher Bestand dauerhafter Karten |
| Neo | Turns, Kandidaten, Verhalten, Episoden, Graph, Recall-/Reconsolidierungsereignisse | Gesprächskontinuität und abgeleitete Arbeitszustände |
| KNOWLEDGE.md | Kuratierte Abschnitte | Kompaktes Referenzwissen mit eigenem Suchpfad |
| Obsidian | Menschenlesbare Spiegel, Reviews, Vorschläge und Beziehungen | Kontrollierte Bearbeitung und Prüfung |

Im Flat-Layout besitzt jeder Agent `{baseDbPath}/{agentId}`. Explizite
Namespaces erlauben demselben Agenten mehrere Lesepartitionen und genau einen
aktiven Writer. Shared-Pools benötigen davon getrennte Freigabe und
Eigentumsbindung. Ein Namespace-Name ersetzt keine ACL.

Neo arbeitet überwiegend mit JSONL-Journalen und angehängten Revisionen. Eine
Float32-Vektordatei samt Index kann große JSON-Zahlenlisten ersetzen; der globale
Kandidatenindex macht die Suche unabhängig vom kurzen jüngsten Journalfenster.
Nicht jede Neo-Beobachtung wird zu einer LanceDB-Karte, und nicht jede Karte
wird in KNOWLEDGE.md befördert. [Neo-Implementierung](lib/neo-arch.js).

Diese Aufteilung erleichtert nachgelagerte Verarbeitung, erzeugt aber mehrere
Konsistenzgrenzen. LanceDB, JSONL, Graph und Vault teilen keine einzelne
Transaktion. Ein erfolgreicher Write in einer Schicht belegt noch keine
abgeschlossene Synchronisierung aller anderen.

## Erfassung: vom Gespräch zur Karte

Der automatische Pfad prüft Inkognito, interne Hintergrundläufe und
Workspace-Policy, ordnet den Auftrag dem Agenten zu und reiht ihn in eine
serielle Capture-Warteschlange ein. Bei einem vorhandenen Sitzungsschlüssel
führen Klassifikationsfehler zum Auslassen; ohne Schlüssel wird derzeit mit
Warnung erfasst. Diese Unterscheidung ist für Integrationen ohne vollständigen
Sessionkontext relevant.

Neo verarbeitet zunächst Gesprächsereignisse und Kandidaten. Dieser Schritt
liegt vor der Erfolgsschranke des späteren LanceDB-Capture; die beiden Pfade
haben also nicht denselben Vertrag für fehlgeschlagene Agentenläufe. Ein Worker
entlastet den Hauptthread; Embedding-Rückstau wird mit dem verbleibenden Budget
nach der aktuellen Erfassung abgearbeitet.

Der Kartenpfad betrachtet Benutzer- und Assistententext. Anhänge können als
beschreibende Platzhalter eingehen, was keine Inhaltsanalyse eines Bildes oder
Audios belegt. Bereits injizierte Erinnerungen und interne Blöcke werden
gefiltert. Die Auswahl priorisiert bis zu drei Benutzerbeiträge mit
URLs/Anhängen und die letzten fünf Texte, insgesamt höchstens acht verschiedene
Einträge. Texte über dem Capture-Limit werden abhängig von der verfügbaren
Zusammenfassungsroute verdichtet oder abgeschnitten; der Code-Fallback liegt
bei 15.000 Zeichen.

Embeddings können gebündelt entstehen. Bei Batchfehlern sind Einzelversuche
möglich. Die Duplikatprüfung sucht bestehende ähnliche Karten; scheitert sie,
wird der betreffende neue Eintrag nicht einfach ungeprüft geschrieben. Writes
laufen seriell. Kurzfassungen im Basispfad sind deterministische Textkürzung,
keine garantierte Extraktion aller atomaren Fakten.

Herkunftsfelder halten unter anderem Rolle, Turn, Zeit, URL und Evidenztext
fest. Eine Assistentenantwort bleibt dadurch als abgeleitete Quelle erkennbar.
[Capture-Orchestrierung](index.js),
[epistemischer Capture](lib/epistemic-capture.js),
[Faktqualität](lib/memory-fact-quality.js), [Textregeln](lib/text-utils.js).

## Vier unabhängige Aussagen über eine Karte

| Achse | Beispiel | Bedeutung |
| --- | --- | --- |
| Lebenszyklus | active, superseded, archived, deleted | Darf diese Version noch normal verwendet werden? |
| Epistemischer Status | observed, trusted, disputed, invalidated | Welche Evidenz-/Vertrauensbewertung trägt sie? |
| Realwelt-Gültigkeit | validFrom / validUntil | Wann hält die beschriebene Aussage? |
| Technische Aufbewahrung | expiresAt | Wann wird sie unabhängig davon vom Recall ausgeschlossen? |

Eine aktive Karte kann eine historisch begrenzte Aussage enthalten. Ein
vertrauenswürdiger Inhalt kann technisch abgelaufen sein. Ein hoher Suchscore
kann weder ein Invalidierungsurteil noch eine fehlende Zugriffsberechtigung
aufheben. `validAt` ist optional: ohne diesen Parameter bedeutet Recall nicht
automatisch „nur heute gültige Fakten“.

Eine Inhaltsänderung schreibt über `safeUpdate` eine Ersatzversion und markiert
danach die vorherige Version. Das Schließen eines historischen
Gültigkeitsfensters kann dagegen eine Metadatenänderung ohne Textversion sein.
Merge und Deduplizierung beachten bekannte disjunkte Zeitfenster. LanceDB kann
Int64-Werte als BigInt liefern; die entsprechenden Helfer behandeln sichere
Zahlen und BigInts ausdrücklich.

[Versionierung](lib/safe-update.js), [Gültigkeit](lib/valid-time.js),
[epistemische Zustände](lib/epistemic-status.js).

## Abruf und Ranking

Die automatische Antwortvorbereitung kombiniert einen Neo-Vorlauf mit der
primären Karten-/KNOWLEDGE-Suche. Letztere bettet die Anfrage ein, sucht
Vektorkandidaten, prüft Score/Lebenszyklus/ACL, verfeinert gegebenenfalls eine
leere Ergebnismenge, verarbeitet Zeitbezug, sucht kanonische Abschnitte,
bewertet Karten und ergänzt autorisierte Graphnachbarn.

Optionales Reranking geschieht in der Child-Pipeline. Die aktuelle Runtime
verschiebt finale Kappung und Deduplizierung hinter die globale Zusammenführung,
auch bei nur einer Tabelle. Diese Zusammenführung sortiert nach alten Scores
und kann dadurch die Reranker-Reihenfolge aufheben. Das ist reproduziert und
wird in [Known issues](docs/known-issues.md) beschrieben.

Die Standardauswahl beginnt mit 40 Vektorkandidaten und erlaubt 12 primäre
Prompttreffer inklusive bis zu 5 kanonischer Abschnitte. Semantic Lens ist im
Manifest an, benötigt aber einen vorbereiteten Index; Conversation Reactivation
Recall ist aus. Weitere Kontextblöcke sind nicht mit diesen 12 Slots
identisch. Der spätere 17.000-Zeichen-Rahmen ist kein hartes Tokenlimit für den
gesamten Hostprompt.

Die Scores verbinden Vektorabstand mit Wichtigkeit, Emotionsfaktor,
Memory-Stärke und epistemischen Zu-/Abschlägen. Neo verwendet eine andere
Kombination aus lexikalischer und semantischer Ähnlichkeit, Herkunft, Salienz,
Kurierung und Aktualität. Diese Werte sind Auswahlheuristiken, keine
Wahrheitswahrscheinlichkeiten. Die genaue Reihenfolge und Formel stehen in der
[Recall-Referenz](docs/recall-architecture.md).

## Pflege, Lernen und Hintergrundarbeit

### Konsolidierung und Korrektur

Tageskonsolidierung kann Ablaufbereinigung, Stärke-/Alterungsdynamik,
Graphbereinigung, Konfliktanalyse, Vorschläge und physische LanceDB-Optimierung
kombinieren. Fragment-/Versionsoptimierung ist Speicherwartung; sie ist keine
semantische Zusammenfassung von Fakten.

`merging.autoApply` ist standardmäßig false. Andere Pfade besitzen eigene
Apply-Verträge: die Memory-Compaction kann exakte Duplikate automatisch
archivieren, während konfliktbehaftete oder zeitlich getrennte Aussagen andere
Vorschläge benötigen. Deshalb ist „alle Jobs erstellen nur Vorschläge“ genauso
ungenau wie „alle Vorschläge werden autonom angewendet“.

[Daily job](lib/jobs/daily-consolidation.js),
[Compaction](lib/jobs/memory-compaction.js),
[Dynamik](lib/memory-dynamics.js).

### Episoden und Dreaming

Episoden verdichten Gesprächsverläufe und ergänzen Themen, Entitäten, Stimmung
oder Erinnerungsverknüpfungen. Grenzen und Ausgaben der Modellantwort werden
validiert. Light Dreaming benötigt unter anderem Neo, aktiviertes Merging,
einen LLM-Pfad und genügend neue Turns; ein einzelnes generisches
`dreaming.enabled` ist keine Beschreibung aller Voraussetzungen.

REM verarbeitet nach ACL getrennte Partitionen. Analyse, Muster und
Wiederholung können Memory-Dynamik und Verknüpfungen beeinflussen. Optionale
Traumerzählungen sind synthetische Texte mit eigener Herkunft. Private
Agentenpartitionen können den verwalteten DREAMS.md-Bereich im Workspace
bedienen; fremde Shared-Partitionen dürfen dort nicht einfach hineinschreiben.
Der Traum ist kein zusätzlicher Wahrheitsbeleg seiner Ausgangsinhalte.

[Light Dreaming](lib/dreaming/light-dream.js),
[REM](lib/dreaming/rem-dream.js), [Episoden](lib/episodes.js).

### Skills, Persona und Emotion

Skill Mining versucht aus hinreichend belegtem wiederkehrendem Material
Vorgehensweisen abzuleiten und übergibt sie an den nativen Skill Workshop.
`skillMiner.autoApply: "host"` kann je nach Host-Policy automatische Aktivierung
erlauben. Entwurf, Zustimmung, Workshop-Aktivierung und späterer Entzug sind
verschiedene Zustände.

Persona-Evolution nutzt Rückmeldungen und einen geschützten Ausgangstext.
Begrenzte Änderungen können automatisch angewendet werden, wenn Daten- und
Zeitbedingungen erfüllt sind. Emotion Tier 1/2 ist am untersuchten Stand
lexikalisch/regelbasiert; Tier 2 lädt trotz seines Dateinamens kein
Emotions-ONNX-Modell. Die Tier-3-LLM-Verfeinerung ist standardmäßig deferred und
braucht eine nutzbare Route.

Diese Mechanismen ändern gespeicherten Zustand, Gewichtungen, Regeln und
Promptkontext. Sie trainieren keine Gewichte des antwortenden Chatmodells und
belegen weder Bewusstsein noch menschliche Emotionen.

[Skill Miner](lib/jobs/skill-miner.js), [Persona](lib/persona-voice.js),
[Emotion](lib/emotion-engine.js), [Tier 2](lib/tier2-transformer.js).

### Proaktivität und Reminder

Afterthoughts und proaktive Hinweise hängen von Verlauf, offenen Themen,
Budgets und einer sicheren Zustellroute ab. Native Cron-Commands liefern
Nachrichtentext oder `NO_REPLY`; OpenClaw finalisiert die Zustellung. Ein
zurückgegebenes Nachrichtenobjekt beweist noch keinen erfolgreichen Versand.
Reminder besitzen eigene Zustände und Abläufe. Dry-run ist dabei kein globaler
Seiteneffekt-Schalter; die konkreten Einschränkungen sind dokumentiert.

## Vertrauen, Zugriff und Datenschutz

ACL-Entscheidungen benötigen den richtigen Kontext. Agent-private ist
agentengebunden, workspacebezogene Sichtbarkeit braucht die entsprechende
Bindung, User-Scope eine verlässliche Nutzeridentität. Automatische Shared-
Quellen können bei mehrdeutiger Identität ausfallen, ohne dass private Inhalte
freigegeben werden. Die Anforderungen unterscheiden sich zwischen Hook,
Modelltool, Chatbefehl und Hostadapter.

Die Chat-Autorisierung verwendet Allowlists und Kanaltyp. Destruktive
Chatbestätigungen sind an Identität und Nonce gebunden. Modelltools für
Vergessen/Wissensänderung sind standardmäßig separat zugelassen; menschliche
Freigaben dürfen nicht pauschal aus dem Chatpfad abgeleitet werden.

Vault-Apply kontrolliert Pfad, Bindung, Modus, Eigentum und Freigabe. Sichere
lexikalische Pfade in einem Helfer belegen noch keine universelle
Symlink-Sicherheit jedes Dateizugriffs. Explizite Namespace-Routen nutzen
strengere Plattform-Capabilities und können auf ungeeigneten Plattformen
abgelehnt werden.

Tombstones verhindern normalisierte identische Wiederaufnahme im gebundenen
Bereich. Das ersetzt weder eine Paraphrasensperre noch Volltilgung aller
Kopien. Optional persistente LLM-Caches enthalten Antworttexte; der
Embedding-Debugcache kann Eingabetext speichern. Einzelne Logs können Queries
oder Vorschauen enthalten. „Keine Klartextprompts im Cache-Key“ ist daher keine
Aussage über sämtliche Dateien und Logs.

Erinnerungen werden als historische Evidenz gerendert und Metadaten escaped.
Das erschwert die Verwechslung mit aktuellen Anweisungen. Ob das Sprachmodell
solche Grenzen zuverlässig respektiert, bleibt zusätzlich zu evaluieren.

[ACL](lib/acl-middleware.js), [Kontextbindung](lib/memory-request-context.js),
[Vault-Apply](lib/obsidian-bridge.js), [Bestätigung](lib/security.js).

## Provider, Warteschlangen und Modellgenerationen

Embedding, Reranking und Chat-LLM sind getrennte Provideraufgaben. Ein
feature-lokaler Chat-Override wird nicht stillschweigend von einem anderen
Feature geerbt. Native LLM-Calls brauchen die vorgesehenen Trust-Bits des
Plugin-Entry; fehlen sie, ist kein ungeprüfter Credential-Fallback zulässig.

Scheduler begrenzen Recall und Capture, bündeln Hintergrundarbeit und
berücksichtigen Speicherdruck. Ein Timeout beendet zunächst das Warten;
weitere Abort-/Generations-/Schreibguards entscheiden, ob verspätete Arbeit
noch Seiteneffekte erzeugen kann. Shutdown muss aktive Besitzer geordnet
beenden, bevor eine neue Generation dieselben Ressourcen übernimmt.

Re-Embedding ist ein eigener Ablauf: Zielprofil vorbereiten, echten Vektor
prüfen, Plan erstellen, neue Generation aufbauen, Bereitschaft prüfen und
separat umschalten. Modellname, Dimension und weitere Fingerprintdaten gehören
zusammen. Ein Modellwechsel ist auch bei gleicher Dimension kein unbedenklicher
Austausch alter gegen neue Vektoren.

[Scheduler](lib/runtime-scheduler.js), [Shutdown](lib/runtime-shutdown.js),
[Re-Embedding](lib/reembedding/), [Provider](lib/providers/).

## Was die Prüfung belegt

Am unveränderten genannten Snapshot liefen unter macOS/Node 22.23.2 4.760 Tests
mit 4.684 Passes, 0 Fehlern und 76 Skips. Dazu kamen zwei isolierte Reproduktionen
für globale Reranker-Reihenfolge und Critical-Push-Batchlimit. Die Testsuite
umfasst auch echte LanceDB-, Dateisystem-, Worker- und Host-Verträge.

Nicht gemessen wurden reale Erinnerungsqualität über längere Zeit,
Ende-zu-Ende-Latenz aller Provider oder der Zustand einer persönlichen
Installation. Ein hilfreiches Evaluationsset muss Herkunft, Nutzergrenzen,
Zeitfenster, Korrekturen, Vergessen, finalen Prompt und tatsächliche Antwort
getrennt prüfen. Die [Known issues](docs/known-issues.md) unterscheiden deshalb
Reproduktion, statische Beobachtung und fehlenden Nachweis.

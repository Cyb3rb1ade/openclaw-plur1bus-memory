# Modellfreier Carrier für PLUR1BUS-Feature-Crons

## Ausgangslage

Die Feature-Crons `afterthought` und `classify-recent` starten derzeit mit
einer mehrzeiligen Agent-Nachricht. Nach dem eigentlichen Slash-Command folgt
ein natürlichsprachiger „Delivery contract“.

Die Analyse des installierten OpenClaw-Runtimes zeigte zusätzlich eine
entscheidende Host-Eigenschaft: Der vorhandene
`plur1bus-cron-cmd-dispatch` ruft zwar den Plugin-Handler auf, hängt dessen
Text aber nur an `commandBody` an und startet danach auch bei einem exakten
Command immer `executeCronRun()`. Exakte Payloads allein beseitigen den
äußeren Agent-/Modell-Turn daher nicht.

Auf dem untersuchten Echtsystem verursachten sechs halbstündliche Jobs dadurch
mehr als sechs Millionen Input-Tokens pro Tag, obwohl die Läufe nahezu immer
`NO_REPLY` ergaben.

## Ziel

Die bestehenden Features und ihre Semantik bleiben erhalten:

- `classify-recent` läuft weiterhin alle 30 Minuten, damit sein
  30-Minuten-Suchfenster lückenlos bleibt.
- `afterthought` läuft weiterhin alle 30 Minuten.
- Feature-interne LLM-Aufrufe bleiben möglich, wenn der Job tatsächlich einen
  Kandidaten verarbeiten muss.
- Die äußere Agent-/Modell-Runde zur Interpretation des Job-Ergebnisses
  entfällt vollständig.

## Design

Die Cron-Payload besteht exakt aus dem registrierten Plugin-Command:

```text
/plur1bus internal afterthought
/plur1bus internal classify-recent
```

Ein idempotenter Host-Patch installiert oder erweitert den
PLUR1BUS-Cron-Dispatcher.
Nur wenn die gesamte Payload exakt einem der beiden Feature-Commands
entspricht, wird der Plugin-Handler direkt ausgeführt. Sein vollständiger
`ReplyPayload` wird anschließend als modellfreies Ausführungsergebnis an
OpenClaws bestehendes `finalizeCronRun()` übergeben. Diese Finalisierung
übernimmt Zustellung, `NO_REPLY`-Unterdrückung, strukturierte Präsentationen,
Cron-Status, Persistenz und Cleanup. Danach kehrt der Cron-Lauf zurück, bevor
`executeCronRun()` erreicht wird.

Mehrzeilige oder benutzerdefinierte Prompts sowie andere Commands behalten den
bisherigen Pfad. Handler- oder Finalisierungsfehler werden für die beiden
direkten Feature-Commands nicht mehr verschluckt, sondern ergeben einen
fehlgeschlagenen Cron-Lauf.

Der Patch gehört zum Release-Paket. Die Plugin-Registrierung wendet ihn bei
jedem Gateway-Start erneut an; der Feature-Cron-Setup-Prozess prüft ihn
zusätzlich vor jedem Cron-Read oder jeder Mutation. Fehlt die Schreibberechtigung
oder passt die installierte OpenClaw-Struktur nicht zu den auditierten Ankern,
bleibt das Cron-Setup fail-closed. Backups sind an den SHA-256-Hash der
ungepatchten Runtime gebunden, sodass ein OpenClaw-Update keine veraltete
Rollback-Datei wiederverwendet.

Der Handler übersetzt die internen Job-Ergebnisse im Cron-Kontext selbst in
eine zustellbare Antwort:

- Afterthought mit `text`: Text unverändert zurückgeben.
- Afterthought ohne Text und regulärem Skip: `NO_REPLY`.
- Classifier mit Push-Nachrichten: deren Texte in stabiler Reihenfolge als
  eine Nachricht zurückgeben, getrennt durch Leerzeilen; Callback-Buttons
  bleiben als strukturierte Präsentation erhalten.
- Classifier ohne Push-Nachricht: `NO_REPLY`.
- Expliziter technischer Jobfehler: Handler fehlschlagen lassen, damit der
  Cron-Lauf als Fehler sichtbar wird.
- Teilfehler mit bereits erzeugten Pushes: Pushes zustellen und einen knappen
  Warnhinweis anhängen, damit bereits hochgezählte Pushes nicht verloren gehen
  und der Teilfehler dennoch sichtbar bleibt.

Manuelle, nicht aus einem Cron stammende `internal`-Aufrufe behalten die
bisherige JSON-Diagnoseausgabe.

## Migration bestehender Jobs

Der Feature-Cron-Planner erkennt ausschließlich die bekannten, von PLUR1BUS
ausgelieferten Delivery-Contract-Payloads und plant für sie ein `cron edit`
auf den exakten Command. Beliebige benutzerdefinierte Prompts werden nicht
überschrieben.

Neu angelegte Jobs verwenden ebenfalls sofort die exakte Command-Payload.

## Nicht Teil dieser Änderung

- keine Änderung der Cron-Frequenz
- kein `thinking: off` (insbesondere nicht für Kimi)
- keine Modellwahl für Afterthought
- keine Light-Context- oder Tool-Allowlist-Konfiguration
- keine Mutation des Echtsystems

## Verifikation

Regressionstests decken die direkte Ergebnisübersetzung, Fehlerpropagation,
exakte Cron-Payloads, die Migration bestehender Standard-Payloads sowie den
idempotenten Host-Patch ab. Der Transformer wird zusätzlich gegen eine Kopie
des tatsächlich installierten OpenClaw-Bundles angewandt und mit
`node --check` validiert. Anschließend laufen die betroffenen Tests sowie die
vollständige Testsuite.

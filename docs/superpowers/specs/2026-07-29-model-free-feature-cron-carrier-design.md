# Modellfreier Carrier für PLUR1BUS-Feature-Crons

## Ausgangslage

Die Feature-Crons `afterthought` und `classify-recent` starten derzeit mit
einer mehrzeiligen Agent-Nachricht. Nach dem eigentlichen Slash-Command folgt
ein natürlichsprachiger „Delivery contract“. Dadurch erkennt OpenClaw die
Nachricht nicht als exakten Plugin-Command und startet für jeden Lauf einen
vollständigen Agent-/Modell-Turn.

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

OpenClaw kann diese exakten Commands vor der Agent-Inferenz direkt an den
PLUR1BUS-Command-Handler übergeben.

Der Handler übersetzt die internen Job-Ergebnisse im Cron-Kontext selbst in
eine zustellbare Antwort:

- Afterthought mit `text`: Text unverändert zurückgeben.
- Afterthought ohne Text und regulärem Skip: `NO_REPLY`.
- Classifier mit Push-Nachrichten: deren Texte in stabiler Reihenfolge als
  eine Nachricht zurückgeben, getrennt durch Leerzeilen.
- Classifier ohne Push-Nachricht: `NO_REPLY`.
- Expliziter technischer Jobfehler: Handler fehlschlagen lassen, damit der
  Cron-Lauf als Fehler sichtbar wird.

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
exakte Cron-Payloads und die Migration bestehender Standard-Payloads ab.
Anschließend laufen die betroffenen Tests sowie die vollständige Testsuite.

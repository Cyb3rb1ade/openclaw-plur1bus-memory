# PLUR1BUS im Alltag

Stand: **7.12.61**, Codeabgleich vom 18.09.2026. Diese Anleitung beschreibt die
Nutzung des Plugins; sie behauptet keinen geprüften Zustand deiner konkreten
Installation. Installation und Mindestversionen stehen im [README](README.md),
Einstellungen in der [Konfigurationsreferenz](docs/configuration.md).

## Zuerst den tatsächlichen Zustand prüfen

Öffne den PLUR1BUS-Reiter im OpenClaw Control UI oder verwende `/state` und
`/plur1bus start`. Prüfe den ausgewählten Agenten, die geladene Version, den
Embedding-Provider und den Zustand seiner Speicher. Eine vorhandene Karte im
Dashboard beweist noch nicht, dass sie im nächsten Prompt ankommt.

Der Reiter nutzt den bestehenden Gateway und dessen Anmeldung. Er ist mit
`controlUi.writeActions: "off"` lesend; zusätzliche Schreibfunktionen benötigen
auch die entsprechende Operatorberechtigung des Hosts.

`/plur1bus setup` zeigt verfügbare Profile. Eine Anwendung ist explizit:

```text
/plur1bus setup safe
/plur1bus setup recommended
```

Wähle eines davon entsprechend dem gewünschten Verhalten. Safe lässt die
Kernspeicherung und Suche nutzbar und schaltet die im Profil aufgeführten
Zusatzmutatoren/Chat-LLM-Funktionen aus. Recommended aktiviert mehr Funktionen,
hält aber Freigaberegeln für Merging, Vault und Reviews bei. Diese Auswahl ist
keine Qualitätsprüfung deiner Erinnerungen und keine Providerkonfiguration.

## Erinnerungen ansehen

```text
/memory Welche Entscheidung gab es zum Backup?
/memory Projekt Atlas --explain
```

Die Suche nutzt semantische Kandidaten und nachgelagerte Auswahlregeln. Eine
kurze UUID ist keine gute semantische Frage. Verwende die angezeigte Karten-ID
für Befehle, die ausdrücklich eine ID verlangen.

Zeitangaben sind zu unterscheiden. „Letzte Woche“ kann nach Erfassungszeit
filtern. Ein exakt gesetztes `validAt` im Modelltool fragt dagegen, wann die
Aussage in der realen Welt gültig war. Ohne diesen Parameter bleiben auch
historische, mit Gültigkeitsgrenzen beschriftete Aussagen grundsätzlich
abrufbar. `expiresAt` ist wiederum die technische Ablaufzeit.

Automatischer Recall und `/memory` sind nicht identisch mit dem vollständigen
Kontext einer Antwort. Neo, Persona, Zeit und andere Blöcke kommen über eigene
Pfade hinzu. Auch späteres Kürzen oder das Sprachmodell kann beeinflussen,
welche gefundenen Informationen tatsächlich verwendet werden.

## Etwas gezielt merken lassen

Du kannst den Agenten ausdrücklich bitten, eine konkrete Entscheidung oder
Präferenz zu speichern. Dafür steht ihm `memory_store` zur Verfügung. Kontrolliere
bei wichtigen Aussagen Inhalt und Herkunft anschließend mit einer Suche.

Automatischer Capture ist ein begrenzter Auswahlprozess. Er erfasst nicht
verlustlos jede Nachricht und kann auch Assistentenaussagen speichern. Lange
Inhalte können zusammengefasst oder abgeschnitten werden. Eine automatisch
gespeicherte Aussage ist deshalb kein unabhängiger Wahrheitsbeleg.

Inkognito-Sitzungen werden vor automatischer Erfassung über den Host
klassifiziert. Bei vorhandenem Sitzungsschlüssel und fehlerhafter Klassifikation
wird ausgelassen. Ohne Sitzungsschlüssel erfasst der derzeitige Code mit Warnung.
Explizite Memory-Tools haben ihren eigenen Berechtigungsvertrag.

## Korrigieren und vergessen

```text
/correct Termin Mittwoch zu Termin Donnerstag
/forget den alten Pferdekauf-Plan
```

`/correct` akzeptiert auch `→` und `->`. Der Chatpfad sucht die passenden
Kandidaten und führt seine Autorisierungs-/Bestätigungsregeln aus. Bestätige nur
die beabsichtigte Karte; ähnlich formulierte Treffer können andere Sachverhalte
betreffen. Eine Inhaltskorrektur erhält eine neue Einbettung und Versionsspur.

Eine historische Veränderung ist etwas anderes als eine falsche Aussage:
„Firma A bis Juni, Firma B ab Juli“ kann zwei gleichzeitig gespeicherte Karten
mit getrennten Gültigkeitsfenstern benötigen. Eine Textkorrektur setzt diese
Fenster nicht automatisch passend. Das explizite Schließen von `validUntil`
hat noch keine eigene allgemeine `/correct`-Bedienoberfläche.

Vergessen ist archive-first und verwendet Soft-Delete/Tombstones. Damit werden
aktive Nutzung und identische normalisierte Wiederaufnahme verhindert.
Journale, Archive, Exporte und Backups können den Inhalt weiterhin enthalten.
Für vollständige Datentilgung reicht der Befehl allein nicht.

Modelltools sind separate Wege: `security.allowModelDestructiveMemoryOps` ist
standardmäßig `true`. Die Bestätigung eines Chatbefehls gilt nicht automatisch
für `memory_forget` oder `knowledge_update` des Modells.

## Feedback geben

```text
/mf <Karten-ID> +
/mf <Karten-ID> -
/mf <Karten-ID> ~
```

Das speichert positives, negatives oder neutrales Feedback. Rückmeldesignale
und Recall-Historie können die Memory-Dynamik beeinflussen. Sie trainieren keine
Gewichte des Chatmodells; der Feedback-Analysebericht selbst ist kein trainierter
Reranker. Prüfe deshalb nach einer Änderung das tatsächliche Suchergebnis.

## Erinnerungen teilen

```text
/share <Karten-ID>
/share <Karten-ID> --user
```

Der erste Weg erstellt nach gebundener Bestätigung eine Workspace-Kopie, der
zweite eine Kopie für den authentifizierten Nutzer. Das Original wird nicht
verschoben. Kanal-, Account- und Nutzerbindung sind Teil der Autorisierung.
Fehlt verlässliche Identität, darf sie nicht aus Memory-Text geraten werden.

Private automatische Karten sind an den Agenten gebunden und können innerhalb
dieses Agenten workspaceübergreifend erscheinen. Benannte Storage-Namespaces
sind keine Freigabe an andere Agenten. Alte `workspace_shared`-Zeilen werden
nicht automatisch in neue geteilte Pools umgedeutet; dafür gibt es einen eigenen
[Migrationspfad](docs/configuration.md#b13-shared-memory-routen-und-hook-grenze).

## Funktionen und Hintergrundjobs

```text
/enable autoRecall
/disable kritischPush
```

Nur registrierte Feature-Namen sind zulässig. Diese Befehle ändern
Konfiguration; beachte die angezeigte Neustart-/Aktivierungsanforderung und prüfe
danach den Laufzeitstatus. Ein deaktiviertes Feature und ein noch vorhandener
Cron-Eintrag sind zwei getrennte Zustände.

Die Einrichtung von Jobs benötigt native Host-Command-Dispatch-Fähigkeit und
explizite Rohkonfiguration. Effektive Defaults allein erzeugen keinen Job.
`node scripts/setup-feature-crons.mjs` ist ein Einrichtungsbefehl mit
Seiteneffekten, kein reiner Health-Check. Ein Exitcode 0 kann wegen der
installationsfreundlichen Fehlerbehandlung auch mit übersprungenen Jobs
auftreten. Entscheidend sind Meldungen, Host-Cronzustand und ausgeführte Läufe.

| Arbeit | Wichtige Voraussetzung |
| --- | --- |
| REM-Dreaming | `merging.enabled`, nutzbares Modell und geeignete ACL-Partition |
| Tageskonsolidierung | `dailyConsolidation.enabled` und geplanter Job |
| Skill Miner | `skillMiner.enabled`; Manifest-Cron `0 5 * * *`, Zeitzone `Europe/Berlin` |
| Persona-Evolution | Explizite Persona-/Skill-Miner-Gates sowie genügend neue Rückmeldungen |
| Afterthought | Explizite Funktion, Merging oder Skill Miner, passende offene Unterhaltung und Proaktivbudget |
| Critical Push | Explizites Gate, Klassifikationsmodell und gebundene Zustellroute |
| Emotion-Verfeinerung | Tier-3-Konfiguration und deferred/inline-Modus beachten |
| Semantische Vault-Links | Bridge und bestätigte Index-/Discovery-Bedingungen |

Zeitpläne können pro Agent gestaffelt oder ausdrücklich überschrieben sein.
Die wirksame Planung steht im Host; der
[Cron-Planer](lib/setup/feature-cron-plan.js) beschreibt die erzeugten Jobs.

Critical Push hat am untersuchten Stand einen bestätigten Batch-Fehler:
`maxPerDay: 3` kann bei fünf gleichzeitig geeigneten Karten fünf Nachrichten
zulassen. Der dokumentierte Test hat nichts real versendet. Verlasse dich bis
zur Korrektur nicht auf einen harten Deckel innerhalb eines Laufs.

## Skills und menschliche Freigabe

```text
/plur1bus skills review
/plur1bus skills show <ID>
/plur1bus skills approve <ID>
/plur1bus skills reject <ID>
/plur1bus skills list
```

Geminte Skills landen im OpenClaw Skill Workshop. `skillMiner.autoApply` kann
`host`, `on` oder `off` sein; `host` folgt dem autonomen Modus des Workshops und
kann unmittelbares Anwenden erlauben. Wer jeden Vorschlag manuell prüfen will,
muss die passende Policy ausdrücklich wählen. Ein Entwurf im Ledger allein
beweist keine erfolgreiche Workshop-Aktivierung.

## Obsidian verwenden

Die Bridge ist standardmäßig aus. Konfiguriere ein Ziel und bestätige den
Vault-Pfad, wenn der gewählte Vertrag das verlangt. Ein gefundener Workspace
oder Vault ist noch keine Bestätigung. Beginne mit der lesenden Ansicht und
prüfe die Bindung an Agent/Workspace.

Generierte Record-Notizen enthalten technische Tags und verwaltete Blöcke.
Änderungen können Review-Vorschläge erzeugen; sie schreiben nicht beliebig in
die Datenbank zurück. Apply verlangt seine eigenen Bedingungen, darunter
Write-Modus, Bindung und gegebenenfalls Freigabe. Konflikte mit manuellen
Bearbeitungen müssen geprüft werden. Ein Checkbox-Text in einer generierten
Task-Notiz ist allein keine Freigabe einer Memory-Änderung.

## Modellwechsel und Wiederherstellung

Ein neues Embedding-Modell kann selbst bei gleicher Dimension einen anderen
Vektorraum erzeugen. Nutze den Re-Embedding-Ablauf mit Zielprobe, Plan,
Bestätigung, Aufbau einer neuen Generation und getrenntem Umschalten. Ein
fertiger Download ist noch keine aktive Migration; `ready_to_switch` ist noch
kein abgeschlossener Wechsel. Rerankerwechsel verändert keine Kartenvektoren.

Vor Wiederherstellung oder Eingriffen in Speicher einen Snapshot anlegen:

```bash
./scripts/backup-snapshot.sh
./scripts/restore-snapshot.sh /absolute/path/to/snapshot
```

Restore ist ohne `--confirm` eine Vorschau. Prüfe die betroffenen Pfade und den
Snapshot; erst die ausdrücklich bestätigte Ausführung schreibt zurück. Das
ersetzt keine koordinierte Prüfung des Gateway-Zustands und aller weiteren
Datenorte. Die Quelldateien dokumentieren ihre unterstützten Optionen:
[Backup](scripts/backup-snapshot.sh), [Restore](scripts/restore-snapshot.sh).

## Wenn etwas nicht stimmt

| Beobachtung | Nächster sinnvoller Nachweis |
| --- | --- |
| Karte vorhanden, aber kein Recall | Agent/Scope, Status, Epistemik, TTL, `validAt`, Embedding-Generation und endgültigen Prompt prüfen |
| Reranker aktiv, Reihenfolge unverändert | Globalen Merge prüfen; [bestätigter Befund](docs/known-issues.md#reranker-order-can-be-lost-during-global-merge) |
| Feature aktiv, Job fehlt | Rohkonfiguration, native Dispatch-Fähigkeit, Setup-Meldung und Cronliste prüfen |
| Neues Modell heruntergeladen, altes aktiv | Re-Embedding-Plan und getrennten Switch prüfen |
| Vault sichtbar, Änderungen wirken nicht | Zielbindung, Write-Modus, Freigabe und Apply-Ergebnis prüfen |
| Keine LLM-Zusatzanalyse | Feature-lokale Route, native Trust-Bits und Diagnosestatus prüfen |

Weitere Grenzen stehen in [Known issues](docs/known-issues.md). Die
[Systemerklärung](how-to-memory-perfect.md) beschreibt die Mechanismen hinter
diesen Bedienwegen.

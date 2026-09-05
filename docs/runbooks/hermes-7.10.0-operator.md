# Hermes 7.10.0: lokaler Operator

Dies ist die Bedienung des lokalen Port-Kandidaten, kein automatischer
Produktiv-Rollout. Vor Änderungen Datenbank/Retry-Queue sichern; tatsächliches
Hermes-Home und den vom Gateway verwendeten Agent-/Profilnamen prüfen.
Keine Modelle/Dimensionen eines gefüllten Stores direkt austauschen.

## Status / physische Kompaktierung

Nach Installation des Python-Pakets im gewählten Interpreter:

```sh
plur1bus-hermes-operator --hermes-home /ABSOLUTES/HERMES-HOME --agent PROFIL status
plur1bus-hermes-operator --hermes-home /ABSOLUTES/HERMES-HOME --agent PROFIL compact
plur1bus-hermes-operator --hermes-home /ABSOLUTES/HERMES-HOME --agent PROFIL compact --apply
```

Der zweite Befehl ist nur ein Dry-run. Der dritte optimiert physische
LanceDB-Fragmente; er ist keine semantische Memory-GC und kein Restore-Ersatz.
Die CLI ist eine lokale OS-Operator-Oberfläche, kein Chat-Tool.

## Re-Embedding: immer separat, nie automatisch aktiv

`target-embedding.json` enthält nur die gewünschte Embedding-Konfiguration
(provider, model, dimensions, ggf. baseUrl/apiKeyEnv), keine `fallback`-Route.
Verwende ein separates, mit dem gewählten Modell getestetes Ziel. Credentials
vorzugsweise über Env, nicht über CLI/Dateien weitergeben.

```sh
plur1bus-hermes-operator --hermes-home /ABSOLUTES/HERMES-HOME --agent PROFIL reembed --target-embedding target-embedding.json > plan.json
plur1bus-hermes-operator --hermes-home /ABSOLUTES/HERMES-HOME --agent PROFIL reembed --target-embedding target-embedding.json --plan plan.json --apply --batch-size 100
plur1bus-hermes-operator --hermes-home /ABSOLUTES/HERMES-HOME --agent PROFIL reembed --target-embedding target-embedding.json --plan plan.json --validate
```

`--apply` macht genau einen Batch; mit demselben Plan wiederholen. Exit-Code
und JSON jedes Schrittes prüfen. Plan verweigert leere Quellen. Eine Änderung
an Quelle oder Zielkonfiguration erfordert einen neuen Plan. Bei Crash zwischen
DB-Write und Checkpoint wird die Diskrepanz gesperrt, nicht blind resubmitted.
Die Writes sind gebatcht; Inventar/Quell-Fingerprint lesen derzeit die komplette
Quelltabelle (kein vollständig speicherbegrenzter Scanner). Keine automatische
Bereinigung fehlgeschlagener Stages. Fertige Stages sind **nicht aktiv**.

## Optionales Dashboard

Im ausgewählten Checkout:

```sh
bash scripts/install-hermes-plugins.sh --hermes-home /ABSOLUTES/HERMES-HOME --dashboard --no-retrieval
```

Der normale Installer installiert/konfiguriert den Provider. Für reine
Dateiaktualisierung `--no-setup` ergänzen; `--no-deps` setzt bereits vorhandene
Python-Pakete im gewählten Interpreter voraus. Dashboard landet unter
`plugins/plur1bus/dashboard`, **nicht** unter `dashboard-plugins`.
Backend benötigt `hermes plugins enable plur1bus` im gewählten Home sowie einen
Neustart des Dashboard-Servers. `--no-setup` nimmt diese Aktivierung nicht vor.
Keine Browser-Mutationsaktionen; Status ist Konfigurations-/Speicherstatus,
kein erfolgreich ausgeführter Embedding-Probe-Request.

## Critical-Review

```text
/plur1bus critical accept REF1 REF2
/plur1bus critical reject all
```

Bestehende Controls-Autorisierung und gebundene Bestätigung bleiben maßgeblich.
Natürlichsprachige Antworten auf zitierte Pushes sind noch nicht angeschlossen.
`all` meint den aktuellen autorisierten Pending-Scope, nicht fremde Agenten.

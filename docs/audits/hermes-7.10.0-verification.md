# Hermes 7.10.0 – lokale Verifikation

Datum: 2026-09-05. Ergebnis: **nativer Port lokal geprüft, vollständige
Upstream-Parität/Produktivfreigabe noch nicht erreicht**. Siehe Vertragsmatrix.

| Prüfung | Ergebnis |
| --- | --- |
| Hermes Python unittest discovery | 315 Tests bestanden, 0 Fehler |
| Controls unittest discovery | 2 bestanden |
| MTPLX-Embed unittest discovery | 9 bestanden |
| Native Dashboard-/Installer-Tests | 8 bestanden |
| Installer Shell-Suiten | 3 bestanden: Home-Auswahl, Hauptplugin/Sidecar-Fehler, Retrieval-Installer |
| Node gesamte Suite | 4.455 Tests, 4.365 bestanden, 18 Fehler, 72 skipped; 783 Suites |
| Unveränderter Upstream, sechs betroffene Testdateien | dieselben 18 Fehler reproduziert, 88 bestanden, 1 skipped |
| Release-/Host-Kompatibilitätsmetadaten | 5 Node-Tests bestanden |
| npm run lint / Dashboard JS syntax | bestanden |
| npm audit --audit-level=moderate | 0 Vulnerabilities |
| git diff --check | bestanden |

Die Node-Fehler betreffen unveränderten Upstream: Abstract-UNIX-Sockets und
Directory-Capabilities unter macOS sowie `/var`-vs-`/private/var`-Testannahmen.
Sie wurden weder als Skip umetikettiert noch durch Änderungen am JS versteckt.
Die gesamte JavaScript-Suite ist deshalb ausdrücklich **nicht grün**.

Native Integration verwendet reale LanceDB 0.34.0 in temporären Verzeichnissen:
physische Optimize-Operation mit Zeilenerhalt, scope-gefilterter Status sowie
Staging mit ACL-Struct-/Arrow-Schema-Erhalt. Embedding-Aufrufe in Tests sind
Mocks; kein Nachweis der Qualität oder Erreichbarkeit eines Live-Modells.

Das Dashboard wird mit den tatsächlichen Hermes-0.21-Discovery-/Mount-Funktionen
geprüft. Installation erfolgte ausschließlich im temporären Test-Home, einschließlich
Asset-Pfad und aufgezeichneter Backend-Aktivierung. Kein visueller UI-Smoke-Test.

## Wiederholbare native Gates

Im isolierten Checkout mit dem passenden Hermes-Interpreter:

```sh
export PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src:mtplx-embed/src
python -m unittest discover -s plur1bus-hermes/tests
python -m unittest discover -s plur1bus-controls/tests
python -m unittest discover -s mtplx-embed/tests
python -m unittest discover -s hermes-dashboard/tests
bash mtplx-embed/tests/test-hermes-home.sh
bash mtplx-embed/tests/test-hermes-plugin-installer.sh
bash mtplx-embed/tests/test-installer.sh
npm run lint
npm audit --audit-level=moderate
git diff --check
```

`plur1bus-hermes-parity --strict` ist kein grünes Gate: Die neuen, noch offenen
Coverage-Verträge werden absichtlich separat und als unvollständig ausgewiesen.

Wheels und npm-Tarball werden lokal gebaut und auf native Module, Manifeste,
Dashboard-Assets sowie fehlende Cache-/Credential-Dateien geprüft. Sie sind
Build-Artefakte, keine Veröffentlichung oder Installationsbestätigung. Prüfsummen
liegen beim ausgelieferten Artefakt; Build-/Testlogs ebenfalls separat.

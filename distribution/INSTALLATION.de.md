# PLUR1BUS für Hermes installieren

## Verfügbarkeit und Geltungsbereich

**Ab 7.12.7-hermes.4:** Das macOS-PKG enthält den grafischen
Einrichtungsassistenten. Bei älteren Assets (einschließlich 7.12.7-hermes.3)
startet man nach dem PKG noch `Install PLUR1BUS.command` in
`/Applications/PLUR1BUS Installer`.

Stand **8. September 2026**: Diese Anleitung beschreibt
Hermes **7.12.7-hermes.4**. Portable Archive und Python-Wheels sind die
plattformübergreifenden Referenzartefakte. Native Installer sind separat nach
Architektur gekennzeichnet; Signatur und Notarisierung sind je Asset in der
Release-Beschreibung ausgewiesen.

Ältere Hermes-Releases enthalten andere Asset-Sätze. Diese Anleitung gilt nur
für die Assets des jeweiligen Release-Tags; GitHubs automatisch erzeugtes
„Source code“-ZIP ist kein fertiges Installationspaket.

Downloads ausschließlich unter [GitHub Releases](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases).
Ein CI-Artefakt oder diese Anleitung ist keine Release-Freigabe. Erst wenn das
entsprechende Hermes-Release veröffentlicht ist, die dort aufgeführten Assets
und deren Prüfsummen verwenden. GitHubs automatisch erzeugtes „Source code“-ZIP
ist ebenfalls **kein fertiges Installationspaket**.

## Welches Paket brauche ich?

`VERSION` steht nachfolgend für die tatsächlich veröffentlichte Hermes-Version.
Die Dateinamen in der Tabelle entsprechen den veröffentlichten oder im
Release ausdrücklich als optional gekennzeichneten Build-Artefakten.

| Zielsystem | Paket / Start | Voraussetzung und Grenze |
| --- | --- | --- |
| macOS Apple Silicon | `plur1bus-VERSION-macos-arm64.pkg` oder entsprechendes ZIP/TAR | Native ARM64-Hermes-Umgebung |
| Windows x64 | `plur1bus-VERSION-windows-x64-setup-unsigned.exe` oder entsprechendes ZIP | Native x64-Hermes-Umgebung; passende Microsoft-C++-Runtime für native Bibliotheken |
| Windows ARM64 | `plur1bus-VERSION-windows-arm64-setup-unsigned.exe` oder entsprechendes ZIP | Vorbereitete native CPython-3.13-Hermes-Umgebung, Standard-GIL; ARM-LanceDB **und** ARM-PyArrow im Paket |
| Linux x64 / ARM64 | `plur1bus-VERSION.tar.gz` oder ZIP, darin `install.sh` | Native Hermes-Umgebung derselben Architektur |
| WSL2 | Linux-Archiv und `install.sh` **innerhalb der Distribution** | Hermes samt Python innerhalb WSL; keine Windows-Python-Pfade verwenden |

Es gibt also native Installer-Builds. Sie installieren **PLUR1BUS in ein bereits
vorhandenes Hermes**, nicht Hermes selbst, und enthalten keine Modellgewichte.
Die `.exe` bringt Python für den Installationsassistenten mit; die eigentliche
Memory-Laufzeit verwendet weiterhin die ausgewählte Hermes-Python-Umgebung.
Die `.pkg` stellt den Assistenten bereit, aktiviert aber noch kein Profil.

`unsigned` bedeutet: keine Publisher-Signatur bzw. keine zugesicherte
Notarisierung. Prüfsummen ersetzen keine Signatur. Schutzmechanismen wie
Gatekeeper, SmartScreen oder Antivirus nicht global abschalten. Bei einer
Sperre Herkunft und Integrität prüfen und die eigene Sicherheitsrichtlinie
beachten; gegebenenfalls auf signierte Pakete warten.

## Vor jeder Installation

1. Hermes nach dessen [offizieller Anleitung](https://github.com/NousResearch/hermes-agent#readme)
   installieren und einmal einrichten. Hermes muss ohne PLUR1BUS starten können.
2. Tatsächliches Hermes-Home und dessen virtuelles Python-Environment bestimmen.
   Übliche Homes: macOS/Linux/WSL `~/.hermes`, Windows `%LOCALAPPDATA%\hermes`.
   Eigene Installationspfade und `HERMES_HOME` können davon abweichen.
3. Bestehende Konfiguration, Memory-Daten und Python-Environment sichern.
   Der Installer sichert geänderte Plugin-/Konfigurationsdateien, aber erstellt
   **kein vollständiges Backup der Python-Abhängigkeiten**.
4. Passendes Paket und die zugehörigen veröffentlichten Prüfsummen herunterladen.
   Vor dem Entpacken/Start abgleichen:

   ```sh
   # macOS: Ausgabe mit dem Eintrag im veröffentlichten SHA256SUMS vergleichen
   shasum -a 256 /Pfad/zum/Paket.zip
   # Linux/WSL
   sha256sum /Pfad/zum/Paket.tar.gz
   ```

   ```powershell
   # Windows: Hash mit dem veröffentlichten Eintrag vergleichen
   Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\Pfad\zum\Paket.zip'
   ```

5. Vor dem bestätigten Schreibschritt Desktop, Gateway, CLI-Sitzungen und
   Hintergrundjobs stoppen, die die betroffenen Daten oder das gemeinsame
   Hermes-Environment verwenden. Als normaler Hermes-Benutzer arbeiten, nicht
   den PLUR1BUS-Assistenten pauschal mit `sudo`/als Administrator starten.

## macOS: Apple Silicon

Der neue grafische Assistent benötigt macOS 13 oder neuer auf Apple Silicon.
Die Einrichtung hat zwei klar getrennte Schritte:

1. **PKG öffnen und installieren.** Der Apple-Installer legt die App
   **PLUR1BUS einrichten** unter Programme ab. Start- und Abschlussseite weisen
   ausdrücklich darauf hin: Noch kein Hermes-Profil wurde eingerichtet.
2. **Programme → PLUR1BUS einrichten öffnen.** Kein Terminal nötig:
   - Hermes-Home bestätigen oder über die Ordnerauswahl wählen; **Profile erkennen** klicken.
   - Alle vorhandenen Profile sind vorausgewählt. Alternativ **Nur Standardprofil
     (default)** klicken oder einzelne Profile an-/abwählen. Aktivierungsstatus
     und unvollständige Aktivierungen werden pro Profil angezeigt.
   - **PLUR1BUS aktivieren** ist vorausgewählt. Dies setzt den Memory-Provider
     und aktiviert Hauptplugin, Dashboard und Controls. Abwählen bedeutet
     ausdrücklich „nur Dateien installieren“, nicht „PLUR1BUS verfügbar machen“.
   - **Installationsplan prüfen**, konkrete Profile kontrollieren, betroffene
     Hermes-Laufzeiten beenden und **Jetzt installieren und aktivieren** klicken.
   - Erfolgsmeldung abwarten und Hermes neu starten. Modelle/Zugangsdaten werden
     nicht automatisch eingerichtet; bestehende Modelle und Erinnerungen bleiben erhalten.

**Die Auswahl ist im grafischen PLUR1BUS-Assistenten, nicht auf Apples
PKG-Komponentenseite.** Er läuft als normaler Benutzer und verändert kein
erratenes Benutzerprofil aus einem privilegierten PKG-Skript heraus.
Für später angelegte Profile denselben Assistenten erneut öffnen. Die Auswahl
„alle“ gilt nur für die konkret aufgelisteten, bestehenden Profile.

Alternativ das zur Architektur passende ZIP/TAR in einen neuen Ordner entpacken,
im Terminal in den enthaltenen Ordner `plur1bus-VERSION` wechseln und starten:

```sh
sh ./install.sh
```

Dieses Release bietet keine Intel-Mac-Edition. Keine unter Rosetta laufende
Python-Umgebung als native Apple-Silicon-Installation verwenden.

## Windows x64

Die passende `...windows-x64-setup-unsigned.exe` als normaler Benutzer öffnen.
Sie startet einen **Terminalassistenten**, keinen vollständig grafischen Wizard.

Alternative ohne `.exe`: ZIP vollständig entpacken, PowerShell im enthaltenen
Ordner öffnen und den Installer direkt mit dem vorhandenen Hermes-Python starten:

```powershell
# Beispiel für das Standard-Home; bei anderer Installation anpassen.
$HermesPython = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\python.exe'
& $HermesPython .\installer.py --interactive
```

Damit ist keine Änderung der PowerShell-ExecutionPolicy nötig. `install.ps1`
ist ein zusätzlicher Launcher, wenn lokale Richtlinien dessen Start erlauben.

Bei `WinError 1114`, `c10.dll` oder ähnlichen nativen Ladefehlern zunächst den
Import im **betroffenen** Python prüfen und die
[offizielle Microsoft Visual C++ Runtime](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)
kontrollieren. Der Fehler allein beweist keine einzelne Ursache. Keine DLLs von
Download-Sammelseiten beziehen und nicht blind Torch downgraden. Nach einer
Reparatur den Plan neu erstellen und die vollständige Installation erneut prüfen.

## Windows ARM64

Das native ARM64-Paket verwenden, nicht die x64-Ausgabe unter Emulation.
Aktuell benötigt der native Weg eine **bereits eingerichtete Hermes-Umgebung
mit CPython 3.13 ARM64 und Standard-GIL**. Der Installer erzeugt dieses Environment
nicht und ersetzt kein vorhandenes x64-Python automatisch.

Im Assistenten den tatsächlichen ARM64-Interpreter explizit angeben, beispielsweise
`C:\Users\NAME\AppData\Local\hermes\hermes-agent\venv-arm64\Scripts\python.exe`.
Im Plan müssen Architektur und Interpreter stimmen; unter `nativeWheels` müssen
die beiden geprüften ARM-Pakete für **LanceDB 0.34.0** und **PyArrow 25.0.1** stehen.
Ein unqualifiziertes portables Archiv ohne diese Wheels ist dafür kein Ersatz.

Für lokale Inferenz ONNX oder alternativ einen unterstützten Remote-Provider
einrichten. Eine passende Torch-Installation wird hier nicht automatisch erzeugt.
Ein optionaler separater ARM-Desktop-Launcher ist im
[technischen Installer-Handbuch](README.md#additional-native-windows-arm-desktop-launcher)
beschrieben. Auch dieser setzt einen bereits vorhandenen ARM64-Hermes-Desktop
voraus. Eine vollständig automatische Hermes-ARM-Neuinstallation wird nicht versprochen.

## Linux und WSL2

Archiv in einen neuen Ordner auf dem Linux-Dateisystem entpacken. Im enthaltenen
Ordner `plur1bus-VERSION` ausführen:

```sh
sh ./install.sh
```

Hermes-Python benötigt mindestens Version 3.11 und passende native Abhängigkeiten.
Bei frischem Linux-x64-Environment zeigt der Plan eine CPU-Torch-Installation;
eine bestehende Torch-Ausgabe wird erhalten. ARM64 benötigt die für seine
Architektur verfügbaren Abhängigkeiten. Ein erfolgreicher x64-Test ist kein
ARM64-Nachweis.

In WSL gehört das Backend samt venv und Memory-Daten ins Linux-Dateisystem,
nicht in einen Windows-Python-Ordner. Für einen zusätzlichen Windows-Desktop
im dortigen Assistenten **Desktop UI only** auswählen. Das kopiert nur die
Oberfläche: Backend, Provider-Aktivierung und Modellkonfiguration müssen separat
innerhalb WSL eingerichtet werden. Ein funktionierender, profilrichtig
verbundener Hermes-Backend-Endpunkt ist weiterhin Voraussetzung. Für Hermes
ist kein `npm install` des OpenClaw-Plugins erforderlich.

## Die Fragen des Assistenten

1. **Hermes root home:** vorhandenes Home auswählen, nicht das entpackte Paket.
2. **Install for which profiles:** `all` für alle bestehenden Profile ist im
   neuen Terminalassistenten vorausgewählt. Alternativ `default` oder ein
   vorhandenes benanntes Profil eingeben. Es werden keine Profile angelegt.
3. **Desktop UI only:** normalerweise Nein; Ja nur für die getrennte Oberfläche
   eines bereits separat betriebenen WSL-/Remote-Backends.
4. **Hermes venv Python executable:** tatsächliches passendes venv-Python wählen.
5. **Operation:** `install` für Paketinstallation; Modellwechsel ist ein anderer Vorgang.
6. **Install AND activate PLUR1BUS:** Ja ist im neuen Terminalassistenten
   vorausgewählt (`Y/n`). Nein installiert nur Dateien und erhält die bisherige
   Aktivierung. Ein widersprüchlicher Provider-/Plugin-Status wird im Plan gewarnt.
7. Plan auf Version, Home, Profile, Architektur und Abhängigkeiten prüfen.
   Erst nach Stoppen der betroffenen Laufzeiten `INSTALL` eingeben.

Pip-Abhängigkeiten können von mehreren Profilen gemeinsam genutzt werden, auch
wenn die Plugin-Dateien profilbezogen installiert werden. Fehlgeschlagene
Abhängigkeitstests nicht mit `--no-deps` übergehen. Erfolgreiche Installation
meldet den Backup-/Receipt-Pfad. Danach Hermes selbst neu starten.

## Nachkontrolle, Modelle und Wiederherstellung

- In jedem aktivierten Profil PLUR1BUS öffnen, Profil-/Agent-Identität prüfen,
  Seite aktualisieren und zwischen Profilen wechseln. Je nach Hermes-Version
  ist die Navigation über Sidebar, Statusleiste oder Befehlspalette erreichbar.
- Bei fehlender Oberfläche **PLUR1BUS: Desktop-Kompatibilität prüfen** aufrufen.
  Ein inkompatibles Hermes-Binary bekommt durch Paketinstallation nicht
  automatisch eine neue Sidebar-API; das technische Handbuch beschreibt den
  separat bestätigten Host-Build. Keine fremden Patches blind einspielen.
- Mit einer harmlosen Test-Erinnerung tatsächlich **Speichern und Abrufen**
  prüfen. Ein erfolgreiches Speichern/Queueing allein belegt noch keinen Capture.
- Embedding-/Reranking-Provider werden durch das Paket nicht automatisch
  gewechselt. Modellgewichte und gegebenenfalls Zugangsdaten/Lizenzzustimmung
  sind separat erforderlich. Neue, noch uninitialisierte Stores sind nicht mit
  einem funktionsfähigen Recall gleichzusetzen.
- Unter **Provider & Dimensionen** Änderungen erst planen und bestätigen.
  Embedding-Wechsel benötigen Re-Embedding, auch bei gleicher Dimension.
  Vorhandene Daten nicht durch eine leere Datenbank ersetzen. Remote-Migration
  überträgt Memory-Inhalte und kann Kosten verursachen.
- Bei Fehlern das Journal unter `<Hermes-Home>/plur1bus-install-backups/`
  sichern und prüfen. Dateibackups rollen keine pip-Änderungen oder späteren
  Memory-Migrationen zurück. Details zu Plan, Staging, Aktivierung und Rollback
  stehen im [technischen Installer-Handbuch](README.md).

Die Release Notes sind maßgeblich für die **tatsächlich getesteten** Plattformen,
bekannte Einschränkungen und verfügbare Assets. CI-Erfolg, Installation,
Oberflächentest und realer Modellbetrieb sind getrennte Prüfschritte.

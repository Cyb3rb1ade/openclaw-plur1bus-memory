# Extensions v5.2.11 Staging Follow-up

## Zusammenfassung

`extensions/memory-lancedb-namespaced/` ist eine gepackte v5.2.11-Staging-Kopie der PLUR1BUS Memory-Erweiterung. Sie liegt parallel zur aktiven Root-Source (`index.js`, `lib/`, `scripts/`, `tests/`) im Repository und dient ursprünglich als Auslieferungsartefakt für native OpenClaw-Installationen.

Die Kopie driftet gegenüber der Root-Source. Die darauf ausgeführte Test-Suite meldet **8 fehlgeschlagene Tests** bei insgesamt 244 Tests.

## Testergebnis

Befehl:

```bash
node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js
```

Ergebnis:

- **244** Tests gesamt
- **236** bestanden
- **8** fehlgeschlagen

## Fehler und Ursachen

### 1. `manifest-schema.test.js` — Plugin-Paket nicht selbstenthalten

**Test:** `plugin package is self-contained for native OpenClaw install`

**Failure:** `package.json` listet `LICENSE` in `files`, der Test erwartet die Datei aber nicht in der Liste.

**Ursache:** Die Staging-Kopie enthält ein `LICENSE`-File, das in `package.json` referenziert wird; der Test wurde offenbar vor Einführung der Lizenzdatei geschrieben und nicht aktualisiert.

### 2. `manifest-schema.test.js` — Manifest-Version

**Test:** `manifest declares disabled-by-default Obsidian bridge config`

**Failure:** Manifest-Version ist `5.2.11`, Test erwartet `5.1.0`.

**Ursache:** Die gepackte Extension wurde auf `5.2.11` hochgezogen; der hartcodierte Vergleich im Test passt nicht.

### 3. `obsidian-control-room.test.js` — Bundle-Cooldown

**Test:** `bundle cooldown is opt-in and returns an explicit skipped summary`

**Failure:** Die Zusammenfassung enthält keinen Hinweis auf `Pause` bzw. keinen deutschen Cooldown-Text.

**Ursache:** Das Bundle-Cooldown-Feature wurde in der Root-Source implementiert, ist in der Staging-Kopie aber entweder nicht vollständig vorhanden oder die deutsche Übersetzung/Formatierung weicht ab.

### 4. `plugin-registration.test.js` — Fehlende PLUR1BUS-Commands

**Test:** `plugin registers without embedding secrets for inspect and doctor flows`

**Failure:** Registrierte Commands sind `plur1bus`, `plur1bus_status`, `plur1bus_doctor`, `plur1bus_dashboards`, `plur1bus_conflicts`. Es fehlen `plur1bus_morning`, `plur1bus_evening`, `plur1bus_review`, `plur1bus_cron`.

**Ursache:** Review- und Cron-Commands wurden in der Root-Source ergänzt, in der Staging-Kopie aber noch nicht integriert.

### 5. `plugin-registration.test.js` — Hilfetext für `/plur1bus`

**Test:** `plugin returns PLUR1BUS command help for bare /plur1bus`

**Failure:** Der Hilfetext enthält keine Hinweise auf `/plur1bus_review approve low-risk`, `/plur1bus_review quickapply`, `/plur1bus_morning` oder Bundle-IDs.

**Ursache:** Der Help-Text der Staging-Kopie enthält nur die Legacy-Shortcuts (`/memory`, `/vergiss`, `/korrigier`, `/zustand`, `/einschalten`, `/ausschalten`).

### 6. `plugin-registration.test.js` — Telegram-Shortcut `/plur1bus_morning`

**Test:** `plugin routes PLUR1BUS Telegram shortcuts through the same command layer`

**Failure:** `TypeError: Cannot read properties of undefined (reading 'handler')` — der Command `plur1bus_morning` existiert nicht.

**Ursache:** Wie Punkt 4: Review/Cron-Commands fehlen in der Staging-Kopie.

### 7. `plugin-registration.test.js` — Cron pre-execution Hook (Einzel-Agent)

**Test:** `plugin pre-executes PLUR1BUS cron review prompts before model inference`

**Failure:** `TypeError: Cannot read properties of undefined (reading 'appendContext')` — der `agent_turn_prepare`-Hook fehlt oder liefert kein Ergebnis.

**Ursache:** Die Cron-Pre-Execution-Logik (`agent_turn_prepare`) wurde in der Root-Source hinzugefügt, um Morgen-/Abend-Reviews vor dem Model-Run auszuführen. Sie ist in der Staging-Kopie nicht vorhanden.

### 8. `plugin-registration.test.js` — Cron pre-execution Hook (alle Agents)

**Test:** `plugin pre-executes PLUR1BUS cron review prompts for all configured agents`

**Failure:** `TypeError: Cannot read properties of undefined (reading 'appendContext')` — derselbe fehlende Hook wie Punkt 7.

**Ursache:** Siehe Punkt 7.

## Empfehlung

Die Kopie sollte **nicht mehr als Teil der Standard-Verifikation** betrachtet werden, solange sie nicht aktiv gewartet wird. Drei Optionen stehen zur Debatte:

| Option | Beschreibung | Einschätzung |
|--------|--------------|--------------|
| **(a) Aus Standard-Verifikation entfernen** | Extension-Tests nicht mehr im CI-Lauf ausführen; ggf. explizit dokumentieren, dass die Kopie veraltet ist. | **Bevorzugt**, wenn kein aktuelles Native-Install-Paket benötigt wird. |
| **(b) Archivieren** | `extensions/memory-lancedb-namespaced/` in ein Archiv-Verzeichnis verschieben oder als Referenz markieren. | Sinnvoll, wenn historische Verpackung erhalten bleiben soll. |
| **(c) Explizit aktualisieren** | Kopie mit der Root-Source synchronisieren, Tests anpassen und wieder grün bekommen. | Aufwändig; nur sinnvoll, wenn Native-OpenClaw-Install weiterhin unterstützt werden soll. |

**Primäre Empfehlung:** Option **(a)** kurzfristig umsetzen (Tests aus der Standard-Pipeline nehmen), Option **(b)** oder **(c)** in einem separaten Release-Plan entscheiden.

## Konkrete Blocker, falls die Kopie im Repo verbleibt

1. **Manifest-Version** muss konsistent gepflegt oder der Test angepasst werden.
2. **LICENSE** muss entweder aus `package.json` entfernt oder im Test als erwartet markiert werden.
3. **Review/Cron-Commands** (`plur1bus_morning`, `plur1bus_evening`, `plur1bus_review`, `plur1bus_cron`) müssen implementiert werden.
4. **Hilfetext** für `/plur1bus` muss die neuen Commands abbilden.
5. **`agent_turn_prepare`-Hook** für Cron-Pre-Execution muss implementiert werden.
6. **Bundle-Cooldown** muss vollständig implementiert und lokalisiert werden.
7. **Synchronisationsprozess** etablieren, damit die Staging-Kopie nicht erneut driftet.

## Nächste Schritte

- Entscheidung treffen, ob Native-OpenClaw-Install weiterhin über diese gepackte Extension erfolgen soll.
- Falls ja: Zeitplan für Synchronisation mit Root-Source erstellen.
- Falls nein: Kopie archivieren oder aus Standard-Verifikation nehmen und in `AGENTS.md` / Release-Checkliste dokumentieren.

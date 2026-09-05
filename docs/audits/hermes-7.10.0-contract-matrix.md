# PLUR1BUS 7.10.0 → Hermes: Machbarkeit und umgesetzter Stand

Stand: 2026-09-05. **Lokaler Port, keine Veröffentlichung und keine Live-Installation.**

**Nachtrag:** Diese ursprüngliche Matrix war für eine Vollständigkeitsbewertung zu eng. Für anschließende Implementierungen und verbleibende Lücken gilt [der Implementierungsnachtrag](hermes-7.10.0-implementation-followup.md). `parity.py` meldet weiterhin ausdrücklich partielle Abdeckung.

Der jüngste Implementierungsstand (Workshop, Merge, native kognitive Jobs und
Gateway-Antworten) steht in [Native Workflows](hermes-7.10.0-native-workflows.md).
Die weiter unten genannten 18 Node-Fehler dokumentieren die ursprüngliche
Upstream-Baseline vor den nachfolgend übernommenen macOS-Korrekturen.

## Geprüfte Basis

- Upstream: `v7.10.0`, Commit `b4138df52781b6d51bc2baa0659e67325dbd5fa9`.
- Native Ausgangsbasis: `7.4.8-hermes.1`, Commit `e65528f1cab9c16f8a6020a3cbd90c8a2a44f9d2`.
- Hermes: lokal inspizierte 0.21.0, Commit `f58fcc8118d9db092ad60d363d4a28520e08ac5a`.
- Native Tests: vorhandener Hermes-Python-Interpreter; LanceDB 0.34.0. Keine Pakete in dieses Venv installiert.
- Umsetzung durch drei Terra-Subagents und Root-Integration/Review. Luna war in der Subagent-Schnittstelle nicht verfügbar.

7.10.0 selbst ändert vor allem die Empfehlung für den lokalen BGE-Reranker.
Der erhebliche Gesamtunterschied gegenüber dem letzten Hermes-Port liegt in
7.5–7.9: SDK-/Host-Integration, Bedienoberflächen, Re-Embedding und Critical-Review.
Das JavaScript basiert auf dem Upstream-Tag; zusätzlich sind die separaten
macOS-Korrekturen aus PR #131/#132 lokal in den Hermes-Branch übernommen.
Hermes verwendet die native Python-Implementierung, nicht diese JS-Host-Pfade.

## Vertragsmatrix

| Bereich | Auf Hermes möglich? | Tatsächlicher Stand dieses Ports |
| --- | --- | --- |
| Capture/Recall, Scope/ACL, Tombstones, Epistemik, Retry | Ja, nativ | Bestehende Python-Pfade und 7.4.8.1-Schemareparaturen übernommen; Regressionen erneut geprüft. Keine Behauptung einer zeilengleichen JS-Portierung. |
| Hermes MemoryProvider-Lifecycle | Ja | RecallStatus, Verfügbarkeitsgrund, Schutz vor internen Notifications/Subagent-Capture; Neuinitialisierung beendet alten Runtime-Besitz und sperrt späte alte Prefetch-Ergebnisse. |
| Critical `accept/reject REF…/all` | Ja | Erreichbar über bestehende autorisierte Controls. Vollständiger Pending-Snapshot im Scope, ID-Dedupe, Fehler je Karte, weitere Karten laufen weiter. |
| Keine Klassifikation inaktiver/gelöschter Karten | Ja | Native Klassifikationspfade filtern diese Karten; Regressionen enthalten. |
| Zitierte natürliche Antwort auf einen Critical-Push | Ja, mit vertrauenswürdigem Host-Metadatenvertrag | Gateway-Wiring prüft eigene Antwort, Host-Message-ID, Route, Agent/Scope, Autorisierung und neuesten Ledger-Zustand. Explizites Accept/Reject erzeugt Feedback erst nach erfolgreicher Änderung. Keine Autorität aus frei kopierten Zitaten. |
| BGE als lokale Reranker-Empfehlung | Ja | Native Python-BGE-Konfiguration beibehalten; bestehende Benutzerkonfiguration und Vektorräume werden nicht geändert. Der JS-ONNX-Modellname ist kein Python-Modellalias. |
| Remote OpenAI-v3-Embeddings | Ja | Angeforderte Dimensionen werden mitgeschickt und geprüft; explizites Key-Env wird nicht durch fremde Standard-Credentials ersetzt; nicht-endliche Vektoren werden nicht gecacht. |
| Jina v3 lokal mit Matryoshka | Technisch ja, weitere Implementierung/Audit erforderlich | **Nicht freigegeben.** Lizenz-/Dimensionsprüfungen vorhanden, danach expliziter Fehler vor Remote-Code-Import. Das Modell delegiert Code an ein separat versioniertes Repository. Kein scheinbar sicherer Modell-Hash-Pin. Bestehender optionaler Jina-Sidecar ist davon getrennt. |
| Semantic Lens / Continuity / Query Refinement | Ja, native Entsprechungen | Aktivierungsdefaults beibehalten; `false` und `{enabled:false}` werden respektiert, Graph-/ACL-Verhalten bleibt erhalten. Keine Behauptung identischer JS-Algorithmen. |
| Private Dream Diary | Ja | `run_dreaming` schreibt idempotenten Managed Block in privates `DREAMS.md`; nicht in User-/Chat-/Workspace-Diary. Manuelle Inhalte erhalten, Größen-/Marker-/Symlink-Schutz. Scoped JSONL-Dreams bleiben erhalten. |
| Operator-Dashboard | Ja, eigene Hermes-Erweiterung | Native **Read-only**-Seite: serverseitiges Profil/Agent-Mapping, scope-begrenzter Kartenstand, redigierte Retrieval-Konfiguration. Installer `--dashboard`, tatsächlicher Hermes-Discovery-/Mount-Vertrag getestet. Kein visueller Browser-Abnahmetest. |
| Physische LanceDB-Kompaktierung | Ja | Explizite lokale Operator-CLI, Dry-run als Default, Write nur `--apply`; echte LanceDB-Prüfung erhält Zeilen. Keine semantische Löschung/GC. |
| Re-Embedding planen / in Batches ausführen | Ja | Eigene Staging-Datenbank, Quellversion/-inhalt und Zielkonfiguration gebunden, Prozess-Lock, Schema-/ACL-Erhalt, Finite-/Dimensionsprüfung, Wiederaufnahme ohne doppelte Batch-Writes. CLI erreichbar. |
| Re-Embedding produktiv umschalten | Ja, aber noch nicht implementiert | **Kein aktiver Generation-Switch.** Staging berichtet immer `active:false`; Backup, Gateway-Quieszenz, Transaktion/Recovery und Runtime-Probe müssen einen separaten Switch-Vertrag bilden. |
| Skill-Miner / revision-bound Skill Workshop | Ja, nativ | Opt-in LLM-Verfahrensvorschläge, Inhalts-/Scope-Evidenzbindung, revisionsgebundenes Approve/Publish, kein Überschreiben manueller Skills. Veröffentlichung im Hermes-Skill-Verzeichnis ist profilweit sichtbar; darauf weist die separate Bestätigung hin. |
| Obsidian | Ja | Bestehende native Mirror-/Sync-/Graph-Funktionen erhalten. Neue Browser-Zielerkennung, Consent- und Operator-UI nicht vollständig nachgebildet. |
| Zeitgesteuerte Hintergrundjobs / Push | Teilweise native Entsprechung | CLI-/launchd-Jobs erhalten. Opt-in In-Process-Timer liefert nach autorisierter Routenregistrierung auch ohne weiteren Eingang; ein Kaltstart braucht zunächst einen neuen autorisierten Gateway-Event. Launchd bleibt macOS-spezifisch. |
| OpenClaw Memory-Slot, SDK, Cron-Ownership, iframe-Aktionen, Dream-Renderer | Nicht 1:1 im Hermes-Host | Upstream-JS vollständig enthalten, in Hermes nicht erreichbar. Funktionale Hermes-Neuentwicklungen wären möglich; keine Shims für interne OpenClaw-APIs. |

`plur1bus-hermes-parity` trennt die übernommene native Baseline von
`coverage710`. `--strict` schlägt bei den dokumentierten Lücken bewusst fehl.
Ein grüner Baseline-Test ist keine Behauptung vollständiger 7.10-Parität.

## Finales Root-Review

Vor Abschluss korrigiert: ACL-Alias-Verwechslung im Critical-Review; Batch-Abbruch
bei Einzelfehlern; Profil-/Agent-Verwechslung in Status/CLI; falsches Dashboard-
Installationsverzeichnis und fehlende Backend-Aktivierung; Runtime-Neuinitialisierung
mit veralteten Prefetch-Ergebnissen; manueller Recall-Aufruf nach dieser Änderung;
Staging-Plan-/Pfad-Manipulation, Symlink-Routen, Schema-Inferenz bei leeren ACL-
Structs, Konfigurationsdrift, Quelländerung während Inferenz und doppelte Writes.
Der unsichere Jina-Remote-Code-Ladepfad wurde nicht freigegeben.

## Nachweise und Grenzen

- Native Hermes-, Controls-, Sidecar-, Dashboard- und Installer-Tests: siehe
  `hermes-7.10.0-verification.md`.
- Vollständige Node-Suite: 4.455 Tests, 4.365 bestanden, 18 fehlgeschlagen,
  72 skipped, 783 Suites. Alle 18 Fehler in einem **unveränderten** Checkout
  von `v7.10.0` in den sechs betroffenen Dateien reproduziert (107 Tests:
  88 bestanden, 18 Fehler, 1 Skip). Ursachen: Linux-Abstract-UNIX-Sockets,
  nicht verfügbare stabile Directory-Capabilities und macOS-Realpath-Aliase.
- Kein Zugriff auf produktive Memory-Inhalte für Tests, keine Migration der
  Live-Datenbank, kein Gateway-Restart, kein neues Modell heruntergeladen.
- Keine neue GitHub-/npm-/ClawHub-Veröffentlichung, kein Tag, kein Push.
- Kein Nachweis automatischer Capture/Recall-Funktion in einer laufenden
  Hermes-Instanz: dafür ist eine gesonderte Sandbox-/Live-Abnahme nötig.

Quellen: [PLUR1BUS v7.10.0](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/tag/v7.10.0),
[Hermes Agent](https://github.com/NousResearch/hermes-agent),
[Jina v3 gepinnte Modellkonfiguration](https://huggingface.co/jinaai/jina-embeddings-v3/blob/ab036b023d30b4d1138c4c3bfa9f0c445ab455d6/config.json).

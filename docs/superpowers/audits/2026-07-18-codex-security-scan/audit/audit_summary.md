# Audit-Zusammenfassung — PLUR1BUS

**Snapshot:** 6dff096efe936f7ec3d0e11a8ba83bf08671ad4e  
**Modus:** Bug-, Feature- und Security-Audit ohne Änderungen an Produktcode oder Tests

## Entscheidung

Die geprüfte Version ist **nicht freigabereif ohne gezielte Nacharbeit**. Die Probleme liegen vor allem an drei wiederkehrenden Grenzen: langlebige Daten werden vor durabler Bestätigung verändert, Ownership/ACL wird nicht bis zum letzten Sink durchgetragen, und Betriebs-/Setup-Werkzeuge bilden ihren beworbenen Vertrag nicht vollständig ab.

Keine Empfehlung verlangt das Abschalten von Features. Semantic Lens, CRR, Neo, Obsidian, Wiki, Graph-Links, Multi-Namespace, Reranking und Wartung sollen erhalten bleiben; korrigiert werden Atomizität, Scope, Validierung, Diagnose und sichere Zustandsübergänge.

| Bereich | Bestätigter Stand | Primäre Details |
| --- | --- | --- |
| Bugs/Zuverlässigkeit | 3 hohe, 9 mittlere, 1 niedriger Kernbefund plus Addendum | [Bug-Audit](bug_audit.md), [Addendum](bug_audit_addendum.md) |
| Features | Kernpfade und additive Recall-Booster vorhanden; mehrere Verträge nur teilweise end-to-end | [Feature-Audit](feature_audit.md), [Addendum](feature_audit_addendum.md) |
| Security | 16 reportierbare Befunde (1 hoher Dependency-Befund, 10× P2, 5× P3); 48 klar dokumentierte Deferreds | [Security-Audit](security_audit.md) |

## Empfohlene Reihenfolge

1. Datenverlust verhindern: /forget und /correct reparieren, Merge store-before-delete machen, Capture-Timeouts wirklich serialisieren, Auto-Capture-Checkpoints erst nach Persistenz schreiben.
2. Scope- und ACL-Grenzen schließen: Wiki, Graph-Hydration, Recall/Rerank und alle Workspace-/Owner-abhängigen Mutationen mit demselben Context absichern.
3. Obsidian/Dateioperationen robust machen: zentralisierte Mutation Policy, sichere Symlink-Behandlung, bestätigte Bundle-Ownership.
4. Konfiguration/Installer feature-erhaltend machen: Preserve respektiert explizites enabled:false, Safe-Profil aktiviert nichts implizit, ungültige Werte schalten Funktionen nicht still ab.
5. Betriebswerkzeuge zu ehrlichen doctor → plan → apply → verify-Flows ausbauen, inklusive Rollback und Endzustandsprüfung.

## Unverhandelbare Regressionen

- Jede Security-Korrektur testet blockierten Fremdzugriff und erfolgreichen legitimen Owner-/Shared-Zugriff.
- Jede mutierende Pipeline testet Fehler zwischen Persistenzschritten sowie Restart/Retry/Parallelität.
- Jeder Dry-run garantiert unveränderte Inhalte und mtimes.
- Jede Pfadfunktion testet vorhandene und nicht vorhandene Ancestor-Symlinks.

## Frische Abschlussverifikation

- node --test --test-concurrency=1 tests/*.test.js: 2.386 bestanden, 0 fehlgeschlagen, 1 erwarteter Skip; Laufzeit 363.068 ms.
- npm audit --omit=dev --audit-level=high: 3 hohe Abhängigkeitsmeldungen in der optionalen Transformers-/ONNX-Kette; siehe [npm_audit_20260718.md](npm_audit_20260718.md).
- Produkt-Worktree: unverändert auf 6dff096efe936f7ec3d0e11a8ba83bf08671ad4e.

## Artefakte

Die vollständigen Audit-Receipts liegen außerhalb des Produkt-Worktrees unter diesem Scan-Root. Der Git-Worktree selbst muss bei der Übergabe unverändert und sauber bleiben.

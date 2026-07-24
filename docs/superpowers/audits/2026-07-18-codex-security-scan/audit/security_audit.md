# Security-Audit — PLUR1BUS

**Repository:** /root/openclaw-plur1bus-memory  
**Snapshot:** 6dff096efe936f7ec3d0e11a8ba83bf08671ad4e  
**Datum:** 2026-07-18  
**Arbeitsmodus:** Read-only; keine Produkt- oder Testdatei verändert

## Ergebnis

Die Repository-Prüfung schließt **72** einzeln nachverfolgbare Security-Kandidaten ab. Davon sind **16 reportierbar**: ein hoher Abhängigkeitsbefund, zehn mittlere (P2) und fünf niedrige (P3) Befunde. Acht technisch bestätigte Installer-/Deploy-Defekte wurden wegen fehlendem belegten Cross-Principal-Pfad im untersuchten Threat Model als **suppressed / ignore** kalibriert. Die übrigen **48** Kandidaten bleiben mit statischer Trace und expliziter Proof-Gap als **deferred** erhalten, statt fälschlich als behoben oder widerlegt zu gelten.

Alle Korrekturempfehlungen sind feature-erhaltend: legitim autorisierte Wiki-, Graph-, Recall- und Vault-Flows bleiben möglich; ergänzt werden Ownership-, Lifecycle- und Containment-Prüfungen am jeweiligen Sink.

## Reportierbare Befunde

| ID | Schwere | Belegter Pfad | Feature-erhaltende Korrektur |
| --- | --- | --- | --- |
| [SEC-01](../artifacts/05_findings/cand-acl-missing-ownership-fail-open/attack_path_analysis_report.md) | P2 | Graph-Hydration verliert Eigentumsfelder; die ACL akzeptiert eine fremde Workspace-Row. | Eigentumsbindung vor ACL vollständig erhalten; fehlende Bindung quarantänen/fail-closed behandeln. |
| [SEC-02](../artifacts/05_findings/cand-pattern-pre-acl-cross-scope/attack_path_analysis_report.md) | P2 | Ein fremder Recall-Kandidat erreicht den Reranker vor dem finalen ACL-Filter. | ACL vor jedem externen Reranker/Provider anwenden; normale Recall-Rangfolge beibehalten. |
| [SEC-03](../artifacts/05_findings/cand-wiki-add-duplicate-cross-scope-disclosure/attack_path_analysis_report.md) | P2 | Wiki-Add rendert die Summary/Textvorschau eines fremden Similarity-Treffers. | Duplicate-Kandidaten vor Antwort mit Record-ACL und memoryKind=wiki filtern. |
| [SEC-04](../artifacts/05_findings/cand-wiki-delete-id-missing-record-acl/attack_path_analysis_report.md) | P2 | Wiki-Delete per UUID archiviert und löscht eine fremde Workspace-Row trotz direkter ACL-Ablehnung. | Vor Archiv/Delete den bereits gebauten ACL-Kontext durchsetzen; archive-first beibehalten. |
| [SEC-05](../artifacts/05_findings/cand-wiki-delete-query-missing-record-acl/attack_path_analysis_report.md) | P2 | Wiki-Delete per Query findet und mutiert einen fremden einzelnen Treffer; Mehrdeutigkeit kann Metadaten zeigen. | Suchresultate vor Auswahl, Anzeige, Archiv und Delete per ACL filtern. |
| [SEC-06](../artifacts/05_findings/cand-graph-constellation-symlink-write/attack_path_analysis_report.md) | P3 | Ein Vault-Verzeichnis-Symlink lenkt den Graph-Report-Schreibpfad nach außerhalb des Workspaces. | Realpath-/No-follow-Containment am Zielwriter; Graph-Report-Funktion bleibt verfügbar. |
| [SEC-07](../artifacts/05_findings/cand-vault-task-cleanup-symlink-delete/attack_path_analysis_report.md) | P3 | Gateway-Start-Cleanup folgt einem Task-Ordner-Symlink und löscht passende Dateien außerhalb des Vaults. | Task-Verzeichnis vor Scan/Unlink canonicalisieren und Symlinks ablehnen; Cleanup bleibt aktiv. |
| [SEC-08](../artifacts/05_findings/cand-wiki-search-inactive-fallback-disclosure/attack_path_analysis_report.md) | P3 | Der Legacy-/Error-Fallback der Wiki-Suche kann superseded/archivierte Rows zurückgeben. | Den active/null-Lifecycle-Filter im Fallback wiederholen; Kompatibilitätsfallback behalten. |
| [SEC-09](../artifacts/05_findings/cand-destructive-audit-log-symlink-write/attack_path_analysis_report.md) | P3 | Ein Workspace-Symlink lenkt den Audit-Log-Writer nach außerhalb des Workspace. | Audit-Parent und Zieldatei realpath/no-follow absichern; Log beibehalten. |
| [SEC-10](../artifacts/05_findings/cand-admzip-install-dos/attack_path_analysis_report.md) | Hoch, Dependency | Die optionale Local-Inference-Kette lockt adm-zip 0.5.17, das laut GHSA-xcpc-8h2w-3j85 beim Installieren eines manipulierten ZIPs Speicher erschöpfen kann. | Kompatibilitätsgetestetes Upgrade der Transformers-/ONNX-Kette; Local Inference nicht abschalten. |
| [SEC-11](../artifacts/05_findings/cand-obsidian-dryrun-auth-bypass/attack_path_analysis_report.md) | P2 | Dry-run-Token unterdrücken den Auth-Gate, obwohl widersprüchliche Flags weiterhin einen mutierenden Handler erreichen können. | Erst Berechtigung, dann eine zentral durchgesetzte MutationPolicy; echte Dry-runs nur planen. |
| [SEC-12](../artifacts/05_findings/cand-chat-read-auth-bypass/attack_path_analysis_report.md) | P2 | Ein nicht allowlisteter Chat-Teilnehmer kann über einen registrierten Read-Pfad agent-private Wiki-Daten lesen. | CheckAuth vor jeder sensitiven Read-Antwort; ACL bleibt zusätzlich aktiv. |
| [SEC-13](../artifacts/05_findings/cand-light-dream-cross-scope-strengthening/attack_path_analysis_report.md) | P3 | Light Dreaming verstärkt in einem Workspace eine semantisch passende victim-owned Row eines anderen Workspace. | Kandidaten vor Dynamics-Update auf denselben autorisierten Scope filtern. |
| [SEC-14](../artifacts/05_findings/cand-neo-agent-private-cross-agent-recall/attack_path_analysis_report.md) | P2 | Zwei Agents im selben Neo-Workspace können agent_private Records gegenseitig routen und lesen. | Requester-Agent bei jedem Neo-Read erzwingen; Shared Scope bleibt explizit möglich. |
| [SEC-15](../artifacts/05_findings/cand-rem-dream-cross-workspace-leak/attack_path_analysis_report.md) | P2 | REM persistiert vertrauliche Workspace-B-Evidence als Workspace-A-Pattern. | REM-Scan, LLM-Input und Persistenz auf ACL-/Workspace-Scope beschränken. |
| [SEC-16](../artifacts/05_findings/cand-safe-update-workspace-binding-loss/attack_path_analysis_report.md) | P2 | /correct kann die Workspace-Bindung verlieren; die Ersatzrow wird für andere Workspaces sichtbar. | Alle Ownership-Felder bei safeUpdate erhalten und fehlende Bindung fail-closed behandeln. |

## Validierung und Grenzen

- SEC-01, SEC-02, SEC-06 und SEC-07 besitzen isolierte, reproduzierbare lokale Proofs unter den jeweiligen validation_artifacts-Verzeichnissen.
- SEC-03 bis SEC-05 nutzen einen benignen Public-Handler-Mock mit getrennten Workspace-/Owner-Kontexten; die direkte ACL verweigert jeweils die Row, der öffentliche Pfad zeigte dennoch die dokumentierte Wirkung.
- SEC-08 reproduziert den Fallback mit einer Builder-Variante ohne where(). Die primäre aktuelle LanceDB-Route filtert korrekt; deshalb P3, nicht P2.
- SEC-09 besitzt einen isolierten Original-Helper-Proof für die Symlink-Umleitung. SEC-11 bis SEC-16 nutzen vorhandene Public-Handler-, Workspace- oder Full-Run-Repros; ihre jeweiligen Boundary- und Gegenbeweise stehen in den Kandidatenakten.
- Der aktuelle Lauf von npm audit meldet für SEC-10 drei hohe Treffer. Das Lockfile hält adm-zip 0.5.17 über den optionalen Transformers-/ONNX-Pfad; die GitHub Advisory Database nennt 0.6.0 als gepatchte Version.
- Für die acht suppressed Installer-/Deploy-Kandidaten existieren begrenzte PoCs, aber ihr nötiger Konfigurations- oder Deployment-Write ist im untersuchten Modell bereits Operator-/Service-Privileg. Sie sind UX-/Hardening-Arbeit, keine eingestufte Cross-Principal-Schwachstelle.
- Die 48 deferred-Kandidaten sind nicht verworfen. Ihre Validierungs- und Angriffspfadberichte speichern Source, Control, Sink, Gegenbeweis und exakte Lücke für eine gezielte nächste Runde.

## Abschlusschecks

- Alle 72 Kandidaten besitzen Discovery-, Validation- und Attack-Path-Receipts; die finale Terminalentscheidung ist 16 reportable, 48 deferred und 8 ignore.
- Die vollständige Node-Testsuite endete frisch mit 2.386 Passes, 0 Fails und 1 Skip.
- npm audit meldet die in SEC-10 dokumentierte Abhängigkeitswarnung; es wurde kein automatisches oder erzwungenes Dependency-Upgrade ausgeführt.

## Priorisierte, funktionspositive Umsetzung

1. Eine unveränderliche aclCtx von Command/Hook bis zu jeder Resultatanzeige, externen Provider-Grenze und Mutation tragen.
2. Für Wiki alle vier Operationen auf die bestehende ACL- und Lifecycle-Hilfslogik vereinheitlichen; erlaubte Owner-/Workspace-Fälle müssen weiter erfolgreich sein.
3. Alle Vault-/Graph-Dateischreib- und Cleanup-Sinks auf realpath-basiertes Containment mit Symlink-Abwehr umstellen.
4. Regressionen als Positiv-/Negativpaar ergänzen: Fremdrow blockiert und legitime Owner-/Shared-Row funktioniert.

## Traceability

- Vollständige Discovery-Receipts: artifacts/02_discovery/file_reviews/review-000.json bis review-048.json
- Per-Kandidat-Entscheidungen: artifacts/05_findings/<candidate-id>/
- Abdeckung und Reconciliation: artifacts/03_coverage/ und artifacts/04_reconciliation/
- Bug-/Feature-Ergebnisse: [bug_audit.md](bug_audit.md), [feature_audit.md](feature_audit.md) sowie ihre Addenda.

# GP5 R5: Abgeleitete Reads ohne Requester

Stand 21.10.2026; frisch gefetchtes Engine-main `98dfe2f03363f6291daa9f85e473578770fb5c55`, offene PRs vor Beginn geprüft. **Analyse, keine Verhaltensänderung.** Vertrag unverändert 1.16.0; keine Abhängigkeit und kein Lockfile geändert.

## Ergebnis

Ungebundene Neo-Reads sind auf dieser Basis ungefiltert: `readGraphEdges`/`readPatterns` wenden den Derived-ACL-Filter nur mit einem Requester an (`lib/neo-arch.js:2077-2080`); auch `isDerivedRecordAccessible(record, {})` gibt true zurück (:1628-1636). Das allein belegt keine Ausgabe fremder Erinnerungstexte: Die drei Recall-Graphpfade prüfen tatsächliche Endpunkte später. Patterns und Vault-Report haben andere Grenzen.

## Aufrufstellen

| Stelle | Requester verfügbar? | Nachgelagerte Prüfung | Prompt / Ausgabe |
|---|---|---|---|
| `engine/recall/assemble-prompt-context.js:413`, Graph | Ja: aufgelöstes `memoryCtx` ab :227 mit workspaceIdentity, Agent und User-Principal; :470 an Recall übergeben. | `lib/recall-pipeline.js:1991` ruft `authorizeGraphEdges` (:1414) vor Spread auf: tatsächliche Quell-/Zielzeilen laden, Lifecycle und ACL beider prüfen. Ohne autorisierte Kanten kein Spread. | Unterstützt Auswahl/Ranking; später erneut CRR-gefiltert. Unnötig breite Metadaten und Budgeteinfluss, aber kein aus diesem Read allein belegtes fremdes Textleck. |
| `assemble-prompt-context.js:620`, Patterns | Ja: dasselbe memoryCtx. | `findBestPattern` prüft Mitgliedsüberlappung, Score und Continuity-Gate, keine Derived-ACL. Zwei sichtbare Mitglieder beweisen keine Sichtbarkeit aller Pattern-Inhalte. Graph-Autorisierung betrifft diesen Pfad nicht. | **Name und Beschreibung gehen in den Prompt**: `lib/pattern-surface.js:159-175`, eingebaut in `lib/relevant-memory-context.js:256`. Sanitizing ist keine Autorisierung. Höchste Freigabepriorität. |
| `engine/recall/warm-recall-path.js:131` | Ja: opts.memoryCtx; neoRequester schon im Prelude :104 genutzt. | Gemeinsames runMergedNamespaceRecall mit memoryCtx, damit dieselbe tatsächliche Endpunktprüfung. | Warm-only gibt blocks:[] zurück, kein eigener Promptblock. Breite Reads beeinflussen Arbeit, Caches und begrenzte Auswahl. |
| `engine/tools/memory-tools.js:188` | Ja: resolveToolMemoryRequestContext :139, :249 im Recall. | Gemeinsame Pipeline prüft beide Endpunkte an tatsächlichen Speicherzeilen. | Autorisierte Recall-Texte im Tool-Ergebnis. Keine Pattern-Namen aus diesem Read. |
| `engine/capture/capture-turn.js:1170`, Dedup | Ja: memoryCtx wird :1195 an buildEdgesForSession übergeben. | **Kein authorizeGraphEdges** für die bestehenden Kanten. readBoundGraph fordert gebundene Ownership, ist aber keine Requester-ACL. Neue Kanten über prepareGraphEndpoint/checkAccess (`lib/memory-graph.js:196`). Episode-Reads :1200 ebenfalls ungebunden, beim Bau geprüft. | Kein Prompt. Breite Metadaten können Dedup beeinflussen; deren eigene Leseberechtigung ist nicht separat bewiesen. |
| `capture-turn.js:1232`, Vault-Report | Ja: gleicher Kontext. | writeGraphConstellationReport (`lib/memory-graph.js:1005`) fordert gebundene Kanten, prüft keinen Requester und keine aktuellen Endpunktzeilen. | Schreibt IDs, Topologie, Stärke, Typstatistik und Hubs, keine Erinnerungstexte. Eigenständige Metadatenausgabe, nur mit Workspace und zufälliger 10%-Auswahl. |
| `lib/conversation-reactivation-recall.js:924` | Ja: Read nur mit kanonischem requestContext und Basis-IDs. Extern übergebene Kanten werden ebenfalls geprüft. | filterGraphEdgesForRequest :926 prüft beide gespeicherten Ownership-Endpunkte (`lib/memory-graph.js:144`). Auswahl/Hydration autorisiert echte Zeilen erneut (authorizeCrrMemory/getMemoryById). Eigene zweistufige Sicherung statt authorizeGraphEdges. | Formatiert nur erneut geprüfte Erinnerungen. Breiter Read hebt die Hydrationsprüfung nicht auf. |

## global_user: Writer und Reader widersprechen sich

stampDerivedVisibility (`lib/neo-arch.js:1597-1613`) normalisiert User-Scope zu global_user und schreibt visibility.ownerUserId. isNeoRecordAccessible (:1581-1583) liest nur item.ownerId, origin.ownerId oder visibility.ownerId. isDerivedRecordAccessible reicht requester.ownerUserId als requesterOwnerId weiter; die Datensatzseite bleibt falsch.

Direkter DB-freier Reproduktionsfall mit echten Funktionen: Pattern für telegram:owner stempeln, mit gleichem Agent und Owner lesen. Ergebnis: visibility.scope=global_user, visibility.ownerUserId=telegram:owner, **Owner false**, fremder User false, ohne Requester true. Die fehlende Sichtbarkeit des Owners ist belegt; keine fehlende Sperre des explizit fremden Users behauptet. Der ungebundene Pattern-Promptpfad kann den Fehler verdecken.

Zusätzlich liest neoRequester (`engine/create-engine.js:1241-1246`) workspaceKey/workspaceId und ownerId/userId, während kanonischer Kontext workspaceIdentity/userPrincipal trägt. Den vorhandenen Adapter bloß mit dem anders geformten Kontext aufzurufen, wäre keine belastbare Korrektur. Keine Identität aus Routing-Defaults erfinden.

## Offene Owner-Frage und Empfehlung

Soll die Derived-ACL für diese interaktiven Reads verbindlich werden, einschließlich User-Owner-Mapping? **Empfehlung: ja, als explizit freigegebene Verhaltensänderung**, zuerst Patterns und Vault-Metadaten, dann die bereits endpunktgesicherten Graph-Reads. Ein zentraler Adapter aus vertrauenswürdigem kanonischem Kontext soll requesterAgentId, requesterWorkspaceKey und requesterOwnerId erzeugen. Bestehende Endpunktprüfungen als zusätzliche Sicherung erhalten.

Migrationsfolgen:

1. ownerUserId als kanonisches Writer-/Reader-Feld. Alte ownerId-Zeilen nur nach eindeutig verifizierter Zuordnung unterstützen oder explizit migrieren. Widersprüchliche Felder verweigern, Vorrang nicht erraten.
2. Vorher read-only Bestand nach Scope, fehlender Bindung und Konflikten erheben. Ungebundene Altzeilen nicht global freigeben. Snapshot und rücknehmbare Metadatenmigration.
3. Fremde/ungestempelte Patterns können verschwinden; korrekt gebundene User-Patterns erstmals für den Owner erscheinen. Das ändert Recall/Prompt und braucht Sichtprüfung sowie Nutzerhinweis.
4. Filterung folgt aktuell readMerged(...limit): fremde Präfixe können eigene Einträge abschneiden. Filterreihenfolge/Budget testen, keine unbeschränkten Reads als Nebenwirkung.
5. Hintergrund-/Maintenance-Reads separat inventarisieren. Nicht pauschal alle requestlosen Systemreads abschalten. Ein expliziter Systemmodus wäre ein eigener Vertrag.
6. Prompt-Cache nach ACL-/Owner-Migration invalidieren/versionieren. Laufende Prozesse dürfen keine alten breiten Kontexte liefern. Legacy-Adapter und kanonische Engine-API getrennt prüfen.

## Tests und Grenzen

`tests/gp5-derived-reads-analysis.test.js` enthält ausschließlich neue TODO-Spezifikationen: einen ausformulierten Owner-Fall und Freigabefälle je Pfad/Migration. Der Mapping-Fall scheitert auf dieser Basis erwartungsgemäß innerhalb seines TODO; er ist **kein behobener oder bestandener Test**. Vorhandene Tests bleiben unverändert.

Quellpfade und direkter Mapping-Fall geprüft, ohne Fake, Netz oder Modell. Kein vollständiger Engine-Lauf, Exploit oder plattformübergreifender Befund behauptet. Keine Laufzeitdatei geändert. Die beschriebenen Einschränkungen und Migrationen sind bis zur Owner-Entscheidung nicht implementiert.

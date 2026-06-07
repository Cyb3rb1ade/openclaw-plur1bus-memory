# Migration v5 → v6 — Engram Release

**Version:** 6.1.0 (Engram)  
**Datum:** 2026-06-07

---

## Zusammenfassung

Das Engram-Release (v6.1.0) ist ein **reines Feature- und Performance-Update**.  
Es erfordert **keine manuelle Migration** und führt **keine Datenbank-Schema-Änderungen** ein.

---

## Was sich ändert

### Neue Defaults (wirken automatisch)

- **`maxPromptMemories`**: `12` (hartes Prompt-Limit)
- **`dedup`**: `0.78` (aggressivere Deduplizierung)
- **`canonicalMaxItems`**: `5` (max. 5 kanonische Items pro Cluster)
- **`halfLifeDaysMap`**: typbasierte Halbwertszeiten statt globalem Wert

### Neue Features (opt-in via Config)

- **Embedding-Cache**: `embeddingCacheEnabled` (default `true`)
- **Recall-Kompression**: automatisch aktiv
- **Adaptive Recall-Tiers**: automatisch aktiv
- **Graph-Index**: automatisch aktiv

---

## Was **nicht** nötig ist

| Maßnahme | Notwendig? |
|----------|------------|
| Datenbank-Backup | Empfohlen, aber nicht zwingend |
| Schema-Migration | **Nein** — keine neuen Spalten |
| Manuelle Config-Änderung | **Nein** — Defaults gelten sofort |
| Re-Indexierung | **Nein** — bestehender ANN-Index bleibt gültig |
| Restart des Plugins | **Ja** — um neue Defaults zu laden |

---

## Verhalten bestehender Daten

- **Alte Memories**: Behalten ihre existierenden `halfLifeDays`-Werte bei. Neue Memories verwenden automatisch `halfLifeDaysMap`.
- **Bestehende Embeddings**: Keine Neuberechnung nötig. Der Embedding-Cache wirkt nur auf neue Calls.
- **Graph-Edges**: Bestehende Edges im Memory Graph werden vom neuen Graph-Index automatisch indexiert (lazy on first read).

---

## Rollback

Falls Probleme auftreten:

1. Plugin stoppen
2. In `openclaw.plugin.json` unter `recall` die alten Werte explizit setzen (z. B. `maxPromptMemories: 20`, `dedup: 0.85`)
3. Plugin starten

Es gibt keine persistierten Seiteneffekte, die nicht durch Config-Änderung rückgängig gemacht werden könnten.

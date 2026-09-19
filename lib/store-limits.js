/**
 * lib/store-limits.js — die eine Obergrenze, mit der Wartungsskripte einen
 * Store vollstaendig laden.
 *
 * Am 19.09.2026 stand diese Zahl in vier Varianten im Code: 100.000
 * (importance-metrics, importance-phase1-reset), 200.000 (dedupe-memory-ids,
 * backfill-manual-core-markers) und 500.000 (importance-backfill).
 *
 * Das ist gefaehrlich, weil LanceDB bei Erreichen der Grenze klaglos
 * abschneidet statt zu melden. Phase 1 haette oberhalb von 100.000 Zeilen die
 * Haelfte des Bestands nicht in die Warteschlange gestellt — und "fertig"
 * gemeldet. Ein Skript, das den ganzen Store braucht, muss ihn ganz bekommen.
 *
 * Die Grenze liegt bewusst weit ueber allem Erreichbaren: der Garbage
 * Collector deckelt die aktiven Zeilen je Agent (Stand 19.09.2026: 50.000,
 * geplant 150.000), archivierte und geloeschte kommen hinzu. Eine Million
 * laesst auch dafuer Reserve und kostet nichts, solange sie nicht erreicht
 * wird.
 */
export const STORE_SCAN_LIMIT = 1_000_000;

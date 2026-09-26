/**
 * engine/runtime/constants.js — module-level constants shared by the recall, capture and command paths.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { LEGACY_DEFAULT_MODEL } from "../../lib/providers/dimensions.js";

const DEFAULT_BASE_DB_PATH = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
const DEFAULT_MODEL = LEGACY_DEFAULT_MODEL;
const MAX_PROMPT_REPLY_OUTCOME_READ_BYTES = 2 * 1024 * 1024;
// Wie viele bereits episodierte Turn-IDs im Hook-State vorgehalten werden.
// Dedup laeuft ueber Turn-IDs statt ueber den Batch-Digest, weil ein
// haengendes Watermark die naechste Slice verbreitert und den Digest damit
// aendert — die Turn-IDs bleiben dagegen stabil.
const EPISODED_TURN_ID_MEMORY = 2000;
// Nach so vielen erfolglosen Nachverarbeitungslaeufen wird das Watermark
// nachgezogen, damit ein dauerhaft kaputter Pfad die Slice nicht unbegrenzt
// wachsen laesst. Der uebersprungene Bereich wird dabei laut protokolliert.
const MAX_POSTPROCESSING_RETRIES = 5;

// Wie viele Zeichen von Alt- und Neu-Text die /correct-Bestätigung zeigt. Lang
// genug, damit erkennbar ist, welche Erinnerung überschrieben wird; kurz genug,
// dass zwei Auszüge plus Anleitung in eine Chat-Nachricht passen.
const CORRECTION_PREVIEW_CHARS = 300;

const TABLE_NAME = "memories";

export { DEFAULT_BASE_DB_PATH, DEFAULT_MODEL, MAX_PROMPT_REPLY_OUTCOME_READ_BYTES, EPISODED_TURN_ID_MEMORY, MAX_POSTPROCESSING_RETRIES, CORRECTION_PREVIEW_CHARS, TABLE_NAME };

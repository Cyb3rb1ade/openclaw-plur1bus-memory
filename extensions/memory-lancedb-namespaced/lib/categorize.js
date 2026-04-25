/**
 * lib/categorize.js — Kategorie-Taxonomie + Auto-Kategorisierung.
 *
 * Eine Quelle der Wahrheit für Plugin (memory_store enum), Cron-Capture
 * (categorizeMemory), Doctor (filter), Migrations.
 */

export const MEMORY_CATEGORIES = [
  "preference",   // User-Präferenzen ("mag kurze Antworten")
  "fact",         // Fakten über User/Projekte/Umgebung
  "decision",     // Architektur-/Tech-Entscheidungen
  "entity",       // Personen, Firmen, Produkte, Orte
  "reference",    // externe Refs: URLs, Links, Dokumente
  "debug",        // Fehler, Stacks, Reproduktionsschritte
  "config",       // Settings, Schwellenwerte, Defaults
  "conversation", // generischer Gesprächs-Capture (Auto-Capture-Default)
  "knowledge",    // kuratiertes Wissen (z.B. aus MEMORY.md-Migration)
  "curated",      // Dreaming-Promotionen, manuell kuratiert
  "other",        // Fallback
];

export const MEMORY_ORIGINS = ["dm", "group", "cron", "internal"];

export const MEMORY_SCOPES = ["agent-private", "workspace", "user"];

/**
 * Heuristische Auto-Kategorisierung basierend auf Text-Patterns. Reihenfolge
 * der Checks ist wichtig — spezifische Patterns zuerst, dann allgemeinere.
 * Default ist "conversation" (passt zu Auto-Capture-Texten).
 */
export function categorizeMemory(text) {
  const lower = String(text).toLowerCase();
  if (/prefer|like|love|hate|want|always|never|usually|tend to|bevorzug|mag|möchte/.test(lower)) return "preference";
  if (/decided|will use|going with|chosen|picked|entschieden|wählen wir|nehmen wir|wir wählen|wir nehmen|wir entscheiden/.test(lower)) return "decision";
  if (/error|exception|stack trace|traceback|fehler|failed|reproduce/.test(lower)) return "debug";
  if (/config|setting|threshold|default|umgebungsvariable|env var/.test(lower)) return "config";
  if (/https?:\/\/|url|link|reference/.test(lower)) return "reference";
  if (/name:|person:|company:|product:|place:/.test(lower)) return "entity";
  if (/is |are |was |were |has |have |\d{4}/.test(lower)) return "fact";
  return "conversation";
}

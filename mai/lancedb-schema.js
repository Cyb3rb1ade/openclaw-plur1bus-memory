/**
 * mai/lancedb-schema.js — LanceDB schema definitions for emotion-enabled engrams.
 *
 * Exports descriptive field definitions and a factory to create / migrate the
 * "engrams" table with full emotion + decay columns.
 */

/**
 * Descriptive schema fields for emotion and decay metadata.
 * @type {Array<{name: string, type: string, dimensions?: number}>}
 */
export const EMOTION_SCHEMA_FIELDS = [
  { name: "valence", type: "float" },
  { name: "arousal", type: "float" },
  { name: "dominance", type: "float" },
  { name: "intensity", type: "float" },
  { name: "primary_emotion", type: "string" },
  { name: "emotion_labels_json", type: "string" },
  { name: "emotion_language", type: "string" },
  { name: "emotion_source", type: "string" },
  { name: "emotion_tier", type: "int8" },
  { name: "emotion_confidence", type: "float" },
  { name: "emotion_timestamp", type: "timestamp" },
  { name: "vad_vector", type: "list<float>", dimensions: 3 },
  { name: "decay_half_life_hours", type: "float" },
  { name: "decay_last_accessed", type: "timestamp" },
  { name: "decay_access_count", type: "int32" },
];

/**
 * Create or open the "engrams" table on a LanceDB connection.
 * If the table already exists, missing emotion/decay columns are added
 * idempotently via `addColumns`.
 *
 * @param {object} db — LanceDB DBConnection
 * @returns {Promise<object>} — LanceDB Table handle
 */
export async function createEngramTableWithEmotion(db) {
  const names = await db.tableNames();

  if (names.includes("engrams")) {
    const table = await db.openTable("engrams");
    const schema = await table.schema();
    const fieldNames = new Set(schema.fields.map((f) => f.name));

    for (const col of EMOTION_SCHEMA_FIELDS) {
      if (fieldNames.has(col.name)) continue;

      let valueSql = "NULL";
      if (col.type === "float") valueSql = "0.0";
      else if (col.type === "int8" || col.type === "int32") valueSql = "0";
      else if (col.type === "string") valueSql = "''";
      else if (col.type === "timestamp") valueSql = "0";
      else if (col.type === "list<float>") valueSql = "[0.0, 0.0, 0.0]";

      await table.addColumns([{ name: col.name, valueSql }]);
    }

    return table;
  }

  const sampleRow = {
    id: "__schema__",
    content: "",
    embedding: Array(768).fill(0.0),
    created_at: 0,
    source: "user",
    session_id: "",
    valence: 0.0,
    arousal: 0.0,
    dominance: 0.0,
    intensity: 0.0,
    primary_emotion: "",
    emotion_labels_json: "{}",
    emotion_language: "en",
    emotion_source: "unknown",
    emotion_tier: 0,
    emotion_confidence: 0.0,
    emotion_timestamp: 0,
    vad_vector: [0.0, 0.0, 0.0],
    decay_half_life_hours: 168.0,
    decay_last_accessed: 0,
    decay_access_count: 0,
  };

  return await db.createTable("engrams", [sampleRow]);
}

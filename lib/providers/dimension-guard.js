export async function readExistingTableDimension(dbPath) {
  let lancedb;
  try {
    lancedb = await import("@lancedb/lancedb");
  } catch (e) {
    return { status: "unknown", error: `LanceDB import failed: ${e.message}` };
  }
  try {
    const db = await lancedb.connect(dbPath);
    let tables;
    try {
      tables = await db.tableNames();
    } catch (e) {
      return { status: "unknown", error: `tableNames() failed: ${e.message}` };
    }
    if (!tables.includes("memories")) {
      return { status: "no-table" };
    }
    const table = await db.openTable("memories");
    const schema = await table.schema();
    const vectorField = schema.fields.find(f => f.name === "vector");
    if (!vectorField) {
      return { status: "unknown", error: "vector field not found in schema" };
    }
    const dim = vectorField?.type?.listSize;
    if (!dim || typeof dim !== "number") {
      return { status: "unknown", error: `vector field listSize invalid: ${dim}` };
    }
    return { status: "ok", dimension: dim };
  } catch (e) {
    return { status: "unknown", error: e.message };
  }
}

export function checkDimensionCompatibility(guardResult, targetDim) {
  if (guardResult.status === "no-table") return "no-existing-table";
  if (guardResult.status === "unknown") return "unknown";
  if (guardResult.dimension === targetDim) return "ok";
  return "mismatch";
}

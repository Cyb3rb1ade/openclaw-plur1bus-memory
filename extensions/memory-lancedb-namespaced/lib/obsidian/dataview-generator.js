export function dataviewTableBlock({ collection, type, columns = [], where = "", sort = "updatedAt DESC", reviewRoot = "plur1bus" }) {
  const fields = columns.length ? columns.join(", ") : "status, risk, scope, trustLevel, agentId, updatedAt";
  const filters = [`plur1bus_type = "${type}"`];
  if (where) filters.push(where);
  return [
    "```dataview",
    `TABLE ${fields}`,
    `FROM "${reviewRoot.replace(/\/+$/, "")}/records/${collection}"`,
    `WHERE ${filters.join(" AND ")}`,
    sort ? `SORT ${sort}` : "",
    "```",
  ].filter(Boolean).join("\n");
}

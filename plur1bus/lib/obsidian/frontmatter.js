export function yamlScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value).replace(/\r?\n/g, " ").slice(0, 2000);
  if (!text || /[:#{}\[\],&*?|\-<>=!%@`"']|\s$|^\s/.test(text)) return JSON.stringify(text);
  return text;
}

export function formatFrontmatter(frontmatter = {}, body = "") {
  const lines = ["---"];
  for (const key of Object.keys(frontmatter).sort()) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---", "");
  return `${lines.join("\n")}${String(body || "").replace(/^\n+/, "")}`;
}

export function parseYamlScalar(rawValue) {
  const value = String(rawValue || "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseFrontmatter(content) {
  const text = String(content || "");
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text, rawFrontmatter: "" };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: text, rawFrontmatter: "" };
  const rawFrontmatter = text.slice(4, end);
  const body = text.slice(end + 5);
  const frontmatter = {};
  let currentKey = null;
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const list = line.match(/^\s+-\s+(.+)$/);
    if (list && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(parseYamlScalar(list[1]));
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) {
      currentKey = null;
      continue;
    }
    const [, key, rawValue = ""] = match;
    frontmatter[key] = rawValue === "" ? [] : parseYamlScalar(rawValue);
    currentKey = key;
  }
  return { frontmatter, body, rawFrontmatter };
}


function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9_/.-]+/i)
    .flatMap((part) => part.split(/[/.]+/))
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function includesToken(text, token) {
  return String(text || "").toLowerCase().includes(token);
}

function scoreText(text, tokens, weight) {
  let score = 0;
  for (const token of tokens) {
    if (includesToken(text, token)) score += weight;
  }
  return score;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function byKey(items, key) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const value = item?.[key];
    if (value) map.set(value, item);
  }
  return map;
}

function indexChunksBySymbol(chunks) {
  const map = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk?.symbolId) continue;
    const list = map.get(chunk.symbolId) || [];
    list.push(chunk);
    map.set(chunk.symbolId, list);
  }
  return map;
}

function indexEdgesByFrom(edges) {
  const map = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge?.from) continue;
    const list = map.get(edge.from) || [];
    list.push(edge);
    map.set(edge.from, list);
  }
  return map;
}

function firstSnippet(chunks, tokens, maxChars = 180) {
  const matching = chunks.find((chunk) => tokens.some((token) => includesToken(chunk.text, token))) || chunks[0];
  if (!matching?.text) return "";
  const collapsed = matching.text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 3)}...` : collapsed;
}

/**
 * Search a PLUR1BUS code index using bounded keyword scoring.
 * @param {Object} index Normalized code index.
 * @param {string} query User query or command text.
 * @param {Object} options Search options.
 * @returns {Array<Object>} Ranked code-index search results.
 */
export function searchCodeIndex(index = {}, query = "", options = {}) {
  const tokens = tokenize(query);
  const limit = Math.max(1, Math.min(Number(options.limit) || 5, 20));
  if (tokens.length === 0) return [];

  const filesByPath = byKey(index.files, "path");
  const chunksBySymbol = indexChunksBySymbol(index.chunks);
  const edgesByFrom = indexEdgesByFrom(index.edges);
  const normalizedQuery = String(query || "").toLowerCase();

  const results = [];
  for (const symbol of Array.isArray(index.symbols) ? index.symbols : []) {
    const file = filesByPath.get(symbol.filePath) || { path: symbol.filePath || "" };
    const chunks = chunksBySymbol.get(symbol.id) || [];
    const edges = edgesByFrom.get(symbol.id) || [];
    const commands = unique(edges.filter((edge) => edge.type === "registers").map((edge) => edge.command));
    const matchTypes = new Set();
    let score = 0;

    const commandText = commands.join(" ");
    if (commandText && commandText.toLowerCase().includes(normalizedQuery)) {
      score += 100;
      matchTypes.add("command");
    }
    const commandScore = scoreText(commandText, tokens, 18);
    if (commandScore > 0) {
      score += commandScore;
      matchTypes.add("command");
    }

    const nameScore = scoreText(symbol.name, tokens, 20);
    if (nameScore > 0) {
      score += nameScore;
      matchTypes.add("symbol");
    }
    const signatureScore = scoreText(symbol.signature, tokens, 8);
    if (signatureScore > 0) {
      score += signatureScore;
      matchTypes.add("signature");
    }
    const pathScore = scoreText(file.path, tokens, 6);
    if (pathScore > 0) {
      score += pathScore;
      matchTypes.add("path");
    }

    const chunkText = chunks.map((chunk) => chunk.text).join("\n");
    const chunkScore = scoreText(chunkText, tokens, 3);
    if (chunkScore > 0) {
      score += chunkScore;
      matchTypes.add("chunk");
    }
    const edgeText = edges.map((edge) => `${edge.type} ${edge.name || ""} ${edge.to || ""} ${edge.handler || ""}`).join(" ");
    const edgeScore = scoreText(edgeText, tokens, 4);
    if (edgeScore > 0) {
      score += edgeScore;
      matchTypes.add("edge");
    }

    if (score <= 0) continue;
    results.push({
      score,
      matchTypes: [...matchTypes].sort(),
      symbol,
      file,
      commands,
      edges,
      snippet: firstSnippet(chunks, tokens, options.snippetChars || 180),
    });
  }

  return results
    .sort((a, b) => b.score - a.score || a.symbol.filePath.localeCompare(b.symbol.filePath) || a.symbol.name.localeCompare(b.symbol.name))
    .slice(0, limit);
}

function lineRange(symbol = {}) {
  const start = symbol.range?.startLine || 1;
  const end = symbol.range?.endLine || start;
  return `${start}-${end}`;
}

/**
 * Render search results as a bounded code-context XML block.
 * @param {Array<Object>} results Results from searchCodeIndex.
 * @param {Object} options Formatting options.
 * @returns {string} XML-ish context block for prompt insertion or CLI display.
 */
export function formatCodeContextBlock(results = [], options = {}) {
  const query = escapeXml(options.query || "");
  const maxChars = Math.max(200, Math.min(Number(options.maxChars) || 3000, 12000));
  const lines = [`<code-context source="plur1bus-code-index" query="${query}">`];
  for (const result of results) {
    const symbol = result.symbol || {};
    const file = result.file || {};
    lines.push(`  <symbol name="${escapeXml(symbol.name)}" kind="${escapeXml(symbol.kind)}" file="${escapeXml(file.path || symbol.filePath)}" lines="${escapeXml(lineRange(symbol))}">`);
    if (symbol.signature) lines.push(`    <signature>${escapeXml(symbol.signature)}</signature>`);
    for (const command of result.commands || []) {
      lines.push(`    <command>${escapeXml(command)}</command>`);
    }
    if (result.snippet) lines.push(`    <snippet>${escapeXml(result.snippet)}</snippet>`);
    lines.push("  </symbol>");
    if (lines.join("\n").length >= maxChars) break;
  }
  lines.push("</code-context>");
  const block = lines.join("\n");
  if (block.length <= maxChars) return block;
  return `${block.slice(0, Math.max(0, maxChars - "</code-context>".length - 1))}\n</code-context>`;
}

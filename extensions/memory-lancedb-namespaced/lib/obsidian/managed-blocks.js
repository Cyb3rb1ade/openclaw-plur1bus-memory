import { createHash } from "node:crypto";

export function sha256Hex(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function normalizeManagedBlockBody(body = "") {
  return String(body || "").replace(/^\n+|\n+$/g, "");
}

export function buildManagedBlock({ id, version = "4.2.9", body = "", attrs = {} }) {
  const normalizedBody = normalizeManagedBlockBody(body);
  const hash = `sha256:${sha256Hex(normalizedBody)}`;
  const attrText = Object.entries({ id, version, ...attrs, hash })
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, "&quot;")}"`)
    .join(" ");
  return [
    `<!-- plur1bus:managed:start ${attrText} -->`,
    normalizedBody,
    "<!-- plur1bus:managed:end -->",
  ].join("\n");
}

export function replaceManagedBlock(content, block) {
  const text = String(content || "");
  const next = buildManagedBlock(block);
  const marker = `id="${block.id}"`;
  const pattern = /<!-- plur1bus:managed:start ([\s\S]*?) -->([\s\S]*?)<!-- plur1bus:managed:end -->/g;
  let replaced = false;
  let conflict = null;
  const output = text.replace(pattern, (match, attrs, body) => {
    if (!attrs.includes(marker)) return match;
    replaced = true;
    const hashMatch = attrs.match(/hash="([^"]+)"/);
    const expected = hashMatch?.[1] || "";
    const normalizedBody = normalizeManagedBlockBody(body);
    const actual = `sha256:${sha256Hex(normalizedBody)}`;
    const legacyTrailingNewline = `sha256:${sha256Hex(`${normalizedBody}\n`)}`;
    if (expected && expected !== actual && expected !== legacyTrailingNewline) {
      conflict = { type: "managed_block_hash_mismatch", id: block.id, expected, actual };
      return match;
    }
    return next;
  });
  if (conflict) return { changed: false, content: text, conflict };
  if (replaced) return { changed: output !== text, content: output, conflict: null };
  const sep = text && !text.endsWith("\n") ? "\n\n" : text ? "\n" : "";
  return { changed: true, content: `${text}${sep}${next}\n`, conflict: null };
}

/**
 * scripts/dist/installer/untar.mjs — a strict reader for the provider tarball (HM2-R21).
 *
 * The HM1 installer bundle imports only `node:` builtins, so this is a small ustar reader,
 * not a general one. It accepts exactly what the harness builder writes
 * (scripts/build-hermes-provider.mjs, HM2 Task 7): gzip'd ustar with regular files
 * (typeflag `0`/NUL) and directories (`5`). Everything else is refused before anything is
 * written: links and special files, pax/GNU extension headers, absolute paths, drive letters,
 * backslashes, `.`/`..` segments, duplicate names and case-fold duplicates (a Windows or
 * macOS file system would merge them), a bad header checksum, a truncated stream, and more
 * than `maxBytes` of unpacked data (also enforced while inflating, so a gzip bomb stops
 * early). `dest` must not exist; it is created, and every file is created exclusively inside it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

export class UntarError extends Error {
  /** @param {"unsafe-entry"|"duplicate"|"too-large"|"corrupt"} code */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const BLOCK = 512;

function field(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function octal(buf, start, length, what) {
  const text = field(buf, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new UntarError("corrupt", `${what} is not an octal number`);
  return parseInt(text, 8);
}

function checksumOk(header) {
  const stored = octal(header, 148, 8, "header checksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === stored;
}

/** Throws unsafe-entry unless `name` is a plain relative path of safe segments. */
function checkName(raw, isDir) {
  const name = isDir && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!name) throw new UntarError("unsafe-entry", "empty entry name");
  if (/[\0\\]/.test(name) || /[\x01-\x1f\x7f]/.test(name)) throw new UntarError("unsafe-entry", `${JSON.stringify(raw)} contains a backslash or a control character`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new UntarError("unsafe-entry", `${JSON.stringify(raw)} is an absolute path`);
  for (const seg of name.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new UntarError("unsafe-entry", `${JSON.stringify(raw)} has an empty, "." or ".." segment`);
  }
  return name;
}

/**
 * @param {{ file: string, dest: string, maxBytes?: number }} a
 * @returns {Promise<{ files: string[], dirs: string[] }>} relative POSIX paths, in archive order
 */
export async function extractTarGz({ file, dest, maxBytes = 64 << 20 }) {
  const gz = readFileSync(file);
  let tar;
  try {
    // the archive's own padding and end blocks come on top of the payload
    tar = gunzipSync(gz, { maxOutputLength: maxBytes + 64 * BLOCK + 10240 });
  } catch (err) {
    if (err?.code === "ERR_BUFFER_TOO_LARGE" || /Cannot create a Buffer larger|maxOutputLength|buffer.*too large/i.test(String(err?.message))) {
      throw new UntarError("too-large", `${file} unpacks to more than ${maxBytes} bytes`);
    }
    throw new UntarError("corrupt", `${file} is not a gzip stream (${err?.code ?? err?.message ?? err})`);
  }

  /** @type {Array<{ name: string, type: "file"|"dir", mode: number, data: Buffer|null }>} */
  const entries = [];
  const seen = new Set();
  const folded = new Map();
  let total = 0;
  let offset = 0;
  let ended = false;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) {
      ended = true;
      break;
    }
    if (!checksumOk(header)) throw new UntarError("corrupt", `bad header checksum at offset ${offset}`);
    const flag = String.fromCharCode(header[156] || 0x30);
    const shortName = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const raw = prefix ? `${prefix}/${shortName}` : shortName;
    if (flag !== "0" && flag !== "5") throw new UntarError("unsafe-entry", `${JSON.stringify(raw)} has type ${JSON.stringify(flag)} (only regular files and directories are allowed)`);
    const isDir = flag === "5";
    const name = checkName(raw, isDir);
    const size = octal(header, 124, 12, "entry size");
    if (isDir && size !== 0) throw new UntarError("corrupt", `directory ${name} has a size`);
    const mode = octal(header, 100, 8, "entry mode");
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) throw new UntarError("corrupt", `${name} is truncated`);
    total += size;
    if (total > maxBytes) throw new UntarError("too-large", `the archive holds more than ${maxBytes} bytes`);
    if (seen.has(name)) throw new UntarError("duplicate", `${name} appears twice`);
    const key = name.normalize("NFC").toLowerCase();
    if (folded.has(key)) throw new UntarError("duplicate", `${name} and ${folded.get(key)} differ only in case`);
    seen.add(name);
    folded.set(key, name);
    entries.push({ name, type: isDir ? "dir" : "file", mode, data: isDir ? null : tar.subarray(dataStart, dataStart + size) });
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!ended) throw new UntarError("corrupt", "the archive has no end-of-archive block");
  // a file used as a directory of another entry
  const fileNames = new Set(entries.filter((e) => e.type === "file").map((e) => e.name));
  for (const e of entries) {
    const parts = e.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (fileNames.has(parts.slice(0, i).join("/"))) throw new UntarError("unsafe-entry", `${e.name} lies below the file ${parts.slice(0, i).join("/")}`);
    }
  }

  const root = resolve(dest);
  if (existsSync(root)) throw new UntarError("unsafe-entry", `destination ${root} already exists`);
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const files = [];
  const dirs = [];
  for (const e of entries) {
    const target = join(root, ...e.name.split("/"));
    if (target !== root && !target.startsWith(root + sep)) throw new UntarError("unsafe-entry", `${e.name} resolves outside ${root}`);
    if (e.type === "dir") {
      mkdirSync(target, { recursive: true, mode: 0o755 });
      dirs.push(e.name);
    } else {
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o755 });
      writeFileSync(target, e.data, { flag: "wx", mode: e.mode & 0o111 ? 0o755 : 0o644 });
      files.push(e.name);
    }
  }
  return { files, dirs };
}

/** SHA-256 hex of a buffer (shared with the provider's MANIFEST check). */
export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * tests/helpers/ustar.js — TEST ONLY: write small ustar archives, including entries a safe reader must refuse.
 */

import { gzipSync } from "node:zlib";

function header({ name, type = "0", size = 0, mode = 0o644, linkname = "", prefix = "" }) {
  const h = Buffer.alloc(512, 0);
  const put = (s, off, len) => Buffer.from(s, "utf8").copy(h, off, 0, len);
  const oct = (n, len) => `${n.toString(8).padStart(len - 1, "0")}\0`;
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(0, 12), 136, 12);
  h.fill(0x20, 148, 156);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

/**
 * @param {Array<{ name: string, type?: string, data?: string|Buffer, mode?: number, linkname?: string, prefix?: string }>} entries
 * @returns {Buffer} the uncompressed archive
 */
export function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    parts.push(header({ ...e, size: data.length }));
    if (data.length) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

export const makeTarGz = (entries) => gzipSync(makeTar(entries));

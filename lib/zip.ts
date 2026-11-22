import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A minimal zip writer — enough for a code export (D53): files, folders by
 * path, deflate. No zip64 (an export is a few hundred kilobytes, and the
 * format's 4 GB / 65,535-entry limits are refused rather than overrun), no
 * encryption, no comments. Node's own `zlib` does the compression and the
 * CRC, so there is no dependency to vet for a feature this small.
 */

export type ZipEntry = { path: string; data: string | Uint8Array };

/** 1980-01-01 00:00 in DOS form — a fixed stamp, so the same input always zips to the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function zip(entries: ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error("Too many files for a zip without zip64");
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || path.split("/").some((s) => s === ".." || s === "")) throw new Error(`Unsafe zip path: ${entry.path}`);
    if (seen.has(path)) throw new Error(`Duplicate zip path: ${path}`);
    seen.add(path);

    const name = Buffer.from(path, "utf8");
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    const deflated = deflateRawSync(raw);
    // Store when deflate does not help (already-compressed images).
    const method = deflated.length < raw.length ? 8 : 0;
    const body = method === 8 ? deflated : raw;
    const crc = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk start, internal attrs: 0
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
    if (offset > 0xffffffff) throw new Error("Zip too large without zip64");
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Reads a zip — the store importer's half (D53). Enough for archives this
 * module writes and for ordinary ones re-zipped by hand: stored and deflate
 * entries, no zip64, no encryption. Walks the **central directory**, not the
 * local headers, because that is the archive's own index of what it holds.
 * Every entry's CRC is checked, and an unsafe path (`..`, absolute) is refused
 * rather than returned for a caller to join onto a directory.
 */
export function unzip(archive: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  // The end record is 22 bytes plus a comment of up to 65,535.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("Damaged zip: bad central directory");
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // a folder entry
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some((s) => s === ".." || s === "")) {
      throw new Error(`Unsafe zip path: ${name}`);
    }
    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`Damaged zip: ${name}`);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const body = buf.subarray(dataAt, dataAt + compressed);
    const raw = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null;
    if (!raw) throw new Error(`Unsupported zip compression (${method}): ${name}`);
    if (raw.length !== size || crc32(raw) >>> 0 !== crc) throw new Error(`Damaged zip: ${name} fails its checksum`);
    out.set(name, raw);
  }
  return out;
}

import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zip } from "./zip";

/** Reads a zip back through its central directory — the way an unzip tool finds files. */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26);
    const body = buf.subarray(start, start + size);
    out[name] = (method === 8 ? inflateRawSync(body) : body).toString("utf8");
    p += 46 + nameLen;
  }
  return out;
}

describe("zip", () => {
  it("round-trips files through the central directory, compressed or stored", () => {
    const big = "export const x = 1;\n".repeat(200);
    const files = unzip(zip([{ path: "app/page.tsx", data: big }, { path: "README.md", data: "é" }]));
    expect(files).toEqual({ "app/page.tsx": big, "README.md": "é" });
  });

  it("is deterministic, so the same export zips to the same bytes", () => {
    const entries = [{ path: "a.txt", data: "a" }];
    expect(zip(entries).equals(zip(entries))).toBe(true);
  });

  it("refuses a path that would escape the folder it unpacks into, and duplicates", () => {
    expect(() => zip([{ path: "../evil", data: "" }])).toThrow(/Unsafe/);
    expect(() => zip([{ path: "a//b", data: "" }])).toThrow(/Unsafe/);
    expect(() => zip([{ path: "a", data: "" }, { path: "a", data: "" }])).toThrow(/Duplicate/);
  });
});

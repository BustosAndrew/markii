import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";

const MAX_BYTES = 5 * 1024 * 1024;
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// Vercel Blob when BLOB_READ_WRITE_TOKEN is set (production); local filesystem
// under public/uploads otherwise (dev). Both return { url } for the images array.
export const POST = handler(async (req) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest('multipart field "file" is required');
  if (file.size > MAX_BYTES) throw badRequest("file exceeds the 5 MB limit");
  const ext = EXT_BY_TYPE[file.type];
  if (!ext) throw badRequest("only png, jpg or webp images are allowed");

  const name = `${crypto.randomUUID()}.${ext}`;

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(`uploads/${name}`, file, {
      access: "public",
      contentType: file.type,
    });
    return NextResponse.json({ url: blob.url }, { status: 201 });
  }

  const dir = path.join(process.cwd(), "public", "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ url: `/uploads/${name}` }, { status: 201 });
});

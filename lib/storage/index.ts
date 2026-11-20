import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BUCKETS, PRIVATE_BUCKET, PUBLIC_BUCKET } from "./buckets";

export { BUCKETS, PRIVATE_BUCKET, PUBLIC_BUCKET } from "./buckets";

/**
 * Supabase Storage (D6, `docs/BACKEND.md` §0 task 8).
 *
 * **Two buckets, and the split is the security boundary**, not tidiness:
 *
 * - `public-media` — product images. World-readable by design; they appear in
 *   storefront HTML and JSON-LD, so a signed URL would break agent legibility
 *   and expire out from under a cached page.
 * - `digital-assets` — **private**. The files a merchant sells. Reachable only
 *   through a short-lived signed URL minted for a specific paid grant. A public
 *   bucket here would mean anyone who ever saw a URL keeps the product forever,
 *   and download limits would be decoration.
 *
 * **This module uses the service-role key and is `server-only` for that reason.**
 * That key bypasses RLS entirely; in a browser bundle it is a full database
 * compromise (`CLAUDE.md`). It is never `NEXT_PUBLIC_*` and nothing here may be
 * imported from a client component.
 *
 * Files are **never proxied through a route handler** (G5). Proxying pays egress
 * twice — Supabase's and Vercel's — and risks a function timeout on a large
 * download. Callers redirect to a signed URL instead.
 */

/** How long a download link lives. Long enough to click, short enough to be useless if shared. */
export const SIGNED_URL_TTL_SECONDS = 5 * 60;

export type StorageUnavailable = {
  ok: false;
  code: "configuration_required";
  message: string;
  resolution: string;
};

function unavailable(): StorageUnavailable {
  return {
    ok: false,
    code: "configuration_required",
    message: "File storage is not configured.",
    resolution:
      "File storage is not configured on this deployment. Contact your Markii admin.",
  };
}

let cached: SupabaseClient | null | undefined;

/**
 * The storage client, or null when credentials are absent.
 *
 * Returns null rather than throwing at import time so `next build` still works
 * on an unconfigured checkout — the same guarantee `lib/db` gives. Callers
 * surface *configuration required*; they never invent a URL.
 */
export function storageClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    cached = null;
    return cached;
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function isStorageConfigured(): boolean {
  return storageClient() !== null;
}

export type UploadResult =
  | { ok: true; path: string; url: string | null; bytes: number }
  | StorageUnavailable
  | { ok: false; code: "upload_failed"; message: string; resolution?: string }
  /** Only without `upsert`: an object is already stored at this path. */
  | { ok: false; code: "already_exists"; message: string };

/**
 * Stores a file and returns its path.
 *
 * `url` is populated only for the public bucket, where a stable address is
 * correct. Private assets deliberately return `url: null` — their address is
 * minted per download by {@link signedDownloadUrl}, and handing out a durable
 * one here is how a paid file ends up on a forum.
 */
export async function uploadFile(input: {
  bucket: typeof PUBLIC_BUCKET | typeof PRIVATE_BUCKET;
  path: string;
  body: ArrayBuffer | Buffer | Blob;
  contentType: string;
  /** Overwrite an existing object at this path. Off by default. */
  upsert?: boolean;
}): Promise<UploadResult> {
  const client = storageClient();
  if (!client) return unavailable();

  const { error } = await client.storage.from(input.bucket).upload(input.path, input.body, {
    contentType: input.contentType,
    upsert: input.upsert ?? false,
  });

  if (error) {
    // A content-addressed path that is already there holds these exact bytes (D53 theme assets).
    const status = String((error as { statusCode?: string | number }).statusCode ?? "");
    if (!input.upsert && (status === "409" || /already exists|duplicate/i.test(error.message))) {
      return { ok: false, code: "already_exists", message: error.message };
    }
    return { ok: false, code: "upload_failed", message: error.message };
  }

  const bytes =
    input.body instanceof Blob
      ? input.body.size
      : input.body instanceof ArrayBuffer
        ? input.body.byteLength
        : input.body.length;

  return {
    ok: true,
    path: input.path,
    url:
      input.bucket === PUBLIC_BUCKET
        ? client.storage.from(input.bucket).getPublicUrl(input.path).data.publicUrl
        : null,
    bytes,
  };
}

export type SignedUrlResult =
  | { ok: true; url: string; expiresAt: Date }
  | StorageUnavailable
  | { ok: false; code: "sign_failed"; message: string };

/**
 * Mints a short-lived URL for a private asset.
 *
 * The link goes straight to Supabase, so the bytes never touch a Next.js
 * function — the G5 requirement, and the reason a 2 GB download does not time
 * out a route or bill egress twice.
 *
 * `downloadAs` sets the `Content-Disposition` filename, so a shopper receives
 * `Course.zip` rather than the opaque storage key the file is stored under.
 */
export async function signedDownloadUrl(input: {
  path: string;
  ttlSeconds?: number;
  downloadAs?: string | null;
}): Promise<SignedUrlResult> {
  const client = storageClient();
  if (!client) return unavailable();

  const ttl = input.ttlSeconds ?? SIGNED_URL_TTL_SECONDS;
  const { data, error } = await client.storage
    .from(PRIVATE_BUCKET)
    .createSignedUrl(input.path, ttl, input.downloadAs ? { download: input.downloadAs } : undefined);

  if (error || !data?.signedUrl) {
    return { ok: false, code: "sign_failed", message: error?.message ?? "no URL returned" };
  }
  return { ok: true, url: data.signedUrl, expiresAt: new Date(Date.now() + ttl * 1000) };
}

/**
 * The stable public address of a `public-media` object, without a network call.
 * Null when storage is not configured.
 */
export function publicMediaUrl(path: string): string | null {
  const client = storageClient();
  if (!client) return null;
  return client.storage.from(PUBLIC_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * The object path behind a `public-media` URL, or null when the URL is anywhere
 * else — another host, another bucket, a signed link. How a theme export tells
 * the store's own images (bundled) from images hosted elsewhere (left as links).
 */
export function publicMediaPathOf(url: string): string | null {
  const base = publicMediaUrl("");
  if (!base) return null;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const bare = url.split(/[?#]/)[0];
  if (!bare.startsWith(prefix)) return null;
  const rest = bare.slice(prefix.length);
  if (!rest) return null;
  try {
    const path = decodeURIComponent(rest);
    return path.split("/").some((seg) => seg === ".." || seg === "") ? null : path;
  } catch {
    return null;
  }
}

export type DownloadResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | StorageUnavailable
  | { ok: false; code: "download_failed"; message: string };

/**
 * Reads an object into memory, for server-side processing only — bundling a
 * theme's images, reading an uploaded theme file. **Never a way to serve a
 * file to a person** (G5): that is {@link signedDownloadUrl}.
 */
export async function downloadFile(bucket: string, path: string): Promise<DownloadResult> {
  const client = storageClient();
  if (!client) return unavailable();
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) return { ok: false, code: "download_failed", message: error?.message ?? "no data returned" };
  return { ok: true, bytes: new Uint8Array(await data.arrayBuffer()), contentType: data.type };
}

export type SignedUploadResult =
  | { ok: true; url: string; token: string; path: string }
  | StorageUnavailable
  | { ok: false; code: "sign_failed"; message: string };

/**
 * A one-time URL the browser uploads a private file to directly (`PUT`), so
 * the bytes never pass through a function — whose request body Vercel caps at
 * 4.5 MB. Used for theme files (D53). Overwrites whatever is at `path`.
 */
export async function signedUploadUrl(path: string): Promise<SignedUploadResult> {
  const client = storageClient();
  if (!client) return unavailable();
  const { data, error } = await client.storage.from(PRIVATE_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error || !data?.signedUrl) return { ok: false, code: "sign_failed", message: error?.message ?? "no URL returned" };
  return { ok: true, url: data.signedUrl, token: data.token, path: data.path };
}

/** Removes an object. Missing is not an error — deletion is meant to be idempotent. */
export async function deleteFile(bucket: string, path: string): Promise<void> {
  const client = storageClient();
  if (!client) return;
  await client.storage.from(bucket).remove([path]);
}

/**
 * Creates both buckets if they are absent.
 *
 * Idempotent, and safe to call on a cold environment. `public-media` is public;
 * `digital-assets` is **explicitly private** — the one flag on this whole module
 * that must never be flipped, since it is what makes a signed URL mean anything.
 */
export async function ensureBuckets(): Promise<{ created: string[]; skipped: string[] }> {
  const client = storageClient();
  if (!client) return { created: [], skipped: [] };

  const created: string[] = [];
  const skipped: string[] = [];

  for (const bucket of BUCKETS) {
    const { error } = await client.storage.createBucket(bucket.name, { public: bucket.public });
    if (error) skipped.push(bucket.name);
    else created.push(bucket.name);
  }
  return { created, skipped };
}

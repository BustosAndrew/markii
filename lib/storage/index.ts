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
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-only — never a " +
      "NEXT_PUBLIC_ variable). See .env.example.",
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
  | { ok: false; code: "upload_failed"; message: string; resolution?: string };

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

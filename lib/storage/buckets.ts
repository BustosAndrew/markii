/**
 * Bucket names and their privacy flags (§18.8, D6).
 *
 * Split out from `lib/storage/index.ts` because that module is `server-only` —
 * a guard the service-role client needs and a setup script cannot satisfy, since
 * `server-only` resolves only inside a Next build. Keeping the definitions here
 * means `scripts/ensure-buckets.ts` provisions exactly what the app expects
 * instead of a second copy of the names that can drift from it.
 *
 * **This file holds no credentials and creates no client.** Everything that
 * touches the service-role key stays behind the `server-only` boundary.
 */

export const PUBLIC_BUCKET = "public-media";
export const PRIVATE_BUCKET = "digital-assets";

/**
 * The privacy flag is the security boundary, not a preference.
 *
 * `public-media` is public because storefront HTML and JSON-LD reference product
 * images directly — a signed URL would expire out of a cached page and break
 * agent legibility. `digital-assets` is private because it holds the files
 * merchants sell; making it public would silently defeat every download limit in
 * §18.8, since anyone who ever saw a URL would keep the product forever.
 */
export const BUCKETS = [
  { name: PUBLIC_BUCKET, public: true },
  { name: PRIVATE_BUCKET, public: false },
] as const;

import { and, eq, gte, sql } from "drizzle-orm";
import { digitalAssets, downloadEvents, type DbHandle } from "../db";
import type { Entitlements } from "../plans";

/**
 * Storage and egress metering against the G5 quotas.
 *
 * G5's finding is the reason both are metered rather than just storage: at
 * Supabase rates a 2 GB course video costs **$0.25/month to store and $18 to
 * deliver 100 times**. Gating storage alone would gate the cheap half and leave
 * the expensive one uncapped — "gate both, or the gate does nothing".
 *
 * The quotas are the plan table in `docs/PRICING.md` §3, signed off with the
 * plan prices on 2026-08-10, and `lib/plans.ts` is their only representation in
 * code — this module converts, it does not restate them.
 *
 * **The two quotas are enforced differently, and on purpose:**
 *
 * - **Storage is enforced at upload.** An upload that would take the org past
 *   its allowance is refused. That is the merchant's own action, refused before
 *   any byte is stored; files already stored keep serving, so a merchant who
 *   downgrades below what they hold loses the ability to add, never what their
 *   customers bought.
 * - **Delivery is reported, never enforced and never billed.** Cutting off
 *   downloads would refuse a paying shopper something they already bought, and
 *   the meter counts bytes *authorised*, not delivered (`download_events`), so
 *   it over-counts every abandoned transfer — a number that may sit on Markii's
 *   cost accounting but not on a merchant's invoice. Bandwidth abuse is bounded
 *   instead by the per-link fair-use throttle (`DOWNLOAD_RATE_LIMIT`), which
 *   needs no measurement to be right.
 */

export type MediaQuota = { storageBytes: number; deliveryBytes: number };

/** How each quota is applied. A field, so a screen never has to infer it. */
export type MediaEnforcement = {
  /** An upload over the allowance is refused with `QUOTA_EXCEEDED`. */
  storage: "enforced";
  /** Measured against the allowance and shown; nothing is refused or billed on it. */
  delivery: "reported";
};

const GIB = 1024 ** 3;

/** The plan's allowance in bytes. GB here are GiB, as Supabase bills them. */
export function mediaQuotaFrom(media: Entitlements["media"]): MediaQuota {
  return {
    storageBytes: media.storageGb * GIB,
    deliveryBytes: media.monthlyEgressGb * GIB,
  };
}

export type MediaUsage = {
  storageBytes: number;
  deliveryBytes: number;
  periodStart: string;
  quota: MediaQuota | null;
  /** Fraction of quota used, or null when no quota was supplied. */
  storageRatio: number | null;
  deliveryRatio: number | null;
  enforcement: MediaEnforcement;
};

export const MEDIA_ENFORCEMENT: MediaEnforcement = { storage: "enforced", delivery: "reported" };

export type StorageCheck =
  | { allowed: true }
  | {
      allowed: false;
      storageBytes: number;
      quotaBytes: number;
      fileBytes: number;
      /** How much would have to be freed for this file to fit. */
      overByBytes: number;
    };

/**
 * Whether a file of `fileBytes` fits in what is left.
 *
 * **The file must fit, not merely start under the line.** Allowing any upload
 * while usage is below the quota would let a merchant at 9.9 GB of 10 store a
 * 2 GB file and sit 19% over — a quota that is a suggestion for whoever
 * uploads the largest file last.
 *
 * Exactly at the allowance is allowed: the plan says 10 GB, and 10 GB is
 * inside it.
 */
export function storageAllows(storageBytes: number, fileBytes: number, quota: MediaQuota): StorageCheck {
  const after = storageBytes + fileBytes;
  if (after <= quota.storageBytes) return { allowed: true };
  return {
    allowed: false,
    storageBytes,
    quotaBytes: quota.storageBytes,
    fileBytes,
    overByBytes: after - quota.storageBytes,
  };
}

/** Start of the current calendar month, UTC — the window delivery is metered over. */
export function currentPeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Storage and month-to-date delivery for one org.
 *
 * Storage sums `digital_assets.size_bytes` rather than asking Storage for a
 * total: the API has no cheap per-prefix aggregate, and the size recorded at
 * upload is the same number. Public product images are deliberately **not**
 * counted — G5's quotas are about the files a merchant sells, and counting a
 * few hundred kilobytes of thumbnails against a 10 GB allowance would be noise
 * that makes the number less useful, not more.
 */
export async function mediaUsageFor(
  db: DbHandle,
  orgId: string,
  opts: { quota?: MediaQuota | null; now?: Date } = {},
): Promise<MediaUsage> {
  const periodStart = currentPeriodStart(opts.now);

  const [stored] = await db
    .select({ bytes: sql<string>`coalesce(sum(${digitalAssets.sizeBytes}), 0)` })
    .from(digitalAssets)
    .where(eq(digitalAssets.orgId, orgId));

  const [delivered] = await db
    .select({ bytes: sql<string>`coalesce(sum(${downloadEvents.bytes}), 0)` })
    .from(downloadEvents)
    .where(and(eq(downloadEvents.orgId, orgId), gte(downloadEvents.createdAt, periodStart)));

  const storageBytes = Number(stored?.bytes ?? 0);
  const deliveryBytes = Number(delivered?.bytes ?? 0);
  const quota = opts.quota ?? null;

  return {
    storageBytes,
    deliveryBytes,
    periodStart: periodStart.toISOString(),
    quota: quota ? { ...quota } : null,
    storageRatio: quota ? storageBytes / quota.storageBytes : null,
    deliveryRatio: quota ? deliveryBytes / quota.deliveryBytes : null,
    enforcement: MEDIA_ENFORCEMENT,
  };
}

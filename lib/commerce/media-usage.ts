import { and, eq, gte, sql } from "drizzle-orm";
import { digitalAssets, downloadEvents, type DbHandle } from "../db";

/**
 * Storage and egress metering against the G5 quotas.
 *
 * G5's finding is the reason both are metered rather than just storage: at
 * Supabase rates a 2 GB course video costs **$0.25/month to store and $18 to
 * deliver 100 times**. Gating storage alone would gate the cheap half and leave
 * the expensive one uncapped — "gate both, or the gate does nothing".
 *
 * Quotas here are the **proposed** numbers from G5, which the decision register
 * marks as needing sign-off alongside D1. They are therefore reported as a
 * measured usage figure against a stated allowance, never enforced by blocking
 * an upload or a download — enforcing an unsigned-off number would cut off a
 * paying merchant's customers over a figure nobody has agreed to.
 */

/** G5's proposed quotas. Storage in bytes, delivery per calendar month. */
export const MEDIA_QUOTAS = {
  starter: { storageBytes: 10 * 1024 ** 3, deliveryBytes: 50 * 1024 ** 3 },
  growth: { storageBytes: 50 * 1024 ** 3, deliveryBytes: 250 * 1024 ** 3 },
  scale: { storageBytes: 250 * 1024 ** 3, deliveryBytes: 1024 ** 4 },
} as const;

export type PlanKey = keyof typeof MEDIA_QUOTAS;

export type MediaUsage = {
  storageBytes: number;
  deliveryBytes: number;
  periodStart: string;
  quota: { storageBytes: number; deliveryBytes: number } | null;
  /** Fraction of quota used, or null when the plan has no quota on record. */
  storageRatio: number | null;
  deliveryRatio: number | null;
  /**
   * Always true for now, and said out loud: these figures are measured but the
   * quotas they are measured against are not signed off (G5), so nothing is
   * blocked on them.
   */
  advisoryOnly: true;
};

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
  opts: { plan?: PlanKey | null; now?: Date } = {},
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
  const quota = opts.plan ? MEDIA_QUOTAS[opts.plan] : null;

  return {
    storageBytes,
    deliveryBytes,
    periodStart: periodStart.toISOString(),
    quota: quota ? { ...quota } : null,
    storageRatio: quota ? storageBytes / quota.storageBytes : null,
    deliveryRatio: quota ? deliveryBytes / quota.deliveryBytes : null,
    advisoryOnly: true,
  };
}

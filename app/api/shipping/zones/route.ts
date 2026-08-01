import { and, asc, eq, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, shippingRates, shippingZones } from "@/lib/db";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/shipping/zones` (§18.6) — zones with their rates.
 *
 * Writes go through `shipping.createZone` / `updateZone` / `deleteZone` — every
 * mutation runs through the action registry (§22 rule 1).
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const conds: SQL[] = [siteScope(orgId, shippingZones.siteId)];
    const siteId = intParam(sp, "siteId");
    if (siteId != null) conds.push(eq(shippingZones.siteId, siteId));

    const zones = await db
      .select()
      .from(shippingZones)
      .where(and(...conds))
      .orderBy(asc(shippingZones.id));

    // Rates are loaded per zone rather than joined so a zone with no rates still
    // appears — an empty zone is the configuration state a merchant most needs
    // to see, since it silently refuses every checkout to that destination.
    const items = [];
    for (const zone of zones) {
      const rates = await db
        .select()
        .from(shippingRates)
        .where(eq(shippingRates.zoneId, zone.id))
        .orderBy(asc(shippingRates.position), asc(shippingRates.id));
      items.push({
        ...zone,
        rates,
        rateCount: rates.length,
        ...(rates.length === 0
          ? {
              warning:
                "This zone has no rates, so checkout is refused for every destination it " +
                "covers. Add a rate or delete the zone.",
            }
          : {}),
        createdAt: zone.createdAt.toISOString(),
        updatedAt: zone.updatedAt.toISOString(),
      });
    }

    return NextResponse.json({ items, total: items.length });
  },
  { permission: "commerce.read" },
);

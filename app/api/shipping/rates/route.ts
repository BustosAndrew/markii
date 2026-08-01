import { and, asc, eq, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, shippingRates, shippingZones } from "@/lib/db";
import { siteScope } from "@/lib/tenancy";

/**
 * `GET /api/shipping/rates` (§18.6) — every rate across the org's zones.
 *
 * Writes go through `shipping.createRate` / `updateRate` / `deleteRate`.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    // Scoped through the zone: a rate has no site of its own, so tenancy is
    // resolved the only place it exists.
    const conds: SQL[] = [siteScope(orgId, shippingZones.siteId)];
    const zoneId = intParam(sp, "zoneId");
    if (zoneId != null) conds.push(eq(shippingRates.zoneId, zoneId));
    const siteId = intParam(sp, "siteId");
    if (siteId != null) conds.push(eq(shippingZones.siteId, siteId));

    const rows = await db
      .select({ rate: shippingRates, zone: shippingZones })
      .from(shippingRates)
      .innerJoin(shippingZones, eq(shippingZones.id, shippingRates.zoneId))
      .where(and(...conds))
      .orderBy(asc(shippingZones.id), asc(shippingRates.position), asc(shippingRates.id));

    return NextResponse.json({
      items: rows.map(({ rate, zone }) => ({
        ...rate,
        zone: { id: zone.id, name: zone.name, siteId: zone.siteId },
        createdAt: rate.createdAt.toISOString(),
        updatedAt: rate.updatedAt.toISOString(),
      })),
      total: rows.length,
    });
  },
  { permission: "commerce.read" },
);

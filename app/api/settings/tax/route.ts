import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, sites, taxSettings } from "@/lib/db";
import { stripeConfigured } from "@/lib/payments";
import { ownSites } from "@/lib/tenancy";

/**
 * `GET /api/settings/tax` (§18.6) — a store's tax configuration.
 *
 * `PUT` is `tax.updateSettings` in the action registry (§22 rule 1). It is
 * `high` risk: an incorrect rate is charged to every shopper and becomes a
 * liability the merchant cannot edit away afterwards.
 *
 * **Markii never gives tax advice** (`docs/DECISIONS.md` G2). Under Connect
 * Standard the merchant is the seller of record and the taxpayer; this endpoint
 * reports what they configured and whether it can actually run.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const siteId = intParam(new URL(req.url).searchParams, "siteId");
    if (siteId == null) throw badRequest("siteId is required");

    const [site] = await db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(and(eq(sites.id, siteId), ownSites(orgId)))
      .limit(1);
    if (!site) throw badRequest("Unknown store");

    const [row] = await db
      .select()
      .from(taxSettings)
      .where(eq(taxSettings.siteId, siteId))
      .limit(1);

    const provider = row?.provider ?? "none";

    /**
     * Whether the chosen provider can actually calculate. A store set to
     * `stripe` with no credentials, or `manual` with no rates, has a
     * configuration that looks complete and refuses every checkout — so the
     * state is reported here rather than discovered by a shopper.
     */
    const operational =
      provider === "none"
        ? { ok: true as const }
        : provider === "manual"
          ? (row?.manualRates.length ?? 0) > 0
            ? { ok: true as const }
            : {
                ok: false as const,
                reason: "No manual rates configured — every checkout will be refused.",
              }
          : stripeConfigured()
            ? { ok: false as const, reason: "Stripe Tax is not implemented yet (§18.6)." }
            : {
                ok: false as const,
                reason: "Stripe Tax is selected but this environment has no Stripe credentials.",
              };

    return NextResponse.json({
      siteId,
      provider,
      pricesIncludeTax: row?.pricesIncludeTax ?? true,
      manualRates: row?.manualRates ?? [],
      defaultTaxCode: row?.defaultTaxCode ?? null,
      registrations: row?.registrations ?? [],
      operational,
      configured: Boolean(row),
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      /** Not advice — a pointer to where advice actually comes from. */
      disclaimer:
        "Markii does not provide tax advice. You are the seller of record and responsible for " +
        "your own registrations and filings. Consult a tax professional.",
    });
  },
  { permission: "commerce.read" },
);

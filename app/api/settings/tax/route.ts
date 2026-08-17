import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, intParam } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, sites, taxSettings } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import { stripeConfigured } from "@/lib/payments";
import { taxAccountStatus } from "@/lib/payments/stripe-tax";
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

/**
 * The three Stripe Tax facts, kept apart (§18.6).
 *
 * They fail independently and want different people: `platform` is Markii's
 * credentials, `connected` and `status` are the merchant's Stripe account, and
 * `activeRegistrations` is the merchant again but in a different corner of the
 * same dashboard. Merging them into one tick is how a merchant spends an
 * afternoon fixing the wrong thing — the same reason the domain status surface
 * (§16) keeps ownership, pointing, and platform apart.
 */
type StripeTaxFacts = {
  /** Markii's own Stripe credentials. Ours to fix. */
  platform: boolean;
  /** Whether this org has connected a Stripe account at all. */
  connected: boolean;
  /** Stripe's own word for the account's Tax activation. */
  status: "active" | "pending" | "unknown" | "unavailable";
  /** What Stripe still wants from the merchant, verbatim. */
  missing: string[];
  /**
   * **Zero is the dangerous number.** Stripe Tax with no registration calculates
   * a legitimate zero everywhere, so the store looks configured, charges nothing,
   * and the merchant finds out when they file. Null means Markii could not read
   * the count — not that there are none.
   */
  activeRegistrations: number | null;
  /** Present only when Stripe refused to answer at all. */
  error?: string;
};

async function stripeTaxFacts(orgId: string): Promise<StripeTaxFacts> {
  if (!stripeConfigured()) {
    return {
      platform: false,
      connected: false,
      status: "unavailable",
      missing: [],
      activeRegistrations: null,
    };
  }

  const connection = await getIntegration(orgId, "stripe");
  const accountId = connection?.status === "connected" ? connection.config.accountId : null;
  if (!accountId) {
    return {
      platform: true,
      connected: false,
      status: "unavailable",
      missing: [],
      activeRegistrations: null,
    };
  }

  /**
   * Read live rather than cached at connect time. A merchant activates Stripe
   * Tax in their own dashboard, at a moment Markii is never told about, so a
   * stored flag would be stale in the direction that reports a working store as
   * broken.
   */
  const status = await taxAccountStatus(accountId);
  if (!status.ok) {
    return {
      platform: true,
      connected: true,
      status: "unavailable",
      missing: [],
      activeRegistrations: null,
      error: status.reason,
    };
  }

  return {
    platform: true,
    connected: true,
    status: status.status,
    missing: status.missing,
    activeRegistrations: status.activeRegistrations,
  };
}

/** The one-line verdict, derived from the same facts rather than a second guess. */
function stripeOperational(facts: StripeTaxFacts): { ok: true } | { ok: false; reason: string } {
  if (!facts.platform) {
    return {
      ok: false,
      reason: "Stripe Tax is selected but this environment has no Stripe credentials.",
    };
  }
  if (!facts.connected) {
    return {
      ok: false,
      reason:
        "Stripe Tax is selected but this store is not connected to Stripe. Stripe Tax runs on " +
        "your own account, with your own registrations — connect it in Settings → Payments.",
    };
  }
  if (facts.status === "unavailable") {
    return {
      ok: false,
      reason: facts.error
        ? `Stripe could not report your tax settings: ${facts.error}`
        : "Stripe could not report your tax settings.",
    };
  }
  if (facts.status !== "active") {
    return {
      ok: false,
      reason:
        "Stripe Tax is not active on your Stripe account yet" +
        (facts.missing.length ? ` — Stripe still needs: ${facts.missing.join(", ")}.` : ".") +
        " Activate it in your own Stripe dashboard; every checkout is refused until then.",
    };
  }

  /**
   * Active with nowhere registered calculates a real zero everywhere, so the
   * checkout succeeds and the merchant collects nothing. Not a refusal — Stripe
   * is answering correctly and a merchant below every threshold genuinely owes
   * nothing — but it is the state most likely to be a mistake, so it is said out
   * loud rather than shown as a tick.
   */
  if (facts.activeRegistrations === 0) {
    return {
      ok: false,
      reason:
        "Stripe Tax is active but your account has no registrations, so it will calculate zero " +
        "tax everywhere. Add the jurisdictions you are registered in from your Stripe dashboard.",
    };
  }

  return { ok: true };
}

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
     * Asked once, and only when it can matter. Stripe is a live round trip, so a
     * store on `manual` or `none` never pays for a call about a service it does
     * not use.
     */
    const facts = provider === "stripe" ? await stripeTaxFacts(orgId) : null;

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
          : stripeOperational(facts!);

    return NextResponse.json({
      siteId,
      provider,
      pricesIncludeTax: row?.pricesIncludeTax ?? true,
      manualRates: row?.manualRates ?? [],
      defaultTaxCode: row?.defaultTaxCode ?? null,
      registrations: row?.registrations ?? [],
      operational,
      /** The facts behind `operational`, un-merged. Null on any other provider. */
      stripeTax: facts,
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

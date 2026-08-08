import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { badRequest, notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, organizations } from "@/lib/db";
import { entitlementsFor } from "@/lib/plans";

/**
 * `/api/billing/addons/:addon` (§17) — toggle an add-on entitlement.
 *
 * **Both add-ons refuse, and the reason is the feature, not the plumbing.**
 * Agent Ops and Chargeback Assist are Phase F, deferred past launch
 * (`docs/DECISIONS.md` §G10, `CLAUDE.md`). Neither product exists. Selling a
 * subscription to one would take $29 or $19 a month for nothing at all — a
 * worse version of the fabricated-success rule in `CLAUDE.md`, because this one
 * has a card behind it.
 *
 * So this is not "not implemented yet" in the sense of missing wiring. Every
 * piece it would need is already here — `resolvePrice` would find a price,
 * `changeSubscriptionPrice` would add the item, the mirror would record it. It
 * refuses because **the thing being sold does not exist**, and that is worth
 * stating explicitly, because the next person to read `addOnAgentOps` sitting
 * unused on the org row will otherwise wire exactly that and ship it.
 *
 * `GET` is real and useful: it reports what the org actually has, including
 * Chargeback Assist arriving **included** on Scale rather than purchased — the
 * one path by which an add-on entitlement is legitimately true today.
 */

const ADDONS = {
  agentOps: {
    label: "Agent Ops",
    monthlyPriceMinor: 29_00,
    phase: "F",
    why: "The chat ops product is not built (docs/AGENT-OPS.md; chat ships last).",
  },
  chargebackAssist: {
    label: "Chargeback Assist",
    monthlyPriceMinor: 19_00,
    phase: "F",
    why: "Chargeback Assist is not built (docs/PLAN.md Phase F).",
  },
} as const;

type AddonKey = keyof typeof ADDONS;

function parseAddon(raw: string): AddonKey {
  if (raw in ADDONS) return raw as AddonKey;
  throw notFound(`Add-on "${raw}"`);
}

export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { addon } = await params;
    const key = parseAddon(addon);

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw notFound("Organization");

    const entitlements = entitlementsFor(org);
    const spec = ADDONS[key];
    const purchased = key === "agentOps" ? org.addOnAgentOps : org.addOnChargebackAssist;

    return NextResponse.json({
      addon: key,
      label: spec.label,
      /** What gates actually read. Included-by-plan and purchased both land here. */
      entitled: entitlements.addOns[key],
      /**
       * Included beats purchased, and the two are reported apart so a merchant
       * on Scale is never asked to buy something their plan already gives them.
       */
      includedInPlan: entitlements.addOns[key] && !purchased,
      purchased,
      pricing: {
        monthlyPriceMinor: spec.monthlyPriceMinor,
        currency: "USD",
        status: "proposed" as const,
      },
      availability: {
        code: "not_built" as const,
        message: `${spec.label} cannot be purchased — the product does not exist yet.`,
        detail: spec.why,
      },
    });
  },
  { permission: "billing.read" },
);

/**
 * Refuses to sell, and says why in terms of the product rather than the code.
 *
 * `409` rather than `503`: a configuration-required would say "set a credential
 * and this works", and no credential makes an unbuilt product exist. This is a
 * conflict with the state of the world.
 */
const refuseToSell = async (raw: string) => {
  const key = parseAddon(raw);
  const spec = ADDONS[key];
  return NextResponse.json(
    {
      error: {
        code: "CONFLICT",
        message: `${spec.label} is not for sale — the product does not exist yet.`,
        details: {
          reason: spec.why,
          phase: spec.phase,
          resolution:
            "Nothing to configure. Build the add-on first; the billing path for it is the same " +
            "one plan changes already use (billing.changePlan, lib/billing/stripe-billing.ts).",
          /**
           * Stated because the tempting shortcut is to flip
           * `organizations.add_on_*` directly and move on. That grants the
           * entitlement with nothing sold — the same hole the plan-change route
           * refuses — and it would grant access to a feature that does not
           * exist, so the merchant gets nothing either way.
           */
          note:
            "Do not set organizations.add_on_agent_ops / add_on_chargeback_assist by hand to work " +
            "around this. Entitlements must follow something actually sold.",
        },
      },
    },
    { status: 409 },
  );
};

export const POST = orgHandler(
  async (_req, { params }) => refuseToSell((await params).addon),
  { permission: "billing.write" },
);

export const DELETE = orgHandler(
  async (_req, { params, orgId }) => {
    const key = parseAddon((await params).addon);
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw notFound("Organization");

    const purchased = key === "agentOps" ? org.addOnAgentOps : org.addOnChargebackAssist;
    /**
     * Cancelling something never sold is a no-op, not an error — but it must not
     * report success either, or a screen would show "removed" for a thing that
     * was never there. Nothing has ever been purchasable, so this is currently
     * always the answer.
     */
    if (!purchased) {
      throw badRequest(`${ADDONS[key].label} is not purchased on this organization.`);
    }
    return refuseToSell(key);
  },
  { permission: "billing.write" },
);

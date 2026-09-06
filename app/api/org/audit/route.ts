import { NextResponse } from "next/server";
import { boolParam, dateRange, enumParam, pagination } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { AUDIT_ACTOR_TYPES, AUDIT_RISK_TIERS } from "@/lib/org/audit";
import { listOrgAudit } from "@/lib/org/audit-query";

/**
 * `GET /api/org/audit` (§16) — who did what in this org, newest first.
 *
 * **The same rows `/api/actions/invocations` serves**, deliberately. §22 rule 5
 * already audits every mutation, so a second table written alongside it would
 * only be a second thing to forget. The two routes differ in framing, not in
 * source: this one resolves actor names, lifts the touched entities out of the
 * diff, reports where the call came from, and filters the way a person
 * reviewing a history asks — by actor, by outcome, by date.
 *
 * §16 shipped without this for a documented reason: the log would have been
 * permanently empty until the first Phase C actions existed. They do now.
 */
export const GET = orgHandler(
  async (req, { orgId }) => {
    const sp = new URL(req.url).searchParams;
    const { page, limit, offset } = pagination(sp);
    const { from, to } = dateRange(sp);

    const { items, total } = await listOrgAudit(
      orgId,
      {
        actorType: enumParam(sp, "actorType", AUDIT_ACTOR_TYPES),
        actorId: sp.get("actorId") || undefined,
        actionId: sp.get("actionId") || undefined,
        riskTier: enumParam(sp, "riskTier", AUDIT_RISK_TIERS),
        /**
         * `?ok=false` is the incident view — every attempt that was refused.
         * Failures are audited precisely so this question has an answer.
         */
        ok: boolParam(sp, "ok"),
        from,
        to,
      },
      { limit, offset },
    );

    return NextResponse.json({ items, total, page, limit });
  },
  /**
   * **`org.audit`, not `org.read`.** `org.read` sits in `READ_ONLY`, so every
   * role holds it — and this is not a read of the merchant's own data but of
   * everyone's activity, carrying each invocation's input. An `analyst` seat
   * should not come with the history of every payout-address and discount
   * change. Only `owner` and `administrator` resolve to it.
   */
  { permission: "org.audit" },
);

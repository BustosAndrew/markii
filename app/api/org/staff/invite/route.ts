import { and, count, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { conflict } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { newId } from "@/lib/auth/provisioning";
import { serializeStaff } from "@/lib/auth/serialize";
import { db, staff } from "@/lib/db";
import { entitlementsFor } from "@/lib/plans";

const inviteSchema = z.object({
  email: z.email().max(255),
  role: z.enum([
    "administrator",
    "catalog_manager",
    "commerce_manager",
    "analyst",
    "developer",
    "viewer",
  ]),
  storeIds: z.union([z.literal("all"), z.array(z.number().int().positive())]).default("all"),
});

/**
 * `POST /api/org/staff/invite` — `201` with `status: "invited"` (§16).
 *
 * **`owner` is not an assignable role.** There is exactly one owner, recorded on
 * `organizations.ownerId`, and it changes only by an explicit transfer. Letting
 * it be handed out here would make "who owns billing" ambiguous.
 */
export const POST = orgHandler(
  async (req, { orgId, session }) => {
    const input = inviteSchema.parse(await req.json());
    const email = input.email.toLowerCase();

    const [existing] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.orgId, orgId), eq(staff.email, email)))
      .limit(1);
    if (existing) throw conflict(`${email} is already a member of this organization`);

    const seatLimit = entitlementsFor(session.org).staffSeatLimit;
    if (seatLimit !== null) {
      const [{ c }] = await db
        .select({ c: count() })
        .from(staff)
        .where(eq(staff.orgId, orgId));
      if (Number(c) >= seatLimit) {
        throw conflict(`Your plan allows ${seatLimit} staff seats`);
      }
    }

    const [row] = await db
      .insert(staff)
      .values({
        id: newId("stf"),
        orgId,
        // Populated when the invitee accepts and their auth user exists.
        userId: null,
        email,
        role: input.role,
        storeIds: input.storeIds,
        status: "invited",
      })
      .returning();

    /**
     * §16: "Never return an invitation as 'delivered' unless a mail provider
     * actually accepted it." Email plumbing is `docs/BACKEND.md` §6 and does not
     * exist yet, so the record is real and the delivery is not — and the
     * response says exactly that rather than implying an email is in flight.
     */
    return NextResponse.json(
      {
        ...serializeStaff(row),
        invitationEmail: {
          sent: false,
          reason:
            "Email delivery is not configured yet — send this person their invitation another way.",
        },
      },
      { status: 201 },
    );
  },
  { permission: "org.staff" },
);

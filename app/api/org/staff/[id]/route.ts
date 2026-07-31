import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, forbidden, notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { serializeStaff } from "@/lib/auth/serialize";
import { db, staff } from "@/lib/db";

/** `PATCH`/`DELETE /api/org/staff/:id` — change role/scope, remove (§16). */

const staffUpdateSchema = z.object({
  role: z
    .enum([
      "administrator",
      "catalog_manager",
      "commerce_manager",
      "analyst",
      "developer",
      "viewer",
    ])
    .optional(),
  storeIds: z.union([z.literal("all"), z.array(z.number().int().positive())]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

/**
 * Loads a staff row **within the caller's org**, and refuses the two edits that
 * would otherwise be privilege escalation:
 *
 * 1. **Editing yourself.** A `catalog_manager` who can PATCH their own row can
 *    make themselves an administrator. Role changes are something others do to
 *    you.
 * 2. **Touching the owner.** The owner's access is recorded on
 *    `organizations.ownerId` and changes only by explicit transfer, so an
 *    administrator cannot demote or remove the person who owns billing.
 */
async function loadEditableMember(id: string, orgId: string, actingUserId: string) {
  const [member] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.id, id), eq(staff.orgId, orgId)))
    .limit(1);
  // 404, not 403 — a 403 would confirm the id exists in another org.
  if (!member) throw notFound("Staff member");

  if (member.userId && member.userId === actingUserId) {
    throw forbidden("You cannot change your own role or access");
  }
  if (member.role === "owner") {
    throw forbidden("The organization owner cannot be modified here — transfer ownership instead");
  }
  return member;
}

export const PATCH = orgHandler(
  async (req, { params, orgId, session }) => {
    const { id } = await params;
    await loadEditableMember(id, orgId, session.user.id);

    const input = staffUpdateSchema.parse(await req.json());
    if (Object.keys(input).length === 0) throw badRequest("No changes supplied");

    const [row] = await db
      .update(staff)
      .set(input)
      .where(and(eq(staff.id, id), eq(staff.orgId, orgId)))
      .returning();

    return NextResponse.json(serializeStaff(row));
  },
  { permission: "org.staff" },
);

export const DELETE = orgHandler(
  async (_req, { params, orgId, session }) => {
    const { id } = await params;
    await loadEditableMember(id, orgId, session.user.id);

    await db.delete(staff).where(and(eq(staff.id, id), eq(staff.orgId, orgId)));
    return NextResponse.json({ deleted: true, id });
  },
  { permission: "org.staff" },
);

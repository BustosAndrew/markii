import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { serializeStaff } from "@/lib/auth/serialize";
import { db, staff } from "@/lib/db";

/** `GET /api/org/staff` — list staff (§16). */
export const GET = orgHandler(
  async (_req, { orgId }) => {
    const rows = await db
      .select()
      .from(staff)
      .where(eq(staff.orgId, orgId))
      .orderBy(asc(staff.createdAt));
    return NextResponse.json({ items: rows.map(serializeStaff) });
  },
  // Deliberately `org.read`, not `org.staff`: seeing who your colleagues are is
  // not the same authority as changing what they can do.
  { permission: "org.read" },
);

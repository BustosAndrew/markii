import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ApiError, badRequest, handler, unauthorized } from "@/lib/api";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { db, staff } from "@/lib/db";
import { updateNameSchema } from "@/lib/validation";

/**
 * `POST /api/auth/update-name` — set the signed-in user's display name (§16).
 *
 * This is the name they chose — a person or a company — not a unique handle
 * and not the organization slug. It is written in two places so they cannot
 * drift: `user_metadata.name` (what `/api/me` reads) and every `staff.name`
 * row for this user (what Team and the audit log show).
 *
 * **Server-side, like every other auth mutation** (D30).
 */
export const POST = handler(async (req) => {
  const { name } = updateNameSchema.parse(await req.json());

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    throw new ApiError("INTERNAL", 503, "Authentication is not configured");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw unauthorized("Sign in to change your name");

  const { error } = await supabase.auth.updateUser({ data: { name } });
  if (error) throw badRequest(error.message);

  await db.update(staff).set({ name }).where(eq(staff.userId, user.id));

  return NextResponse.json({ ok: true, name });
});

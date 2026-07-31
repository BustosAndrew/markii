import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { orgHandler } from "@/lib/auth/handler";
import { serializeOrg } from "@/lib/auth/serialize";
import { db, organizations } from "@/lib/db";

/** `GET`/`PATCH /api/org` — org profile, billing email, currency (§16). */

const orgUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  billingEmail: z.email().max(255).optional(),
  /** ISO 4217. Uppercased on write so the minor-unit exponent lookup is stable (D31). */
  currency: z.string().length(3).regex(/^[A-Za-z]{3}$/).optional(),
  country: z.string().length(2).regex(/^[A-Za-z]{2}$/).optional(),
});

export const GET = orgHandler(
  async (_req, { session }) => NextResponse.json(serializeOrg(session.org)),
  { permission: "org.read" },
);

export const PATCH = orgHandler(
  async (req, { orgId }) => {
    const input = orgUpdateSchema.parse(await req.json());

    const [row] = await db
      .update(organizations)
      .set({
        ...input,
        ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
        ...(input.country ? { country: input.country.toUpperCase() } : {}),
        updatedAt: new Date(),
      })
      // Scoped to the session's org. `planId` is deliberately absent from the
      // schema: a merchant does not change their own plan by PATCHing it —
      // that goes through billing (§17).
      .where(eq(organizations.id, orgId))
      .returning();

    return NextResponse.json(serializeOrg(row));
  },
  { permission: "org.write" },
);

import "server-only";

import { eq } from "drizzle-orm";
import { slugify } from "../api";
import { db, organizations, staff, type Organization } from "../db";

/** Prefixed ids, so a value in a log says what it is without a lookup. */
export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

async function uniqueOrgSlug(base: string): Promise<string> {
  const root = slugify(base) || "org";
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const [taken] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  return `${root}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Creates a user's first organization and their owner staff record (§16:
 * sign-up "creates the user *and* their first org").
 *
 * **Idempotent by design.** Supabase deliberately returns a plausible-looking
 * user for an email that already exists, so that sign-up cannot be used to
 * enumerate accounts. A naive implementation therefore mints a second org every
 * time someone re-submits the sign-up form with an existing address. This
 * returns the existing org instead.
 *
 * Org and staff row are written in one transaction: an org whose owner has no
 * staff record is unreachable by its own creator.
 */
export async function ensureFirstOrg(
  userId: string,
  email: string,
): Promise<{ org: Organization; created: boolean }> {
  const existing = await db
    .select({ org: organizations })
    .from(staff)
    .innerJoin(organizations, eq(organizations.id, staff.orgId))
    .where(eq(staff.userId, userId))
    .limit(1);
  if (existing.length > 0) return { org: existing[0].org, created: false };

  const local = email.split("@")[0] ?? "store";
  const slug = await uniqueOrgSlug(local);

  const org = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(organizations)
      .values({
        id: newId("org"),
        name: `${local}'s organization`,
        slug,
        ownerId: userId,
        billingEmail: email,
      })
      .returning();

    await tx.insert(staff).values({
      id: newId("stf"),
      orgId: row.id,
      userId,
      email,
      role: "owner",
      storeIds: "all",
      // The creator is active immediately — an "invited" owner could never
      // accept their own invitation.
      status: "active",
      lastActiveAt: new Date(),
    });

    return row;
  });

  return { org, created: true };
}

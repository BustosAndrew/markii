import "server-only";

import { and, count, desc, eq, gte, ilike, isNotNull, or, sql } from "drizzle-orm";
import { notFound } from "@/lib/api";
import { db, organizations, sites, sql as rawSql, staff } from "@/lib/db";
import { accountStanding, serializeStanding } from "@/lib/billing/standing";
import {
  SIGNUP_REVIEW_THRESHOLD,
  SIGNUP_REVIEW_WINDOW_MS,
  signupBursts,
} from "@/lib/auth/signup-review";

/**
 * What an operator sees of merchants' orgs (G12) — enough to act on a
 * sign-up-review line and to confirm the action took, and no more.
 *
 * Deliberately not the org's full row: the operator's job here is standing
 * and suspension. Billing address, Stripe ids and entitlements are the
 * merchant's business and their own dashboard's.
 */

/**
 * **By id or slug**, because the digest names the slug and the audit row names
 * the id, and an operator arriving from either should not need a lookup.
 * Slugs are unique (`organizations_slug_uq`) so the two cannot collide with a
 * real row, only with each other, and an id is never shaped like a slug.
 */
export async function platformOrgView(idOrSlug: string) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(or(eq(organizations.id, idOrSlug), eq(organizations.slug, idOrSlug)))
    .limit(1);
  if (!org) throw notFound("Organization");

  const stores = await db
    .select({ id: sites.id, slug: sites.slug, name: sites.name, status: sites.status })
    .from(sites)
    .where(eq(sites.orgId, org.id));

  const members = await db
    .select({ userId: staff.userId, email: staff.email, role: staff.role, status: staff.status })
    .from(staff)
    .where(eq(staff.orgId, org.id));

  /**
   * Verified authenticators per member, read from Supabase's own
   * `auth.mfa_factors` — the same source `readMfaState` asks, so this cannot
   * say "enrolled" about a factor the sign-in gate does not count.
   */
  const userIds = members.map((m) => m.userId).filter((u): u is string => !!u);
  const factorRows = userIds.length
    ? await rawSql<{ user_id: string; n: number }[]>`
        select user_id::text, count(*)::int as n from auth.mfa_factors
        where status = 'verified' and user_id::text in ${rawSql(userIds)}
        group by user_id`
    : [];
  const factors = new Map(factorRows.map((r) => [r.user_id, r.n]));

  const standing = accountStanding(org);

  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    billingEmail: org.billingEmail,
    createdAt: org.createdAt.toISOString(),
    planId: org.planId,
    standing: serializeStanding(standing),
    /**
     * The reason, as recorded. `standing.message` above is the merchant's
     * "contact support" copy; the merchant reads the reason in their audit log.
     */
    suspension: org.suspendedAt
      ? {
          since: org.suspendedAt.toISOString(),
          reason: org.suspendedReason,
          by: org.suspendedBy,
        }
      : null,
    stores,
    /** Invited members have no `userId` yet and nothing to reset. */
    staff: members.map((m) => ({
      userId: m.userId,
      email: m.email,
      role: m.role,
      status: m.status,
      mfaEnrolled: m.userId ? (factors.get(m.userId) ?? 0) > 0 : false,
    })),
  };
}

export type PlatformOrgListFilters = {
  /** Matches name, slug or billing email, case-insensitively. */
  q?: string;
  /** `true` → only suspended orgs; `false` → only not; undefined → all. */
  suspended?: boolean;
  page: number;
  limit: number;
};

/**
 * The org list, newest first. Search is a plain `ILIKE` over three columns —
 * the table is small (one row per merchant) and an operator is typing a slug
 * or an address they have in front of them, not exploring.
 */
export async function listPlatformOrgs(filters: PlatformOrgListFilters) {
  const conds = [];
  if (filters.q?.trim()) {
    const needle = `%${filters.q.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    conds.push(
      or(
        ilike(organizations.name, needle),
        ilike(organizations.slug, needle),
        ilike(organizations.billingEmail, needle),
      ),
    );
  }
  if (filters.suspended === true) conds.push(isNotNull(organizations.suspendedAt));
  if (filters.suspended === false) conds.push(sql`${organizations.suspendedAt} is null`);
  const where = conds.length ? and(...conds) : undefined;

  const [{ total }] = await db.select({ total: count() }).from(organizations).where(where);

  const rows = await db
    .select({
      org: organizations,
      /**
       * Written out because drizzle renders column refs inside a subquery
       * unqualified, and `"org_id" = "id"` resolves both names inside `sites`
       * — a `text = integer` error at runtime, not a type error.
       */
      storeCount: sql<number>`(select count(*)::int from sites s where s.org_id = organizations.id)`,
    })
    .from(organizations)
    .where(where)
    .orderBy(desc(organizations.createdAt))
    .limit(filters.limit)
    .offset((filters.page - 1) * filters.limit);

  return {
    items: rows.map(({ org, storeCount }) => ({
      id: org.id,
      slug: org.slug,
      name: org.name,
      billingEmail: org.billingEmail,
      createdAt: org.createdAt.toISOString(),
      planId: org.planId,
      standing: serializeStanding(accountStanding(org)),
      suspendedAt: org.suspendedAt?.toISOString() ?? null,
      storeCount,
    })),
    total,
    page: filters.page,
    limit: filters.limit,
  };
}

/**
 * The sign-up review as a page rather than a mail: the same grouping the
 * digest uses (`signupBursts`), over a chosen number of days, plus the raw
 * recent list so an operator can look below the threshold when they want to.
 */
export async function platformSignups(days: number, now: Date = new Date()) {
  const since = new Date(now.getTime() - days * SIGNUP_REVIEW_WINDOW_MS);
  const rows = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      billingEmail: organizations.billingEmail,
      createdAt: organizations.createdAt,
      suspendedAt: organizations.suspendedAt,
    })
    .from(organizations)
    .where(gte(organizations.createdAt, since))
    .orderBy(desc(organizations.createdAt));

  const platformDomain = process.env.ROOT_DOMAIN?.trim().toLowerCase();
  const bursts = signupBursts(rows, SIGNUP_REVIEW_THRESHOLD, platformDomain ? [platformDomain] : []);

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    days,
    threshold: SIGNUP_REVIEW_THRESHOLD,
    total: rows.length,
    bursts: bursts.map((b) => ({
      domain: b.domain,
      count: b.count,
      orgs: b.orgs.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })),
    })),
    recent: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      billingEmail: r.billingEmail,
      createdAt: r.createdAt.toISOString(),
      suspended: r.suspendedAt !== null,
    })),
  };
}

/** The numbers on the admin overview, each a single aggregate query. */
export async function platformOverview(now: Date = new Date()) {
  const dayAgo = new Date(now.getTime() - SIGNUP_REVIEW_WINDOW_MS);
  const [[orgs], [suspended], [signups24h]] = await Promise.all([
    db.select({ n: count() }).from(organizations),
    db.select({ n: count() }).from(organizations).where(isNotNull(organizations.suspendedAt)),
    db.select({ n: count() }).from(organizations).where(gte(organizations.createdAt, dayAgo)),
  ]);

  const recentSuspensions = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      suspendedAt: organizations.suspendedAt,
      suspendedReason: organizations.suspendedReason,
    })
    .from(organizations)
    .where(isNotNull(organizations.suspendedAt))
    .orderBy(desc(organizations.suspendedAt))
    .limit(10);

  const signups = await platformSignups(1, now);

  return {
    orgs: orgs.n,
    suspended: suspended.n,
    signups24h: signups24h.n,
    flaggedDomains: signups.bursts.length,
    threshold: signups.threshold,
    recentSuspensions: recentSuspensions.map((r) => ({
      ...r,
      suspendedAt: r.suspendedAt!.toISOString(),
    })),
  };
}

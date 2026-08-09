import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/storefront/site-header";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { currentCustomer } from "@/lib/auth/shopper";
import { membershipStatus } from "@/lib/commerce/memberships";
import { customerMemberships, db, membershipTiers } from "@/lib/db";
import { loadSite } from "@/lib/storefront";
import { and, eq } from "drizzle-orm";

type Props = {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
};

export async function generateMetadata({
  params,
}: {
  params: Props["params"];
}): Promise<Metadata> {
  const { site: siteSlug } = await params;
  const data = await loadSite(siteSlug);
  if (!data) return {};
  return {
    title: `Account — ${data.site.name}`,
    // Never index a page whose whole content is one shopper's own records.
    robots: { index: false, follow: false },
  };
}

/**
 * `/account` on a storefront host (§18.3, §18.9) — sign in, and see which
 * memberships you hold.
 *
 * **No JavaScript at all — plain `<form method="post">`.** `CLAUDE.md` sanctions
 * exactly three storefront islands (cart, variant picker, checkout) and an
 * account page is not one of them, so the auth routes accept a form-encoded body
 * and answer with a 303 rather than JSON. Errors come back as a query parameter
 * because there is no client to hold them.
 */
export default async function AccountPage({ params, searchParams }: Props) {
  const { site: siteSlug } = await params;
  const { error, notice } = await searchParams;
  const data = await loadSite(siteSlug);
  if (!data) notFound();
  const { site, bundle, baseUrl } = data;
  if (site.status === "paused") notFound();

  const customer = await currentCustomer(site.id);

  const rows = customer
    ? await db
        .select({
          tierId: customerMemberships.tierId,
          name: membershipTiers.name,
          startsAt: customerMemberships.startsAt,
          endsAt: customerMemberships.endsAt,
          revokedAt: customerMemberships.revokedAt,
        })
        .from(customerMemberships)
        .innerJoin(membershipTiers, eq(membershipTiers.id, customerMemberships.tierId))
        .where(
          and(
            eq(customerMemberships.customerId, customer.id),
            eq(membershipTiers.siteId, site.id),
          ),
        )
    : [];

  const now = new Date();
  const topCategories = bundle.categories.filter((c) => !c.parentSlug);

  return (
    <ThemeRoot themeId={site.themeId ?? "studio"}>
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        nav={topCategories.map((c) => ({ name: c.name, href: `${baseUrl}/c/${c.slug}` }))}
      />
      <main className="sf-main">
        <h1 className="sf-title">Your account</h1>

        {error ? (
          <p className="sf-gate sf-gate-locked" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="sf-gate">{notice}</p> : null}

        {customer ? (
          <>
            <p className="sf-muted">Signed in as {customer.email}</p>

            <h2>Memberships</h2>
            {rows.length === 0 ? (
              <p>You do not hold a membership at this store yet.</p>
            ) : (
              <ul>
                {rows.map((m) => {
                  const status = membershipStatus(m, now);
                  return (
                    <li key={m.tierId}>
                      <strong>{m.name}</strong> — {status}
                      {/*
                        Expiry is shown for an active membership and for one that
                        has lapsed, because "when does this run out" and "when
                        did it" are the two questions this page exists to answer.
                      */}
                      {m.endsAt ? (
                        <span className="sf-muted">
                          {status === "expired" ? " · ended " : " · renews or ends "}
                          {m.endsAt.toISOString().slice(0, 10)}
                        </span>
                      ) : (
                        <span className="sf-muted"> · no expiry</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <form className="sf-form" method="post" action={`${baseUrl}/api/auth/sign-out`}>
              <button type="submit">Sign out</button>
            </form>
          </>
        ) : (
          <>
            <p>Sign in to see your memberships and any members-only products.</p>

            <h2>Sign in</h2>
            <form className="sf-form" method="post" action={`${baseUrl}/api/auth/sign-in`}>
              <label htmlFor="signin-email">Email</label>
              <input id="signin-email" name="email" type="email" autoComplete="email" required />
              <label htmlFor="signin-password">Password</label>
              <input
                id="signin-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
              <button type="submit">Sign in</button>
            </form>

            <h2>Create an account</h2>
            <form className="sf-form" method="post" action={`${baseUrl}/api/auth/sign-up`}>
              <label htmlFor="signup-email">Email</label>
              <input id="signup-email" name="email" type="email" autoComplete="email" required />
              <label htmlFor="signup-password">Password</label>
              <input
                id="signup-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
              />
              <button type="submit">Create account</button>
            </form>
          </>
        )}
      </main>
    </ThemeRoot>
  );
}

import type { Metadata } from "next";
import { and, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/storefront/site-header";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { currentCustomer } from "@/lib/auth/shopper";
import { membershipStatus } from "@/lib/commerce/memberships";
import { customerMemberships, db, membershipTiers } from "@/lib/db";
import { loadSite } from "@/lib/storefront";

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
    robots: { index: false, follow: false },
  };
}

/**
 * `/account` on a storefront host (§18.3, §18.9) — sign in, see memberships,
 * cancel renewal.
 *
 * **No JavaScript — plain `<form method="post">`.** Cart / variant / checkout
 * are the only sanctioned storefront islands.
 *
 * **`status` and `renews` are shown apart.** Access and billing are different
 * questions — a cancelled membership stays active until `accessEndsAt`.
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
          id: customerMemberships.id,
          tierId: customerMemberships.tierId,
          name: membershipTiers.name,
          startsAt: customerMemberships.startsAt,
          endsAt: customerMemberships.endsAt,
          revokedAt: customerMemberships.revokedAt,
          stripeSubscriptionId: customerMemberships.stripeSubscriptionId,
          renewalCanceledAt: customerMemberships.renewalCanceledAt,
        })
        .from(customerMemberships)
        .innerJoin(membershipTiers, eq(membershipTiers.id, customerMemberships.tierId))
        .where(
          and(
            eq(customerMemberships.customerId, customer.id),
            eq(membershipTiers.siteId, site.id),
          ),
        )
        .orderBy(desc(customerMemberships.startsAt))
    : [];

  const now = new Date();
  const topCategories = bundle.categories.filter((c) => !c.parentSlug);

  return (
    <ThemeRoot themeId={site.themeId ?? "studio"}>
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        accountHref={`${baseUrl}/account`}
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
              <ul className="sf-list">
                {rows.map((m) => {
                  const status = membershipStatus(m, now);
                  const renews =
                    Boolean(m.stripeSubscriptionId) && m.renewalCanceledAt === null;
                  const accessEnds = m.endsAt
                    ? m.endsAt.toISOString().slice(0, 10)
                    : null;
                  return (
                    <li key={m.id}>
                      <div>
                        <strong>{m.name}</strong>
                        <p className="sf-muted">
                          Access: {status}
                          {accessEnds
                            ? status === "expired"
                              ? ` · ended ${accessEnds}`
                              : ` · access through ${accessEnds}`
                            : " · no expiry"}
                        </p>
                        <p className="sf-muted">
                          Billing:{" "}
                          {renews
                            ? "renews automatically"
                            : m.stripeSubscriptionId
                              ? "will not renew"
                              : "one-off — does not renew"}
                        </p>
                        {renews ? (
                          <form
                            className="sf-form"
                            method="post"
                            action={`${baseUrl}/api/account/memberships/${m.id}/renewal`}
                          >
                            <button type="submit">
                              Cancel renewal
                              {accessEnds ? ` (keep access until ${accessEnds})` : ""}
                            </button>
                          </form>
                        ) : null}
                      </div>
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
            <p>Sign in to see your memberships and manage renewals.</p>

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

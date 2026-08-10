import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CartCheckout } from "@/components/storefront/cart-checkout";
import { SiteHeader } from "@/components/storefront/site-header";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { loadSite } from "@/lib/storefront";

type Props = { params: Promise<{ site: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadSite((await params).site);
  if (!data) return {};
  return {
    title: `Cart — ${data.site.name}`,
    robots: { index: false },
  };
}

export default async function CartPage({ params }: Props) {
  const data = await loadSite((await params).site);
  if (!data || data.site.status === "paused") notFound();
  const { site, bundle, baseUrl } = data;
  const themeId = site.themeId ?? "studio";
  const topCategories = bundle.categories.filter((c) => !c.parentSlug);

  return (
    <ThemeRoot themeId={themeId}>
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        accountHref={`${baseUrl}/account`}
        nav={topCategories.map((c) => ({
          name: c.name,
          href: `${baseUrl}/c/${c.slug}`,
        }))}
      />
      <main className="sf-main">
        <CartCheckout
          homeHref={`${baseUrl}/`}
          accountHref={`${baseUrl}/account`}
          rails={{
            stripe: Boolean(site.paymentProviders?.stripe),
            x402: Boolean(site.paymentProviders?.x402),
          }}
        />
      </main>
    </ThemeRoot>
  );
}

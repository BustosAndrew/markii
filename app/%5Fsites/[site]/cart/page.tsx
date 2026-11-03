import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CartCheckout } from "@/components/storefront/cart-checkout";
import { StoreFooter, StoreTop } from "@/components/storefront/store-chrome";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { loadSite, storefrontHalted } from "@/lib/storefront";

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
  if (!data || storefrontHalted(data)) notFound();
  const { site, baseUrl } = data;
  const themeId = site.themeId ?? "studio";

  return (
    <ThemeRoot themeId={themeId} theme={data.theme} preview={data.preview}>
      <StoreTop data={data} minimal />
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
      <StoreFooter data={data} />
    </ThemeRoot>
  );
}

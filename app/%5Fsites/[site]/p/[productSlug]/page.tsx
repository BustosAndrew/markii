import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AddToCart } from "@/components/storefront/add-to-cart";
import { SiteHeader } from "@/components/storefront/site-header";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { logTraffic } from "@/lib/agents";
import { levelsForVariants } from "@/lib/commerce/queries";
import { membershipGateFor } from "@/lib/commerce/memberships";
import { db, productOptions, variants } from "@/lib/db";
import { formatPrice, productJsonLd } from "@/lib/generators";
import { loadSite } from "@/lib/storefront";

type Props = { params: Promise<{ site: string; productSlug: string }> };

function stripHtml(html: string | null | undefined) {
  return (html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, productSlug } = await params;
  const data = await loadSite(siteSlug);
  const product = data?.bundle.products.find((p) => p.slug === productSlug);
  if (!data || !product) return {};
  return {
    title: `${product.name} — ${data.site.name}`,
    description: stripHtml(product.description).slice(0, 160) || undefined,
    robots: data.site.indexed ? undefined : { index: false },
    other: data.site.googleSiteVerification
      ? { "google-site-verification": data.site.googleSiteVerification }
      : undefined,
  };
}

export default async function ProductPage({ params }: Props) {
  const { site: siteSlug, productSlug } = await params;
  const data = await loadSite(siteSlug);
  if (!data) notFound();
  const { site, bundle, cats, prods, baseUrl } = data;
  const dbProduct = prods.find((p) => p.slug === productSlug && p.enabled);
  const product = bundle.products.find((p) => p.slug === productSlug);
  if (!dbProduct || !product || site.status === "paused") notFound();

  await logTraffic({
    siteId: site.id,
    path: `/p/${productSlug}`,
    userAgent: (await headers()).get("user-agent"),
    productId: dbProduct.id,
  });

  const category =
    dbProduct.categoryId != null
      ? cats.find((c) => c.id === dbProduct.categoryId)
      : undefined;
  const suggested = prods.filter(
    (p) => dbProduct.suggestedProductIds.includes(p.id) && p.enabled,
  );
  const jsonLd = productJsonLd(bundle, product, baseUrl);
  const topCategories = bundle.categories.filter((c) => !c.parentSlug);
  const themeId = site.themeId ?? "studio";
  const description = stripHtml(product.description);

  const options = await db
    .select()
    .from(productOptions)
    .where(eq(productOptions.productId, dbProduct.id))
    .orderBy(asc(productOptions.position));
  const variantRows = await db
    .select()
    .from(variants)
    .where(eq(variants.productId, dbProduct.id))
    .orderBy(asc(variants.position));
  const levels = await levelsForVariants(variantRows.map((v) => v.id));

  const gate = dbProduct.requiresTierId
    ? await membershipGateFor(site.id, dbProduct.requiresTierId)
    : null;
  const locked = gate !== null && !gate.unlocked;

  return (
    <ThemeRoot themeId={themeId}>
      <script
        id="product-jsonld"
        type="application/ld+json"
        // Trusted server-built JSON-LD from our own catalog fields (not merchant HTML).
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SiteHeader
        siteName={site.name}
        homeHref={`${baseUrl}/`}
        cartHref={`${baseUrl}/cart`}
        nav={topCategories.map((c) => ({
          name: c.name,
          href: `${baseUrl}/c/${c.slug}`,
        }))}
      />
      <main className="sf-main">
        <p className="sf-crumb">
          <a href={`${baseUrl}/`}>{site.name}</a>
          {category ? (
            <>
              {" / "}
              <a href={`${baseUrl}/c/${category.slug}`}>{category.name}</a>
            </>
          ) : null}
        </p>
        <h1 className="sf-title">{product.name}</h1>
        <div className="sf-product-media">
          {product.images.map((src) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={src} src={src} alt={product.name} loading="lazy" />
          ))}
        </div>
        <p>
          <strong className="sf-price">
            {formatPrice(product.priceCents, product.currency)}
          </strong>
          <span className="sf-muted">
            {" — "}
            {product.stock > 0 ? `${product.stock} in stock` : "out of stock"}
            {product.sku ? ` — SKU ${product.sku}` : ""}
          </span>
        </p>
        {description ? <p>{description}</p> : null}

        {gate ? (
          <p className={locked ? "sf-gate sf-gate-locked" : "sf-gate"}>
            {locked ? (
              <>
                <strong>Members only.</strong> This product is available to{" "}
                {gate.tierName} members.{" "}
                <a href={`${baseUrl}/account`}>Sign in or create an account</a>{" "}
                to check whether your membership covers it.
              </>
            ) : (
              <>
                <strong>Included with your {gate.tierName} membership.</strong>
              </>
            )}
          </p>
        ) : null}

        <AddToCart
          productId={dbProduct.id}
          currency={product.currency}
          basePriceMinor={product.priceCents}
          cartHref={`${baseUrl}/cart`}
          locked={locked}
          options={options.map((o) => ({
            name: o.name,
            position: o.position,
            values: o.values,
          }))}
          variants={variantRows.map((v) => ({
            id: v.id,
            title: v.title,
            optionValues: v.optionValues,
            priceMinor: v.priceMinor,
            available: (levels.get(v.id) ?? []).reduce(
              (sum, row) => sum + row.available,
              0,
            ),
          }))}
        />

        {locked ? null : (
          <>
            <h2>Buy via agent</h2>
            <pre className="sf-buy">{`POST ${baseUrl}/api/checkout
{"productSlug": "${product.slug}", "quantity": 1}`}</pre>
            <p className="sf-muted">
              Payment protocol: <a href={`${baseUrl}/agent.md`}>agent.md</a>{" "}
              (x402, USDC on Base Sepolia)
            </p>
          </>
        )}
        {suggested.length > 0 ? (
          <>
            <h2>You might also like</h2>
            <ul className="sf-list">
              {suggested.map((p) => (
                <li key={p.id}>
                  <a href={`${baseUrl}/p/${p.slug}`}>{p.name}</a>
                  <span className="sf-price">
                    {formatPrice(p.priceCents, p.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </main>
    </ThemeRoot>
  );
}

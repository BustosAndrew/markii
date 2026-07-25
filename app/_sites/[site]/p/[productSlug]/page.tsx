import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { logTraffic } from "@/lib/agents";
import { formatPrice, productJsonLd } from "@/lib/generators";
import { loadSite } from "@/lib/storefront";

type Props = { params: Promise<{ site: string; productSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, productSlug } = await params;
  const data = await loadSite(siteSlug);
  const product = data?.bundle.products.find((p) => p.slug === productSlug);
  if (!data || !product) return {};
  return {
    title: `${product.name} — ${data.site.name}`,
    description: product.description?.replace(/<[^>]*>/g, " ").slice(0, 160) ?? undefined,
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

  const category = dbProduct.categoryId != null ? cats.find((c) => c.id === dbProduct.categoryId) : undefined;
  const suggested = prods.filter((p) => dbProduct.suggestedProductIds.includes(p.id) && p.enabled);
  const jsonLd = productJsonLd(bundle, product, baseUrl);

  return (
    <main style={{ fontFamily: "system-ui", background: "#fff", color: "#111", minHeight: "100vh", padding: "2rem 1rem", maxWidth: 720, margin: "0 auto" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <p>
        <a href={`${baseUrl}/`}>{site.name}</a>
        {category && (
          <>
            {" / "}
            <a href={`${baseUrl}/c/${category.slug}`}>{category.name}</a>
          </>
        )}
      </p>
      <h1>{product.name}</h1>
      {product.images.map((src) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={src} src={src} alt={product.name} loading="lazy" style={{ maxWidth: "100%", borderRadius: 8, marginBottom: "0.5rem" }} />
      ))}
      <p>
        <strong>{formatPrice(product.priceCents, product.currency)}</strong>
        {" — "}
        {product.stock > 0 ? `${product.stock} in stock` : "out of stock"}
        {product.sku ? ` — SKU ${product.sku}` : ""}
      </p>
      {product.description && (
        <div dangerouslySetInnerHTML={{ __html: product.description }} />
      )}
      <h2>Buy via agent</h2>
      <pre style={{ background: "#f6f6f6", padding: "1rem", borderRadius: 8, overflowX: "auto" }}>
        {`POST ${baseUrl}/api/checkout\n{"productSlug": "${product.slug}", "quantity": 1}`}
      </pre>
      <p>
        Payment protocol: <a href={`${baseUrl}/agent.md`}>agent.md</a> (x402, USDC on Base Sepolia)
      </p>
      {suggested.length > 0 && (
        <>
          <h2>You might also like</h2>
          <ul>
            {suggested.map((p) => (
              <li key={p.id}>
                <a href={`${baseUrl}/p/${p.slug}`}>{p.name}</a> —{" "}
                {formatPrice(p.priceCents, p.currency)}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

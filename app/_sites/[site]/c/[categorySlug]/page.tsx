import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { logTraffic } from "@/lib/agents";
import { formatPrice } from "@/lib/generators";
import { loadSite } from "@/lib/storefront";

type Props = { params: Promise<{ site: string; categorySlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, categorySlug } = await params;
  const data = await loadSite(siteSlug);
  const cat = data?.cats.find((c) => c.slug === categorySlug);
  if (!data || !cat) return {};
  return {
    title: `${cat.name} — ${data.site.name}`,
    robots: data.site.indexed ? undefined : { index: false },
  };
}

export default async function CategoryPage({ params }: Props) {
  const { site: siteSlug, categorySlug } = await params;
  const data = await loadSite(siteSlug);
  if (!data) notFound();
  const { site, cats, prods, baseUrl } = data;
  const category = cats.find((c) => c.slug === categorySlug && c.enabled);
  if (!category || site.status === "paused") notFound();

  await logTraffic({
    siteId: site.id,
    path: `/c/${categorySlug}`,
    userAgent: (await headers()).get("user-agent"),
  });

  const children = cats.filter((c) => c.parentId === category.id && c.enabled);
  const categoryIds = [category.id, ...children.map((c) => c.id)];
  const items = prods.filter(
    (p) => p.enabled && p.categoryId != null && categoryIds.includes(p.categoryId),
  );

  return (
    <main style={{ fontFamily: "system-ui", background: "#fff", color: "#111", minHeight: "100vh", padding: "2rem 1rem", maxWidth: 960, margin: "0 auto" }}>
      <p>
        <a href={`${baseUrl}/`}>{site.name}</a> / {category.name}
      </p>
      <h1>{category.name}</h1>
      {category.description && <p>{category.description}</p>}
      {children.length > 0 && (
        <nav>
          {children.map((c) => (
            <a key={c.slug} href={`${baseUrl}/c/${c.slug}`} style={{ marginRight: "0.75rem" }}>
              {c.name}
            </a>
          ))}
        </nav>
      )}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {items.map((p) => (
          <li key={p.id} style={{ borderBottom: "1px solid #eee", padding: "0.75rem 0" }}>
            <a href={`${baseUrl}/p/${p.slug}`}>{p.name}</a> —{" "}
            <strong>{formatPrice(p.priceCents, p.currency)}</strong> —{" "}
            {p.stock > 0 ? `${p.stock} in stock` : "out of stock"}
          </li>
        ))}
      </ul>
    </main>
  );
}

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { logTraffic } from "@/lib/agents";
import { formatPrice } from "@/lib/generators";
import { loadSite } from "@/lib/storefront";

type Props = { params: Promise<{ site: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadSite((await params).site);
  if (!data) return {};
  return {
    title: data.site.name,
    description: `${data.site.name} — agent-friendly store`,
    robots: data.site.indexed ? undefined : { index: false },
    other: data.site.googleSiteVerification
      ? { "google-site-verification": data.site.googleSiteVerification }
      : undefined,
  };
}

export default async function StorePage({ params }: Props) {
  const data = await loadSite((await params).site);
  if (!data) notFound();
  const { site, bundle, baseUrl } = data;

  if (site.status === "paused") {
    return (
      <main style={{ fontFamily: "system-ui", background: "#fff", color: "#111", minHeight: "100vh", padding: "4rem 1rem", textAlign: "center" }}>
        <h1>{site.name}</h1>
        <p>This store is temporarily paused. Please check back later.</p>
      </main>
    );
  }

  await logTraffic({ siteId: site.id, path: "/", userAgent: (await headers()).get("user-agent") });

  const topCategories = bundle.categories.filter((c) => !c.parentSlug);
  return (
    <main style={{ fontFamily: "system-ui", background: "#fff", color: "#111", minHeight: "100vh", padding: "2rem 1rem", maxWidth: 960, margin: "0 auto" }}>
      <h1>{site.name}</h1>
      <p>
        Agent-readable store — see <a href={`${baseUrl}/llms.txt`}>llms.txt</a> and{" "}
        <a href={`${baseUrl}/agent.md`}>agent.md</a>.
      </p>
      {topCategories.length > 0 && (
        <nav>
          {topCategories.map((c) => (
            <a key={c.slug} href={`${baseUrl}/c/${c.slug}`} style={{ marginRight: "0.75rem" }}>
              {c.name}
            </a>
          ))}
        </nav>
      )}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "1rem" }}>
        {bundle.products.map((p) => (
          <li key={p.slug} style={{ border: "1px solid #eee", borderRadius: 8, padding: "1rem" }}>
            {p.images[0] && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.images[0]} alt={p.name} loading="lazy" style={{ maxWidth: "100%", borderRadius: 4 }} />
            )}
            <h2 style={{ fontSize: "1rem" }}>
              <a href={`${baseUrl}/p/${p.slug}`}>{p.name}</a>
            </h2>
            <p>
              <strong>{formatPrice(p.priceCents, p.currency)}</strong>
              {" — "}
              {p.stock > 0 ? `${p.stock} in stock` : "out of stock"}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}

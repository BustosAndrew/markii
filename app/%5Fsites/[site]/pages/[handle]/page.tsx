import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { redirectOrNotFound } from "@/lib/storefront/redirects";
import { StorefrontBuilderPage } from "@/components/storefront/builder-page";
import { StoreFooter, StoreTop } from "@/components/storefront/store-chrome";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { contentGateFor } from "@/lib/commerce/memberships";
import { MembersGate, MembersPreviewNote } from "@markii/renderer/members-gate";
import { logTraffic } from "@/lib/agents";
import { loadSite, pageFor, storefrontHalted } from "@/lib/storefront";
import { pageSocialMetadata } from "@/lib/storefront-meta";

/**
 * A merchant's own page — about, shipping, FAQ — designed in the builder and
 * served at `/pages/{handle}` once published (D51). Only published pages
 * exist here — a draft page is a 404 until its publish — except in the
 * builder's live preview, where `pageFor` returns the draft.
 */

type Props = { params: Promise<{ site: string; handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data) return {};
  const page = await pageFor(data, handle);
  if (!page) return {};
  const title = page.seo.title || `${page.title} — ${data.site.name}`;
  const description = page.seo.description || undefined;
  return {
    title,
    description,
    robots: data.site.indexed && !page.seo.noindex ? undefined : { index: false },
    ...pageSocialMetadata(data, { title, description, path: `/pages/${page.handle}`, seo: page.seo }),
  };
}

export default async function BuilderPageRoute({ params }: Props) {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data || storefrontHalted(data)) notFound();
  // The home page is served at /, not twice.
  if (handle === "home") notFound();
  const page = await pageFor(data, handle);
  if (!page) return redirectOrNotFound(data, `/pages/${handle}`);

  await logTraffic({
    siteId: data.site.id,
    path: `/pages/${handle}`,
    userAgent: (await headers()).get("user-agent"),
  });

  const baseUrl = data.baseUrl.replace(/\/$/, "");
  const ld = {
    name: page.seo.title || page.title,
    description: page.seo.description || undefined,
    url: `${baseUrl}/pages/${page.handle}`,
    membersOnly: page.requiresTierId != null,
  };
  // Members-only (§18.9): without the tier, the page's blocks are never rendered at all.
  const gate = page.requiresTierId != null ? await contentGateFor(data.site.id, page.requiresTierId, { preview: data.preview }) : null;

  if (gate && !gate.unlocked) {
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: ld.name,
      ...(ld.description ? { description: ld.description } : {}),
      url: ld.url,
      isPartOf: { "@type": "WebSite", name: data.site.name, url: `${baseUrl}/` },
      isAccessibleForFree: false,
    };
    return (
      <ThemeRoot themeId={data.site.themeId} theme={data.theme} preview={data.preview}>
        <StoreTop data={data} />
        <main className="sf-main">
          <header className="sf-hero">
            <h1 className="sf-title">{page.title}</h1>
            {page.seo.description ? <p className="sf-lede">{page.seo.description}</p> : null}
          </header>
          <MembersGate
            what="page"
            tierName={gate.tierName}
            signInHref={`${baseUrl}/account`}
            join={gate.join.map((j) => ({ name: j.name, href: `${baseUrl}/p/${j.slug}` }))}
          />
        </main>
        <StoreFooter data={data} />
        <script
          type="application/ld+json"
          // Built by JSON.stringify; `<` escaped so a title cannot close the tag.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      </ThemeRoot>
    );
  }

  return (
    <StorefrontBuilderPage
      data={data}
      tree={page.tree}
      documentId={page.id}
      before={gate && data.preview ? <MembersPreviewNote what="page" tierName={gate.tierName} /> : undefined}
      extra={{ page: ld }}
    />
  );
}

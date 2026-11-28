import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MembersGate } from "@markii/renderer/members-gate";
import type { PageNode } from "@markii/renderer/types";
import { getPage, getStore, siteUrl } from "../../../lib/markii";
import { documentOf, JsonLd, seoOf, StorePage } from "../../../lib/page";

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const store = await getStore();
  const { handle } = await params;
  if (!store || !documentOf(store, "page", handle)) return {};
  const doc = store.design?.documents.find((d) => d.kind === "page" && d.handle === handle);
  const seo = seoOf(store, "page", handle);
  return { title: seo.title || doc?.title, description: seo.description || undefined, robots: seo.noindex ? { index: false } : undefined };
}

/**
 * A published builder page, with the same `WebPage` / `FAQPage` / `ItemList` JSON-LD Markii emits.
 *
 * A members-only page arrives from `/api/store` with an empty tree; its real
 * tree is asked for as the shopper (`getPage`). Without the tier the shopper
 * sees the page's title and a way to join, as on Markii.
 */
export default async function BuilderPageRoute({ params }: Props) {
  const store = await getStore();
  const { handle } = await params;
  let tree = store && handle !== "home" ? documentOf(store, "page", handle) : null;
  if (!store || !tree) notFound();
  const doc = store.design?.documents.find((d) => d.kind === "page" && d.handle === handle);
  const seo = seoOf(store, "page", handle);
  const base = siteUrl();
  const membersOnly = store.membersOnlyPages.some((p) => p.handle === handle);
  const page = { name: seo.title || doc?.title || handle, description: seo.description || undefined, url: `${base}/pages/${handle}`, membersOnly };

  if (membersOnly) {
    const gated = await getPage(handle);
    if (!gated) notFound();
    if (gated.locked || !gated.tree) {
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: page.name,
        ...(page.description ? { description: page.description } : {}),
        url: page.url,
        isAccessibleForFree: false,
      };
      return (
        <StorePage store={store} before={<JsonLd data={jsonLd} />}>
          <main className="sf-main">
            <header className="sf-hero">
              <h1 className="sf-title">{doc?.title ?? gated.title}</h1>
              {seo.description ? <p className="sf-lede">{seo.description}</p> : null}
            </header>
            <MembersGate
              what="page"
              tierName={gated.gate?.tierName ?? null}
              signInHref={`${base}/account`}
              join={(gated.gate?.join ?? []).map((j) => ({ name: j.name, href: `${base}/p/${j.slug}` }))}
            />
          </main>
        </StorePage>
      );
    }
    tree = gated.tree as PageNode;
  }
  // `page` is what makes the renderer emit the page's JSON-LD, as on Markii.
  return <StorePage store={store} tree={tree} extra={{ page }} />;
}

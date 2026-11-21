import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getStore, siteUrl } from "../../../lib/markii";
import { documentOf, seoOf, StorePage } from "../../../lib/page";

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const store = await getStore();
  const { handle } = await params;
  if (!store || !documentOf(store, "page", handle)) return {};
  const doc = store.design?.documents.find((d) => d.kind === "page" && d.handle === handle);
  const seo = seoOf(store, "page", handle);
  return { title: seo.title || doc?.title, description: seo.description || undefined, robots: seo.noindex ? { index: false } : undefined };
}

/** A published builder page, with the same `WebPage` / `FAQPage` / `ItemList` JSON-LD Markii emits. */
export default async function BuilderPageRoute({ params }: Props) {
  const store = await getStore();
  const { handle } = await params;
  const tree = store && handle !== "home" ? documentOf(store, "page", handle) : null;
  if (!store || !tree) notFound();
  const doc = store.design?.documents.find((d) => d.kind === "page" && d.handle === handle);
  const seo = seoOf(store, "page", handle);
  const page = { name: seo.title || doc?.title || handle, description: seo.description || undefined, url: `${siteUrl()}/pages/${handle}` };
  // `page` is what makes the renderer emit the page's JSON-LD, as on Markii.
  return <StorePage store={store} tree={tree} extra={{ page }} />;
}

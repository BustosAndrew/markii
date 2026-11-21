import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DEFAULT_TEMPLATE_TREES } from "@markii/renderer/presets";
import { collectionStructuredData } from "@markii/renderer/structured-data";
import { collectionView } from "@markii/renderer/views";
import { getCollectionProducts, getStore, siteUrl } from "../../../lib/markii";
import { documentOf, JsonLd, StorePage } from "../../../lib/page";

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const store = await getStore();
  const collection = store?.collections.find((c) => c.handle === handle);
  return collection && store ? { title: `${collection.title} — ${store.store.name}` } : {};
}

/** A published collection: its template (or the default), with the route's own `CollectionPage` JSON-LD. */
export default async function CollectionRoute({ params }: Props) {
  const store = await getStore();
  const { handle } = await params;
  const collection = store?.collections.find((c) => c.handle === handle);
  if (!store || !collection) notFound();
  const items = await getCollectionProducts(handle, 200);
  const baseUrl = siteUrl();
  return (
    <StorePage
      store={store}
      tree={documentOf(store, "template", "collection") ?? DEFAULT_TEMPLATE_TREES.collection()}
      before={<JsonLd data={collectionStructuredData(collection, items, baseUrl)} />}
      scope={{ collection: collectionView(collection, { baseUrl, productCount: items.length }) }}
      extra={{ collectionProducts: items }}
    />
  );
}

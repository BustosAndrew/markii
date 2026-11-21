import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { plainText } from "@markii/renderer/views";
import { getStore } from "../../../lib/markii";
import { listingTree } from "../../../lib/listing";
import { StorePage } from "../../../lib/page";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const store = await getStore();
  const category = store?.categories.find((c) => c.slug === slug);
  return category && store ? { title: `${category.name} — ${store.store.name}` } : {};
}

/** A category: its name, its description, and its products. */
export default async function CategoryRoute({ params }: Props) {
  const { slug } = await params;
  const store = await getStore();
  const category = store?.categories.find((c) => c.slug === slug);
  if (!store || !category) notFound();
  const description = plainText(category.description);
  return (
    <StorePage
      store={store}
      tree={listingTree([
        { type: "heading", props: { text: category.name.slice(0, 200), level: 1 } },
        ...(description ? [{ type: "text", props: { markdown: description.slice(0, 2000) } }] : []),
        { type: "productGrid", props: { source: "category", categorySlug: category.slug, limit: 48 } },
      ])}
    />
  );
}

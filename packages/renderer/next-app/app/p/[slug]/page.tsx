import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DEFAULT_TEMPLATE_TREES } from "@markii/renderer/presets";
import { productStructuredData } from "@markii/renderer/structured-data";
import { plainText, productView } from "@markii/renderer/views";
import { BuyForm } from "../../../components/buy-form";
import { getProduct, getProducts, getStore, memberTierIds, siteUrl, toRenderProduct } from "../../../lib/markii";
import { documentOf, JsonLd, StorePage } from "../../../lib/page";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ cart_error?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [store, product] = await Promise.all([getStore(), getProduct((await params).slug)]);
  if (!store || !product) return {};
  return { title: `${product.name} — ${store.store.name}`, description: plainText(product.description).slice(0, 160) || undefined };
}

export default async function ProductPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const [store, product] = await Promise.all([getStore(), getProduct(slug)]);
  if (!store || !product) notFound();

  const record = toRenderProduct(product);
  const products = await getProducts();
  const baseUrl = siteUrl();
  const tiers = product.requiresTier ? await memberTierIds() : new Set<number>();
  const gate = product.requiresTier ? { tierName: product.requiresTier.name, unlocked: tiers.has(product.requiresTier.id) } : null;
  const error = (await searchParams).cart_error;

  return (
    <StorePage
      store={store}
      tree={documentOf(store, "template", "product") ?? DEFAULT_TEMPLATE_TREES.product()}
      // The Product JSON-LD is the route's, as on Markii — no design can remove what buying agents read.
      before={<JsonLd data={productStructuredData(record, store.store.name, baseUrl)} />}
      scope={{ product: productView(record, { baseUrl, categories: store.categories, products }) }}
      extra={{
        product: {
          record,
          purchase: {
            buy: <BuyForm product={product} locked={gate !== null && !gate.unlocked} error={error} />,
            gate,
            agentCheckout: null,
          },
        },
      }}
    />
  );
}

import {
  getMe,
  getProduct,
  getVariantMatrix,
  listCategories,
  listSites,
} from "@/lib/api/server";
import { firstParam, loadOrError } from "@/lib/api/load";
import { FetchError } from "@/components/dashboard/fetch-error";
import { ProductForm } from "@/components/dashboard/product-form";
import { VariantEditor } from "@/components/dashboard/variant-editor";
import { PageHeader } from "@/components/ui/page-header";

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const siteIdRaw = firstParam(sp.siteId);
  const siteId = siteIdRaw ? Number(siteIdRaw) : undefined;

  const [productResult, sitesResult, categoriesResult, meResult] = await Promise.all([
    loadOrError(() =>
      getProduct(slug, Number.isFinite(siteId) ? { siteId } : undefined),
    ),
    loadOrError(() => listSites({ limit: 100, sort: "name" })),
    loadOrError(() => listCategories({ limit: 100 })),
    loadOrError(() => getMe()),
  ]);

  if (productResult.error || !productResult.data) {
    return (
      <div>
        <PageHeader title="Product" description={slug} />
        <FetchError title="Product not found" message={productResult.error ?? "Not found"} />
      </div>
    );
  }

  const product = productResult.data;
  const matrixResult = await loadOrError(() =>
    getVariantMatrix(slug, { siteId: product.siteId }),
  );

  const sites = sitesResult.data?.items ?? [];
  const categories = categoriesResult.data?.items ?? [];
  const currency = product.currency || meResult.data?.org.currency || "USD";

  return (
    <div>
      <PageHeader
        title={product.name}
        description="Edit pricing, inventory, images, and availability."
      />
      {(sitesResult.error || categoriesResult.error) && (
        <p className="mb-4 text-sm text-muted">
          Some related lists failed to load. You can still edit core fields.
        </p>
      )}
      <ProductForm mode="edit" product={product} sites={sites} categories={categories} />
      <div className="mt-6">
        {matrixResult.data ? (
          <VariantEditor
            key={`variants-${matrixResult.data.productId}-${matrixResult.data.variants.length}-${matrixResult.data.options.map((o) => o.values.join(",")).join("|")}`}
            productId={product.id}
            siteId={product.siteId}
            currency={currency}
            matrix={matrixResult.data}
          />
        ) : (
          <FetchError
            title="Variants unavailable"
            message={matrixResult.error ?? "The variant matrix could not be loaded."}
          />
        )}
      </div>
    </div>
  );
}

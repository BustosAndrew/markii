import { listCategories } from "@/lib/api/server";
import { getProduct } from "@/lib/api/server";
import { listSites } from "@/lib/api/server";
import { firstParam, loadOrError } from "@/lib/api/load";
import { PageHeader } from "@/components/ui/page-header";
import { FetchError } from "@/components/dashboard/fetch-error";
import { ProductForm } from "@/components/dashboard/product-form";

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

  const [productResult, sitesResult, categoriesResult] = await Promise.all([
    loadOrError(() =>
      getProduct(
        slug,
        Number.isFinite(siteId) ? { siteId } : undefined),
    ),
    loadOrError(() =>
      listSites({ limit: 100, sort: "name" }),
    ),
    loadOrError(() =>
      listCategories({ limit: 100 }),
    ),
  ]);

  if (productResult.error || !productResult.data) {
    return (
      <div>
        <PageHeader title="Product" description={slug} />
        <FetchError
          title="Product not found"
          message={productResult.error ?? "Not found"}
        />
      </div>
    );
  }

  const sites = sitesResult.data?.items ?? [];
  const categories = categoriesResult.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title={productResult.data.name}
        description="Edit pricing, inventory, images, and availability."
      />
      {(sitesResult.error || categoriesResult.error) && (
        <p className="mb-4 text-sm text-muted">
          Some related lists failed to load. You can still edit core fields.
        </p>
      )}
      <ProductForm
        mode="edit"
        product={productResult.data}
        sites={sites}
        categories={categories}
      />
    </div>
  );
}

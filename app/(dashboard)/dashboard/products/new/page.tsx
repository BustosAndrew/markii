import { listCategories } from "@/lib/api/categories";
import { listSites } from "@/lib/api/sites";
import { loadOrError } from "@/lib/api/load";
import { PageHeader } from "@/components/ui/page-header";
import { FetchError } from "@/components/dashboard/fetch-error";
import { ProductForm } from "@/components/dashboard/product-form";

export default async function NewProductPage() {
  const [sitesResult, categoriesResult] = await Promise.all([
    loadOrError(() =>
      listSites({ limit: 100, sort: "name" }, { cache: "no-store" }),
    ),
    loadOrError(() =>
      listCategories({ limit: 100 }, { cache: "no-store" }),
    ),
  ]);

  if (sitesResult.error || !sitesResult.data) {
    return (
      <div>
        <PageHeader title="New product" />
        <FetchError
          title="Cannot create product"
          message={
            sitesResult.error ??
            "Sites are required before creating a product."
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="New product"
        description="Add a product to a site. Price is stored as integer cents."
      />
      <ProductForm
        mode="create"
        sites={sitesResult.data.items}
        categories={categoriesResult.data?.items ?? []}
      />
    </div>
  );
}

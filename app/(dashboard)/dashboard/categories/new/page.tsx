import { listCategories } from "@/lib/api/categories";
import { listSites } from "@/lib/api/sites";
import { loadOrError } from "@/lib/api/load";
import { PageHeader } from "@/components/ui/page-header";
import { FetchError } from "@/components/dashboard/fetch-error";
import { CategoryForm } from "@/components/dashboard/category-form";

export default async function NewCategoryPage() {
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
        <PageHeader title="New category" />
        <FetchError
          title="Cannot create category"
          message={
            sitesResult.error ??
            "Sites are required before creating a category."
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="New category"
        description="Create a category or subcategory on a site."
      />
      <CategoryForm
        mode="create"
        sites={sitesResult.data.items}
        categories={categoriesResult.data?.items ?? []}
      />
    </div>
  );
}

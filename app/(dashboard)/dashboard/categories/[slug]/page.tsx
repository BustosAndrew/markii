import { getCategory, listCategories } from "@/lib/api/categories";
import { listSites } from "@/lib/api/sites";
import { firstParam, loadOrError } from "@/lib/api/load";
import { PageHeader } from "@/components/ui/page-header";
import { FetchError } from "@/components/dashboard/fetch-error";
import { CategoryForm } from "@/components/dashboard/category-form";

export default async function CategoryDetailPage({
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

  const [categoryResult, sitesResult, categoriesResult] = await Promise.all([
    loadOrError(() =>
      getCategory(
        slug,
        Number.isFinite(siteId) ? { siteId } : undefined,
        { cache: "no-store" },
      ),
    ),
    loadOrError(() =>
      listSites({ limit: 100, sort: "name" }, { cache: "no-store" }),
    ),
    loadOrError(() =>
      listCategories({ limit: 100 }, { cache: "no-store" }),
    ),
  ]);

  if (categoryResult.error || !categoryResult.data) {
    return (
      <div>
        <PageHeader title="Category" description={slug} />
        <FetchError
          title="Category not found"
          message={categoryResult.error ?? "Not found"}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={categoryResult.data.name}
        description="Reassign site or parent, enable, duplicate, or delete."
      />
      <CategoryForm
        mode="edit"
        category={categoryResult.data}
        sites={sitesResult.data?.items ?? []}
        categories={categoriesResult.data?.items ?? []}
      />
    </div>
  );
}

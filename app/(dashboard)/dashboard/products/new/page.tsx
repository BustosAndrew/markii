import { getTaxSettings } from "@/lib/api/server";
import { listCategories } from "@/lib/api/server";
import { listMembershipTiers } from "@/lib/api/server";
import { listSites } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { PageHeader } from "@/components/ui/page-header";
import { FetchError } from "@/components/dashboard/fetch-error";
import { ProductForm } from "@/components/dashboard/product-form";

export default async function NewProductPage() {
  const [sitesResult, categoriesResult, tiersResult] = await Promise.all([
    loadOrError(() =>
      listSites({ limit: 100, sort: "name" }),
    ),
    loadOrError(() =>
      listCategories({ limit: 100 }),
    ),
    loadOrError(() => listMembershipTiers()),
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

  const sites = sitesResult.data.items;
  const taxResults = await Promise.all(
    sites.map((site) => loadOrError(() => getTaxSettings(site.id))),
  );
  const taxProviders: Record<number, "none" | "manual" | "stripe"> = {};
  sites.forEach((site, index) => {
    const provider = taxResults[index]?.data?.provider;
    if (provider) taxProviders[site.id] = provider;
  });

  return (
    <div>
      <PageHeader
        title="New product"
        description="Add a product to a site. Price is stored as integer cents."
      />
      <ProductForm
        mode="create"
        sites={sites}
        categories={categoriesResult.data?.items ?? []}
        tiers={(tiersResult.data?.items ?? []).map((tier) => ({
          id: tier.id,
          name: tier.name,
          siteId: tier.siteId,
        }))}
        taxProviders={taxProviders}
      />
    </div>
  );
}

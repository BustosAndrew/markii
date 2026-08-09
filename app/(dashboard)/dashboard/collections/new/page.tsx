import { loadOrError } from "@/lib/api/load";
import { listSites } from "@/lib/api/server";
import { FetchError } from "@/components/dashboard/fetch-error";
import { CollectionForm } from "@/components/dashboard/collection-form";
import { PageHeader } from "@/components/ui/page-header";

export default async function NewCollectionPage() {
  const sitesResult = await loadOrError(() =>
    listSites({ limit: 100, sort: "name" }),
  );

  if (sitesResult.error || !sitesResult.data) {
    return (
      <div>
        <PageHeader title="New collection" />
        <FetchError
          title="Cannot create collection"
          message={sitesResult.error ?? "Sites are required before creating a collection."}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="New collection"
        description="Group products for merchandising. Manual collections let you pick members; automated ones resolve by rules."
      />
      <CollectionForm sites={sitesResult.data.items} />
    </div>
  );
}

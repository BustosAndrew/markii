import { getCollection, getMe, listSites } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { canWriteCatalog } from "@/lib/api/org";
import { CollectionForm } from "@/components/dashboard/collection-form";
import { FetchError } from "@/components/dashboard/fetch-error";
import { PageHeader } from "@/components/ui/page-header";

export default async function EditCollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [collectionResult, sitesResult, me] = await Promise.all([
    loadOrError(() => getCollection(id)),
    loadOrError(() => listSites({ limit: 100, sort: "name" })),
    loadOrError(() => getMe()),
  ]);

  if (collectionResult.error || !collectionResult.data) {
    return (
      <div>
        <PageHeader title="Collection" />
        <FetchError title="Collection not found" message={collectionResult.error ?? "Not found"} />
      </div>
    );
  }

  const collection = collectionResult.data;
  const sites = sitesResult.data?.items ?? [];

  return (
    <div>
      <PageHeader title={collection.title} description={`/${collection.handle}`} />
      {canWriteCatalog(me.data?.role) ? (
        <CollectionForm sites={sites} collection={collection} />
      ) : (
        <p className="text-sm text-muted">You can view this collection but not change it.</p>
      )}
    </div>
  );
}

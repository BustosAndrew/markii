import { listSites } from "@/lib/api/sites";
import { loadOrError } from "@/lib/api/load";
import { CreateWebsiteWizard } from "@/components/dashboard/create-website-wizard";

export default async function NewWebsitePage() {
  const sitesResult = await loadOrError(() =>
    listSites({ limit: 100, sort: "name" }, { cache: "no-store" }),
  );

  return <CreateWebsiteWizard sites={sitesResult.data?.items ?? []} />;
}

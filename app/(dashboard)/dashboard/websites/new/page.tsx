import { listSites } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { CreateWebsiteWizard } from "@/components/dashboard/create-website-wizard";

export default async function NewWebsitePage() {
  const sitesResult = await loadOrError(() =>
    listSites({ limit: 100, sort: "name" }),
  );

  return <CreateWebsiteWizard sites={sitesResult.data?.items ?? []} />;
}

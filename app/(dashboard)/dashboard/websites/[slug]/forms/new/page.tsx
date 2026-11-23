import { getMe, getSite } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { canWriteCms } from "@/lib/api/org";
import { FetchError } from "@/components/dashboard/fetch-error";
import { FormEditor } from "@/components/dashboard/form-editor";
import { WebsiteNav } from "@/components/dashboard/website-nav";
import { PageHeader } from "@/components/ui/page-header";

export default async function NewFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [siteResult, me] = await Promise.all([loadOrError(() => getSite(slug)), loadOrError(() => getMe())]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="New form" />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }

  const site = siteResult.data;
  const canWrite = canWriteCms(me.data?.role);

  return (
    <div>
      <WebsiteNav slug={site.slug} />
      <PageHeader title="New form" description="Live at /forms/{handle} as soon as you create it." />
      {canWrite ? (
        <FormEditor siteId={site.id} siteSlug={site.slug} canWrite />
      ) : (
        <p className="text-sm text-muted">You need permission to edit this store’s design to create a form.</p>
      )}
    </div>
  );
}

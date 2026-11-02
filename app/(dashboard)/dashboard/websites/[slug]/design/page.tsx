import { getMe, getSite } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { canWriteCms } from "@/lib/api/org";
import { FetchError } from "@/components/dashboard/fetch-error";
import { DesignEditor } from "@/components/builder/design-editor";
import { PageHeader } from "@/components/ui/page-header";

/**
 * The site editor (D51, M2). Everything happens client-side against the
 * builder API; this page only resolves the site and whether the caller may
 * edit (`cms.write`). The server enforces that again on every action.
 */
export default async function DesignEditorPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [siteResult, meResult] = await Promise.all([loadOrError(() => getSite(slug)), loadOrError(() => getMe())]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="Design" description={`/${slug}`} />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }
  const site = siteResult.data;

  return (
    <DesignEditor
      site={{ id: site.id, slug: site.slug, name: site.name, storefrontUrl: site.storefrontUrl || null }}
      canEdit={canWriteCms(meResult.data?.role)}
    />
  );
}

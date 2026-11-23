import { getMe, getSite, getSiteForm } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { canWriteCms } from "@/lib/api/org";
import { FetchError } from "@/components/dashboard/fetch-error";
import { FormEditor } from "@/components/dashboard/form-editor";
import { WebsiteNav } from "@/components/dashboard/website-nav";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";

export default async function EditFormPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const formId = Number(id);
  const [siteResult, formResult, me] = await Promise.all([
    loadOrError(() => getSite(slug)),
    loadOrError(() => getSiteForm(slug, formId)),
    loadOrError(() => getMe()),
  ]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="Form" />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }
  if (formResult.error || !formResult.data) {
    return (
      <div>
        <PageHeader title="Form" />
        <FetchError title="Form not found" message={formResult.error ?? "Not found"} />
      </div>
    );
  }

  const site = siteResult.data;
  const form = formResult.data;

  return (
    <div>
      <WebsiteNav slug={site.slug} />
      <PageHeader
        title={form.name}
        description={`${form.path} — live at once. Handle is fixed.`}
        actions={
          <ButtonLink href={`/dashboard/websites/${site.slug}/forms/submissions?form=${encodeURIComponent(form.handle)}`} variant="secondary">
            Submissions
          </ButtonLink>
        }
      />
      <FormEditor siteId={site.id} siteSlug={site.slug} form={form} canWrite={canWriteCms(me.data?.role)} />
    </div>
  );
}

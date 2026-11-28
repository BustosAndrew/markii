import { getMe, getSite, listMembershipTiers } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { canWriteCms } from "@/lib/api/org";
import { BlogPostForm } from "@/components/dashboard/blog-post-form";
import { FetchError } from "@/components/dashboard/fetch-error";
import { WebsiteNav } from "@/components/dashboard/website-nav";
import { PageHeader } from "@/components/ui/page-header";

export default async function NewBlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [siteResult, me, tiersResult] = await Promise.all([
    loadOrError(() => getSite(slug)),
    loadOrError(() => getMe()),
    loadOrError(() => listMembershipTiers()),
  ]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="New post" />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }

  const site = siteResult.data;
  return (
    <div>
      <WebsiteNav slug={site.slug} />
      <PageHeader title="New post" description="Posts publish on their own. A draft stays private until you publish or schedule it." />
      <BlogPostForm
        siteId={site.id}
        siteSlug={site.slug}
        canWrite={canWriteCms(me.data?.role)}
        tiers={(tiersResult.data?.items ?? []).filter((t) => t.siteId === site.id)}
      />
    </div>
  );
}

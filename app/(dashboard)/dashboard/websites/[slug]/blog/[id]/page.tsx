import { getMe, getSite, getSiteBlogPost, listMembershipTiers } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { canWriteCms } from "@/lib/api/org";
import { BlogPostForm } from "@/components/dashboard/blog-post-form";
import { FetchError } from "@/components/dashboard/fetch-error";
import { WebsiteNav } from "@/components/dashboard/website-nav";
import { PageHeader } from "@/components/ui/page-header";

export default async function EditBlogPostPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const postId = Number(id);
  const [siteResult, postResult, me, tiersResult] = await Promise.all([
    loadOrError(() => getSite(slug)),
    loadOrError(() => getSiteBlogPost(slug, postId)),
    loadOrError(() => getMe()),
    loadOrError(() => listMembershipTiers()),
  ]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="Post" />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }
  if (postResult.error || !postResult.data) {
    return (
      <div>
        <PageHeader title="Post" />
        <FetchError title="Post not found" message={postResult.error ?? "Not found"} />
      </div>
    );
  }

  const site = siteResult.data;
  const post = postResult.data;

  return (
    <div>
      <WebsiteNav slug={site.slug} />
      <PageHeader title={post.title} description={post.path} />
      <BlogPostForm
        siteId={site.id}
        siteSlug={site.slug}
        post={post}
        canWrite={canWriteCms(me.data?.role)}
        tiers={(tiersResult.data?.items ?? []).filter((t) => t.siteId === site.id)}
      />
    </div>
  );
}

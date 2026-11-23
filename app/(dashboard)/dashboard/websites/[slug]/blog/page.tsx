import Link from "next/link";
import { getMe, getSite, listSiteBlogPosts } from "@/lib/api/server";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { canWriteCms } from "@/lib/api/org";
import type { PostStatus } from "@/lib/api/blog";
import { FetchError } from "@/components/dashboard/fetch-error";
import { WebsiteNav } from "@/components/dashboard/website-nav";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { LocalDateTime } from "@/components/ui/local-date";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";

const STATUS: Record<PostStatus, { label: string; variant: "neutral" | "info" | "success" }> = {
  draft: { label: "Draft", variant: "neutral" },
  scheduled: { label: "Scheduled", variant: "info" },
  published: { label: "Published", variant: "success" },
};

export default async function BlogListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const statusRaw = firstParam(sp.status);
  const status = (["draft", "scheduled", "published"] as const).find((s) => s === statusRaw);
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit, 50);
  const offset = (page - 1) * limit;

  const [siteResult, listResult, me] = await Promise.all([
    loadOrError(() => getSite(slug)),
    loadOrError(() => listSiteBlogPosts(slug, { q, status, limit, offset })),
    loadOrError(() => getMe()),
  ]);

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="Blog" />
        <FetchError title="Website not found" message={siteResult.error ?? "Not found"} />
      </div>
    );
  }

  const site = siteResult.data;
  const canWrite = canWriteCms(me.data?.role);
  const data = listResult.data;

  return (
    <div>
      <WebsiteNav slug={site.slug} />
      <PageHeader
        title="Blog"
        description="Posts publish on their own. Once a post is live, saving changes updates it straight away."
        actions={canWrite ? <ButtonLink href={`/dashboard/websites/${site.slug}/blog/new`}>New post</ButtonLink> : null}
      />
      <ListFilters
        searchPlaceholder="Search posts…"
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { value: "draft", label: "Draft" },
              { value: "scheduled", label: "Scheduled" },
              { value: "published", label: "Published" },
            ],
          },
        ]}
      />
      {!data ? (
        <FetchError message={listResult.error ?? "Posts could not be loaded."} />
      ) : data.items.length === 0 ? (
        <EmptyState
          title="No posts yet"
          description="Write in Markdown. Link to /blog from a navigation menu — a listing block is not built yet."
          action={canWrite ? <ButtonLink href={`/dashboard/websites/${site.slug}/blog/new`}>New post</ButtonLink> : undefined}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">Post</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Published</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((post) => (
                  <tr key={post.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/websites/${site.slug}/blog/${post.id}`} className="font-medium text-foreground hover:text-brand">
                        {post.title}
                      </Link>
                      <div className="text-xs text-muted">{post.excerpt}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS[post.status].variant}>{STATUS[post.status].label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      <LocalDateTime value={post.publishedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} limit={limit} total={data.total} />
        </>
      )}
    </div>
  );
}

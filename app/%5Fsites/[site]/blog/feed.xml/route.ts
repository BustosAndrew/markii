import { logTraffic } from "@/lib/agents";
import { storefrontPosts } from "@/lib/blog/queries";
import { BLOG_FEED_SIZE, excerptOf } from "@/lib/blog/rules";
import { loadSite, storefrontHalted } from "@/lib/storefront";

/**
 * `/blog/feed.xml` — RSS 2.0 of the latest live posts: what feed readers and
 * many agents subscribe to instead of polling the blog. Live posts only, even
 * in the preview: a feed is something other software keeps.
 */

function xml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const data = await loadSite((await params).site);
  if (!data || data.preview || storefrontHalted(data)) return new Response("Not found", { status: 404 });
  await logTraffic({ siteId: data.site.id, path: "/blog/feed.xml", userAgent: req.headers.get("user-agent") });

  const base = data.baseUrl.replace(/\/$/, "");
  const { posts } = await storefrontPosts(data.site.id, { limit: BLOG_FEED_SIZE });
  const items = posts
    .map((p) => {
      const url = `${base}/blog/${p.handle}`;
      return [
        "<item>",
        `<title>${xml(p.title)}</title>`,
        `<link>${xml(url)}</link>`,
        `<guid isPermaLink="true">${xml(url)}</guid>`,
        `<pubDate>${p.publishedAt!.toUTCString()}</pubDate>`,
        p.author ? `<dc:creator>${xml(p.author)}</dc:creator>` : "",
        `<description>${xml(excerptOf(p))}</description>`,
        "</item>",
      ].join("");
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(`${data.site.name} blog`)}</title>
<link>${xml(`${base}/blog`)}</link>
<atom:link href="${xml(`${base}/blog/feed.xml`)}" rel="self" type="application/rss+xml"/>
<description>${xml(`Posts from ${data.site.name}`)}</description>
${posts[0]?.publishedAt ? `<lastBuildDate>${posts[0].publishedAt.toUTCString()}</lastBuildDate>` : ""}
${items}
</channel>
</rss>
`;
  return new Response(body, {
    headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=600" },
  });
}

import "server-only";

import { articleToMarkdown } from "@markii/renderer/article";
import { pageToMarkdown } from "@markii/renderer/to-markdown";
import { storeView } from "@markii/renderer/views";
import {
  generateAgentMd,
  generateLlmsFullTxt,
  generateLlmsTxt,
  generateSitemapXml,
  type DiscoveryPage,
} from "./generators";
import { defaultWallet } from "./integrations";
import { publishedPages, type SiteData } from "./storefront";
import { membersByHandle } from "./storefront/collections";
import { livePostsForDocs, postsOfSite } from "./blog/queries";
import { descriptionOf } from "./blog/rules";

/**
 * The agent-facing documents a storefront publishes, rendered from one
 * place.
 *
 * They used to be assembled inline in their own route handlers, which was fine
 * while those routes were the only caller. The MCP `markii://site/{slug}/…`
 * resources are a second one, and the options are the part that would drift:
 * `agent.md` needs the payout address resolved through `defaultWallet`, and both
 * need the site's enabled rails and whether purchases are on. A resource that
 * quietly rendered without them would show a merchant a document their store
 * does not serve — which is the failure mode worth designing out, because it
 * looks correct.
 *
 * **The merchant's own pages reach these documents as of M5** (D51): the
 * sitemap lists them, `llms.txt` links them, `llms-full.txt` carries their full
 * text as Markdown. All three read one list (`listedPages`) — **published
 * pages only, and never one marked noindex**: a merchant hiding a page from
 * search engines is not asking for it to be advertised to agents instead.
 *
 * **None of these log traffic**, and the routes still do. An agent crawl is an
 * event that happened; a merchant reading their own store's document through
 * MCP is not one, and counting it would inflate the analytics the merchant uses
 * to judge whether agents find them at all.
 */

async function listedPages(data: SiteData) {
  return (await publishedPages(data.site.id)).filter((p) => !p.seo.noindex);
}

function discovery(p: { title: string; path: string; seo: { description?: string } }): DiscoveryPage {
  return { title: p.title, path: p.path, description: p.seo.description || undefined };
}

/**
 * Live blog posts the documents may name — never a noindex one, for the same
 * reason as pages. Newest first.
 */
async function listedPosts(data: SiteData) {
  return (await livePostsForDocs(data.site.id)).filter((p) => !p.seo.noindex);
}

/** How many posts `llms.txt` lists and `llms-full.txt` carries in full; the rest are one link away. */
const POSTS_IN_DOCS = 20;
const POSTS_IN_FULL_TEXT = 50;

function postDiscovery(p: Awaited<ReturnType<typeof listedPosts>>[number]): DiscoveryPage {
  return { title: p.title, path: `/blog/${p.handle}`, description: descriptionOf(p) || undefined };
}

/** The pages `llms.txt` and `agent.md` advertise — the home page is the store link itself. */
async function advertisedPages(data: SiteData): Promise<DiscoveryPage[]> {
  return (await listedPages(data)).filter((p) => p.path !== "/").map(discovery);
}

export async function renderLlmsTxt(data: SiteData): Promise<string> {
  return generateLlmsTxt(data.bundle, data.baseUrl, {
    rails: data.site.paymentProviders,
    purchasesEnabled: data.site.purchasesEnabled,
    pages: await advertisedPages(data),
    posts: (await listedPosts(data)).slice(0, POSTS_IN_DOCS).map(postDiscovery),
  });
}

export async function renderAgentMd(data: SiteData): Promise<string> {
  const [payTo, pages] = await Promise.all([
    data.site.walletAddress ?? defaultWallet(data.site.orgId),
    advertisedPages(data),
  ]);
  return generateAgentMd(data.bundle, data.baseUrl, {
    payTo,
    rails: data.site.paymentProviders,
    purchasesEnabled: data.site.purchasesEnabled,
    pages,
  });
}

/**
 * Every listed page's full text, home included — its published design is the
 * store's front page and often its only statement of what the store is. Null
 * when the store has published no pages: there is nothing to serve, and an
 * empty document would claim otherwise.
 */
export async function renderLlmsFullTxt(data: SiteData): Promise<string | null> {
  const [pages, posts] = await Promise.all([listedPages(data), listedPosts(data)]);
  if (pages.length === 0 && posts.length === 0) return null;
  const { baseUrl, prods, cats, colls, site } = data;
  const ctx = {
    baseUrl,
    products: prods,
    categories: cats,
    collections: colls,
    values: { store: storeView(site, { baseUrl, products: prods, collections: colls }) },
    membersOf: membersByHandle(colls),
    postsOf: postsOfSite(site.id),
    // The document's title is the h1; each page's own h1 sits under its ## section.
    headingOffset: 2,
  };
  const rendered = await Promise.all(
    pages.map(async (p) => ({ ...discovery(p), markdown: await pageToMarkdown(p.tree, ctx) })),
  );
  const postSections = posts.slice(0, POSTS_IN_FULL_TEXT).map((p) => ({
    ...postDiscovery(p),
    publishedAt: p.publishedAt!.toISOString(),
    markdown: articleToMarkdown(p.body, baseUrl),
  }));
  return generateLlmsFullTxt(data.bundle, baseUrl, rendered, postSections);
}

export async function renderSitemapXml(data: SiteData): Promise<string> {
  const [pages, posts] = await Promise.all([listedPages(data), listedPosts(data)]);
  const blog = posts.length > 0 ? ["/blog", ...posts.map((p) => `/blog/${p.handle}`)] : [];
  return generateSitemapXml(data.bundle, data.baseUrl, [...pages.map((p) => p.path), ...blog]);
}

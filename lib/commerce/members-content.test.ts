import { createElement } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { descriptionOf, excerptOf } from "@/lib/blog/rules";
import { diffDesigns, type DesignSnapshot } from "@/lib/builder/design-diff";
import type { BlogPost } from "@/lib/db";
import { tableSpec, type IdMaps } from "@/lib/store-export/spec";
import { pageJson, postJson, storeJson } from "@/lib/storefront/read-api";
import type { SiteData } from "@/lib/storefront";
import { articleStructuredData } from "@markii/renderer/article-view";
import { MembersGate } from "@markii/renderer/members-gate";
import { PostList } from "@markii/renderer/post-list";

/**
 * Members-only posts and pages (§18.9, migration 0054) — the rules that keep a
 * gated body out of every public surface, tested without a database. The
 * storefront, the read API and the export are covered end to end in
 * `tests/integration/members-content.test.ts`.
 */

const BODY = "The secret blend is three parts sencha to one part genmaicha.";

const post = (over: Partial<BlogPost> = {}): BlogPost =>
  ({
    id: 1, siteId: 1, handle: "blend", title: "The blend", excerpt: "", body: BODY, coverImage: null, coverAlt: "",
    author: "", seo: {}, publishedAt: new Date("2026-11-01T00:00:00Z"), requiresTierId: null, createdBy: "user:1",
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-11-02T00:00:00Z"), ...over,
  }) as BlogPost;

const data = { baseUrl: "https://leaf.test" } as unknown as SiteData;

async function html(el: ReturnType<typeof createElement>): Promise<string> {
  const { prelude } = await prerender(el);
  return new Response(prelude).text();
}

describe("a members-only post's excerpt", () => {
  it("never falls back to the body's opening words, which are the paid content", () => {
    expect(excerptOf(post())).toContain("secret blend");
    expect(excerptOf(post({ requiresTierId: 4 }))).toBe("");
    expect(excerptOf(post({ requiresTierId: 4, excerpt: "  For members  " }))).toBe("For members");
    expect(descriptionOf(post({ requiresTierId: 4 }))).toBe("");
    expect(descriptionOf(post({ requiresTierId: 4, seo: { description: "SEO" } }))).toBe("SEO");
  });
});

describe("the read API's members-only answers", () => {
  const gate = (unlocked: boolean) => ({ tierName: "Tea Club", unlocked, join: [{ name: "Club membership", slug: "club" }] });

  it("sends a gated post's body only to a caller the gate unlocks, and locked when it is not asked", () => {
    const gated = post({ requiresTierId: 4 });
    expect(postJson(data, gated)).toMatchObject({ locked: true, body: "", membersOnly: true, requiresTierId: 4, excerpt: "" });
    const locked = postJson(data, gated, gate(false));
    expect(locked).toMatchObject({ locked: true, body: "" });
    expect(locked.gate).toEqual({ tierName: "Tea Club", join: [{ name: "Club membership", slug: "club", url: "https://leaf.test/p/club" }] });
    expect(JSON.stringify(locked)).not.toContain("secret blend");
    expect(postJson(data, gated, gate(true))).toMatchObject({ locked: false, body: BODY });
  });

  it("leaves a public post as it was", () => {
    expect(postJson(data, post())).toMatchObject({ locked: false, gate: null, body: BODY, membersOnly: false, requiresTierId: null });
  });

  it("withholds a gated page's tree the same way", () => {
    const page = { handle: "club", title: "Club", seo: {}, tree: { id: "n_000000root", type: "root" }, requiresTierId: 4 };
    expect(pageJson(data, page)).toMatchObject({ locked: true, tree: null, url: "https://leaf.test/pages/club" });
    expect(pageJson(data, page, gate(true)).tree).toEqual(page.tree);
    expect(pageJson(data, { ...page, requiresTierId: null })).toMatchObject({ locked: false, gate: null });
  });

  it("lists members-only pages beside the design", () => {
    const site = { site: { name: "Leaf", slug: "leaf", themeId: "atlas", agentDiscovery: true, purchasesEnabled: true, paymentProviders: {} }, baseUrl: "https://leaf.test", prods: [], cats: [], colls: [] } as unknown as SiteData;
    expect(storeJson(site, null).membersOnlyPages).toEqual([]);
    expect(storeJson(site, null, [{ handle: "club", requiresTierId: 4 }]).membersOnlyPages).toEqual([{ handle: "club", requiresTierId: 4 }]);
  });
});

describe("drawing a members-only post", () => {
  it("names the tier, links sign-in and every way to join", async () => {
    const out = await html(
      createElement(MembersGate, {
        what: "post",
        tierName: "Tea Club",
        signInHref: "https://leaf.test/account",
        join: [
          { name: "Monthly", href: "https://leaf.test/p/monthly" },
          { name: "Yearly", href: "https://leaf.test/p/yearly" },
        ],
      }),
    );
    expect(out).toContain("This post is for Tea Club members.");
    expect(out).toContain('href="https://leaf.test/account"');
    expect(out).toMatch(/href="https:\/\/leaf.test\/p\/monthly">Monthly<\/a><\/span><span> or <a href="https:\/\/leaf.test\/p\/yearly">Yearly/);
  });

  it("does not point at nothing when no product grants the tier", async () => {
    const out = await html(createElement(MembersGate, { what: "page", tierName: null, signInHref: "/account", join: [] }));
    expect(out).toContain("This page is for members.");
    expect(out).not.toContain("Join with");
  });

  it("labels it in a listing", async () => {
    const out = await html(
      createElement(PostList, {
        posts: [{ handle: "blend", title: "The blend", excerpt: "", coverImage: null, coverAlt: "", author: "", publishedAt: "2026-11-01T00:00:00Z", membersOnly: true }],
        baseUrl: "https://leaf.test",
      }),
    );
    expect(out).toContain("Members only");
  });

  it("tells search engines it is not free, and where the body is when a member reads it", () => {
    const base = { title: "T", description: "", url: "u", publishedAt: "p", modifiedAt: "m", store: { name: "Leaf", url: "s" } };
    expect(articleStructuredData(base)).not.toHaveProperty("isAccessibleForFree");
    expect(articleStructuredData({ ...base, membersOnly: { bodyShown: false } })).toMatchObject({ isAccessibleForFree: false });
    expect(articleStructuredData({ ...base, membersOnly: { bodyShown: false } })).not.toHaveProperty("hasPart");
    expect(articleStructuredData({ ...base, membersOnly: { bodyShown: true } })).toMatchObject({
      isAccessibleForFree: false,
      hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".mk-article-body" },
    });
  });
});

describe("a page's gate in the design", () => {
  const doc = (requiresTierId?: number | null): DesignSnapshot["documents"][number] => ({
    id: 2, kind: "page", handle: "club", title: "Club", seo: {}, tree: { id: "n_000000root", type: "root", props: {} }, ...(requiresTierId !== undefined ? { requiresTierId } : {}),
  });
  const snap = (d: DesignSnapshot["documents"][number]): DesignSnapshot => ({ themeId: "studio", tokens: {}, documents: [d] });

  it("is a change a publish diff names — and a snapshot from before it existed reads as public", () => {
    const d = diffDesigns(snap(doc(null)), snap(doc(4)));
    expect(d.documents[0].fields).toEqual([{ field: "requiresTierId", before: null, after: 4 }]);
    expect(diffDesigns(snap(doc()), snap(doc(null))).identical).toBe(true);
  });

  it("travels in a store export's past versions — and a tier the import cannot map never becomes public", () => {
    const ids: IdMaps = new Map([
      ["siteDocuments", new Map([[2, 202]])],
      ["membershipTiers", new Map([[4, 404]])],
    ]);
    const versions = tableSpec("siteDesignVersions")!;
    const out = versions.remap!({ snapshot: { documents: [{ id: 2, requiresTierId: 4 }, { id: 3, requiresTierId: 9 }, { id: 5, requiresTierId: null }, { id: 6 }] } }, ids);
    expect((out.snapshot as { documents: unknown[] }).documents).toEqual([
      { id: 202, requiresTierId: 404 },
      { id: -2, requiresTierId: -1 },
      { id: -3, requiresTierId: null },
      { id: -4 },
    ]);
  });
});

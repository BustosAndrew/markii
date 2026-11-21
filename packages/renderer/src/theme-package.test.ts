import { describe, expect, it } from "vitest";
import { BLOCKS } from "./blocks";
import {
  ASSET_REF,
  documentProblems,
  imageRefs,
  mapImages,
  packageFromDesign,
  themeFileSchema,
  themePackageSchema,
  type ThemePackage,
} from "./theme-package";
import { validateTree } from "./tree";
import type { PageNode } from "./types";

/**
 * D53 — the theme package. The image walker is the piece that matters most:
 * a reference it misses ships as a link back to the seller's store, silently,
 * because nothing else looks.
 */

const OWN = "https://media.test/storage/v1/object/public/public-media/org_1";

function home(): PageNode {
  return {
    id: "n_0000000001",
    type: "root",
    props: {},
    children: [
      {
        id: "n_0000000002",
        type: "section",
        props: {},
        children: [
          { id: "n_0000000003", type: "image", props: { src: `${OWN}/hero.png`, alt: "Hero" } },
          {
            id: "n_0000000004",
            type: "html",
            props: { html: `<p>Hi</p><img src="${OWN}/inline.webp" alt="x"><img src='https://cdn.elsewhere.test/a.jpg'>` },
          },
          { id: "n_0000000005", type: "storeBrand", props: { logoSrc: `${OWN}/logo.png`, showName: true } },
        ],
      },
    ],
  };
}

function pkg(): ThemePackage {
  return themePackageSchema.parse({
    format: "markii.theme",
    version: 1,
    theme: {
      themeId: "studio",
      tokens: {},
      customCss: `.hero { background: url("${OWN}/bg.jpg") } .x { background: url(https://cdn.elsewhere.test/b.png) }`,
    },
    documents: [{ kind: "page", handle: "home", title: "Home", seo: { ogImage: `${OWN}/share.png` }, tree: home() }],
    savedBlocks: [{ name: "Banner", node: { type: "image", props: { src: `${OWN}/banner.png`, alt: "" } } }],
  });
}

describe("the image walker finds every place an image can be", () => {
  it("finds block props, the link-preview image, custom HTML and theme CSS", () => {
    const refs = imageRefs(pkg());
    const byPlace = (p: string) => refs.filter((r) => r.place === p).map((r) => r.url).sort();
    expect(byPlace("block")).toEqual([`${OWN}/banner.png`, `${OWN}/hero.png`, `${OWN}/logo.png`].sort());
    expect(byPlace("seo")).toEqual([`${OWN}/share.png`]);
    // The single-quoted src is found too: HTML is rebuilt to the canonical form before it is read.
    expect(byPlace("html")).toEqual(["https://cdn.elsewhere.test/a.jpg", `${OWN}/inline.webp`].sort());
    expect(byPlace("css")).toEqual([`${OWN}/bg.jpg`, "https://cdn.elsewhere.test/b.png"].sort());
  });

  it("says where each one is, so a person can find it", () => {
    const hero = imageRefs(pkg()).find((r) => r.url.endsWith("hero.png"))!;
    expect(hero.where).toBe('page "home" › image n_0000000003');
    const banner = imageRefs(pkg()).find((r) => r.url.endsWith("banner.png"))!;
    expect(banner.where).toContain('saved block "Banner"');
  });

  it("covers every block prop the registry marks as an image — a new one joins on its own", () => {
    for (const def of BLOCKS.values()) {
      for (const field of def.editorPanel ?? []) {
        if (field.kind !== "image") continue;
        const tree: PageNode = {
          id: "n_0000000001",
          type: "root",
          props: {},
          children: [{ id: "n_0000000002", type: def.type, props: { [field.name]: "https://x.test/i.png" } }],
        };
        const refs = imageRefs({ theme: { themeId: "studio", tokens: {}, customCss: "" }, documents: [{ kind: "page", handle: "home", title: "Home", seo: {}, tree }], savedBlocks: [] });
        expect(refs.map((r) => r.url), `${def.type}.${field.name}`).toEqual(["https://x.test/i.png"]);
      }
    }
  });

  it("rewrites what it finds and leaves everything else alone", () => {
    const out = mapImages(pkg(), (url) => (url.startsWith(OWN) ? `asset:${"a".repeat(64)}` : url));
    const refs = imageRefs(out);
    for (const r of refs) {
      if (r.url.includes("elsewhere")) continue;
      expect(r.url, r.where).toMatch(ASSET_REF);
    }
    expect(refs.filter((r) => r.url.includes("elsewhere"))).toHaveLength(2);
    // Untouched CSS around the url() survives byte for byte.
    expect(out.theme.customCss).toContain(".hero { background: url(\"asset:");
    expect(out.theme.customCss).toContain("url(https://cdn.elsewhere.test/b.png)");
  });

  it("escapes a rewritten URL inside custom HTML instead of breaking out of the attribute", () => {
    const out = mapImages(pkg(), (url) => (url.endsWith("inline.webp") ? 'https://x.test/a.png"onerror="alert(1)' : url));
    const html = (out.documents[0].tree.children![0].children![1].props as { html: string }).html;
    expect(html).not.toContain('"onerror=');
    expect(html).toContain("&quot;onerror=&quot;");
  });
});

describe("the file form and the applied form", () => {
  it("a file may hold asset tokens where the applied form needs https URLs", () => {
    const tokened = mapImages(pkg(), (url) => (url.startsWith(OWN) ? `asset:${"b".repeat(64)}` : url));
    // The applied form refuses a token in the link-preview image…
    expect(themePackageSchema.safeParse(tokened).success).toBe(false);
    // …the file form takes it, with the bytes alongside.
    expect(themeFileSchema.safeParse({ ...tokened, assets: [] }).success).toBe(true);
  });

  it("refuses another format or a future version rather than guessing", () => {
    expect(themePackageSchema.safeParse({ ...pkg(), format: "shopify.theme" }).success).toBe(false);
    expect(themePackageSchema.safeParse({ ...pkg(), version: 2 }).success).toBe(false);
  });

  it("has no place for head code — scripts never travel", () => {
    expect(themePackageSchema.safeParse({ ...pkg(), headHtml: "<script></script>" }).success).toBe(false);
    expect(themePackageSchema.safeParse({ ...pkg(), theme: { ...pkg().theme, headHtml: "<script></script>" } }).success).toBe(false);
  });

  it("a package's trees pass the same validation any edit does", () => {
    for (const d of pkg().documents) expect(() => validateTree(d.tree as PageNode)).not.toThrow();
  });
});

describe("document rules", () => {
  it("needs a home page, real addresses, and real template and region slots", () => {
    expect(documentProblems([{ kind: "page", handle: "home" }])).toEqual([]);
    expect(documentProblems([{ kind: "page", handle: "about" }])).toContain("A theme package must include the home page.");
    expect(documentProblems([{ kind: "page", handle: "home" }, { kind: "page", handle: "About Us" }]).join(" ")).toMatch(/not a page address/);
    expect(documentProblems([{ kind: "page", handle: "home" }, { kind: "template", handle: "blog" }]).join(" ")).toMatch(/no "blog" template/);
    expect(documentProblems([{ kind: "page", handle: "home" }, { kind: "region", handle: "sidebar" }]).join(" ")).toMatch(/no "sidebar" region/);
    expect(documentProblems([{ kind: "page", handle: "home" }, { kind: "page", handle: "home" }]).join(" ")).toMatch(/Two pages/);
  });
});

describe("building a package from a design", () => {
  const design = {
    draftThemeId: "noir",
    draftTokens: { accent: "#112233" },
    publishedTokens: { accent: "#445566" },
    draftCustomCss: ".draft{}",
    publishedCustomCss: ".live{}",
  };
  const doc = (over: Record<string, unknown>) => ({
    kind: "page" as const,
    handle: "home",
    title: "Home",
    seo: {},
    draftTree: home(),
    draftDeleted: false,
    publishedHandle: null,
    publishedTitle: null,
    publishedSeo: null,
    publishedTree: null,
    ...over,
  });

  it("draft is what the editor shows, published is what shoppers see", () => {
    const docs = [
      doc({ publishedHandle: "home", publishedTitle: "Home (live)", publishedTree: home() }),
      doc({ handle: "about", title: "About" }), // never published
      doc({ handle: "old", title: "Old", draftDeleted: true, publishedHandle: "old", publishedTitle: "Old", publishedTree: home() }),
    ];
    const draft = packageFromDesign({ source: "draft", publishedThemeId: "studio", design, documents: docs, savedBlocks: [] })!;
    expect(draft.theme).toEqual({ themeId: "noir", tokens: { accent: "#112233" }, customCss: ".draft{}" });
    expect(draft.documents.map((d) => d.handle)).toEqual(["home", "about"]);

    const live = packageFromDesign({ source: "published", publishedThemeId: "studio", design, documents: docs, savedBlocks: [] })!;
    expect(live.theme).toEqual({ themeId: "studio", tokens: { accent: "#445566" }, customCss: ".live{}" });
    expect(live.documents.map((d) => [d.handle, d.title])).toEqual([["home", "Home (live)"], ["old", "Old"]]);
    expect(themePackageSchema.safeParse(live).success).toBe(true);
  });

  it("answers null for published when nothing is live, rather than an empty theme", () => {
    expect(packageFromDesign({ source: "published", publishedThemeId: "studio", design, documents: [doc({})], savedBlocks: [] })).toBeNull();
  });
});

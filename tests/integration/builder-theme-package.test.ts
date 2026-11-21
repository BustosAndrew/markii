import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Theme packages (D53) against a real database, dev server and storage: a
 * design copied between two stores of one org, a package imported through the
 * registry, and the file path — export, upload, import — carrying the store's
 * own image inside the file and landing it in the importing org's storage.
 *
 * What only the wiring shows: that a copy replaces the draft and leaves what
 * shoppers see alone, that unpublished work is never overwritten silently,
 * that neither an API token nor another org can reach it, and that an image
 * in an imported theme points at the importer's storage, not the seller's.
 */

// A real 1×1 PNG — the import checks the file signature, not the label.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("site builder — theme packages (D53)", () => {
  const merchant = new Client();
  const other = new Client();
  const cleanup = new Cleanup();
  let orgId: string;
  let a: { id: number; slug: string };
  let b: { id: number; slug: string };
  let c: { id: number; slug: string };
  let otherSite: number;
  let token: string;
  let imageUrl: string | null = null;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const design = async (site: number) => (await merchant.get(`/api/builder/sites/${site}`)).json;
  const page = async (site: number, pageId: number) => (await merchant.get(`/api/builder/sites/${site}/pages/${pageId}`)).json;
  const homeOf = async (site: number) => {
    const d = await design(site);
    return page(site, d.pages.find((p: any) => p.handle === "home").id);
  };

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "themepkg");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
    const sa = await createTestStore(cleanup, "pkga", { orgId });
    const sb = await createTestStore(cleanup, "pkgb", { orgId });
    const sc = await createTestStore(cleanup, "pkgc", { orgId });
    a = { id: sa.site.id, slug: sa.slug };
    b = { id: sb.site.id, slug: sb.slug };
    c = { id: sc.site.id, slug: sc.slug };

    const { email: otherEmail } = await signUpMerchant(other, "themepkg2");
    cleanup.merchantEmails.push(otherEmail);
    const otherOrg = (await other.get("/api/me")).json.org.id;
    otherSite = (await createTestStore(cleanup, "pkgo", { orgId: otherOrg })).site.id;

    // The store's own upload, so the file path has an image to carry.
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "dot.png");
    const up = await merchant.postForm("/api/uploads", form);
    if (up.status === 201) imageUrl = up.json.url;

    // Store A: a designed, published store with a page, theme CSS, an image and a saved block.
    expect((await act("builder.startDesign", { siteId: a.id })).status).toBe(200);
    expect((await act("builder.setTheme", { siteId: a.id, themeId: "noir" })).status).toBe(200);
    const about = await act("builder.createPage", { siteId: a.id, handle: "about", title: "About us" });
    expect(about.status, JSON.stringify(about.json)).toBe(200);
    expect((await act("builder.setCustomCss", { siteId: a.id, css: ".promo { color: red }" })).status).toBe(200);
    const home = await homeOf(a.id);
    if (imageUrl) {
      const added = await act("builder.addBlock", {
        siteId: a.id,
        pageId: home.id,
        parentId: home.tree.children[0].id,
        type: "image",
        props: { src: imageUrl, alt: "A dot" },
      });
      expect(added.status, JSON.stringify(added.json)).toBe(200);
    }
    expect((await act("builder.saveBlock", { siteId: a.id, name: "Promo", node: { type: "heading", props: { text: "Sale" } } })).status).toBe(200);
    const pub = await act("builder.publish", { siteId: a.id });
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);

    const created = await merchant.post("/api/org/tokens", { label: "pkg", role: "administrator" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    token = created.json.token;
  }, 240_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("copies a published design into a store that was never designed — into its draft only", async () => {
    const res = await act("builder.copyDesign", { siteId: b.id, fromSiteId: a.id });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result).toMatchObject({ documents: 2, headCode: "kept", savedBlocks: { added: ["Promo"], skipped: [] } });

    const d = await design(b.id);
    expect(d.started).toBe(true);
    expect(d.themeId).toBe("noir");
    expect(d.pages.map((p: any) => p.handle).sort()).toEqual(["about", "home"]);
    // Nothing is live until a person publishes.
    expect(d.publishedVersion).toBe(0);
    expect(d.hasUnpublishedChanges).toBe(true);

    // The same org's image is kept as it is — both stores share the org's media.
    if (imageUrl) {
      const home = await homeOf(b.id);
      expect(JSON.stringify(home.tree)).toContain(imageUrl);
    }
    const saved = (await merchant.get(`/api/builder/sites/${b.id}/saved-blocks`)).json.items;
    expect(saved.map((s: any) => s.name)).toEqual(["Promo"]);
  });

  it("refuses to overwrite unpublished work unless told to", async () => {
    const again = await act("builder.copyDesign", { siteId: b.id, fromSiteId: a.id });
    expect(again.status).toBe(409);
    expect(again.json.error.details.reason).toBe("unpublished_changes");

    const forced = await act("builder.copyDesign", { siteId: b.id, fromSiteId: a.id, discardUnpublished: true });
    expect(forced.status, JSON.stringify(forced.json)).toBe(200);
    // The saved block already exists under that name, so the store keeps its own.
    expect(forced.json.result.savedBlocks).toEqual({ added: [], skipped: [{ name: "Promo", reason: "name_taken" }] });
  });

  it("copies the draft when asked, which can differ from what is live", async () => {
    expect((await act("builder.createPage", { siteId: a.id, handle: "draft-only", title: "Draft only" })).status).toBe(200);
    const res = await act("builder.copyDesign", { siteId: b.id, fromSiteId: a.id, source: "draft", discardUnpublished: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await design(b.id)).pages.map((p: any) => p.handle).sort()).toEqual(["about", "draft-only", "home"]);
  });

  it("refuses copying a store onto itself, from another org, or by an API token", async () => {
    const self = await act("builder.copyDesign", { siteId: a.id, fromSiteId: a.id });
    expect(self.status).toBe(409);

    // Another org's store answers exactly as one that does not exist.
    const foreign = await act("builder.copyDesign", { siteId: b.id, fromSiteId: otherSite, discardUnpublished: true });
    expect(foreign.status).toBe(404);

    const viaToken = await fetch(`${BASE_URL}/api/actions/builder.copyDesign`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ siteId: b.id, fromSiteId: a.id, discardUnpublished: true }),
    });
    expect(viaToken.status).toBe(403);
    expect((await viaToken.json()).error.code).toBe("HUMAN_APPROVAL_REQUIRED");
  });

  it("imports a package through the registry, and refuses one without a home page or with unresolved images", async () => {
    const pkg = {
      format: "markii.theme",
      version: 1,
      theme: { themeId: "bloom", tokens: {}, customCss: "" },
      documents: [
        {
          kind: "page",
          handle: "home",
          title: "Home",
          seo: {},
          tree: { id: "n_aaaaaaaaaa", type: "root", props: {}, children: [{ id: "n_bbbbbbbbbb", type: "section", props: {}, children: [] }] },
        },
      ],
      savedBlocks: [],
    };
    const ok = await act("builder.importTheme", { siteId: c.id, package: pkg });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await design(c.id)).themeId).toBe("bloom");

    const noHome = await act("builder.importTheme", {
      siteId: c.id,
      discardUnpublished: true,
      package: { ...pkg, documents: [{ ...pkg.documents[0], handle: "about" }] },
    });
    expect(noHome.status).toBe(400);
    expect(noHome.json.error.message).toMatch(/home page/);

    // A bundled-image token cannot reach the applied form: the import route resolves them first.
    const tokened = await act("builder.importTheme", {
      siteId: c.id,
      discardUnpublished: true,
      package: { ...pkg, theme: { ...pkg.theme, customCss: `.x { background: url(asset:${"c".repeat(64)}) }` } },
    });
    expect(tokened.status).toBe(400);
  });

  /**
   * The storefront as a Next.js app (D53): a zip behind a download link, read
   * back through its own central directory. What matters is that it is the
   * renderer plus the scaffold, names this store, and holds no secret.
   */
  it("exports the storefront as a Next.js project the merchant can deploy", async () => {
    const res = await merchant.post(`/api/builder/sites/${a.id}/next-export`, {});
    if (res.status === 503) return; // storage not configured on this deployment
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toMatchObject({ storeLive: true });
    expect(res.json.storeUrl).toContain(a.slug);

    const zipped = Buffer.from(await (await fetch(res.json.url)).arrayBuffer());
    expect(zipped.readUInt32LE(0)).toBe(0x04034b50);
    const names: string[] = [];
    const end = zipped.length - 22;
    let p = zipped.readUInt32LE(end + 16);
    for (let i = 0; i < zipped.readUInt16LE(end + 10); i++) {
      const len = zipped.readUInt16LE(p + 28);
      names.push(zipped.subarray(p + 46, p + 46 + len).toString("utf8"));
      p += 46 + len;
    }
    expect(names).toEqual(expect.arrayContaining(["package.json", "LICENSE", "lib/shopper.ts", "renderer/src/render.tsx", "app/p/[slug]/page.tsx"]));
    expect(names.some((n) => n.endsWith(".test.ts"))).toBe(false);
    expect(res.json.files).toBe(names.length);

    // No session, no export.
    expect((await new Client().post(`/api/builder/sites/${a.id}/next-export`, {})).status).toBe(401);
  });

  it("exports a file with the store's own image inside it, and imports it into another org's storage", async () => {
    const exported = await merchant.post(`/api/builder/sites/${a.id}/theme-export`, { source: "published" });
    if (exported.status === 503) return; // storage not configured on this deployment: nothing to prove here
    expect(exported.status, JSON.stringify(exported.json)).toBe(201);
    expect(exported.json.headCodeLeftOut).toBe(false);
    if (imageUrl) expect(exported.json.images.bundled).toBe(1);

    const file = await fetch(exported.json.url).then((r) => r.json());
    expect(file.format).toBe("markii.theme");
    expect(file).not.toHaveProperty("headHtml");
    if (imageUrl) {
      expect(JSON.stringify(file.documents)).not.toContain(imageUrl);
      expect(JSON.stringify(file.documents)).toMatch(/asset:[a-f0-9]{64}/);
      expect(file.assets).toHaveLength(1);
    }

    // Another org imports it: upload straight to storage, then import from the caller's own slot.
    const slot = await other.post(`/api/builder/sites/${otherSite}/theme-import/upload-url`, {});
    expect(slot.status, JSON.stringify(slot.json)).toBe(201);
    const put = await fetch(slot.json.uploadUrl, { method: "PUT", headers: slot.json.headers, body: JSON.stringify(file) });
    expect(put.ok, await put.text()).toBe(true);

    const uploadId = slot.json.uploadId;
    const dry = await other.post(`/api/builder/sites/${otherSite}/theme-import?dryRun=1`, { uploadId });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json.dryRun).toBe(true);

    // Nobody else can import that upload: the path is under the uploader's own prefix.
    const stranger = await merchant.post(`/api/builder/sites/${c.id}/theme-import`, { uploadId, discardUnpublished: true });
    expect(stranger.status).toBe(404);
    expect(stranger.json.error.details.reason).toBe("no_upload");

    const imported = await other.post(`/api/builder/sites/${otherSite}/theme-import`, { uploadId });
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);
    const d = (await other.get(`/api/builder/sites/${otherSite}`)).json;
    expect(d.themeId).toBe("noir");
    expect(d.pages.map((p: any) => p.handle).sort()).toEqual(["about", "home"]);

    if (imageUrl) {
      const otherOrg = (await other.get("/api/me")).json.org.id;
      const homeId = d.pages.find((p: any) => p.handle === "home").id;
      const tree = JSON.stringify((await other.get(`/api/builder/sites/${otherSite}/pages/${homeId}`)).json.tree);
      // The image now lives in the importer's storage, not the seller's.
      expect(tree).not.toContain(imageUrl);
      expect(tree).toContain(`/public-media/${otherOrg}/theme-assets/`);
      const stored = tree.match(/https:[^"]+theme-assets\/[a-f0-9]{64}\.png/)![0];
      const img = await fetch(stored);
      expect(img.status).toBe(200);
      expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
    }

    // A second, different upload imports *its* content — never the file before it.
    const slot2 = await other.post(`/api/builder/sites/${otherSite}/theme-import/upload-url`, {});
    expect(slot2.json.uploadId).not.toBe(uploadId);
    const changed = { ...file, theme: { ...file.theme, themeId: "atlas" } };
    const put2 = await fetch(slot2.json.uploadUrl, { method: "PUT", headers: slot2.json.headers, body: JSON.stringify(changed) });
    expect(put2.ok).toBe(true);
    const second = await other.post(`/api/builder/sites/${otherSite}/theme-import`, { uploadId: slot2.json.uploadId, discardUnpublished: true });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect((await other.get(`/api/builder/sites/${otherSite}`)).json.themeId).toBe("atlas");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The site builder (Phase D, D51) against a real database and dev server.
 *
 * What the unit tests cannot show is the wiring: that a draft really does not
 * reach the storefront until publish, that publish swaps the fixed home for
 * the design in one step, that undo runs through the registry, and that the
 * agent's edit lease refuses a person's write while it stands.
 */
describe("site builder", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();
  let orgId: string;
  let siteId: number;
  let slug: string;
  let homeId: number;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const storefront = (path = "") => shopper.getRaw(`/_sites/${slug}${path}`);
  const homePage = async () => (await merchant.get(`/api/builder/sites/${siteId}/pages/${homeId}`)).json;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "builder");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "builder", { orgId });
    siteId = store.site.id;
    slug = store.slug;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("reports a design that has not been started, and refuses edits until it is", async () => {
    const summary = await merchant.get(`/api/builder/sites/${siteId}`);
    expect(summary.status).toBe(200);
    expect(summary.json).toEqual({ siteId, started: false });

    const early = await act("builder.setTheme", { siteId, themeId: "noir" });
    expect(early.status).toBe(409);
    expect(early.json.error.details.reason).toBe("design_not_started");
  });

  it("starts a design idempotently, seeding a home page that is not yet live", async () => {
    const first = await act("builder.startDesign", { siteId });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.result).toEqual({ siteId, started: true });
    const again = await act("builder.startDesign", { siteId });
    expect(again.json.result).toEqual({ siteId, started: false });

    const summary = (await merchant.get(`/api/builder/sites/${siteId}`)).json;
    expect(summary.started).toBe(true);
    expect(summary.pages).toHaveLength(1);
    expect(summary.pages[0]).toMatchObject({ handle: "home", path: "/", published: false });
    homeId = summary.pages[0].id;

    const page = await homePage();
    expect(page.tree.children.map((s: any) => s.children.map((c: any) => c.type))).toEqual([["heading", "text"], ["productGrid"]]);

    // Nothing published: the storefront is still the fixed layout.
    const live = await storefront();
    expect(live.status).toBe(200);
    expect(live.text).toContain("sf-hero");
    expect(live.text).not.toContain("mk-page");
  });

  it("keeps draft edits off the storefront until publish, then shows them", async () => {
    const intro = (await homePage()).tree.children[0];
    const added = await act("builder.addBlock", {
      siteId,
      pageId: homeId,
      parentId: intro.id,
      type: "button",
      props: { label: "Browse the range", href: "/collections" },
    });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    expect(added.json.result.revision).toBeGreaterThan(0);

    const heading = intro.children[0];
    const renamed = await act("builder.setProps", { siteId, pageId: homeId, nodeId: heading.id, props: { text: "Draft headline" } });
    expect(renamed.status).toBe(200);

    expect((await storefront()).text).not.toContain("Draft headline");

    const published = await act("builder.publish", { siteId, note: "first design" });
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    expect(published.json.result.version).toBe(1);

    const live = await storefront();
    expect(live.text).toContain("Draft headline");
    expect(live.text).toContain("Browse the range");
    expect(live.text).toContain("mk-page");
    // The live page carries no editor attributes.
    expect(live.text).not.toContain("data-mk-node");
    // The seeded product grid renders the store's real products.
    expect(live.text).toContain("Test Product One");

    const summary = (await merchant.get(`/api/builder/sites/${siteId}`)).json;
    expect(summary.hasUnpublishedChanges).toBe(false);
    expect((await merchant.get(`/api/builder/sites/${siteId}/versions`)).json.items[0]).toMatchObject({ version: 1, note: "first design" });
  });

  it("undoes an edit through the registry", async () => {
    const intro = (await homePage()).tree.children[0];
    const added = await act("builder.addBlock", { siteId, pageId: homeId, parentId: intro.id, type: "divider" });
    const nodeId = added.json.result.nodeId;
    expect(JSON.stringify((await homePage()).tree)).toContain(nodeId);

    const undone = await merchant.post(`/api/actions/builder.addBlock/undo`, { invocationId: added.json.invocationId });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect(JSON.stringify((await homePage()).tree)).not.toContain(nodeId);
  });

  it("serves a new page only once it is published", async () => {
    const created = await act("builder.createPage", { siteId, handle: "about", title: "About us" });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect((await storefront("/pages/about")).status).toBe(404);

    await act("builder.publish", { siteId });
    const about = await storefront("/pages/about");
    expect(about.status).toBe(200);
    expect(about.text).toContain("About us");
    // The home page is not served a second time under /pages.
    expect((await storefront("/pages/home")).status).toBe(404);
  });

  it("publishes design tokens to every storefront page, not only builder pages", async () => {
    const set = await act("builder.setThemeTokens", { siteId, tokens: { accent: "#c9184a" } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.result.tokens.accent).toBe("#C9184A");
    expect((await storefront("/search?q=test")).text).not.toContain("#C9184A");

    await act("builder.publish", { siteId });
    expect((await storefront("/search?q=test")).text).toContain("#C9184A");
  });

  it("blocks publishing a draft with a broken block, and says why", async () => {
    const intro = (await homePage()).tree.children[0];
    const image = await act("builder.addBlock", { siteId, pageId: homeId, parentId: intro.id, type: "image" });
    const blocked = await act("builder.publish", { siteId });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details.reason).toBe("checks_failed");
    expect(blocked.json.error.details.checks.map((c: any) => c.code)).toContain("MISSING_IMAGE_SOURCE");

    await act("builder.removeNodes", { siteId, pageId: homeId, nodeIds: [image.json.result.nodeId] });
  });

  it("refuses a person's edit while the brand agent holds the lease, and allows it after", async () => {
    // A turn holding the lease, as M3's agent turn will set it.
    await sql`update site_designs set agent_lock_session_id = 'as_testlease000000000000', agent_lock_expires_at = now() + interval '1 minute'
              where site_id = ${siteId}`;
    const refused = await act("builder.setTheme", { siteId, themeId: "noir" });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("AGENT_EDITING");
    expect((await merchant.get(`/api/builder/sites/${siteId}/revision`)).json.agentLock.active).toBe(true);

    // An expired lease frees the site without anyone releasing it.
    await sql`update site_designs set agent_lock_expires_at = now() - interval '1 second' where site_id = ${siteId}`;
    const allowed = await act("builder.setTheme", { siteId, themeId: "noir" });
    expect(allowed.status, JSON.stringify(allowed.json)).toBe(200);
  });

  it("refuses an API token publishing — a person must", async () => {
    const created = await merchant.post("/api/org/tokens", { label: "builder", role: "developer" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const viaToken = (id: string, input: unknown) =>
      fetch(`${BASE_URL}/api/actions/${id}`, {
        method: "POST",
        headers: { authorization: `Bearer ${created.json.token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      }).then(async (r) => ({ status: r.status, json: await r.json() }));

    // A token may edit the draft (MCP clients build sites this way)…
    const edit = await viaToken("builder.setTheme", { siteId, themeId: "atlas" });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    // …but not publish it.
    const publish = await viaToken("builder.publish", { siteId });
    expect(publish.status).toBe(403);
    expect(publish.json.error.code).toBe("HUMAN_APPROVAL_REQUIRED");
  });

  it("does not let another org read or edit this design", async () => {
    const other = new Client();
    const { email } = await signUpMerchant(other, "builder-other");
    cleanup.merchantEmails.push(email);
    expect((await other.get(`/api/builder/sites/${siteId}`)).status).toBe(404);
    const edit = await other.post(`/api/actions/builder.setTheme`, { siteId, themeId: "bloom" });
    expect(edit.status).toBe(404);
  });
});

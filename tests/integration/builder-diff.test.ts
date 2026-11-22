import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant } from "./helpers";

/**
 * Version diff (`docs/BUILDER.md` §12) against a real database. The unit tests
 * prove the comparison; this proves the three states it reads — the draft, the
 * live design and a stored version — are read into one shape, so a change made
 * through the registry shows up between them and nothing else does.
 */
describe("site builder — version diff", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let homeId: number;
  let headingId: string;
  let buttonId: string;

  const act = async (id: string, input: unknown) => {
    const res = await merchant.post(`/api/actions/${id}`, input);
    expect(res.status, `${id}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json.result;
  };
  const diff = (query = "") => merchant.get(`/api/builder/sites/${siteId}/diff${query}`);

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "builder-diff");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    siteId = (await createTestStore(cleanup, "builder-diff", { orgId })).site.id;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("refuses before the design exists, and asks for a publish before comparing with live", async () => {
    const early = await diff();
    expect(early.status).toBe(409);
    expect(early.json.error.details.reason).toBe("design_not_started");

    await act("builder.startDesign", { siteId });
    const unpublished = await diff();
    expect(unpublished.status).toBe(409);
    expect(unpublished.json.error.details.reason).toBe("nothing_published");
  });

  it("finds the draft identical to live straight after publishing", async () => {
    await act("builder.publish", { siteId, note: "first" });
    const res = await diff();
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.identical).toBe(true);
    expect(res.json.from).toMatchObject({ ref: "version", version: 1, live: true, note: "first" });
    expect(res.json.to).toMatchObject({ ref: "draft", version: null, live: false });
  });

  it("shows exactly the draft's edits as what publishing would change", async () => {
    const summary = (await merchant.get(`/api/builder/sites/${siteId}`)).json;
    homeId = summary.pages[0].id;
    const intro = (await merchant.get(`/api/builder/sites/${siteId}/pages/${homeId}`)).json.tree.children[0];
    headingId = intro.children[0].id;

    await act("builder.setProps", { siteId, pageId: homeId, nodeId: headingId, props: { text: "New headline" } });
    buttonId = (
      await act("builder.addBlock", { siteId, pageId: homeId, parentId: intro.id, type: "button", props: { label: "Shop", href: "/" } })
    ).nodeId;
    await act("builder.setTheme", { siteId, themeId: "noir" });

    const res = (await diff()).json;
    expect(res.identical).toBe(false);
    expect(res.theme).toMatchObject({ after: "noir" });
    expect(res.documents).toHaveLength(1);
    const home = res.documents[0];
    expect(home).toMatchObject({ id: homeId, handle: "home", change: "changed", fields: [] });
    expect(home.nodes.added).toEqual([{ id: buttonId, type: "button", label: "Button" }]);
    expect(home.nodes.removed).toEqual([]);
    expect(home.nodes.changed).toEqual([
      expect.objectContaining({ id: headingId, changes: [expect.objectContaining({ field: "props.text", after: "New headline" })] }),
    ]);
  });

  it("compares two stored versions in either direction", async () => {
    await act("builder.publish", { siteId, note: "second" });
    expect((await diff()).json.identical).toBe(true);

    const forward = (await diff("?from=1&to=2")).json;
    expect(forward.from).toMatchObject({ version: 1, live: false });
    expect(forward.to).toMatchObject({ version: 2, live: true, note: "second" });
    expect(forward.documents[0].nodes.added.map((n: { id: string }) => n.id)).toEqual([buttonId]);

    const back = (await diff("?from=live&to=1")).json;
    expect(back.theme.before).toBe("noir");
    expect(back.documents[0].nodes.removed.map((n: { id: string }) => n.id)).toEqual([buttonId]);
    expect(back.documents[0].nodes.added).toEqual([]);
  });

  it("refuses a malformed side and an unknown version", async () => {
    const bad = await diff("?from=latest");
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("VALIDATION_ERROR");
    const missing = await diff("?from=99");
    expect(missing.status).toBe(404);
  });
});

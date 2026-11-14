import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The editor's bulk edits and saved blocks (D51 M7) against a real database
 * and dev server: a bulk move is one action and one undo, a paste lands on
 * another page with fresh ids, and a saved block is a library entry that an
 * insert copies — so deleting it leaves pages alone, and custom HTML inside it
 * is still a person's to place.
 */
describe("site builder — bulk edits and saved blocks (M7)", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let homeId: number;
  let otherId: number;
  let token: string;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const viaToken = (id: string, input: unknown) =>
    fetch(`${BASE_URL}/api/actions/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const tree = async (pageId: number) => (await merchant.get(`/api/builder/sites/${siteId}/pages/${pageId}`)).json.tree;
  const texts = (n: { children?: { props: { text?: string } }[] }) => (n.children ?? []).map((c) => c.props.text);

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "editing");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "editing", { orgId });
    siteId = store.site.id;
    expect((await act("builder.startDesign", { siteId })).status).toBe(200);
    homeId = (await merchant.get(`/api/builder/sites/${siteId}`)).json.pages[0].id;
    const page = await act("builder.createPage", { siteId, handle: "about", title: "About" });
    expect(page.status, JSON.stringify(page.json)).toBe(200);
    otherId = page.json.result.pageId;
    const created = await merchant.post("/api/org/tokens", { label: "editing", role: "developer" });
    token = created.json.token;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("moves several blocks in one action, and one undo puts them all back", async () => {
    const root = await tree(homeId);
    const section = root.children[0];
    const added = await act("builder.insertNodes", {
      siteId,
      pageId: homeId,
      placements: ["A", "B", "C"].map((text) => ({ parentId: section.id, node: { type: "heading", props: { text, level: 2 } } })),
    });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    const [a, b] = added.json.result.inserted.map((i: { nodeId: string }) => i.nodeId);
    const before = await tree(homeId);
    const end = before.children[0].children.length;

    // A and B to the end of the section — the editor's plan for "move these two to the end".
    const moved = await act("builder.moveNodes", {
      siteId,
      pageId: homeId,
      moves: [
        { nodeId: a, parentId: section.id, index: end - 1 },
        { nodeId: b, parentId: section.id, index: end - 1 },
      ],
    });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(texts((await tree(homeId)).children[0]).slice(-3)).toEqual(["C", "A", "B"]);

    const undone = await merchant.post("/api/actions/builder.moveNodes/undo", { invocationId: moved.json.invocationId });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect(await tree(homeId)).toEqual(before);
  });

  it("pastes blocks copied from one page onto another, with fresh ids", async () => {
    const home = await tree(homeId);
    const copied = home.children[0].children.filter((c: { props: { text?: string } }) => ["A", "B"].includes(c.props.text ?? ""));
    // What the editor's clipboard holds: the subtrees without ids.
    const strip = (n: { id?: string; children?: unknown[] }): unknown => {
      const rest: Record<string, unknown> = { ...n };
      delete rest.id;
      if (n.children) rest.children = (n.children as { id: string }[]).map(strip);
      return rest;
    };
    const other = await tree(otherId);
    const pasted = await act("builder.insertNodes", {
      siteId,
      pageId: otherId,
      placements: copied.map((c: { id: string }) => ({ parentId: other.id, node: { type: "section", children: [strip(c)] } })),
    });
    expect(pasted.status, JSON.stringify(pasted.json)).toBe(200);
    const after = await tree(otherId);
    const headings = after.children.slice(-2).map((s: { children: { id: string; props: { text: string } }[] }) => s.children[0]);
    expect(headings.map((h: { props: { text: string } }) => h.props.text)).toEqual(["A", "B"]);
    for (const h of headings) expect(copied.map((c: { id: string }) => c.id)).not.toContain(h.id);
  });

  it("saves a block, lists it, inserts it elsewhere, and refuses a second one with the same name", async () => {
    const section = (await tree(homeId)).children[0];
    const node = { type: "section", children: [{ type: "heading", props: { text: "Free shipping over $50", level: 2 } }] };
    const saved = await act("builder.saveBlock", { siteId, name: "Shipping promise", node });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.result.nodeCount).toBe(2);

    const list = (await merchant.get(`/api/builder/sites/${siteId}/saved-blocks`)).json.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Shipping promise", type: "section", nodeCount: 2 });

    const dup = await act("builder.saveBlock", { siteId, name: "Shipping promise", node });
    expect(dup.status).toBe(409);
    expect(dup.json.error.details.reason).toBe("name_taken");

    const other = await tree(otherId);
    const inserted = await act("builder.insertNodes", { siteId, pageId: otherId, placements: [{ parentId: other.id, node: list[0].node }] });
    expect(inserted.status, JSON.stringify(inserted.json)).toBe(200);
    expect(JSON.stringify(await tree(otherId))).toContain("Free shipping over $50");
    expect(section).toBeTruthy();
  });

  it("deleting a saved block leaves the pages that used it alone, and undo brings it back", async () => {
    const [entry] = (await merchant.get(`/api/builder/sites/${siteId}/saved-blocks`)).json.items;
    const del = await act("builder.deleteSavedBlock", { siteId, savedBlockId: entry.id });
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    expect((await merchant.get(`/api/builder/sites/${siteId}/saved-blocks`)).json.items).toHaveLength(0);
    expect(JSON.stringify(await tree(otherId))).toContain("Free shipping over $50");

    const undone = await merchant.post("/api/actions/builder.deleteSavedBlock/undo", { invocationId: del.json.invocationId });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    const back = (await merchant.get(`/api/builder/sites/${siteId}/saved-blocks`)).json.items;
    expect(back.map((b: { name: string }) => b.name)).toEqual(["Shipping promise"]);
  });

  it("stores custom HTML in a saved block cleaned, and a token still cannot place it", async () => {
    const saved = await act("builder.saveBlock", {
      siteId,
      name: "Promo HTML",
      node: { type: "section", children: [{ type: "html", props: { html: '<p onclick="steal()">Promo</p><script>steal()</script>' } }] },
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const entry = (await merchant.get(`/api/builder/sites/${siteId}/saved-blocks`)).json.items.find((b: { name: string }) => b.name === "Promo HTML");
    expect(JSON.stringify(entry.node)).not.toContain("steal");

    const other = await tree(otherId);
    const refused = await viaToken("builder.insertNodes", { siteId, pageId: otherId, placements: [{ parentId: other.id, node: entry.node }] });
    expect(refused.status).toBe(403);
    expect(refused.json.error.details.reason).toBe("custom_code");
  });

  it("refuses another org's site", async () => {
    const stranger = new Client();
    const { email } = await signUpMerchant(stranger, "editing-other");
    cleanup.merchantEmails.push(email);
    const res = await stranger.post("/api/actions/builder.saveBlock", { siteId, name: "x", node: { type: "spacer" } });
    expect(res.status).toBe(404);
    expect((await stranger.get(`/api/builder/sites/${siteId}/saved-blocks`)).status).toBe(404);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, refused, signUpMerchant, sql } from "./helpers";

/**
 * Agent readiness end to end (§9).
 *
 * The rules and the arithmetic are unit-tested in `lib/readiness/*.test.ts`.
 * What only a real request can show is that the score is computed from the
 * **merchant's actual catalog**, that a dismissal survives the next
 * recomputation — the whole reason issue ids are deterministic — and that one
 * org's issues never reach another.
 */
describe("agent readiness", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let site: any;
  let products: any[];

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "readiness");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "readiness", { orgId });
    site = store.site;
    products = store.products;
  });

  afterAll(async () => {
    await sql`delete from readiness_issue_states where org_id = ${orgId}`;
    await sql`delete from readiness_snapshots where org_id = ${orgId}`;
    await cleanup.run();
  });

  it("returns a report with the five components §9 pins", async () => {
    const res = await merchant.get("/api/readiness/overview");
    expect(res.status).toBe(200);

    expect(res.json.components.map((c: any) => c.key)).toEqual([
      "product_data",
      "inventory",
      "policies",
      "checkout",
      "protocol_coverage",
    ]);
    expect(res.json.score).toBeGreaterThanOrEqual(0);
    expect(res.json.score).toBeLessThanOrEqual(100);
    expect(["critical", "needs_work", "good", "excellent"]).toContain(res.json.grade);
  });

  it("raises issues derived from the merchant's own products", async () => {
    // The fixture products have no description and no images, so these are real
    // findings about real rows — not a seeded example.
    const res = await merchant.get("/api/readiness/issues?limit=100");
    expect(res.status).toBe(200);

    const codes = res.json.items.map((i: any) => i.code);
    expect(codes).toContain("MISSING_DESCRIPTION");
    expect(codes).toContain("NO_IMAGES");

    const missing = res.json.items.find((i: any) => i.code === "MISSING_DESCRIPTION");
    expect(missing.scope.productId).toBeGreaterThan(0);
    expect(missing.severity).toBe("critical");
    // Every issue has to be actionable or it is noise.
    expect(missing.recommendation.length).toBeGreaterThan(10);
    expect(missing.expectedImpact.length).toBeGreaterThan(10);
    expect(missing.evidence.length).toBeGreaterThan(0);
  });

  it("gives the same issue the same id on every run", async () => {
    // The property everything else depends on: without it a dismissal cannot
    // survive to tomorrow.
    const first = await merchant.get("/api/readiness/issues?limit=100");
    const second = await merchant.get("/api/readiness/issues?limit=100");
    expect(second.json.items.map((i: any) => i.id)).toEqual(
      first.json.items.map((i: any) => i.id),
    );
  });

  it("stops counting a dismissed issue, and keeps it dismissed", async () => {
    const before = await merchant.get("/api/readiness/overview");
    const list = await merchant.get("/api/readiness/issues?severity=critical&limit=100");
    const target = list.json.items[0];

    const done = await merchant.invoke("readiness.updateIssues", {
      ids: [target.id],
      action: "dismiss",
      note: "Not selling this one yet",
    });
    expect(done.json.ok).toBe(true);
    expect(done.json.result.updated).toBe(1);
    // Said plainly: triage changed how it is tracked, not the catalog.
    expect(done.json.result.catalogChanged).toBe(false);

    const after = await merchant.get("/api/readiness/overview");
    expect(after.json.score).toBeGreaterThan(before.json.score);

    // Recomputed from scratch, and still dismissed.
    const again = await merchant.get("/api/readiness/issues?limit=200");
    expect(again.json.items.find((i: any) => i.id === target.id).status).toBe("dismissed");

    await merchant.invoke("readiness.updateIssues", { ids: [target.id], action: "reopen" });
    const reopened = await merchant.get("/api/readiness/issues?limit=200");
    expect(reopened.json.items.find((i: any) => i.id === target.id).status).toBe("open");
  });

  it("an issue disappears once the underlying data is fixed", async () => {
    const product = products[0];
    await sql`update products
      set description = ${"A genuinely useful description of this product, long enough that an agent has something real to match a shopper's request against."},
          images = ${sql.json(["https://example.test/one.jpg"])}
      where id = ${product.id}`;

    const res = await merchant.get("/api/readiness/issues?limit=200");
    const forProduct = res.json.items.filter((i: any) => i.scope.productId === product.id);
    // No action was taken on the issue — fixing the product is what removes it.
    expect(forProduct.map((i: any) => i.code)).not.toContain("MISSING_DESCRIPTION");
    expect(forProduct.map((i: any) => i.code)).not.toContain("NO_IMAGES");
  });

  it("does not let a filter make the store look healthier", async () => {
    // A filtered table is a view, not a change to the facts.
    const all = await merchant.get("/api/readiness/issues?limit=200");
    const filtered = await merchant.get("/api/readiness/issues?severity=opportunity&limit=200");
    expect(filtered.json.score).toBe(all.json.score);
    expect(filtered.json.items.every((i: any) => i.severity === "opportunity")).toBe(true);
  });

  it("scopes to one store when asked", async () => {
    const res = await merchant.get(`/api/readiness/overview?siteId=${site.id}`);
    expect(res.json.scope).toBe("site");
    expect(res.json.scopeId).toBe(site.id);
  });

  it("records history and reports honestly when there is none", async () => {
    await merchant.get("/api/readiness/overview");
    const history = await merchant.get("/api/readiness/history?scope=organization");
    expect(history.status).toBe(200);
    expect(history.json.points.length).toBeGreaterThan(0);
    expect(history.json.points[0]).toHaveProperty("score");

    // A store never scored at this scope gets an empty series and is told why —
    // not a flat line back-filled to its creation date.
    const empty = await merchant.get("/api/readiness/history?scope=product&scopeId=999999");
    expect(empty.json.points).toHaveLength(0);
    expect(empty.json.note).toContain("No history yet");
  });

  it("keeps one snapshot per scope per day", async () => {
    await merchant.get("/api/readiness/overview");
    await merchant.get("/api/readiness/overview");
    const rows = await sql`select count(*)::int n from readiness_snapshots
      where org_id = ${orgId} and scope = 'organization'`;
    // A merchant editing all afternoon wants a trend, not a sawtooth.
    expect(rows[0].n).toBe(1);
  });

  it("exports the filtered rows as CSV", async () => {
    // The client cannot parse CSV as JSON, so it surfaces the body as `raw` —
    // which is exactly the text we want to assert on.
    const csv = await merchant.get("/api/readiness/issues/export?severity=critical");
    expect(csv.status).toBe(200);
    const text: string = csv.json.raw ?? "";
    expect(text.split("\r\n")[0]).toContain('"severity"');
    // An export that quietly differs from the screen is worse than none.
    expect(text).toContain('"critical"');
    expect(text).not.toContain('"opportunity"');
  });

  it("lists only measurable groups in the completeness matrix", async () => {
    const res = await merchant.get("/api/readiness/products");
    expect(res.status).toBe(200);

    const groups = res.json.columns.map((c: any) => c.group);
    expect(groups).toContain("core");

    // The §11 agent-data extension does not exist, so it must not be a column
    // every merchant scores zero on — that would be a fabricated criticism.
    expect(groups).not.toContain("agent_data");
    const notMeasured = res.json.notMeasured.map((g: any) => g.group);
    expect(notMeasured).toContain("agent_data");
    expect(res.json.notMeasured[0].reason.length).toBeGreaterThan(20);

    expect(res.json.items[0]).toHaveProperty("score");
    expect(res.json.items[0].groups.core).toHaveProperty("state");
  });

  it("refuses to assign an issue to someone outside the organization", async () => {
    const list = await merchant.get("/api/readiness/issues?limit=10");
    const r = await merchant.invoke("readiness.updateIssues", {
      ids: [list.json.items[0].id],
      action: "assign",
      assignee: "user_from_another_tenant",
    });
    expect(refused(r)).toBe(true);
  });

  it("keeps another org out of these issues entirely", async () => {
    const outsider = new Client();
    const { email } = await signUpMerchant(outsider, "readiness-outsider");
    cleanup.merchantEmails.push(email);

    const mine = await merchant.get("/api/readiness/issues?limit=200");
    const theirs = await outsider.get("/api/readiness/issues?limit=200");

    const myIds = new Set(mine.json.items.map((i: any) => i.id));
    expect(theirs.json.items.some((i: any) => myIds.has(i.id))).toBe(false);

    const drawer = await outsider.get(`/api/readiness/issues/${mine.json.items[0].id}`);
    expect(drawer.status).toBe(404);
  });
});

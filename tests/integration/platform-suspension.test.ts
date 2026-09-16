import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Platform suspension (G12) end to end: an operator holds a merchant's org,
 * everything that should stop stops, everything that should not does not,
 * and lifting it restores the lot.
 *
 * The operator is a merchant like any other, signed up at the host
 * `.env.local` allowlists (`PLATFORM_OPERATOR_EMAILS=@ops.markii.shop`).
 * The dev server reads that at request time, so the suite skips itself with
 * a message rather than failing on a machine where it is not set.
 *
 * What is falsifiable here and nowhere else: that the operator's `orgId` is
 * the *target* (the audit row lands in the merchant's log), that the reason
 * never reaches the merchant, and that `platform.unsuspendOrg` is exempt from
 * the standing gate it would otherwise refuse itself on.
 */
const OPERATOR_DOMAIN = (process.env.PLATFORM_OPERATOR_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .find((s) => s.startsWith("@"))
  ?.slice(1);

describe.skipIf(!OPERATOR_DOMAIN)("platform suspension", () => {
  const operator = new Client();
  const merchant = new Client();
  const bystander = new Client();
  const cleanup = new Cleanup();
  let orgId: string;
  let orgSlug: string;
  let siteSlug: string;
  let siteId: number;
  let productSlug: string;

  beforeAll(async () => {
    const op = await signUpMerchant(operator, "operator", { domain: OPERATOR_DOMAIN });
    cleanup.merchantEmails.push(op.email);

    const m = await signUpMerchant(merchant, "suspended");
    cleanup.merchantEmails.push(m.email);
    const me = await merchant.get("/api/me");
    orgId = me.json.org.id;
    orgSlug = me.json.org.slug;
    const store = await createTestStore(cleanup, "suspension", { orgId });
    siteSlug = store.slug;
    siteId = store.site.id;
    productSlug = store.products[0].slug;

    const b = await signUpMerchant(bystander, "bystander");
    cleanup.merchantEmails.push(b.email);
  }, 240_000);

  afterAll(async () => {
    await cleanup.run();
  });

  it("refuses a merchant who is not on the allowlist, with 403 and a live session", async () => {
    expect((await bystander.get("/api/me")).status).toBe(200);
    const res = await bystander.get(`/api/admin/orgs/${orgSlug}`);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("FORBIDDEN");

    const post = await bystander.post(`/api/admin/orgs/${orgSlug}/suspend`, { reason: "nope" });
    expect(post.status).toBe(403);
  });

  it("shows an operator the org by slug or id, not suspended", async () => {
    const bySlug = await operator.get(`/api/admin/orgs/${orgSlug}`);
    expect(bySlug.status).toBe(200);
    expect(bySlug.json.id).toBe(orgId);
    expect(bySlug.json.suspension).toBeNull();
    expect(bySlug.json.stores.map((s: { slug: string }) => s.slug)).toContain(siteSlug);

    const byId = await operator.get(`/api/admin/orgs/${orgId}`);
    expect(byId.json.slug).toBe(orgSlug);
  });

  it("lists and searches orgs for an operator, and refuses a merchant", async () => {
    const all = await operator.get(`/api/admin/orgs?q=${encodeURIComponent(orgSlug)}`);
    expect(all.status).toBe(200);
    expect(all.json.items.map((o: { id: string }) => o.id)).toContain(orgId);
    expect(all.json.items[0].storeCount).toBeGreaterThanOrEqual(1);

    const none = await operator.get(`/api/admin/orgs?q=${encodeURIComponent(orgSlug)}&suspended=true`);
    expect(none.json.items).toEqual([]);

    expect((await bystander.get("/api/admin/orgs")).status).toBe(403);
    expect((await bystander.get("/api/admin/overview")).status).toBe(403);
    expect((await bystander.get("/api/admin/signups")).status).toBe(403);
  });

  it("reports the overview and the sign-up review to an operator", async () => {
    const ov = await operator.get("/api/admin/overview");
    expect(ov.status).toBe(200);
    expect(ov.json.orgs).toBeGreaterThanOrEqual(3);
    expect(typeof ov.json.suspended).toBe("number");
    expect(Array.isArray(ov.json.recentSuspensions)).toBe(true);

    const su = await operator.get("/api/admin/signups?days=1");
    expect(su.status).toBe(200);
    expect(su.json.recent.map((r: { id: string }) => r.id)).toContain(orgId);
    // The fixtures live at the platform domain and are never a burst.
    const root = process.env.ROOT_DOMAIN?.trim().toLowerCase();
    if (root) expect(su.json.bursts.map((b: { domain: string }) => b.domain)).not.toContain(root);

    // Clamped, never trusted.
    expect((await operator.get("/api/admin/signups?days=9999")).json.days).toBe(30);
  });

  it("tells the operator they are one, and the merchant they are not", async () => {
    expect((await operator.get("/api/me")).json.operator).toBe(true);
    expect((await merchant.get("/api/me")).json.operator).toBe(false);
  });

  it("dry-runs the suspension without writing", async () => {
    const res = await operator.post(`/api/admin/orgs/${orgSlug}/suspend?dryRun=1`, {
      reason: "dry run",
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const [row] = await sql`select suspended_at from organizations where id = ${orgId}`;
    expect(row.suspended_at).toBeNull();
  });

  it("requires a reason", async () => {
    const res = await operator.post(`/api/admin/orgs/${orgSlug}/suspend`, {});
    expect(res.status).toBe(400);
  });

  it("suspends the org and records the operator on the row", async () => {
    const res = await operator.post(`/api/admin/orgs/${orgSlug}/suspend`, {
      reason: "Integration test: 40 sign-ups from one domain",
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.result.orgId).toBe(orgId);

    const opId = (await operator.get("/api/me")).json.user.id;
    const [row] =
      await sql`select suspended_at, suspended_reason, suspended_by from organizations where id = ${orgId}`;
    expect(row.suspended_at).not.toBeNull();
    expect(row.suspended_by).toBe(opId);
    expect(row.suspended_reason).toContain("40 sign-ups");
  });

  it("refuses to suspend twice", async () => {
    const res = await operator.post(`/api/admin/orgs/${orgSlug}/suspend`, { reason: "again" });
    expect(res.status).toBe(409);
  });

  it("shows the suspension on the list, the overview and the org view", async () => {
    const list = await operator.get(`/api/admin/orgs?q=${encodeURIComponent(orgSlug)}&suspended=true`);
    expect(list.json.items.map((o: { id: string }) => o.id)).toEqual([orgId]);
    expect(list.json.items[0].standing.state).toBe("suspended");

    const ov = await operator.get("/api/admin/overview");
    const mine = ov.json.recentSuspensions.find((r: { id: string }) => r.id === orgId);
    expect(mine?.suspendedReason).toContain("40 sign-ups");

    const view = await operator.get(`/api/admin/orgs/${orgId}`);
    expect(view.json.suspension.reason).toContain("40 sign-ups");
    expect(view.json.standing.state).toBe("suspended");
  });

  it("tells the merchant they are suspended — and not why", async () => {
    const me = await merchant.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.json.standing.state).toBe("suspended");
    expect(me.json.standing.since).toBeTruthy();
    expect(JSON.stringify(me.json.standing)).not.toContain("40 sign-ups");

    const sub = await merchant.get("/api/billing/subscription");
    expect(sub.status).toBe(200);
    expect(sub.json.standing.state).toBe("suspended");
    expect(JSON.stringify(sub.json)).not.toContain("40 sign-ups");
  });

  it("refuses the merchant's writes with 403 ACCOUNT_SUSPENDED on both surfaces", async () => {
    // v1 REST route, gated in `orgHandler`.
    const edit = await merchant.patch(`/api/sites/${siteId}`, { name: "Edited while suspended" });
    expect(edit.status).toBe(403);
    expect(edit.json.error.code).toBe("ACCOUNT_SUSPENDED");
    expect(edit.json.error.details.standing).toBe("suspended");

    // Registry action, gated in `invokeAction`.
    const action = await merchant.post("/api/actions/catalog.createCollection", {
      siteId,
      title: "While suspended",
    });
    expect(action.status).toBe(403);
    expect(action.json.error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("leaves the merchant's reads alone", async () => {
    expect((await merchant.get("/api/sites")).status).toBe(200);
    expect((await merchant.get("/api/orders")).status).toBe(200);
  });

  it("keeps the billing door open", async () => {
    // Whatever this answers, it must not be the suspension gate.
    const res = await merchant.get("/api/billing/subscription");
    expect(res.status).toBe(200);
    const cancel = await merchant.post("/api/actions/billing.setCancellation", {
      cancelAtPeriodEnd: true,
    });
    expect(cancel.json?.error?.code).not.toBe("ACCOUNT_SUSPENDED");
  });

  it("takes the storefront offline without disclosing why", async () => {
    const page = await fetch(`${BASE_URL}/_sites/${siteSlug}/`);
    const body = (await page.text()).toLowerCase();
    expect(body).toContain("temporarily paused");
    for (const leak of ["suspend", "40 sign-ups", "markii operator", "billing"]) {
      expect(body, `storefront disclosed "${leak}"`).not.toContain(leak);
    }
    const product = await fetch(`${BASE_URL}/_sites/${siteSlug}/p/${productSlug}`);
    expect(product.status).toBe(404);
  });

  it("appears in the merchant's own audit log as a Markii operator", async () => {
    const res = await merchant.get("/api/org/audit?actionId=platform.suspendOrg");
    expect(res.status).toBe(200);
    const entries = res.json.items.filter(
      (e: { action: string }) => e.action === "platform.suspendOrg",
    );
    // The suspension itself, and the refused second attempt — a refusal is
    // audited too (§22 rule 5), which is why there are two.
    // Refusals here: the 400 with no reason, the 409 second attempt.
    expect(entries.filter((e: { ok: boolean }) => e.ok)).toHaveLength(1);
    expect(entries.filter((e: { ok: boolean }) => !e.ok).length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(entry.actor.type).toBe("operator");
      expect(entry.actor.name).toBe("Markii operator");
    }
    // The reason is in the merchant's log — it is the record of what was done
    // to their org, and a suspension they cannot see the grounds for in their
    // own audit trail is not an audit trail.
    const done = entries.find((e: { ok: boolean }) => e.ok);
    expect(JSON.stringify(done)).toContain("40 sign-ups");
  });

  it("is lifted by the operator, which the standing gate must not refuse", async () => {
    const res = await operator.del(`/api/admin/orgs/${orgSlug}/suspend`);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    const me = await merchant.get("/api/me");
    expect(me.json.standing.state).not.toBe("suspended");

    // Recent suspensions on the overview no longer list this org.
    const ov = await operator.get("/api/admin/overview");
    expect(ov.json.recentSuspensions.map((r: { id: string }) => r.id)).not.toContain(orgId);

    const edit = await merchant.patch(`/api/sites/${siteId}`, { name: "Edited after reinstatement" });
    expect(edit.status).toBe(200);

    const page = await fetch(`${BASE_URL}/_sites/${siteSlug}/`);
    expect((await page.text()).toLowerCase()).not.toContain("temporarily paused");
  });

  it("refuses to lift a suspension that is not there", async () => {
    const res = await operator.del(`/api/admin/orgs/${orgSlug}/suspend`);
    expect(res.status).toBe(409);
  });
});

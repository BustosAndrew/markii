import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * `GET /api/org/audit` end to end (§16).
 *
 * The mapping is unit-tested in `lib/org/audit.test.ts` and needs no database.
 * What only a real request can show is the span: that invoking an action
 * actually lands a row, that the row carries the address the call came from,
 * that a *refused* attempt is recorded too, that the filters narrow what they
 * claim to, that one org cannot read another's history — and that the
 * permission gate is real, which is the part most easily passed for the wrong
 * reason.
 */
describe("org audit log", () => {
  const merchant = new Client();
  const other = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let variantId: number;
  /** The invocation the happy-path assertions hang off. */
  let changeInvocationId: string;

  const CALLER_IP = "203.0.113.9";

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "audit");
    cleanup.merchantEmails.push(email);
    const me = (await merchant.get("/api/me")).json;
    orgId = me.org.id;
    userId = me.user.id;

    const { email: otherEmail } = await signUpMerchant(other, "auditother");
    cleanup.merchantEmails.push(otherEmail);
    otherOrgId = (await other.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "audit", { orgId });
    const [variant] = await sql`insert into variants
      (product_id, title, option_values, price_minor, position)
      values (${store.products[0].id}, 'Default', ${sql.json({})}, 1500, 0)
      returning *`;
    variantId = variant.id;

    // One successful change, invoked as if through a proxy so the audit row has
    // an address to record.
    const change = await merchant.call(
      "POST",
      "/api/actions/catalog.updateVariant",
      { variantId, priceMinor: 2500 },
      { "x-forwarded-for": `${CALLER_IP}, 70.41.3.18`, "user-agent": "AuditSuite/1.0" },
    );
    expect(change.status).toBe(200);
    changeInvocationId = change.json.invocationId;
  }, 180_000);

  afterAll(async () => {
    await sql`delete from action_invocations where org_id in (${orgId}, ${otherOrgId})`;
    await cleanup.run();
  });

  it("records the invocation with the actor resolved to a real person", async () => {
    const res = await merchant.get("/api/org/audit");
    expect(res.status).toBe(200);

    const entry = res.json.items.find((i: any) => i.id === changeInvocationId);
    expect(entry).toBeDefined();
    expect(entry.action).toBe("catalog.updateVariant");
    expect(entry.ok).toBe(true);
    expect(entry.error).toBeNull();
    expect(entry.actor.type).toBe("user");
    expect(entry.actor.id).toBe(userId);
    // The name comes from the staff row, not from the id on the invocation.
    expect(entry.actor.email).toBeTruthy();
  }, 60_000);

  /**
   * The column this section added. Before it, §16 could not have answered the
   * question it specifies — the table recorded who, never from where.
   */
  it("records the address the call came from, taking the client end of the chain", async () => {
    const res = await merchant.get("/api/org/audit");
    const entry = res.json.items.find((i: any) => i.id === changeInvocationId);
    expect(entry.ip).toBe(CALLER_IP);
    expect(entry.userAgent).toBe("AuditSuite/1.0");
  }, 60_000);

  it("lifts the touched entity out of the diff and keeps the field-level changes", async () => {
    const res = await merchant.get("/api/org/audit");
    const entry = res.json.items.find((i: any) => i.id === changeInvocationId);

    expect(entry.entities).toContainEqual({ type: "variant", id: String(variantId) });
    const priceChange = entry.changes.find((c: any) => c.path === "priceMinor");
    expect(priceChange).toBeDefined();
    expect(priceChange.before).toBe(1500);
    expect(priceChange.after).toBe(2500);
  }, 60_000);

  /**
   * "Who tried what and was refused" is the half of an audit log that matters
   * during an incident, and it is the half a naive implementation drops.
   */
  it("records a refused attempt and narrows to it with ?ok=false", async () => {
    const refusal = await merchant.invoke("catalog.updateVariant", {
      variantId: 999_999_999,
      priceMinor: 100,
    });
    expect(refusal.status).toBeGreaterThanOrEqual(400);

    const res = await merchant.get("/api/org/audit?ok=false");
    expect(res.status).toBe(200);
    expect(res.json.items.length).toBeGreaterThan(0);

    // The filter means what it says: no successful invocation is in this list.
    for (const item of res.json.items) expect(item.ok).toBe(false);

    const failure = res.json.items[0];
    expect(failure.error.code).toBeTruthy();
    expect(failure.error.message).toBeTruthy();
    // And the successful change is absent from the refusals view.
    expect(res.json.items.some((i: any) => i.id === changeInvocationId)).toBe(false);
  }, 90_000);

  it("filters by action id", async () => {
    const res = await merchant.get("/api/org/audit?actionId=catalog.updateVariant");
    expect(res.status).toBe(200);
    expect(res.json.items.length).toBeGreaterThan(0);
    for (const item of res.json.items) expect(item.action).toBe("catalog.updateVariant");
  }, 60_000);

  it("filters by actor type", async () => {
    const res = await merchant.get("/api/org/audit?actorType=user");
    expect(res.status).toBe(200);
    for (const item of res.json.items) expect(item.actor.type).toBe("user");

    // No token has invoked anything in this org, so that view is genuinely empty
    // rather than falling back to the unfiltered list.
    const tokens = await merchant.get("/api/org/audit?actorType=token");
    expect(tokens.status).toBe(200);
    expect(tokens.json.items).toEqual([]);
  }, 60_000);

  /**
   * An unrecognised filter value is a 400, never a silent no-op — a merchant
   * reading a screen cannot tell an ignored filter from one that matched
   * everything.
   */
  it("refuses an unknown actorType rather than ignoring it", async () => {
    const res = await merchant.get("/api/org/audit?actorType=wizard");
    expect(res.status).toBe(400);
  }, 60_000);

  it("excludes rows outside the date range", async () => {
    const past = await merchant.get("/api/org/audit?to=2020-01-01");
    expect(past.status).toBe(200);
    expect(past.json.items).toEqual([]);

    const present = await merchant.get("/api/org/audit?from=2020-01-01");
    expect(present.json.items.length).toBeGreaterThan(0);
  }, 60_000);

  it("counts the total under the same filters as the page", async () => {
    const all = await merchant.get("/api/org/audit?limit=1");
    expect(all.json.items).toHaveLength(1);
    expect(all.json.total).toBeGreaterThan(1);

    const failures = await merchant.get("/api/org/audit?ok=false&limit=1");
    // Narrower filter, strictly fewer matches — not the org's whole history.
    expect(failures.json.total).toBeLessThan(all.json.total);
  }, 60_000);

  /** Each org's log contains its own invocations only. */
  it("does not leak another org's history", async () => {
    const res = await other.get("/api/org/audit");
    expect(res.status).toBe(200);
    expect(res.json.items.some((i: any) => i.id === changeInvocationId)).toBe(false);
  }, 60_000);

  /**
   * The permission gate, asserted the way this repo learned to: prove the
   * credential is live on a route it *does* hold, then pin the exact status on
   * the route it does not. A bare "4xx" would pass with the check deleted, since
   * a dead token 401s on everything.
   */
  describe("permission", () => {
    let analystToken: string;

    beforeAll(async () => {
      const created = await merchant.post("/api/org/tokens", {
        label: "audit-gate-test",
        role: "analyst",
      });
      expect(created.status).toBeLessThan(300);
      analystToken = created.json.token;
      expect(analystToken).toBeTruthy();
    }, 60_000);

    const asAnalyst = (path: string) =>
      fetch(`${BASE_URL}${path}`, { headers: { authorization: `Bearer ${analystToken}` } });

    /**
     * **`/api/org`, deliberately, and not `/api/me`.** This probe has to prove
     * two things at once: that the token authenticates at all, and that the
     * analyst really does hold `org.read` — which is the whole reason the audit
     * log is not gated on it. `GET /api/org` runs through `orgHandler` and
     * requires exactly `org.read`, so a 200 here makes the 403 below a
     * permission answer rather than a dead credential.
     *
     * `/api/me` was the first choice and is the wrong one: it calls
     * `requireSession()`, not `requireAuthContext`, so it accepts a cookie
     * session only and answers **401 to every API token**. That failure is what
     * caught this — the refusal assertions below had been passing against a
     * credential that was being turned away everywhere.
     */
    it("proves the analyst credential is live before asserting a refusal", async () => {
      const res = await asAnalyst("/api/org");
      expect(res.status).toBe(200);
    }, 60_000);

    /**
     * `analyst` holds `org.read` — which is exactly why the audit log is not
     * gated on it. Reading everyone's activity, with each action's input, is
     * not part of a reporting seat.
     */
    it("refuses an analyst with 403, not 401", async () => {
      const res = await asAnalyst("/api/org/audit");
      expect(res.status).toBe(403);
    }, 60_000);

    /**
     * Two endpoints over one table cannot hold two different permissions, or
     * the looser one is the real permission. This was the bypass: the
     * invocations route served the same rows at `org.read`.
     */
    it("gates /api/actions/invocations behind the same permission", async () => {
      const res = await asAnalyst("/api/actions/invocations");
      expect(res.status).toBe(403);
    }, 60_000);

    it("lets the owner read it", async () => {
      const res = await merchant.get("/api/org/audit");
      expect(res.status).toBe(200);
    }, 60_000);
  });
});

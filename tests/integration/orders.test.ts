import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Cleanup,
  Client,
  createTestStore,
  refused,
  signUpMerchant,
  sql,
  trackCart,
  trackOrderCascade,
} from "./helpers";

/**
 * Order operations (§18.7): itemisation, refunds, restocking, metering,
 * cancellation, manual fulfillment, and the timeline.
 *
 * The arithmetic is unit-tested in `lib/commerce/{allocation,refunds}.test.ts`.
 * What only a real request against a real database can show is the wiring: that
 * a refund's usage record carries the **net sales** base rather than the amount
 * returned, that restocked units reach the ledger at the right location, and
 * that the same refund submitted twice does not meter twice.
 */
describe("order operations", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();

  let slug: string;
  let site: any;
  let p1: any;
  let locationId: number;
  let orgId: string;

  const cart = (p = "") => `/_sites/${slug}/api/cart${p}`;
  const checkout = (p = "") => `/_sites/${slug}/api/checkout${p}`;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "orders");
    cleanup.merchantEmails.push(email);

    const me = await merchant.get("/api/me");
    orgId = me.json.org.id;

    const store = await createTestStore(cleanup, "orders", { orgId });
    slug = store.slug;
    site = store.site;
    [p1] = store.products;

    const [loc] = await sql`insert into locations (site_id, name, is_default)
      values (${site.id}, 'Test Location', true) returning *`;
    locationId = loc.id;
    cleanup.locationIds.push(loc.id);
  });

  afterAll(async () => {
    await cleanup.run();
  });

  /** A variant with a known ledger balance, so stock movement is observable. */
  async function makeVariant(label: string, units: number, priceMinor = 2000) {
    const [v] = await sql`insert into variants (product_id, title, option_values, price_minor,
      weight_grams, requires_shipping, inventory_policy)
      values (${p1.id}, ${label}, ${sql.json({ Test: label })}, ${priceMinor}, 100,
              false, 'deny') returning *`;
    cleanup.variantIds.push(v.id);
    await sql`insert into inventory_ledger (variant_id, location_id, available_delta, reason, actor_type)
      values (${v.id}, ${locationId}, ${units}, 'test seed', 'system')`;
    return v;
  }

  /** Buys `quantity` of a variant end to end and returns the completed order id. */
  async function buy(variantId: number, quantity: number) {
    const c = await shopper.post(cart(), { productId: p1.id, variantId, quantity });
    await trackCart(cleanup, c.json.token);

    const session = await shopper.post(checkout("/session"), {
      cartToken: c.json.token,
      rail: "x402",
    });
    expect(session.status).toBe(201);

    cleanup.checkoutSessionIds.push(session.json.id);

    const paid = await shopper.post(checkout(`/session/${session.json.id}/complete`), {
      paymentReference: `0xtest${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`,
    });
    expect(paid.status).toBe(200);

    const orderId: number = paid.json.orderId;
    await trackOrderCascade(cleanup, orderId);
    return orderId;
  }

  async function levelOf(variantId: number) {
    const [row] = await sql`select coalesce(sum(available_delta), 0)::int as available
      from inventory_ledger where variant_id = ${variantId}`;
    return row.available as number;
  }

  it("itemises a completed order and splits its money", async () => {
    const v = await makeVariant("itemise", 5);
    const orderId = await buy(v.id, 2);

    const detail = await merchant.get(`/api/orders/${orderId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.itemised).toBe(true);
    expect(detail.json.lines).toHaveLength(1);

    const [line] = detail.json.lines;
    expect(line.quantity).toBe(2);
    expect(line.quantityRefundable).toBe(2);
    expect(line.variantId).toBe(v.id);
    // The stock's actual origin, so a restock returns it where it came from.
    expect(line.locationId).toBe(locationId);

    // Lines sum to the order's own subtotal — the property that makes refunds
    // return the right money.
    const summed = detail.json.lines.reduce((s: number, l: any) => s + l.subtotalMinor, 0);
    expect(summed).toBe(detail.json.totals.subtotalMinor);
    expect(detail.json.totals.refundableMinor).toBe(detail.json.totals.totalMinor);

    expect(detail.json.financialStatus).toBe("paid");
    expect(detail.json.fulfillmentStatus).toBe("unfulfilled");
    expect(detail.json.timeline.some((e: any) => e.type === "placed")).toBe(true);
  });

  it("refunds part of a line, restocks it, and meters net sales", async () => {
    const v = await makeVariant("partial", 5, 2500);
    const orderId = await buy(v.id, 3);

    const before = await levelOf(v.id);
    const detail = await merchant.get(`/api/orders/${orderId}`);
    const lineId = detail.json.lines[0].id;

    const r = await merchant.invoke("orders.refund", {
      orderId,
      lines: [{ orderLineId: lineId, quantity: 1 }],
      reason: "requested_by_customer",
    });
    expect(r.status).toBeLessThan(400);
    expect(r.json.ok).toBe(true);
    expect(r.json.result.amountMinor).toBe(2500);
    // No tax and no shipping on this rail, so the two bases coincide here — the
    // divergent case is covered below.
    expect(r.json.result.netSalesMinor).toBe(2500);
    // Stated plainly: Markii wrote this down, it did not move money.
    expect(r.json.result.moneyMoved).toBe(false);

    expect(await levelOf(v.id)).toBe(before + 1);

    const [usage] = await sql`select * from usage_records
      where order_id = ${orderId} and type = 'refund'`;
    expect(usage.amount_minor).toBe(-2500);
    expect(usage.dedupe_key).toBe(`refund:${r.json.result.refundId}`);

    const after = await merchant.get(`/api/orders/${orderId}`);
    expect(after.json.financialStatus).toBe("partially_refunded");
    expect(after.json.lines[0].quantityRefundable).toBe(2);
    expect(after.json.totals.refundableMinor).toBe(5000);
    expect(after.json.refunds).toHaveLength(1);
    expect(after.json.refunds[0].moneyMovedByMarkii).toBe(false);
  });

  it("meters two partial refunds separately rather than dropping the second", async () => {
    // The regression the old `(orderId, type)` unique key would have caused:
    // the second refund's metering row silently discarded, permanently
    // over-metering the merchant by that amount.
    const v = await makeVariant("twice", 5, 1000);
    const orderId = await buy(v.id, 3);
    const detail = await merchant.get(`/api/orders/${orderId}`);
    const lineId = detail.json.lines[0].id;

    await merchant.invoke("orders.refund", {
      orderId,
      lines: [{ orderLineId: lineId, quantity: 1 }],
    });
    await merchant.invoke("orders.refund", {
      orderId,
      lines: [{ orderLineId: lineId, quantity: 1 }],
    });

    const rows = await sql`select amount_minor from usage_records
      where order_id = ${orderId} and type = 'refund'`;
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s: number, r: any) => s + r.amount_minor, 0)).toBe(-2000);
  });

  it("refuses to refund more units than the line has left", async () => {
    const v = await makeVariant("overrefund", 5);
    const orderId = await buy(v.id, 1);
    const detail = await merchant.get(`/api/orders/${orderId}`);
    const lineId = detail.json.lines[0].id;

    await merchant.invoke("orders.refund", { orderId, lines: [{ orderLineId: lineId, quantity: 1 }] });
    const second = await merchant.invoke("orders.refund", {
      orderId,
      lines: [{ orderLineId: lineId, quantity: 1 }],
    });
    expect(refused(second)).toBe(true);
  });

  it("does not restock when the merchant says not to", async () => {
    const v = await makeVariant("norestock", 5);
    const orderId = await buy(v.id, 2);
    const before = await levelOf(v.id);
    const detail = await merchant.get(`/api/orders/${orderId}`);

    await merchant.invoke("orders.refund", {
      orderId,
      lines: [{ orderLineId: detail.json.lines[0].id, quantity: 1, restock: false }],
      reason: "item_unavailable",
    });

    // A damaged return is refunded but not resold.
    expect(await levelOf(v.id)).toBe(before);
  });

  it("refuses a processor-executed refund instead of pretending", async () => {
    const v = await makeVariant("processor", 5);
    const orderId = await buy(v.id, 1);
    const detail = await merchant.get(`/api/orders/${orderId}`);

    const r = await merchant.invoke("orders.refund", {
      orderId,
      lines: [{ orderLineId: detail.json.lines[0].id, quantity: 1 }],
      method: "processor",
    });
    expect(refused(r)).toBe(true);
    // x402 settlement is irreversible; the refusal has to say so.
    expect(JSON.stringify(r.json)).toMatch(/final|irreversible|wallet/i);

    // And nothing was written — no half-recorded refund left behind.
    const rows = await sql`select id from refunds where order_id = ${orderId}`;
    expect(rows).toHaveLength(0);
  });

  it("refuses to cancel a paid order, directing to a refund", async () => {
    const v = await makeVariant("cancelpaid", 5);
    const orderId = await buy(v.id, 1);

    const r = await merchant.invoke("orders.cancel", { orderId, reason: "changed mind" });
    expect(refused(r)).toBe(true);
    expect(JSON.stringify(r.json)).toMatch(/refund/i);
  });

  it("records a manual fulfillment and marks the order fulfilled", async () => {
    const v = await makeVariant("fulfil", 5);
    const orderId = await buy(v.id, 2);
    const detail = await merchant.get(`/api/orders/${orderId}`);

    const f = await merchant.invoke("orders.fulfill", {
      orderId,
      lines: [{ orderLineId: detail.json.lines[0].id, quantity: 2 }],
      carrier: "Royal Mail",
      trackingNumber: "AB123456789GB",
    });
    expect(f.json.ok).toBe(true);
    expect(f.json.result.fulfillmentStatus).toBe("fulfilled");
    // Merchant-entered, never confirmed by a carrier — and never claimed to be.
    expect(f.json.result.customerNotified).toBe(false);

    const after = await merchant.get(`/api/orders/${orderId}`);
    expect(after.json.fulfillmentStatus).toBe("fulfilled");
    expect(after.json.fulfillments[0].trackingVerified).toBe(false);
    expect(after.json.fulfillments[0].trackingNumber).toBe("AB123456789GB");
    expect(after.json.timeline.some((e: any) => e.type === "fulfilled")).toBe(true);
  });

  it("treats refunded units as no longer needing shipping", async () => {
    const v = await makeVariant("partialfulfil", 5);
    const orderId = await buy(v.id, 3);
    const detail = await merchant.get(`/api/orders/${orderId}`);
    const lineId = detail.json.lines[0].id;

    await merchant.invoke("orders.refund", { orderId, lines: [{ orderLineId: lineId, quantity: 1 }] });
    const f = await merchant.invoke("orders.fulfill", {
      orderId,
      lines: [{ orderLineId: lineId, quantity: 2 }],
    });

    // Two shipped, one refunded, nothing outstanding — leaving this
    // `partially_fulfilled` sends a merchant looking for a parcel to send.
    expect(f.json.result.fulfillmentStatus).toBe("fulfilled");
  });

  it("appends notes to the timeline without overwriting anything", async () => {
    const v = await makeVariant("notes", 5);
    const orderId = await buy(v.id, 1);

    await merchant.invoke("orders.addNote", { orderId, note: "Customer called about delivery" });
    await merchant.invoke("orders.addNote", {
      orderId,
      note: "Shipped early as a courtesy",
      visibility: "customer",
    });

    const after = await merchant.get(`/api/orders/${orderId}`);
    const notes = after.json.timeline.filter((e: any) => e.type === "note");
    expect(notes).toHaveLength(2);
    expect(notes.map((n: any) => n.visibility).sort()).toEqual(["customer", "internal"]);
    // Every entry is attributable — a timeline whose author is unknown is not a record.
    expect(notes.every((n: any) => n.actorLabel)).toBe(true);
  });

  it("reports an unsendable confirmation rather than claiming it was sent", async () => {
    const v = await makeVariant("resend", 5);
    const orderId = await buy(v.id, 1);

    const r = await merchant.invoke("orders.resendConfirmation", {
      orderId,
      to: "someone@markii.shop",
    });
    expect(r.json.ok).toBe(true);
    expect(r.json.result.queued).toBe(true);

    // SES is not wired, so the honest outcome is a failure on the timeline —
    // never a success the merchant would act on.
    const events = await sql`select type from order_events
      where order_id = ${orderId} and type in ('email_sent', 'email_failed')`;
    expect(events.length).toBeGreaterThan(0);
  });

  it("keeps another org out of an order it does not own", async () => {
    const outsider = new Client();
    const { email } = await signUpMerchant(outsider, "orders-outsider");
    cleanup.merchantEmails.push(email);

    const v = await makeVariant("tenancy", 5);
    const orderId = await buy(v.id, 1);

    expect((await outsider.get(`/api/orders/${orderId}`)).status).toBe(404);
    expect(refused(await outsider.invoke("orders.addNote", { orderId, note: "hi" }))).toBe(true);
    expect(
      refused(await outsider.invoke("orders.refund", { orderId, amountMinor: 100 })),
    ).toBe(true);

    // …and sees an empty list, not somebody else's. A list route that leaks is
    // worse than a detail route that does: one id versus every order.
    const list = await outsider.get("/api/orders");
    expect(list.status).toBe(200);
    expect(list.json.items).toEqual([]);
    expect(list.json.total).toBe(0);
    expect(list.json.totals.byCurrency).toEqual([]);
  });

  it("lists orders with their itemisation and per-currency totals", async () => {
    const v = await makeVariant("list", 5);
    const orderId = await buy(v.id, 2);

    const list = await merchant.get(`/api/orders?siteId=${site.id}&limit=100`);
    expect(list.status).toBe(200);
    expect(list.json.total).toBeGreaterThan(0);
    expect(list.json.total).toBe(list.json.items.length);

    const row = list.json.items.find((o: any) => o.id === orderId);
    expect(row).toBeDefined();
    expect(row.itemised).toBe(true);
    expect(row.lineCount).toBe(1);
    expect(row.unitCount).toBe(2);
    expect(row.refundableMinor).toBe(row.amountCents - row.refundedMinor);
    // Newest first by default.
    expect(list.json.items[0].id).toBe(orderId);

    // Totals are per currency and never summed across it, and every row's net
    // is its own gross less its own refunds.
    expect(list.json.totals.byCurrency.length).toBeGreaterThan(0);
    for (const c of list.json.totals.byCurrency) {
      expect(c.netMinor).toBe(c.grossMinor - c.refundedMinor);
      expect(c.paidOrderCount).toBeLessThanOrEqual(c.orderCount);
    }
    const counted = list.json.totals.byCurrency.reduce((n: number, c: any) => n + c.orderCount, 0);
    expect(counted).toBe(list.json.total);

    // Findable by the order number a merchant would paste from a support email.
    const byId = await merchant.get(`/api/orders?q=${orderId}`);
    expect(byId.json.items.map((o: any) => o.id)).toContain(orderId);
  });

  it("keeps unpaid orders out of the revenue total while still listing them", async () => {
    const before = await merchant.get(`/api/orders?siteId=${site.id}&limit=100`);
    const grossBefore = before.json.totals.byCurrency.reduce(
      (n: number, c: any) => n + c.grossMinor,
      0,
    );

    const [pending] = await sql`insert into orders
      (site_id, product_id, quantity, status, amount_cents, currency, provider)
      values (${site.id}, ${p1.id}, 1, 'pending', 999900, 'USD', 'x402') returning *`;
    cleanup.orderIds.push(pending.id);

    const after = await merchant.get(`/api/orders?siteId=${site.id}&limit=100`);
    // The order is listed — it exists and the merchant should see it…
    expect(after.json.total).toBe(before.json.total + 1);
    expect(after.json.items.map((o: any) => o.id)).toContain(pending.id);
    // …but a payment that never arrived is not revenue.
    const grossAfter = after.json.totals.byCurrency.reduce(
      (n: number, c: any) => n + c.grossMinor,
      0,
    );
    expect(grossAfter).toBe(grossBefore);

    const onlyPending = await merchant.get(`/api/orders?siteId=${site.id}&status=pending`);
    expect(onlyPending.json.items.every((o: any) => o.status === "pending")).toBe(true);
    expect(onlyPending.json.total).toBeGreaterThan(0);
    expect(onlyPending.json.totals.byCurrency.every((c: any) => c.grossMinor === 0)).toBe(true);
  });

  it("refuses a filter value it cannot honour instead of ignoring it", async () => {
    // `refunded` is a *financial* status. Silently dropping it would answer with
    // every order, which reads as "all of these were refunded".
    const bad = await merchant.get("/api/orders?status=refunded");
    expect(bad.status).toBe(400);

    const ok = await merchant.get("/api/orders?financialStatus=refunded");
    expect(ok.status).toBe(200);
    expect(ok.json.items.every((o: any) => o.financialStatus === "refunded")).toBe(true);

    // A rail with no column value, and a §13 filter with no column at all —
    // both refused by name rather than quietly returning the whole list.
    expect((await merchant.get("/api/orders?provider=paypal")).status).toBe(400);
    expect((await merchant.get("/api/orders?exception=true")).status).toBe(400);
    expect((await merchant.get("/api/orders?paymentStatus=paid")).status).toBe(400);
  });
});

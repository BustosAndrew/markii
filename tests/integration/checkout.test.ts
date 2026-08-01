import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, sql, trackCart, trackOrderCascade } from "./helpers";

/**
 * Checkout, inventory reservation, and metering (§18.4, §17).
 *
 * The concurrency test here is the one `docs/BACKEND.md` §4 names by
 * hand — "concurrent checkout of the last unit is a real race" — and it is the
 * reason this file exists rather than a unit test.
 */
describe("checkout", () => {
  const client = new Client();
  const cleanup = new Cleanup();
  let slug: string;
  let site: any;
  let p1: any;
  /** A second product on the same store, for the variant-less one-shot path. */
  let p2: any;
  let locationId: number;

  const cart = (p = "") => `/_sites/${slug}/api/cart${p}`;
  const checkout = (p = "") => `/_sites/${slug}/api/checkout${p}`;

  beforeAll(async () => {
    const store = await createTestStore(cleanup, "checkout");
    slug = store.slug;
    site = store.site;
    [p1, p2] = store.products;

    const [loc] = await sql`insert into locations (site_id, name, is_default)
      values (${site.id}, 'Test Location', true) returning *`;
    locationId = loc.id;
    cleanup.locationIds.push(loc.id);
  });

  afterAll(async () => {
    await cleanup.run();
  });

  /** A variant with a known ledger balance, so stock behaviour is observable. */
  async function makeVariant(label: string, units: number, opts?: { requiresShipping?: boolean }) {
    const [v] = await sql`insert into variants (product_id, title, option_values, price_minor,
      weight_grams, requires_shipping, inventory_policy)
      values (${p1.id}, ${label}, ${sql.json({ Test: label })}, 2000, 100,
              ${opts?.requiresShipping ?? false}, 'deny') returning *`;
    cleanup.variantIds.push(v.id);
    await sql`insert into inventory_ledger (variant_id, location_id, available_delta, reason, actor_type)
      values (${v.id}, ${locationId}, ${units}, 'test seed', 'system')`;
    return v;
  }

  it("completes a sale and records order, stock, and metering atomically", async () => {
    const v = await makeVariant("complete", 5);

    const c = await client.post(cart(), { productId: p1.id, variantId: v.id, quantity: 2 });
    await trackCart(cleanup, c.json.token);

    const session = await client.post(checkout("/session"), {
      cartToken: c.json.token,
      rail: "x402",
    });
    expect(session.status).toBe(201);
    cleanup.checkoutSessionIds.push(session.json.id);

    // Reserved but not yet sold: still 5 on hand, 2 committed.
    let [lvl] = await sql`select coalesce(sum(available_delta),0) a,
      coalesce(sum(committed_delta),0) c from inventory_ledger where variant_id = ${v.id}`;
    expect(Number(lvl.a)).toBe(5);
    expect(Number(lvl.c)).toBe(2);

    const tx = `0xtest${Date.now().toString(16)}`;
    const done = await client.post(checkout(`/session/${session.json.id}/complete`), {
      paymentReference: tx,
    });
    expect(done.status).toBe(200);
    await trackOrderCascade(cleanup, done.json.orderId);

    // Sold: stock has actually left and nothing stays committed.
    [lvl] = await sql`select coalesce(sum(available_delta),0) a,
      coalesce(sum(committed_delta),0) c from inventory_ledger where variant_id = ${v.id}`;
    expect(Number(lvl.a)).toBe(3);
    expect(Number(lvl.c)).toBe(0);

    const [order] = await sql`select * from orders where id = ${done.json.orderId}`;
    expect(order.status).toBe("success");
    expect(order.amount_cents).toBe(session.json.totalMinor);

    const usage = await sql`select * from usage_records where order_id = ${done.json.orderId}`;
    expect(usage).toHaveLength(1);
    expect(usage[0].type).toBe("sale");
    // The test store is live and the payment verified, so this is a real sale.
    expect(usage[0].environment).toBe("production");

    const [cartRow] = await sql`select status from carts where token = ${c.json.token}`;
    expect(cartRow.status).toBe("converted");
  });

  it("is idempotent — a retried completion returns the same order", async () => {
    const v = await makeVariant("idempotent", 3);
    const c = await client.post(cart(), { productId: p1.id, variantId: v.id, quantity: 1 });
    await trackCart(cleanup, c.json.token);

    const session = await client.post(checkout("/session"), {
      cartToken: c.json.token,
      rail: "x402",
    });
    cleanup.checkoutSessionIds.push(session.json.id);

    const tx = `0xidem${Date.now().toString(16)}`;
    const first = await client.post(checkout(`/session/${session.json.id}/complete`), {
      paymentReference: tx,
    });
    await trackOrderCascade(cleanup, first.json.orderId);

    const second = await client.post(checkout(`/session/${session.json.id}/complete`), {
      paymentReference: tx,
    });
    expect(second.status).toBe(200);
    expect(second.json.alreadyCompleted).toBe(true);
    expect(second.json.orderId).toBe(first.json.orderId);

    const [orders] = await sql`select count(*)::int c from orders where tx_hash = ${tx}`;
    expect(orders.c).toBe(1);
    const [usage] = await sql`select count(*)::int c from usage_records
      where order_id = ${first.json.orderId}`;
    // Double-counting a sale would overcharge the merchant at the threshold.
    expect(usage.c).toBe(1);
  });

  it("never oversells the last units under concurrent checkout", async () => {
    // docs/BACKEND.md §4: solved with a row lock in a transaction, not an
    // application-level read-then-write.
    const STOCK = 3;
    const RACERS = 8;
    const v = await makeVariant("race", STOCK);

    const tokens: string[] = [];
    for (let i = 0; i < RACERS; i++) {
      const c = await client.post(cart(), { productId: p1.id, variantId: v.id, quantity: 1 });
      tokens.push(c.json.token);
      await trackCart(cleanup, c.json.token);
    }

    const results = await Promise.all(
      tokens.map((t) => client.post(checkout("/session"), { cartToken: t, rail: "x402" })),
    );
    const winners = results.filter((r) => r.status === 201);
    for (const w of winners) cleanup.checkoutSessionIds.push(w.json.id);

    expect(winners).toHaveLength(STOCK);
    expect(results.filter((r) => r.status === 409)).toHaveLength(RACERS - STOCK);

    const [lvl] = await sql`select coalesce(sum(committed_delta),0) c
      from inventory_ledger where variant_id = ${v.id}`;
    expect(Number(lvl.c)).toBe(STOCK);

    const [held] = await sql`select count(*)::int c from inventory_reservations
      where variant_id = ${v.id} and status = 'held'`;
    expect(held.c).toBe(STOCK);
  });

  it("releases held stock when a checkout expires", async () => {
    const v = await makeVariant("expiry", 2);
    const c = await client.post(cart(), { productId: p1.id, variantId: v.id, quantity: 1 });
    await trackCart(cleanup, c.json.token);

    const session = await client.post(checkout("/session"), {
      cartToken: c.json.token,
      rail: "x402",
    });
    cleanup.checkoutSessionIds.push(session.json.id);

    await sql`update inventory_reservations set expires_at = now() - interval '1 hour'
      where checkout_session_id = ${session.json.id}`;
    await sql`update checkout_sessions set expires_at = now() - interval '1 hour'
      where id = ${session.json.id}`;

    // Opening another checkout sweeps first, so an idle store does not refuse
    // real sales for stock nobody is buying.
    const other = await client.post(cart(), { productId: p1.id, variantId: v.id, quantity: 1 });
    await trackCart(cleanup, other.json.token);
    const sweeper = await client.post(checkout("/session"), {
      cartToken: other.json.token,
      rail: "x402",
    });
    if (sweeper.json.id) cleanup.checkoutSessionIds.push(sweeper.json.id);

    const [reservation] = await sql`select status from inventory_reservations
      where checkout_session_id = ${session.json.id}`;
    expect(reservation.status).toBe("released");

    const [expired] = await sql`select status from checkout_sessions where id = ${session.json.id}`;
    expect(expired.status).toBe("expired");

    const late = await client.post(checkout(`/session/${session.json.id}/complete`), {
      paymentReference: `0xlate${Date.now().toString(16)}`,
    });
    expect(late.status).toBe(409);
  });

  it("refuses the card rail rather than pretending it works", async () => {
    const v = await makeVariant("card", 2);
    const c = await client.post(cart(), { productId: p1.id, variantId: v.id, quantity: 1 });
    await trackCart(cleanup, c.json.token);

    const r = await client.post(checkout("/session"), {
      cartToken: c.json.token,
      rail: "stripe",
    });
    expect(r.status).toBe(409);
  });

  it("routes the x402 one-shot through the same pipeline and meters it", async () => {
    // The store's second product, which no other test has attached variants to
    // — this path exercises the variant-less `products.stock` branch.
    const target = p2;

    const challenge = await client.get(
      `/_sites/${slug}/api/checkout?productId=${target.id}&quantity=1`,
    );
    expect(challenge.status).toBe(402);

    const tx = `0xoneshot${Date.now().toString(16)}`;
    const paid = await fetch(
      `${(await import("./setup")).BASE_URL}/_sites/${slug}/api/checkout?productId=${target.id}&quantity=1`,
      {
        headers: {
          "x-payment": Buffer.from(JSON.stringify({ txHash: tx, from: "0xagent" })).toString(
            "base64",
          ),
          "user-agent": "GPTBot/1.0",
        },
      },
    ).then((r) => r.json());

    expect(paid.success).toBe(true);
    // The route builds its own cart and session internally, so track backwards
    // from the order rather than guessing their ids.
    await trackOrderCascade(cleanup, paid.order.id);

    // The whole point: the agent rail writes the same metering event as the
    // human one, or the threshold meter is blind to half the sales.
    const usage = await sql`select * from usage_records where order_id = ${paid.order.id}`;
    expect(usage).toHaveLength(1);
    expect(usage[0].type).toBe("sale");

    const replay = await client.get(
      `/_sites/${slug}/api/checkout?productId=${target.id}&quantity=1`,
    );
    // A fresh challenge, not a second order — replay protection is on the hash.
    expect(replay.status).toBe(402);
  });
});
